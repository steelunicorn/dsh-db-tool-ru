/**
 * dsh-db-tool 插件入口（形态对齐 dsh-ssh-tunnel：apply(ctx) + inject + ctx.effect）。
 *
 *  - 注册 DatabaseManager 模型工具（单工具多 action），projectPath 取自
 *    session header.cwd（不信任模型自报），业务操作经 GrantStore 授权。
 *  - HTTP API 挂载在 DSH webServer（prefix /dsh-db-tool/api）：前端同源
 *    相对路径 fetch('/dsh-db-tool/api/...') 即可达；0.2.0-rc.1 起插件前缀路由
 *    不经宿主 Connection 栅栏，故在 handler 顶层先应用 ctx.connection.requestRejection
 *    （Host/Origin + 浏览器 token 鉴权，401/403）；宿主无 connection 服务时退回
 *    http-trust 本地校验（Host loopback / trustedHosts + Origin 同源校验）。
 *  - ctx.effect 收尾：注销 HTTP 路由、关适配器、停 challenge 清理。
 */
import { isIP } from 'node:net';
import { DbToolStore, normalizeProjectKey } from './store/index.js';
import { DbToolService, handleToolAction, type ToolActionArgs } from './manager.js';
import { handleDbToolRequest } from './http/index.js';

/* ---------- DSH 运行时最小结构类型（宿主为 JS，运行时按结构匹配） ---------- */

interface ToolExecContext {
  agent?: { session?: { id?: string } };
}

