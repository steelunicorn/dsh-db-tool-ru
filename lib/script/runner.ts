/**
 * run_script 子进程执行器。
 *
 * 为什么不用 node:vm 同进程沙箱：node:vm 官方明确不是安全边界，脚本可经
 * Function constructor 等已知路径逃逸到宿主 realm 拿到 process/require，
 * 读取 secrets.json 与任意文件。子进程 + Node permission model（禁 fs）+
 * 新 vm realm 双层隔离：vm 逃逸后仍是无文件权限的 worker 进程。
 * 超时用 SIGKILL 进程级强杀（vm timeout 管不到异步调用），并对会话专用
 * 适配器立即 close，中断在途调用。
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { DbToolError } from '../manager.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.cjs');

export interface ScriptRunOptions {
  code: string;
  timeoutMs?: number;
  /** 走完整 guard/challenge/审计链路的 db 句柄（由 DbToolService 提供）；database? 即跨库路由目标 */
  dbQuery: (sql: string, params?: unknown[], database?: string) => Promise<unknown>;
  dbExecute: (statement: string, params?: unknown[], database?: string) => Promise<unknown>;
  /**
   * file.save 桥（配置开启时才提供）：写盘发生在父进程，worker 仍无 fs 权限。
   * 缺省 = worker 的 vm 里没有 file 对象。
   */
  fileSave?: (relPath: string, text: string) => Promise<unknown>;
  onLog?: (level: 'log' | 'error', text: string) => void;
  /** 超时强杀后回调（关闭会话专用适配器，中断在途 db 调用） */
  onTimeout?: () => void;
}

/** permission model 的版本兼容 flag：Node ≥22 用稳定名，20/21 用 experimental 别名 */
function permissionFlags(): string[] {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22 ? ['--permission'] : ['--experimental-permission'];
}

/** worker 启动/运行所需的环境变量白名单（Windows/Unix 各取所需），其余一律不透传 */
const ENV_ALLOWLIST = [
  'PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'HOME', 'LANG', 'TZ',
] as const;

/** 最小化环境变量：--permission 只禁 fs，脚本仍可读 process.env，故 fork 时按白名单裁剪 */
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface DoneMsg {
  ok: boolean;
  result?: unknown;
  error?: { name?: string; message?: string; code?: string; payload?: unknown };
}

export async function runScriptInChild(opts: ScriptRunOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const child = fork(WORKER_PATH, [], {
    execArgv: permissionFlags(),
    env: minimalEnv(),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });

  const pendingDb = new Map<number, (r: { ok: boolean; result?: unknown; error?: { code?: string; message?: string; payload?: unknown } }) => void>();
  let dbSeq = 0;
  let settled = false;

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      opts.onTimeout?.();
      reject(new DbToolError('SCRIPT_TIMEOUT', `Script execution timed out (${Math.round(timeoutMs / 1000)}s); the process was killed and this session's connection was closed`));
    }, timeoutMs);
    timer.unref?.();

    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as {
        type?: string;
        reqId?: unknown;
        method?: unknown;
        args?: unknown;
        path?: unknown;
        text?: unknown;
        level?: unknown;
        ok?: boolean;
        result?: unknown;
        error?: { name?: string; message?: string; code?: string; payload?: unknown };
      };
      if (msg.type === 'db') {
        const reqId = Number(msg.reqId);
        // 先注册回包通道再发起调用（同一处理器内，保证时序）
        pendingDb.set(reqId, (r) => {
          child.send({ type: 'dbResult', reqId, ...r }, () => {
            /* 忽略回包失败（worker 可能已死） */
          });
        });
        void handleDbCall(String(msg.method ?? ''), Array.isArray(msg.args) ? msg.args : [])
          .then((result) => pendingDb.get(reqId)?.({ ok: true, result }))
          .catch((e) => pendingDb.get(reqId)?.({ ok: false, error: errorOf(e) }));
        return;
      }
      if (msg.type === 'fileSave') {
        const reqId = Number(msg.reqId);
        pendingDb.set(reqId, (r) => {
          child.send({ type: 'dbResult', reqId, ...r }, () => {
            /* 忽略回包失败（worker 可能已死） */
          });
        });
        const filePath = typeof msg.path === 'string' ? msg.path : '';
        const text = typeof msg.text === 'string' ? msg.text : String(msg.text ?? '');
        void handleFileSave(filePath, text)
          .then((result) => pendingDb.get(reqId)?.({ ok: true, result }))
          .catch((e) => pendingDb.get(reqId)?.({ ok: false, error: errorOf(e) }));
        return;
      }
      if (msg.type === 'log') {
        opts.onLog?.(msg.level === 'error' ? 'error' : 'log', String(msg.text ?? ''));
        return;
      }
      if (msg.type === 'done' && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (msg.ok) {
          resolve(msg.result);
        } else {
          const err = msg.error ?? {};
          if (err.code === 'NEEDS_CONFIRMATION' && err.payload) {
            reject(needConfirmFromPayload(err.payload));
          } else if (err.code === 'SCRIPT_TIMEOUT') {
            reject(new DbToolError('SCRIPT_TIMEOUT', err.message ?? 'Script execution timed out'));
          } else if (err.code === 'READ_ONLY') {
            reject(new DbToolError('READ_ONLY', err.message ?? 'This connection is read-only; write operations are refused'));
          } else {
            const e: Error & { code?: string } = new Error(err.message ?? 'Script execution failed');
            // 文件交换类错误（PATH_OUTSIDE_PROJECT 等）保留机器可读的 code
            if (err.code !== undefined) e.code = err.code;
            reject(e);
          }
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Script process exited abnormally (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`));
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DbToolError('DRIVER_ERROR', `Failed to start the script process: ${e.message}`));
    });

    child.send({ type: 'run', code: opts.code, allowFile: opts.fileSave !== undefined }, () => {
      /* 入队即可 */
    });
  });

  async function handleFileSave(relPath: string, text: string): Promise<unknown> {
    if (!opts.fileSave) {
      throw new DbToolError('INVALID_ARGUMENT', 'file.save is not enabled for this plugin (scriptFileBridge=false)');
    }
    return opts.fileSave(relPath, text);
  }

  async function handleDbCall(method: string, args: unknown[]): Promise<unknown> {
    const [statement, params, rawDatabase] = args as [string, unknown[] | undefined, string | undefined];
    // IPC JSON 序列化会把 undefined 变 null，归一回 undefined 保持与直连调用语义一致
    const database = rawDatabase ?? undefined;
    if (method === 'query') return opts.dbQuery(statement, params, database);
    if (method === 'execute') return opts.dbExecute(statement, params, database);
    throw new DbToolError('INVALID_ARGUMENT', `Unknown db method: ${method}`);
  }

  function errorOf(e: unknown): { code?: string; message: string; payload?: unknown } {
    if (e instanceof DbToolError) {
      if (e.code === 'NEEDS_CONFIRMATION') {
        let payload: unknown;
        try {
          payload = JSON.parse(e.message);
        } catch {
          payload = undefined;
        }
        return { code: e.code, message: e.message, payload };
      }
      return { code: e.code, message: e.message };
    }
    return { message: e instanceof Error ? e.message : String(e) };
  }

  function needConfirmFromPayload(payload: unknown): DbToolError {
    return new DbToolError('NEEDS_CONFIRMATION', JSON.stringify(payload));
  }
}
