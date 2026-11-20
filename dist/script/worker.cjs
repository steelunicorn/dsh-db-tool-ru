/**
 * run_script 子进程 worker（纯 JS，CommonJS，父进程 fork 直接加载）。
 *
 * 安全模型：
 *  - 脚本运行在 worker 进程的 vm.runInNewContext 新 realm 中，仅注入 db/console；
 *  - worker 进程以 Node permission model 启动（无文件系统权限），即使脚本逃逸
 *    vm realm，也读不到 secrets.json 等宿主文件；
 *  - db 调用经 IPC 回父进程，走完整 guard/challenge/审计链路；
 *  - 超时由父进程 SIGKILL 强杀（vm timeout 管不到异步，进程级才是真强杀）。
 *
 * IPC 协议：
 *  父→worker {type:'run', code, allowFile}
 *  worker→父 {type:'db', reqId, method, args}   // args=[statement, params, database?]，database 即跨库路由目标
 *  父→worker {type:'dbResult', reqId, ok, result, error}
 *  worker→父 {type:'fileSave', reqId, path, text}  // 仅 allowFile=true（插件配置 scriptFileBridge）
 *  worker→父 {type:'done', ok, result, error}
 */
'use strict';

const vm = require('node:vm');

process.on('message', (msg) => {
  if (!msg || msg.type !== 'run') return;
  runScript(String(msg.code ?? ''), msg.allowFile === true);
});

async function runScript(code, allowFile) {
  /** db 请求队列：reqId → resolve */
  const pending = new Map();
  let reqSeq = 0;

  const dbCall = (method) => (statement, params, database) =>
    new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      pending.set(reqId, { resolve, reject });
      process.send({ type: 'db', reqId, method, args: [statement, params, database] });
    });

  const db = {
    query: dbCall('query'),
    execute: dbCall('execute'),
  };

  // file.save 桥：worker 自身没有 fs 权限，请求经 IPC 交给父进程写盘
  // （父进程走与 export_to_file 相同的项目内路径校验）。未开启时 vm 里没有 file。
  const fileCall = (relPath, text) =>
    new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      pending.set(reqId, { resolve, reject });
      process.send({ type: 'fileSave', reqId, path: String(relPath ?? ''), text: String(text ?? '') });
    });
  const file = { save: (relPath, text) => fileCall(relPath, text) };

  const consoleBridge = {
    log: (...a) => process.send({ type: 'log', level: 'log', text: a.map(fmt).join(' ') }),
    error: (...a) => process.send({ type: 'log', level: 'error', text: a.map(fmt).join(' ') }),
  };

  function fmt(v) {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  // 父进程回包分发
  const onMessage = (msg) => {
    if (!msg) return;
    if (msg.type === 'dbResult') {
      const p = pending.get(msg.reqId);
      if (!p) return;
      pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.result);
      else {
        const e = new Error(msg.error?.message ?? 'database call failed');
        if (msg.error?.code) e.code = msg.error.code;
        if (msg.error?.payload !== undefined) e.payload = msg.error.payload;
        p.reject(e);
      }
    }
  };
  process.on('message', onMessage);

  let sandbox;
  try {
    // file 只在 allowFile=true 时注入：默认的 run_script 环境与之前完全一致
    const globals = allowFile ? { db, console: consoleBridge, file } : { db, console: consoleBridge };
    sandbox = vm.createContext(globals);
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'db-script.js' });
    const result = await script.runInContext(sandbox, { timeout: 60000 });
    process.send({ type: 'done', ok: true, result: safeClone(result) });
  } catch (e) {
    process.send({
      type: 'done',
      ok: false,
      error: {
        name: e instanceof Error ? e.name : 'Error',
        message: e instanceof Error ? e.message : String(e),
        code: e && typeof e === 'object' && e.code !== undefined ? String(e.code) : undefined,
        payload: e && typeof e === 'object' && e.payload !== undefined ? safeClone(e.payload) : undefined,
      },
    });
  } finally {
    process.off('message', onMessage);
  }
}

function safeClone(v) {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}