interface DshContext {
  tools?: {
    register(tool: {
      name: string;
      timeoutMs?: number;
      description: string;
      parameters: Record<string, unknown>;
      output?: {
        schema?: Record<string, unknown>;
        render?: (args: unknown, value: { text: string }) => Array<{ type: string; text: string }>;
      };
      execute: (args: Record<string, unknown>, exec: ToolExecContext) => Promise<{ text: string; isError?: boolean }>;
    }): void;
  };
  sessions?: {
    get(id: string): { header?: { cwd?: string } } | undefined;
  };
  webServer?: {
    register(h: {
      kind: 'prefix';
      path: string;
      handler: (req: unknown, res: unknown) => Promise<void> | void;
    }): () => void;
    /** 监听地址/端口 getter（rc.1 与 rc.3 都提供）。rc.3 的 Connection 单独接受 bind 地址。 */
    host?: string;
    port?: number;
  };
  /** 可选服务读取（cordis 反射层）：不进 inject，缺失时返回 undefined */
  get?: (name: string, strict?: boolean) => unknown;
  /** 0.2.1-rc.3 的信任权威来源（--trusted-host 值），取代已删除的 webRuntime 服务。 */
  webStartup?: { trustedHosts?: string[] };
  webRuntime?: { trustedHosts?: string[] };
  /** Connection 服务（0.2.0-rc.1 web-app bundle 常驻行）：宿主级请求鉴权栅栏。 */
  connection?: {
    /** 返回 401/403 表示拒绝（宿主已写出响应语义由调用方兜底），undefined 表示放行。 */
    requestRejection?: (req: unknown) => 401 | 403 | undefined;
  };
  effect?: (fn: () => () => void, name?: string) => void;
  logger?: { info?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

/**
 * cordis 注入清单（服务名以 dsh-ssh-tunnel 为准；connection 用于宿主鉴权栅栏）。
 *
 * 注意：不要把 webRuntime 写进来。宿主 @deepseek-ai/dsh-web-app 提供的是
 * webApp，从不注册 webRuntime；cordis 的 inject 是硬依赖，缺失服务会让 fiber
 * 永久 pending、apply() 不执行，HTTP 路由也就不会注册（前端表现为 HTTP 404）。
 * trustedHosts 改用 ctx.get('webStartup' | 'webRuntime', true) 可选读取：
 * 0.2.1-rc.3 删除了 webRuntime 服务、信任权威改为 webStartup.trustedHosts，
 * 旧宿主仍用 webRuntime，故按新优先、旧回退读取。
 */
export const inject = ['webServer', 'sessions', 'tools', 'connection'];

/** 插件配置（cordis.patch.yml 里该行的 config 段；全部可选） */
export interface DbToolPluginConfig {
  /** 文件交换限制：读写上限（字节）与允许的扩展名（小写、带点） */
  fileIo?: {
    maxReadBytes?: number;
    maxWriteBytes?: number;
    extensions?: string[];
  };
  /** run_script 的 file.save 桥（默认 false：脚本依旧没有任何文件能力） */
  scriptFileBridge?: boolean;
}

const TOOL_DESCRIPTION = `Database management tool (dsh-db-tool-ru): runs queries, writes and scripts against the configured database connections.

Permission model (must be respected):
- For the current project every connection is granted either ro (read-only) or rw (read/write); all business operations on a connection without a grant are rejected.
- A grant may also carry a database allowlist: access opens only to the databases the user ticked in the panel, so a connection with a fresh grant has no reachable database until something is ticked (DATABASE_NOT_GRANTED names the panel; the user must tick the databases themselves — never work around it).
- On an ro connection execute / run_script / execute_file are rejected outright (READ_ONLY); the adapter layer additionally enforces session-level read-only.
- Dangerous operations (DDL, dropping databases, FLUSHALL, …) are not executed directly: the tool returns NEEDS_CONFIRMATION with a challengeId.
  You must then explain the statement and its risk to the user, obtain explicit consent, and retry with the same challengeId and the same statement;
  a challenge is single-use, bound to the statement, and valid for 5 minutes. Never retry without the user's consent.

Actions:
- list_connections: list connections (secrets masked; kinds and per-project grant status are visible in the HTTP panel).
- query: read-only SQL/command (conn_id, sql, params?).
- execute: write/DDL (conn_id, statement, params?, database? — cross-database target).
- schema: browse structure (conn_id; with table returns columns, with database returns tables, with neither returns databases).
- preview: preview rows, limit≤50 (conn_id, table, database?, limit?).
- run_script: sandboxed child-process script (conn_id, code), hard-killed after 60s, permission model blocks file
  access plus a fresh vm realm as second isolation; only restricted db.query/db.execute handles are injected (they go through the full
  guard/audit chain) and only rw connections can write. Handle signature db.query(sql, params?, database?):
  the third argument routes to another database (pg/gaussdb route per database, Navicat style), so multi-database statistics
  can be collected in one call by looping over databases inside the script.
  With the optional plugin setting scriptFileBridge a file.save(path, text) handle is added; the write itself happens in the host
  process under the same project-folder checks as export_to_file, so the script still has no filesystem access of its own.
- export_to_file: write a read-only query result to a file inside the project folder (conn_id, sql, path — relative to the project,
  format=text|json|csv, params?, database?, overwrite?, create_dirs?, allow_empty?).
  format=text requires exactly one row and one column and writes the value byte-for-byte (no newline is added or normalized);
  json writes the rows array with 2-space indentation plus a trailing newline; csv writes a header row with RFC 4180 quoting and CRLF.
  Files are always UTF-8 without BOM. 0 rows (or NULL in text mode) is EMPTY_RESULT unless allow_empty=true.
  An existing file is FILE_EXISTS unless overwrite=true. Relative paths are validated: no absolute paths, no '..', no drive letters or
  alternate data streams, no device names, no symbolic links, and the parent folder must exist unless create_dirs=true.
  Default limits: read ≤ 8 MB, write ≤ 64 MB; extensions .sql/.txt/.json/.csv/.tsv/.md/.log.
  Reply: {path, bytes, md5, rows, format}. Use it whenever a result must reach a file unchanged (function bodies, big exports) — do not
  re-type large text through the model.
- execute_file: execute a statement read from a file inside the project folder (conn_id, path, params?, database?, challenge_id?, search_path?).
  The whole file content is passed to execute unchanged (no trailing-whitespace trimming), so the same guard, NEEDS_CONFIRMATION and
  audit rules apply; DDL still needs the user's consent. Reply: {path, bytes, md5, commandtag?}.
  search_path (PostgreSQL only) is prepended as a separate "set search_path = …;" statement so a body that names types or routines
  without a schema still resolves; it cannot be combined with params.

Chat references (produced by the panel, not by this tool):
- The user may send messages containing @db:<connId>/<database>[/<schema>]/<table> or @col:<connId>/<database>[/<schema>]/<table>/<column>.
  These come from the sidebar "Browse data" panel, point at exactly one table or column, and are rendered as chips in the chat.
  They are NOT file paths and must not be treated as such: resolve the identifiers, check that the connection and database are reachable
  for this project, and read what you need with schema / query / preview.
- A segment may be percent-encoded: decode %XX escapes (a space is %20) before using the name; anything else appears literally.
  When the schema segment is present, pass database as "<database>.<schema>" (same rule as the database argument of query/preview).`;

export function apply(ctx: DshContext, config?: DbToolPluginConfig): void {
  const log = ctx.logger ?? { info: () => {}, error: () => {} };
  const store = new DbToolStore();
  const service = new DbToolService(store, {
    fileIo: config?.fileIo,
    scriptFileBridge: config?.scriptFileBridge === true,
  });

  // HTTP API：挂在 DSH webServer 的 /dsh-db-tool/api 前缀下（同源访问）
  /**
   * rc.3 的 Connection 在 trustedHosts 之外还单独接受监听 bind 地址
   * （isBindAddressAuthority）。本地兜底对齐该语义，但只补具体单播字面量：
   * wildcard（0.0.0.0/::/*）与 loopback 一律跳过，不放宽 DNS rebinding 攻击面。
   */
  const bindAuthorities = (): string[] => {
    const host = ctx.webServer?.host;
    if (typeof host !== 'string') return [];
    const h = host.trim();
    if (h === '' || h === '*' || h === '0.0.0.0' || h === '::') return [];
    if (isIP(h) === 0) return [];
    if (h === '::1' || h === '::ffff:127.0.0.1' || /^127\./.test(h)) return [];
    const port = ctx.webServer?.port;
    if (typeof port !== 'number' || !(port > 0)) return [h];
    return [h, `${h.includes(':') ? `[${h}]` : h}:${port}`];
  };

  const trustedHosts = (): string[] => {
    try {
      // webRuntime 不在 inject 内：缺失服务会让插件永不激活，故可选读取。
      // 0.2.1-rc.3 删除了 webRuntime，改由 webStartup.trustedHosts 提供信任权威。
      const startup = ctx.get?.('webStartup', true) as { trustedHosts?: string[] } | undefined;
      const declared =
        startup?.trustedHosts ??
        (ctx.get?.('webRuntime', true) as { trustedHosts?: string[] } | undefined)?.trustedHosts ??
        [];
      // 仅 rc.3（webStartup 存在）补 bind 地址；旧宿主的 webRuntime 已含 bind 派生的 LAN 地址。
      return startup === undefined ? declared : [...bindAuthorities(), ...declared];
    } catch {
      return [];
    }
  };
  ctx.effect?.(
    () =>
      ctx.webServer?.register({
        kind: 'prefix',
        path: '/dsh-db-tool-ru/api',
        handler: async (req, res) => {
          // 宿主 Connection 栅栏优先：0.2.0-rc.1 起插件前缀路由不经宿主鉴权，
          // 必须显式应用 requestRejection（Host/Origin + 浏览器 token）；
          // 401/403 时由本处兜底写出 JSON 响应（宿主只返回状态码）。
          const rejection = ctx.connection?.requestRejection?.(req);
          if (rejection !== undefined) {
            const httpRes = res as import('node:http').ServerResponse;
            httpRes.statusCode = rejection;
            httpRes.setHeader('Content-Type', 'application/json; charset=utf-8');
            httpRes.end(
              JSON.stringify({
                ok: false,
                error: rejection === 401 ? 'unauthorized: browser authentication required' : 'forbidden: untrusted request',
                code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
              }),
            );
            return;
          }
          await handleDbToolRequest(
            req as import('node:http').IncomingMessage,
            res as import('node:http').ServerResponse,
            service,
            {
              trustedHosts: trustedHosts(),
              // 项目上下文权威解析：会话 header.cwd 优先，回退前端 cwd（对齐 ssh-tunnel getProjectContext）
              resolveProject: (sessionId, fallbackCwd) => {
                let cwd = '';
                try {
                  cwd = sessionId !== '' ? ctx.sessions?.get?.(sessionId)?.header?.cwd ?? '' : '';
                } catch {
                  // 会话不可得时用前端回退值
                }
                const key = service.projectKey(cwd || fallbackCwd || '');
                return { projectPathKey: key, hasProject: key !== '' };
              },
            },
          );
        },
      }) ?? (() => {}),
    'db-tool-ru-api',
  );

  // 收尾：适配器连接与 challenge 清理定时器
  ctx.effect?.(() => () => service.dispose(), 'db-tool-ru-dispose');

  // 模型工具
  ctx.tools?.register({
    name: 'DatabaseManager',
    timeoutMs: 90_000,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_connections', 'query', 'execute', 'schema', 'preview', 'run_script', 'export_to_file', 'execute_file'],
          description: 'Operation to perform',
        },
        conn_id: { type: 'string', description: 'Connection id (required for query/execute/schema/preview/run_script/export_to_file/execute_file)' },
        sql: { type: 'string', description: 'Read-only SQL/command for query and export_to_file' },
        statement: { type: 'string', description: 'Statement for execute' },
        params: { type: 'array', items: {}, description: 'Placeholder parameters' },
        database: { type: 'string', description: 'Database/schema (optional). query/execute: target another database (Navicat style; pg/gaussdb route per database); schema/preview: browse target (pg/gaussdb accept "database.schema")' },
        table: { type: 'string', description: 'Table/collection/key (schema/preview)' },
        limit: { type: 'number', description: 'preview row cap (≤50)' },
        offset: { type: 'number', description: 'preview row offset (paging, default 0)' },
        code: { type: 'string', description: 'Script source for run_script' },
        path: {
          type: 'string',
          description: 'File path relative to the project folder (export_to_file, execute_file); absolute paths, "..", drive letters and symbolic links are refused',
        },
        format: {
          type: 'string',
          enum: ['text', 'json', 'csv'],
          description: 'export_to_file output format (default text: exactly 1 row × 1 column, written byte-for-byte)',
        },
        overwrite: { type: 'boolean', description: 'export_to_file: replace an existing file (default false → FILE_EXISTS)' },
        create_dirs: { type: 'boolean', description: 'export_to_file: create missing parent folders inside the project (default false)' },
        allow_empty: { type: 'boolean', description: 'export_to_file: write an empty file instead of EMPTY_RESULT when there are no rows (or NULL in text mode)' },
        search_path: {
          type: 'string',
          description:
            'execute_file: optional PostgreSQL search_path for this batch (comma-separated plain identifiers, e.g. "sys, dbo, public"); needed when the file body names types or routines without a schema. Cannot be combined with params',
        },
        challenge_id: {
          type: 'string',
          description: 'Dangerous-operation consent token: ask the user, then resend it unchanged with the retry',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'JSON result text' },
          isError: { type: 'boolean', description: 'true when the operation was refused or failed' },
        },
        required: ['text'],
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      // projectPath 从 session header.cwd 取，不信任模型自报
      let projectPath = '';
      try {
        const sid = exec.agent?.session?.id ?? '';
        const cwd = sid !== '' ? ctx.sessions?.get(sid)?.header?.cwd : undefined;
        if (cwd) projectPath = normalizeProjectKey(cwd);
      } catch {
        // 取不到 cwd 视为匿名项目（业务操作会被拒，连接管理仍可用）
      }
      return handleToolAction(service, args as unknown as ToolActionArgs, projectPath);
    },
  });

  log.info?.('[db-tool-ru] plugin loaded (DatabaseManager tool + /dsh-db-tool-ru/api mounted)');
}

// 注意：不要提供 default export。
// cordis-plugin-loader 的 unwrapExports() 会优先取 exports.default，
// 裸函数形态会丢失 named export 的 inject 声明，导致
// "cannot get property "webServer" without inject" 且插件无法激活。
