import { randomBytes } from 'node:crypto';
import { getAdapter } from './adapters/index.js';
import { friendlyConnectError } from './adapters/connect-feedback.js';
import { ChallengeStore, classifyStatement, sqlHead, SQL_READ_HEADS, } from './guard/index.js';
import { mergeUrlCredentials, normalizeProjectKey, DECRYPT_FAIL_MESSAGE, DEFAULT_TRANSFER_CONFIG, } from './store/index.js';
import { runScriptInChild } from './script/runner.js';
import { decryptPayload, encryptPayload } from './store/export-crypto.js';
import { startTransferTask } from './transfer.js';
/* ---------------- 错误与结果类型 ---------------- */
/** 携带机器可读 code 的业务错误（HTTP 层直接映射 {ok:false,error,code}） */
export class DbToolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DbToolError';
    }
}
/** 粘性通道的语句串行队列：前序失败不阻塞后续，但执行严格按到达顺序 */
function enqueue(chain, task) {
    const next = chain.p.then(task, task);
    chain.p = next.catch(() => { });
    return next;
}
function assertNonEmpty(v, label) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s === '')
        throw new DbToolError('INVALID_ARGUMENT', `Missing required parameter: ${label}`);
    return s;
}
/** 传输页配置收敛：枚举回退默认值，数字按前端控件范围钳制，布尔严格取 === true */
function normalizeTransferConfig(input) {
    const cap = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
    };
    const mode = input.writeMode;
    return {
        sourceConnId: typeof input.sourceConnId === 'string' ? input.sourceConnId : '',
        targetConnId: typeof input.targetConnId === 'string' ? input.targetConnId : '',
        writeMode: mode === 'insert' || mode === 'ignore' || mode === 'replace' || mode === 'truncate'
            ? mode : DEFAULT_TRANSFER_CONFIG.writeMode,
        batchSize: cap(input.batchSize, 1, 5000, DEFAULT_TRANSFER_CONFIG.batchSize),
        tableConcurrency: cap(input.tableConcurrency, 1, 16, DEFAULT_TRANSFER_CONFIG.tableConcurrency),
        shardConcurrency: cap(input.shardConcurrency, 1, 32, DEFAULT_TRANSFER_CONFIG.shardConcurrency),
        overwriteStructure: input.overwriteStructure === true,
    };
}
/** searchTables 回退白名单：listTables(database) 语义为「库名」的 kind（pg/gaussdb 有原生实现；
 *  redis/oracle/dmdb 语义不兼容，回退会错标来源或重复返回，见 manager.searchTables 注释） */
const SEARCH_FALLBACK_KINDS = new Set(['mysql', 'mongodb', 'sqlite']);
/** 单连接并发控制台事务会话上限（每会话独占驱动池 + checkout 连接，防连接耗尽） */
const MAX_CONSOLE_SESSIONS_PER_CONN = 4;
/** 全局并发传输任务上限（每任务独立 reader/writer 连接，防连接耗尽） */
const MAX_TRANSFER_TASKS = 8;
/** 终态快照保留窗口：前端轮询间隔 800ms + 慢网络余量；窗口后定时清除（不无限滞留） */
const TRANSFER_SNAPSHOT_TTL_MS = 60_000;
/** 单任务表清单上限：statement 进 challenge 响应与审计（表名全量 join），防兆级放大 */
const MAX_TRANSFER_TABLES = 1000;
/* ---------------- 服务核心 ---------------- */
export class DbToolService {
    store;
    adapterCache = new Map();
    /** 控制台事务会话注册表（token → 会话） */
    consoleSessions = new Map();
    consoleTtlMs;
    consoleSweepTimer;
    challenges;
    resolver;
    disposed = false;
    constructor(store, opts) {
        this.store = store;
        this.resolver = opts?.adapterResolver ?? getAdapter;
        this.challenges = opts?.challenges ?? new ChallengeStore();
        this.consoleTtlMs = opts?.consoleTx?.ttlMs ?? 5 * 60 * 1000;
        const sweep = opts?.consoleTx?.sweepIntervalMs ?? 30 * 1000;
        if (sweep > 0) {
            this.consoleSweepTimer = setInterval(() => this.consoleSweep(), sweep);
            this.consoleSweepTimer.unref?.();
        }
    }
    /* -- 连接管理（无需授权） -- */
    listConnections() {
        return this.store.connections.list();
    }
    createConnection(input) {
        const meta = this.store.connections.create(input);
        this.audit('', input.id, 'create_connection', input.id, 'none', false, true);
        return meta;
    }
    updateConnection(id, patch) {
        const meta = this.store.connections.update(id, patch);
        if (!meta)
            throw new DbToolError('NOT_FOUND', `Connection not found: ${id}`);
        // url/凭证/ssl 变更后旧适配器仍持旧连接串，必须作废重建；
        // 控制台事务会话的专用适配器不在缓存里，单独回收（否则旧凭据最长存活到空闲 TTL）；
        // 传输任务持独立连接，同样回收（凭证变更后不得按旧凭据继续读写）
        void this.dropAdapters(id);
        void this.dropConsoleSessions(id);
        this.cancelTransferTasksForConn(id);
        this.audit('', id, 'update_connection', id, 'none', false, true);
        return meta;
    }
    removeConnection(id) {
        const ok = this.store.connections.remove(id);
        if (!ok)
            throw new DbToolError('NOT_FOUND', `Connection not found: ${id}`);
        void this.dropAdapters(id);
        void this.dropConsoleSessions(id);
        this.cancelTransferTasksForConn(id);
        this.audit('', id, 'remove_connection', id, 'none', false, true);
        return ok;
    }
    async testConnection(id) {
        const rc = this.requireConn(id);
        try {
            const factory = await this.resolver(rc.meta.kind);
            const adapter = await factory(rc);
            try {
                return this.friendlyTestResult(rc.meta.kind, await adapter.testConnect());
            }
            finally {
                await adapter.close().catch(() => { });
            }
        }
        catch (e) {
            throw this.toConnectTestError(rc.meta.kind, e);
        }
    }
    /** 连接测试失败结果：错误文案过一遍错误码翻译（认识的特征换成准确提示，不认识保留原文） */
    friendlyTestResult(kind, r) {
        if (r && !r.ok && r.error) {
            const mapped = friendlyConnectError(kind, r.error);
            return mapped ? { ...r, error: mapped } : r;
        }
        return r;
    }
    /** 连接测试抛错：认识的特征换成准确提示，不认识走 toDriverError 保留原文 */
    toConnectTestError(kind, e) {
        const mapped = friendlyConnectError(kind, e);
        if (mapped)
            return new DbToolError('DRIVER_ERROR', mapped);
        return this.toDriverError(e);
    }
    /**
     * 测试未保存的连接草稿（侧边栏「保存前测试」）。不落库、不写审计，
     * 一次性适配器用完即关。url/fields 校验交给适配器层（与保存后测试同口径）。
     * 编辑已有连接时传 connId：密码留空/url 未改动时自动拼回已存机密
     * （仅注入本次测试，绝不回传客户端）。
     */
    async testDraft(input) {
        const rc = {
            meta: { id: input.connId ?? '(draft)', kind: input.kind, name: '(draft)' },
        };
        let url = input.url;
        let fields = input.fields !== undefined ? { ...input.fields } : undefined;
        let secretsUrl;
        if (input.connId) {
            // 已存连接：编辑时客户端不发旧机密（留空语义），这里从 secrets 拼回
            const sec = this.store.secrets.get(input.connId);
            secretsUrl = sec?.url;
            if (url === undefined && secretsUrl !== undefined)
                url = secretsUrl;
            if (fields !== undefined && sec?.password !== undefined && fields.password === undefined) {
                fields.password = sec.password;
            }
        }
        // URL 模式独立凭据注入（拼回已存 URL 之后；无凭据字段时 helper 原样返回，?? 保持不变）
        url = mergeUrlCredentials({
            url,
            urlUser: input.urlUser,
            urlPassword: input.urlPassword,
            secretsUrl,
        }) ?? url;
        if (url !== undefined)
            rc.url = url;
        if (fields !== undefined)
            rc.fields = fields;
        if (input.ssl !== undefined)
            rc.ssl = input.ssl;
        try {
            const factory = await this.resolver(input.kind);
            const adapter = await factory(rc);
            try {
                return this.friendlyTestResult(input.kind, await adapter.testConnect());
            }
            finally {
                await adapter.close().catch(() => { });
            }
        }
        catch (e) {
            throw this.toConnectTestError(input.kind, e);
        }
    }
    /* -- 连接导出/导入（口令加密，无需授权；口令不落审计） -- */
    /** 口令下限：导出包含全部连接机密（明文密码/完整 URL），安全边界在服务端而非 UI */
    static PASSPHRASE_MIN = 8;
    /**
     * 导出全部连接（含机密）为口令加密的 JSON 密文。
     * 审计只记连接条数，绝不落口令与密文内容。
     */
    exportConnections(passphrase) {
        const pp = assertNonEmpty(passphrase, 'passphrase');
        if (pp.length < DbToolService.PASSPHRASE_MIN) {
            throw new DbToolError('INVALID_ARGUMENT', `Passphrase must be at least ${DbToolService.PASSPHRASE_MIN} characters long`);
        }
        const bundle = this.store.connections.exportBundle();
        const json = encryptPayload(bundle, pp);
        this.audit('', '', 'export_connections', `export ${bundle.connections.length} connection(s)`, 'none', false, true);
        return json;
    }
    /**
     * 从口令加密的 JSON 密文导入连接。口令错误或密文损坏统一报
     * INVALID_ARGUMENT(DECRYPT_FAIL_MESSAGE)（不区分原因，防口令探测）。
     */
    importConnections(encryptedJson, passphrase) {
        const enc = assertNonEmpty(encryptedJson, 'json');
        const pp = assertNonEmpty(passphrase, 'passphrase');
        if (pp.length < DbToolService.PASSPHRASE_MIN) {
            throw new DbToolError('INVALID_ARGUMENT', `Passphrase must be at least ${DbToolService.PASSPHRASE_MIN} characters long`);
        }
        let bundle;
        try {
            bundle = decryptPayload(enc, pp);
        }
        catch {
            // 口令错误/密文损坏/非合法 JSON 统一归一（decryptPayload 已统一文案，这里兜底）
            throw new DbToolError('INVALID_ARGUMENT', DECRYPT_FAIL_MESSAGE);
        }
        // 结构校验：必须是含 connections 数组的对象，且每个元素为带非空 string id/kind 的对象。
        // 畸形元素会让 importBundle 在 try 之外抛 TypeError（绕开统一文案），
        // 或以 undefined id 静默落库成 UI 删不掉的幽灵记录
        const conns = bundle?.connections;
        if (!bundle ||
            typeof bundle !== 'object' ||
            !Array.isArray(conns) ||
            conns.some((c) => c === null ||
                typeof c !== 'object' ||
                typeof c.id !== 'string' ||
                c.id === '' ||
                typeof c.kind !== 'string' ||
                c.kind === '')) {
            throw new DbToolError('INVALID_ARGUMENT', DECRYPT_FAIL_MESSAGE);
        }
        const summary = this.store.connections.importBundle(bundle);
        this.audit('', '', 'import_connections', `imported ${summary.imported} connection(s), skipped ${summary.skipped.length}, failed ${summary.errors.length}`, 'none', false, true);
        return summary;
    }
    /* -- 授权管理 -- */
    /** 项目路径归一化（/api/project-context 无会话解析器时的回退路径） */
    projectKey(projectPath) {
        return normalizeProjectKey(projectPath);
    }
    grantsFor(projectPath) {
        return this.store.grants.grantsFor(normalizeProjectKey(projectPath));
    }
    /**
     * 授权/改授权。databases 为 undefined 表示保持既有库白名单不变，
     * 数组表示覆盖（空数组 = 解除库限制 → 全部库）。
     */
    grant(projectPath, connId, mode, databases) {
        const key = normalizeProjectKey(projectPath);
        this.store.grants.grant(key, connId, mode, databases);
        // 授权模式变更（含 rw→ro 降级）必须作废旧会话适配器，否则降级不生效；
        // 控制台事务会话的粘性适配器不在缓存里，单独回收（回滚未提交事务并 close）
        void this.dropAdapters(connId);
        void this.dropConsoleSessions(connId);
        const dbPart = databases && databases.length > 0 ? ` dbs=${databases.join(',')}` : '';
        this.audit(key, connId, 'grant', `${connId} -> ${mode}${dbPart}`, 'none', false, true);
    }
    revokeGrant(projectPath, connId) {
        const key = normalizeProjectKey(projectPath);
        this.store.grants.revoke(key, connId);
        void this.dropAdapters(connId);
        void this.dropConsoleSessions(connId);
        this.cancelTransferTasksForConn(connId); // 撤销后任务立即止损（否则写端全速跑完，管理员无系统内手段）
        this.audit(key, connId, 'revoke', connId, 'none', false, true);
    }
    /* -- 浏览（ro 即可） -- */
    /**
     * 列出连接可见的库（按库白名单过滤）。
     * 不做「目标库」校验：清单本身没有目标库，过滤结果就是白名单的体现；
     * 若先按连接默认库判定，收窄到不含默认库时会连清单都打不开。
     */
    async databases(projectPath, connId) {
        const access = this.accessFor(projectPath, connId, false);
        const adapter = await this.adapterFor(connId, access.mode);
        try {
            const result = await adapter.listDatabases();
            this.audit(access.key, connId, 'databases', 'listDatabases', 'none', false, true);
            return filterDatabaseList(result, access.databases);
        }
        catch (e) {
            this.audit(access.key, connId, 'databases', 'listDatabases', 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /** 授权面板用：库清单不收窄（白名单的编辑入口，否则收窄后无法再放开） */
    async grantDatabases(projectPath, connId) {
        const access = this.accessFor(projectPath, connId, false);
        const adapter = await this.adapterFor(connId, access.mode);
        try {
            const result = await adapter.listDatabases();
            this.audit(access.key, connId, 'grant_databases', 'listDatabases', 'none', false, true);
            return result;
        }
        catch (e) {
            this.audit(access.key, connId, 'grant_databases', 'listDatabases', 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    async tables(projectPath, connId, database) {
        const { key, adapter } = await this.authorize(projectPath, connId, false, database);
        try {
            const result = await adapter.listTables(database);
            this.audit(key, connId, 'tables', database ?? 'default', 'none', false, true);
            return result;
        }
        catch (e) {
            this.audit(key, connId, 'tables', database ?? 'default', 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /**
     * 跨库表名模糊搜索（ro 即可）。优先用适配器原生实现（mysql 走 information_schema
     * 一条 LIKE）；未实现时回退「逐库 listTables + 内存过滤」（小并发防打满连接池），
     * 单库语义（sqlite/redis）只搜默认库。limit 钳制 1..200，默认 100。
     */
    async searchTables(projectPath, connId, keyword, database, limit) {
        const kw = assertNonEmpty(keyword, 'keyword').trim();
        const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
        const { key, adapter, databases: allowed } = await this.authorize(projectPath, connId, false, database);
        const auditStmt = `search "${kw.length > 100 ? kw.slice(0, 100) + '…' : kw}"${database ? ` @ ${database}` : ''}`;
        try {
            let hits;
            if (adapter.searchTables) {
                if (!database && allowed && allowed.length > 0) {
                    // 库白名单下不允许「不指定库」的全局搜索：逐授权库调用，避免泄漏未授权库的表
                    hits = [];
                    for (const db of allowed) {
                        if (hits.length >= cap)
                            break;
                        try {
                            hits = hits.concat(await adapter.searchTables(kw, db, cap));
                        }
                        catch {
                            continue; // 个别库不可读（权限/系统库）不拖垮整体搜索
                        }
                    }
                }
                else {
                    hits = await adapter.searchTables(kw, database, cap);
                }
            }
            else if (SEARCH_FALLBACK_KINDS.has(adapter.kind)) {
                // 回退仅对「listTables(database) 语义 = 库名」的 kind 安全：
                // pg/gaussdb 走原生 searchTables；redis listTables 忽略库名（逐库循环会重复返回同一批键）、
                // oracle/dmdb database 语义为 owner，跨库回退会错标来源——这些 kind 不支持回退，返回空。
                if (database) {
                    const list = await adapter.listTables(database);
                    hits = filterTables(list, kw, database);
                }
                else {
                    const dbs = filterDatabaseList(await adapter.listDatabases(), allowed);
                    hits = [];
                    for (let i = 0; i < dbs.length && hits.length < cap; i += 8) {
                        const batch = await Promise.all(dbs.slice(i, i + 8).map(async (db) => {
                            try {
                                return filterTables(await adapter.listTables(db), kw, db);
                            }
                            catch {
                                return []; // 个别库不可读（权限/系统库）不拖垮整体搜索
                            }
                        }));
                        hits = hits.concat(...batch);
                    }
                }
            }
            else {
                hits = [];
            }
            this.audit(key, connId, 'search_tables', auditStmt, 'none', false, true, undefined, hits.length);
            return hits.slice(0, cap);
        }
        catch (e) {
            this.audit(key, connId, 'search_tables', auditStmt, 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /** 库内 schema 清单（仅 PG/GaussDB 等三层语义适配器实现；ro 即可）。 */
    async schemas(projectPath, connId, database) {
        const { key, adapter } = await this.authorize(projectPath, connId, false, database);
        if (!adapter.listSchemas)
            return [];
        try {
            const result = await adapter.listSchemas(database);
            this.audit(key, connId, 'schemas', database ?? 'default', 'none', false, true);
            return result;
        }
        catch (e) {
            this.audit(key, connId, 'schemas', database ?? 'default', 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    async schema(projectPath, connId, table, database) {
        const t = assertNonEmpty(table, 'table');
        const { key, adapter } = await this.authorize(projectPath, connId, false, database);
        try {
            const result = await adapter.describeTable(t, database);
            this.audit(key, connId, 'schema', t, 'none', false, true);
            return result;
        }
        catch (e) {
            this.audit(key, connId, 'schema', t, 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    async preview(projectPath, connId, table, limit, database, offset) {
        const t = assertNonEmpty(table, 'table');
        const capped = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
        const off = Math.max(0, Math.floor(Number(offset) || 0));
        const { key, adapter } = await this.authorize(projectPath, connId, false, database);
        try {
            const result = await adapter.previewRows(t, capped, database, off);
            this.audit(key, connId, 'preview', `PREVIEW ${t} LIMIT ${capped} OFFSET ${off}`, 'none', false, true, undefined, result.rowCount);
            return result;
        }
        catch (e) {
            this.audit(key, connId, 'preview', `PREVIEW ${t} LIMIT ${capped} OFFSET ${off}`, 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /* -- SQL 控制台（guard + challenge） -- */
    async query(projectPath, connId, sql, params, challengeId, database) {
        const statement = assertNonEmpty(sql, 'sql');
        return this.runGuarded({
            projectPath,
            connId,
            op: 'query',
            statement,
            challengeId,
            database,
            run: (adapter) => adapter.query(statement, params, database),
            rowsAffected: (r) => r.rowCount,
        });
    }
    async execute(projectPath, connId, statement, params, challengeId, database) {
        const stmt = assertNonEmpty(statement, 'statement');
        return this.runGuarded({
            projectPath,
            connId,
            op: 'execute',
            statement: stmt,
            challengeId,
            database,
            run: (adapter) => adapter.execute(stmt, params, database),
            rowsAffected: (r) => r.affectedRows,
        });
    }
    /**
     * run_script：子进程隔离执行（lib/script/worker.cjs + permission model + 新 vm realm）。
     *  - 会话专用适配器（不走缓存，超时即 close 中断在途调用，不污染共享缓存）；
     *  - db 句柄经 IPC 回父进程，走完整 guard/challenge/审计链路；
     *  - 脚本内 NEEDS_CONFIRMATION 以 DbToolError 形式抛出（message 为 JSON），
     *    由入口层还原为 NEEDS_CONFIRMATION 响应；
     *  - 审计后置：仅在拿到真实执行结果（成功/失败）后落盘。
     */
    async runScript(projectPath, connId, code, challengeId) {
        const src = assertNonEmpty(code, 'code');
        // authorize(needWrite=true) 已拒绝 ro 授权；脚本内写句柄再经 runGuarded 双重校验
        const { key, mode } = await this.authorize(projectPath, connId, true);
        // 会话专用适配器：独立于缓存实例，脚本超时可立即 close（中断在途查询）
        const rc = this.requireConn(connId);
        const factory = await this.resolver(rc.meta.kind);
        const sessionAdapter = await factory(rc, { mode }).catch((e) => {
            throw e instanceof DbToolError ? e : this.toDriverError(e);
        });
        const auditStmt = src.length > 200 ? src.slice(0, 200) + '…' : src;
        try {
            const result = await runScriptInChild({
                code: src,
                dbQuery: async (sql, params, database) => this.unwrapForScript(await this.query(key, connId, sql, params, challengeId, database)),
                dbExecute: async (statement, params, database) => this.unwrapForScript(await this.execute(key, connId, statement, params, challengeId, database)),
                onLog: (level, text) => level === 'error' ? console.error('[db-script]', text) : console.log('[db-script]', text),
                onTimeout: () => {
                    void sessionAdapter.close().catch(() => { });
                },
            });
            this.audit(key, connId, 'script', auditStmt, 'none', false, true);
            return result;
        }
        catch (e) {
            if (!(e instanceof DbToolError && e.code === 'NEEDS_CONFIRMATION')) {
                this.audit(key, connId, 'script', auditStmt, 'none', false, false, this.errText(e));
            }
            if (e instanceof DbToolError)
                throw e;
            throw this.toDriverError(e);
        }
        finally {
            await sessionAdapter.close().catch(() => { });
        }
    }
    /* -- 控制台事务会话（粘性连接；语义对齐 runGuarded） -- */
    /**
     * 开始控制台事务：authorize(needWrite=true)（ro 直接 READ_ONLY 拒）→ 创建会话专用
     * 适配器并打开粘性事务通道 → 返回 sessionToken。database 入参显式拒绝：粘性事务
     * 绑定连接默认库、无法跨库，客户端切了非默认库时静默跑错库比报错更危险。
     */
    async consoleBegin(projectPath, connId, database) {
        if (database !== undefined) {
            throw new DbToolError('INVALID_ARGUMENT', 'A transaction session cannot target a specific database (the sticky transaction is bound to the default database of the connection); clear the database selection before starting a transaction');
        }
        // authorize(needWrite=true) 已拒绝 ro 授权（与 runScript 同构；顺带建立缓存适配器）
        const { key, mode } = await this.authorize(projectPath, connId, true);
        const rc = this.requireConn(connId);
        // 每会话独占一个驱动池 + checkout 连接，放任创建会耗尽数据库连接（ponytail: 固定上限，不做 LRU）
        const live = [...this.consoleSessions.values()].filter((s) => s.connId === connId).length;
        if (live >= MAX_CONSOLE_SESSIONS_PER_CONN) {
            throw new DbToolError('INVALID_ARGUMENT', `Concurrent transaction sessions for this connection reached the limit (${MAX_CONSOLE_SESSIONS_PER_CONN}); commit or roll back an existing transaction first`);
        }
        const factory = await this.resolver(rc.meta.kind);
        const sessionAdapter = await factory(rc, { mode }).catch((e) => {
            throw e instanceof DbToolError ? e : this.toDriverError(e);
        });
        try {
            const session = await this.openConsoleSession(key, connId, sessionAdapter);
            try {
                // 注册前复核授权：authorize → 注册之间有多次 await，窗口内 revoke/降级触发的
                // dropConsoleSessions 扫不到本会话（TOCTOU）；授权已变更则回滚并经外层审计后抛
                this.recheckConsoleAuth(session);
            }
            catch (e) {
                await session.finish('rollback').catch(() => { });
                throw e;
            }
            this.consoleSessions.set(session.token, session);
            this.audit(key, connId, 'console_begin', 'BEGIN', 'none', false, true);
            return { sessionToken: session.token };
        }
        catch (e) {
            await sessionAdapter.close().catch(() => { });
            this.audit(key, connId, 'console_begin', 'BEGIN', 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /**
     * 会话内执行一条语句：语义等同 execute——classifyStatement + challenge + 审计，
     * 在粘性通道串行执行。读语句走适配器 query 通道保留结果集（事务内 SELECT 看
     * 未提交数据是核心场景）；写/管理语句走 execute 通道。
     */
    async consoleExec(sessionToken, statement, params, challengeId) {
        const stmt = assertNonEmpty(statement, 'statement');
        if (params !== undefined && !Array.isArray(params)) {
            throw new DbToolError('INVALID_ARGUMENT', 'params must be an array (bound parameters)');
        }
        const s = this.requireConsoleSession(sessionToken);
        s.lastAccess = Date.now();
        // 授权复核：会话适配器不在 adapterCache，dropAdapters 管不到——revoke/rw→ro 降级必须即时生效
        this.recheckConsoleAuth(s);
        const kind = s.adapter.kind;
        const verdict = classifyStatement(kind, stmt, 'execute');
        if (verdict.level === 'danger') {
            const scope = { connId: s.connId, projectKey: s.projectKey };
            if (!challengeId) {
                const { id: cid } = this.challenges.create(stmt, scope);
                this.audit(s.projectKey, s.connId, 'console_exec', stmt, 'danger', false, false, 'NEEDS_CONFIRMATION');
                return { needConfirmation: true, challengeId: cid, statement: stmt, danger: 'danger', reason: verdict.reason ?? 'Dangerous operation; user confirmation required' };
            }
            if (!this.challenges.consume(challengeId, stmt, scope)) {
                this.audit(s.projectKey, s.connId, 'console_exec', stmt, 'danger', false, false, 'INVALID_CHALLENGE');
                throw new DbToolError('INVALID_CHALLENGE', 'Confirmation token is invalid (missing, already used, expired, or the statement changed); start over');
            }
        }
        try {
            const result = await s.run(stmt, params);
            this.audit(s.projectKey, s.connId, 'console_exec', stmt, verdict.level, verdict.level === 'danger', true, undefined, 'rowCount' in result ? result.rowCount : result.affectedRows);
            return result;
        }
        catch (e) {
            this.audit(s.projectKey, s.connId, 'console_exec', stmt, verdict.level, verdict.level === 'danger', false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /** 粘性连接提交 → 销毁会话并 close 适配器（对应官方 finally release 语义）；审计照落 */
    consoleCommit(sessionToken) {
        return this.consoleTeardown(sessionToken, 'commit');
    }
    /** 粘性连接回滚 → 销毁会话并 close 适配器；审计照落 */
    consoleRollback(sessionToken) {
        return this.consoleTeardown(sessionToken, 'rollback');
    }
    /** commit/rollback 共用结算：授权复核 → 摘除会话 → finish → 审计（verb 参数化，两路镜像合一） */
    async consoleTeardown(sessionToken, how) {
        const s = this.requireConsoleSession(sessionToken);
        s.lastAccess = Date.now();
        this.recheckConsoleAuth(s);
        this.consoleSessions.delete(sessionToken); // 先摘除防并发重入；成败都销毁
        const action = how === 'commit' ? 'console_commit' : 'console_rollback';
        const verb = how.toUpperCase();
        try {
            await s.finish(how);
            this.audit(s.projectKey, s.connId, action, verb, 'none', false, true);
            return { message: how === 'commit' ? 'Transaction committed' : 'Transaction rolled back' };
        }
        catch (e) {
            this.audit(s.projectKey, s.connId, action, verb, 'none', false, false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /* -- 审计与状态 -- */
    auditTail(projectPath, limit) {
        const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
        if (!projectPath || projectPath.trim() === '')
            return this.store.audit.tail(n);
        const key = normalizeProjectKey(projectPath);
        return this.store.audit.tail(n).filter((e) => e.projectPathKey === key);
    }
    state(projectPath) {
        const grants = projectPath && projectPath.trim() !== '' ? this.grantsFor(projectPath) : [];
        return {
            connections: this.listConnections(),
            grants,
            auditTail: this.auditTail(projectPath, 50),
        };
    }
    /** 关闭缓存的适配器、回收控制台事务会话并停止 challenge/TTL 清理 */
    async dispose() {
        this.disposed = true;
        this.challenges.dispose();
        if (this.consoleSweepTimer) {
            clearInterval(this.consoleSweepTimer);
            this.consoleSweepTimer = undefined;
        }
        const sessions = [...this.consoleSessions.values()];
        this.consoleSessions.clear();
        for (const s of sessions) {
            try {
                await s.finish('rollback'); // 服务关闭：未提交事务一律回滚，不留悬挂连接
            }
            catch {
                // 已断开等场景忽略
            }
        }
        const pending = [...this.adapterCache.values()];
        this.adapterCache.clear();
        for (const p of pending) {
            try {
                const a = await p;
                await a.close().catch(() => { });
            }
            catch {
                // 缓存里的加载失败项直接忽略
            }
        }
    }
    /* ---------------- 内部 ---------------- */
    requireConn(connId) {
        try {
            return this.store.connections.testTarget(connId);
        }
        catch {
            throw new DbToolError('NOT_FOUND', `Connection not found: ${connId}`);
        }
    }
    /**
     * 授权基础校验（项目密钥 + 授权存在 + 写权限），不取适配器、不判库白名单。
     * 供「列出库清单」这类没有具体目标库的入口复用：库清单本身要用来编辑白名单，
     * 若先按默认库判白名单，收窄后连清单都打不开（无法再放开）。
     */
    accessFor(projectPath, connId, needWrite) {
        if (this.disposed)
            throw new DbToolError('INVALID_ARGUMENT', 'Service is shut down');
        if (!projectPath || projectPath.trim() === '') {
            throw new DbToolError('UNAUTHORIZED_PROJECT', 'Project path is empty: fill in the current project path at the top of the panel (or reopen the sidebar so the plugin resolves it automatically) before browsing or querying data');
        }
        const key = normalizeProjectKey(projectPath);
        const grant = this.store.grants.resolve(key, connId);
        if (!grant)
            throw new DbToolError('UNAUTHORIZED_PROJECT', `Project is not granted this connection: ${connId} (open the "Project grants" panel, tick ro/rw for this connection, then retry)`);
        if (needWrite && grant.mode === 'ro') {
            throw new DbToolError('READ_ONLY', 'This connection is read-only (ro) for the current project; write operations are refused');
        }
        return { key, mode: grant.mode, databases: grant.databases };
    }
    /** 授权校验（模式 + 可选库白名单）+ 取（缓存的）适配器 */
    async authorize(projectPath, connId, needWrite, database) {
        const access = this.accessFor(projectPath, connId, needWrite);
        // 库白名单判定放在 ro 判定之后：只读连接上的写操作仍以 READ_ONLY 优先报出
        this.assertDatabaseAllowed(access.databases, connId, database);
        const adapter = await this.adapterFor(connId, access.mode);
        return { key: access.key, mode: access.mode, adapter, databases: access.databases };
    }
    /**
     * 目标库名解析：显式入参 > 连接保存的默认库；"db.schema" 形式取点前一段。
     * 单文件语义（sqlite）与无法判定时返回 undefined（白名单不生效）。
     */
    targetDatabaseName(connId, database) {
        const rc = this.requireConn(connId);
        if (rc.meta.kind === 'sqlite')
            return undefined;
        const explicit = typeof database === 'string' ? database.trim() : '';
        if (explicit)
            return explicit.split('.')[0]?.trim() || undefined;
        const def = typeof rc.meta.database === 'string' ? rc.meta.database.trim() : '';
        return def === '' ? undefined : def;
    }
    /** 库白名单校验：清单为空 = 不限；目标库不可判定时放行 */
    assertDatabaseAllowed(allowed, connId, database) {
        if (!allowed || allowed.length === 0)
            return;
        const target = this.targetDatabaseName(connId, database);
        if (!target)
            return;
        if (allowed.some((db) => db.toLowerCase() === target.toLowerCase()))
            return;
        throw new DbToolError('DATABASE_NOT_GRANTED', `Database ${target} is not granted for connection ${connId} (databases allowed for this project: ${allowed.join(', ')})`);
    }
    /** 授权 + 库白名单校验（不取适配器的入口用，如数据传输两端） */
    assertGrantDatabase(projectPath, connId, database) {
        const key = normalizeProjectKey(projectPath ?? '');
        const grant = this.store.grants.resolve(key, connId);
        if (!grant)
            throw new DbToolError('UNAUTHORIZED_PROJECT', `Project is not granted this connection: ${connId}`);
        this.assertDatabaseAllowed(grant.databases, connId, database);
    }
    /** 关闭指定连接的全部缓存适配器（mode 变更/凭证变更/删除时） */
    async dropAdapters(connId) {
        const keys = [...this.adapterCache.keys()].filter((k) => k.startsWith(`${connId}@mode=`));
        for (const k of keys) {
            const p = this.adapterCache.get(k);
            this.adapterCache.delete(k);
            if (!p)
                continue;
            try {
                const a = await p;
                await a.close().catch(() => { });
            }
            catch {
                // 加载失败或已断开的旧实例直接忽略
            }
        }
    }
    /* -- 控制台事务会话内部 -- */
    requireConsoleSession(token) {
        const s = this.consoleSessions.get(token);
        if (!s)
            throw new DbToolError('NOT_FOUND', 'Transaction session not found (already committed/rolled back, or reclaimed after idle timeout)');
        return s;
    }
    /** 会话存活期间的授权复核（语义与 authorize 一致，但不取适配器） */
    recheckConsoleAuth(s) {
        const mode = this.store.grants.check(s.projectKey, s.connId);
        if (!mode)
            throw new DbToolError('UNAUTHORIZED_PROJECT', `Project is not granted this connection: ${s.connId}`);
        if (mode === 'ro')
            throw new DbToolError('READ_ONLY', 'This connection is read-only (ro) for the current project; write operations are refused');
    }
    /**
     * 打开粘性事务通道。按适配器 tx 可选成员的两种运行时形态分派
     * （见 ConsoleTxSession 注释）。不支持事务的 kind（无 tx）报 INVALID_ARGUMENT。
     */
    async openConsoleSession(key, connId, adapter) {
        const token = 't_' + randomBytes(12).toString('hex');
        const tx = adapter.tx;
        if (!tx) {
            throw new DbToolError('INVALID_ARGUMENT', `Connection kind ${adapter.kind} does not support console transaction sessions`);
        }
        const chain = { p: Promise.resolve() };
        // 结算标志：commit/rollback/sweep/drop/dispose 并发到达时首个 finisher 生效，后续 no-op
        // （finish 一律经 enqueue 排到链尾，等在途语句完成再提交/回滚，避免 exec 跑在事务外）
        let settled = false;
        const lastAccess = Date.now();
        if (typeof tx === 'function') {
            // —— tx(fn) 形态（oracle/dmdb）：挂起 fn 模式。fn 第一段同步登记 exec 通道并
            //    触发 ready；commit 以 resolve 结束 fn、rollback 以 reject 结束 fn，提交/
            //    回滚与异常回滚由适配器 tx 原子实现完成。opened 已把 reject 归一为
            //    { txError }（rollback 属正常路径，不算失败）。exec 通道按语句头返回
            //    双形状（读语句 QueryResult / 其余 ExecResult，分流在适配器内完成）；
            //    契约侧（types.ts）exec 返回 unknown，落地形状在 run 处收窄断言。
            let channel = null;
            let settle;
            const done = new Promise((resolve, reject) => {
                settle = { resolve, reject };
            });
            let ready;
            const readyP = new Promise((r) => {
                ready = r;
            });
            const opened = tx(async (exec) => {
                channel = exec;
                ready();
                await done;
                return null;
            })
                .then(() => ({}), (e) => ({ txError: e }));
            // begin 等待：fn 被调用（通道就绪）或 tx 开启失败（getConnection/SET TRANSACTION 失败）
            const outcome = await Promise.race([
                readyP.then(() => ({ ok: true })),
                opened.then((v) => ({ ok: false, err: v.txError })),
            ]);
            if (!outcome.ok)
                throw this.toDriverError(outcome.err);
            return {
                token,
                projectKey: key,
                connId,
                adapter,
                lastAccess,
                run: (stmt, params) => enqueue(chain, async () => {
                    if (!channel)
                        throw new DbToolError('DRIVER_ERROR', 'Transaction channel is closed');
                    return (await channel(stmt, params));
                }),
                finish: (how) => {
                    // 首个 finisher 生效；任务排到链尾等在途语句完成后才提交/回滚
                    if (settled)
                        return Promise.resolve();
                    settled = true;
                    return enqueue(chain, async () => {
                        try {
                            if (how === 'commit') {
                                settle.resolve();
                                const v = await opened;
                                // commit 路径的 txError 是真实提交失败，必须上抛供审计
                                if (v.txError !== undefined)
                                    throw v.txError;
                            }
                            else {
                                // rollback 以 reject 结束 fn：tx 原子实现执行 ROLLBACK 并吞掉回滚自身的
                                // 次生错误（适配器语义），占位 reject 原因不是真实故障，不上抛
                                settle.reject(new Error('Console transaction rolled back'));
                                await opened;
                            }
                        }
                        finally {
                            await adapter.close().catch(() => { });
                        }
                    });
                },
            };
        }
        // —— TxHandle 形态（mysql/pg 系）：begin 即 checkout 粘性连接并执行 BEGIN；
        //    之后适配器把 query/execute 路由到同一连接，exec 直接透传即可。
        await tx.begin();
        return {
            token,
            projectKey: key,
            connId,
            adapter,
            lastAccess,
            run: (stmt, params) => enqueue(chain, () => SQL_READ_HEADS.has(sqlHead(stmt)) ? adapter.query(stmt, params) : adapter.execute(stmt, params)),
            finish: (how) => {
                // 首个 finisher 生效；任务排到链尾等在途语句完成后才提交/回滚
                if (settled)
                    return Promise.resolve();
                settled = true;
                return enqueue(chain, async () => {
                    try {
                        if (how === 'commit')
                            await tx.commit();
                        else
                            await tx.rollback();
                    }
                    finally {
                        await adapter.close().catch(() => { });
                    }
                });
            },
        };
    }
    /** 空闲 TTL 扫描：超时会话强制回滚（close 适配器）并审计一条超时回滚 */
    consoleSweep() {
        const now = Date.now();
        for (const [token, s] of this.consoleSessions) {
            if (now - s.lastAccess <= this.consoleTtlMs)
                continue;
            this.consoleSessions.delete(token);
            void s
                .finish('rollback')
                // 回收原因放 statement 说明槽：ok:true 的记录不得带 error 槽（矛盾审计）
                .then(() => this.audit(s.projectKey, s.connId, 'console_rollback', 'ROLLBACK (auto-reclaimed after idle timeout)', 'none', false, true))
                .catch((e) => this.audit(s.projectKey, s.connId, 'console_rollback', 'ROLLBACK', 'none', false, false, `Idle-timeout auto-rollback failed: ${this.errText(e)}`));
        }
    }
    /** 授权变更时回收指定连接的全部控制台事务会话（回滚并 close，不审计——非业务事件） */
    async dropConsoleSessions(connId) {
        for (const [token, s] of this.consoleSessions) {
            if (s.connId !== connId)
                continue;
            this.consoleSessions.delete(token);
            try {
                await s.finish('rollback');
            }
            catch {
                // 已断开等场景忽略
            }
        }
    }
    /* -- 数据传输（并行任务） -- */
    /**
     * 读取项目级传输页配置。连接 id 是弱引用：删除连接、撤销授权或目标授权降级为 ro 后，
     * 对应字段就地回退为空，其余选项原样保留。源端 ro 即可，目标端必须 rw（对齐 transferStart）。
     */
    transferConfigGet(projectPath) {
        if (!projectPath || projectPath.trim() === '')
            return { ...DEFAULT_TRANSFER_CONFIG };
        const key = normalizeProjectKey(projectPath);
        const cfg = this.store.transferConfig.get(key);
        const alive = (id, needWrite) => {
            if (!id)
                return true;
            if (!this.store.connections.get(id))
                return false;
            const mode = this.store.grants.check(key, id);
            return needWrite ? mode === 'rw' : mode !== undefined;
        };
        return {
            ...cfg,
            sourceConnId: alive(cfg.sourceConnId, false) ? cfg.sourceConnId : '',
            targetConnId: alive(cfg.targetConnId, true) ? cfg.targetConnId : '',
        };
    }
    transferConfigSet(projectPath, input) {
        const key = assertNonEmpty(projectPath, 'projectPath');
        this.store.transferConfig.set(key, normalizeTransferConfig(input));
        return { saved: true };
    }
    /** 运行中的传输任务（taskId → 条目）；终态后保留一个轮询窗口再清除（见 finished 回调） */
    transferTasks = new Map();
    async transferStart(projectPath, input, challengeId) {
        const tables = input.tables;
        if (!Array.isArray(tables) || tables.length === 0) {
            throw new DbToolError('INVALID_ARGUMENT', 'tables must be a non-empty array of strings');
        }
        // 编排层按表名反查进度条目：重复名会让两遍传输共享同一进度对象且第二条永久 pending
        if (new Set(tables).size !== tables.length) {
            throw new DbToolError('INVALID_ARGUMENT', 'tables contains duplicate table names; deduplicate and retry');
        }
        if (tables.length > MAX_TRANSFER_TABLES) {
            throw new DbToolError('INVALID_ARGUMENT', `Table count per task exceeds the limit (${tables.length} > ${MAX_TRANSFER_TABLES}); split the transfer into batches`);
        }
        const writeMode = input.writeMode ?? 'insert';
        if (writeMode !== 'insert' && writeMode !== 'ignore' && writeMode !== 'replace' && writeMode !== 'truncate') {
            throw new DbToolError('INVALID_ARGUMENT', `Invalid writeMode: ${String(writeMode)} (insert/ignore/replace/truncate)`);
        }
        // 源连接只读授权即可（传输读端自建专用连接）；目标连接需写
        const { key: srcKey } = await this.authorize(projectPath, input.sourceConnId, false);
        const { key: dstKey } = await this.authorize(projectPath, input.targetConnId, true);
        const source = this.requireConn(input.sourceConnId);
        const target = this.requireConn(input.targetConnId);
        // 定位：optStr 语义（存在则 trim 非空才收，否则忽略）；缺省 = 连接默认上下文
        const optLoc = (v) => {
            const s = typeof v === 'string' ? v.trim() : '';
            return s !== '' ? s : undefined;
        };
        const srcDb = optLoc(input.sourceDatabase);
        const srcSchema = optLoc(input.sourceSchema);
        const dstDb = optLoc(input.targetDatabase);
        const dstSchema = optLoc(input.targetSchema);
        // 库白名单：两端分别校验（源读侧、目标写侧各自受本项目授权约束）
        this.assertGrantDatabase(projectPath, input.sourceConnId, srcDb);
        this.assertGrantDatabase(projectPath, input.targetConnId, dstDb);
        // 定位进 statement（start/finish/cancel 三链审计与 challenge 绑定共用一条），
        // 首次生成与带 challengeId 重放同 input 必同值；schema 附着于库（前端联动恒先选库）
        const locSeg = (db, schema) => db ? (schema ? `${db}.${schema}` : db) : '';
        const locPart = [
            srcDb ? ` source=${locSeg(srcDb, srcSchema)}` : '',
            dstDb ? ` target=${locSeg(dstDb, dstSchema)}` : '',
        ].join('');
        const statement = `Data transfer ${source.meta.kind}(${source.meta.id}) → ${target.meta.kind}(${target.meta.id}) tables[${tables.join(', ')}] mode=${writeMode}${locPart}`;
        // 危险操作确认（批量建表+写入，对齐 runGuarded 的 danger 分支语义）
        const scope = { connId: input.targetConnId, projectKey: dstKey };
        if (!challengeId) {
            const { id: cid } = this.challenges.create(statement, scope);
            this.audit(dstKey, input.targetConnId, 'transfer', statement, 'danger', false, false, 'NEEDS_CONFIRMATION');
            return {
                needConfirmation: true,
                challengeId: cid,
                statement,
                danger: 'danger',
                reason: writeMode === 'truncate'
                    ? `[DANGER] This clears all existing data of ${tables.length} table(s) in target ${target.meta.kind}(${target.meta.id}) and rewrites them; clearing cannot be undone, confirmation required`
                    : `This creates tables in target ${target.meta.kind}(${target.meta.id}) and bulk-writes ${tables.length} table(s); confirmation required`,
            };
        }
        if (!this.challenges.consume(challengeId, statement, scope)) {
            this.audit(dstKey, input.targetConnId, 'transfer', statement, 'danger', false, false, 'INVALID_CHALLENGE');
            throw new DbToolError('INVALID_CHALLENGE', 'Confirmation token is invalid (missing, already used, expired, or the statement changed); start over');
        }
        // —— 同步段：预算检查 + 注册之间零 await，杜绝并发 start 双过检查（TOCTOU）——
        this.sweepTransferTasks();
        const running = [...this.transferTasks.values()].filter((e) => e.task.snapshot().status === 'running');
        if (running.length >= MAX_TRANSFER_TASKS) {
            throw new DbToolError('INVALID_ARGUMENT', `Global concurrent transfer task limit reached (${MAX_TRANSFER_TASKS}); wait for running tasks to finish`);
        }
        if (running.some((e) => e.targetConnId === input.targetConnId)) {
            throw new DbToolError('INVALID_ARGUMENT', 'A transfer task is already running against this target connection (concurrent writes to one target collide); wait for it or cancel it first');
        }
        const task = startTransferTask(source, target, {
            tables,
            writeMode,
            ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
            ...(input.tableConcurrency !== undefined ? { tableConcurrency: input.tableConcurrency } : {}),
            ...(input.shardConcurrency !== undefined ? { shardConcurrency: input.shardConcurrency } : {}),
            ...(input.overwriteStructure === true ? { overwriteStructure: true } : {}),
            ...(srcDb !== undefined || srcSchema !== undefined ? { sourceDatabase: srcDb, sourceSchema: srcSchema } : {}),
            ...(dstDb !== undefined || dstSchema !== undefined ? { targetDatabase: dstDb, targetSchema: dstSchema } : {}),
            // 传输日志：任务开始/表完成/进度节流/终态逐行落 <我的文档>/DSH/transfer-log.jsonl
            onLog: (ev) => {
                this.store.transferLog.append({
                    type: ev.type,
                    taskId: task.id,
                    projectPathKey: dstKey,
                    statement,
                    ...(ev.status !== undefined ? { status: ev.status } : {}),
                    ...(ev.table !== undefined ? { table: ev.table } : {}),
                    ...(ev.rows !== undefined ? { rows: ev.rows } : {}),
                    ...(ev.totalRows !== undefined ? { totalRows: ev.totalRows } : {}),
                    ...(ev.tables !== undefined ? { tables: ev.tables } : {}),
                    ...(ev.failures !== undefined ? { failures: ev.failures } : {}),
                });
            },
        });
        this.transferTasks.set(task.id, { task, sourceConnId: input.sourceConnId, targetConnId: input.targetConnId, projectKey: dstKey, statement });
        this.audit(dstKey, input.targetConnId, 'transfer', statement, 'danger', true, true);
        void task.finished.then((s) => {
            const failed = s.failures.length > 0;
            this.audit(dstKey, input.targetConnId, 'transfer_finish', statement, 'danger', true, !failed, failed ? `${s.failures.length} shard(s)/table(s) failed` : undefined);
            // 终态不无限滞留 Map：保留一个轮询窗口（前端 800ms 轮询 + 慢网络余量）供拉到
            // 终态快照，之后定时清除；start 时的 sweepTransferTasks 兜底清同一批条目
            setTimeout(() => {
                this.transferTasks.delete(task.id);
            }, TRANSFER_SNAPSHOT_TTL_MS);
        });
        return { taskId: task.id };
    }
    async transferProgress(projectPath, taskId) {
        const entry = this.transferTasks.get(taskId);
        if (!entry)
            throw new DbToolError('NOT_FOUND', `Transfer task not found or already finished: ${taskId}`);
        // 快照含表清单/行数/错误详情，非公开信息：与数据面接口一致要求项目授权，
        // 且必须与发起项目同 key（taskId 可枚举，不能凭 id 越项目读取）
        const { key } = await this.authorize(projectPath, entry.targetConnId, false);
        if (key !== entry.projectKey) {
            throw new DbToolError('UNAUTHORIZED_PROJECT', `Transfer task does not belong to this project: ${taskId}`);
        }
        return entry.task.snapshot();
    }
    async transferCancel(projectPath, taskId) {
        const entry = this.transferTasks.get(taskId);
        if (!entry)
            throw new DbToolError('NOT_FOUND', `Transfer task not found or already finished: ${taskId}`);
        // 取消需对目标连接有写授权（能发起即能取消，授权语义对齐）
        await this.authorize(projectPath, entry.targetConnId, true);
        entry.task.cancel();
        // 取消是影响目标库状态的操作：与 start/finish 同链审计（ok 以 cancelled 语义恒真）
        this.audit(entry.projectKey, entry.targetConnId, 'transfer_cancel', entry.statement, 'danger', true, true);
        return { cancelled: true };
    }
    /** 授权/连接变更时回收该连接参与的传输任务（对齐控制台会话的对称回收；cancel 为协作式，检查点退出） */
    cancelTransferTasksForConn(connId) {
        for (const entry of this.transferTasks.values()) {
            if (entry.sourceConnId === connId || entry.targetConnId === connId)
                entry.task.cancel();
        }
    }
    /** 传输历史：最近 n 条任务终态（可选按项目过滤）；对齐审计查询的公开语义 */
    transferHistory(projectPath, limit = 50) {
        const n = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
        return projectPath && projectPath.trim() !== ''
            ? this.store.transferLog.tail(n, normalizeProjectKey(projectPath), 'finish')
            : this.store.transferLog.tail(n, undefined, 'finish');
    }
    /** 实时进度：全部运行中任务的快照（可选按项目过滤），供「实时进度」子标签轮询 */
    transferLive(projectPath) {
        const key = projectPath && projectPath.trim() !== '' ? normalizeProjectKey(projectPath) : undefined;
        return [...this.transferTasks.entries()]
            .filter(([, e]) => e.task.snapshot().status === 'running' && (!key || e.projectKey === key))
            .map(([taskId, e]) => ({ taskId, snapshot: e.task.snapshot() }));
    }
    /** 传输日志：最近 n 条全事件行（start/表完成/进度/终态），供日志标签实时查看 */
    transferLogTail(projectPath, limit = 200) {
        const n = Math.min(Math.max(1, Math.floor(limit) || 200), 2000);
        return projectPath && projectPath.trim() !== ''
            ? this.store.transferLog.tail(n, normalizeProjectKey(projectPath))
            : this.store.transferLog.tail(n);
    }
    /** 清除传输历史：projectPath 给定时只清该项目（前端文案语义），缺省全清。留审计。 */
    transferHistoryClear(projectPath) {
        const key = projectPath && projectPath.trim() !== '' ? normalizeProjectKey(projectPath) : undefined;
        const removed = this.store.transferLog.clear(key);
        this.audit(key ?? '', '', 'transfer_history_clear', key !== undefined ? `clear transfer history of project: ${key}` : 'clear all transfer history', 'none', false, true);
        return { removed };
    }
    /** 清理终态任务（start 时调用；快照仅在 running 期间可查） */
    sweepTransferTasks() {
        for (const [id, entry] of this.transferTasks) {
            if (entry.task.snapshot().status !== 'running')
                this.transferTasks.delete(id);
        }
    }
    adapterFor(connId, mode) {
        const cacheKey = `${connId}@mode=${mode}`;
        let p = this.adapterCache.get(cacheKey);
        if (!p) {
            p = (async () => {
                const rc = this.requireConn(connId);
                const factory = await this.resolver(rc.meta.kind);
                return factory(rc, { mode });
            })().catch((e) => {
                this.adapterCache.delete(cacheKey);
                throw e instanceof DbToolError ? e : this.toDriverError(e);
            });
            this.adapterCache.set(cacheKey, p);
        }
        return p;
    }
    /** guard 主流程：分类 → challenge → 执行 → 审计 */
    async runGuarded(args) {
        const { projectPath, connId, op, statement, challengeId, database } = args;
        if (args.params !== undefined && !Array.isArray(args.params)) {
            throw new DbToolError('INVALID_ARGUMENT', 'params must be an array (bound parameters)');
        }
        const { key, adapter } = await this.authorize(projectPath, connId, op === 'execute', database);
        const kind = adapter.kind;
        const verdict = classifyStatement(kind, statement, op);
        if (verdict.level === 'danger') {
            const scope = { connId, projectKey: key };
            if (!challengeId) {
                const { id: cid } = this.challenges.create(statement, scope);
                this.audit(key, connId, op, statement, 'danger', false, false, 'NEEDS_CONFIRMATION');
                return { needConfirmation: true, challengeId: cid, statement, danger: 'danger', reason: verdict.reason ?? 'Dangerous operation; user confirmation required' };
            }
            if (!this.challenges.consume(challengeId, statement, scope)) {
                this.audit(key, connId, op, statement, 'danger', false, false, 'INVALID_CHALLENGE');
                throw new DbToolError('INVALID_CHALLENGE', 'Confirmation token is invalid (missing, already used, expired, or the statement changed); start over');
            }
        }
        try {
            const result = await args.run(adapter);
            this.audit(key, connId, op, statement, verdict.level, verdict.level === 'danger', true, undefined, args.rowsAffected?.(result));
            return result;
        }
        catch (e) {
            this.audit(key, connId, op, statement, verdict.level, verdict.level === 'danger', false, this.errText(e));
            throw this.toDriverError(e);
        }
    }
    /** 脚本内句柄：NeedConfirm 无法在脚本中交互，转为可还原的 DbToolError */
    unwrapForScript(r) {
        if (r && typeof r === 'object' && r.needConfirmation === true) {
            const nc = r;
            throw new DbToolError('NEEDS_CONFIRMATION', JSON.stringify(nc));
        }
        return r;
    }
    audit(projectPathKey, connId, action, statement, danger, confirmed, ok, error, rowsAffected) {
        try {
            this.store.audit.append({
                projectPathKey, connId, action, statement, danger, confirmed, ok,
                ...(error !== undefined ? { error } : {}),
                ...(rowsAffected !== undefined ? { rowsAffected } : {}),
            });
        }
        catch {
            // 审计失败不阻塞业务（best-effort）
        }
    }
    errText(e) {
        return e instanceof Error ? e.message : String(e);
    }
    toDriverError(e) {
        if (e instanceof DbToolError)
            return e;
        return new DbToolError('DRIVER_ERROR', this.errText(e));
    }
}
/** 表名/注释子串匹配（大小写不敏感，回退路径用；命中转 TableSearchHit） */
function filterTables(list, keyword, database) {
    const kw = keyword.toLowerCase();
    return list
        .filter((t) => t.name.toLowerCase().includes(kw) ||
        (t.comment !== undefined && t.comment.toLowerCase().includes(kw)))
        .map((t) => ({ database, name: t.name, type: t.type, comment: t.comment }));
}
/** 库白名单过滤（清单为空 = 不限；大小写不敏感） */
function filterDatabaseList(list, allowed) {
    if (!allowed || allowed.length === 0)
        return list;
    const set = new Set(allowed.map((db) => db.toLowerCase()));
    return list.filter((db) => set.has(db.toLowerCase()));
}
function pick(args, snake) {
    return args[snake] ?? (snake === 'conn_id' ? args.connId : args.challengeId);
}
/**
 * 工具 action 分发。危险待确认时文本内含确认指引，
 * 提示模型向用户 ask 确认后带 challenge_id 重试。
 * 返回 { text, isError } 对象：harness 工具契约要求结构化结果，
 * isError=true 仅用于被拒/失败；NEEDS_CONFIRMATION 不是失败。
 */
export async function handleToolAction(service, args, projectPath) {
    const action = args.action;
    const connId = pick(args, 'conn_id');
    const challengeId = pick(args, 'challenge_id');
    const j = (v) => JSON.stringify(v, null, 2);
    const ok = (t) => ({ text: t, isError: false });
    try {
        switch (action) {
            case 'list_connections':
                return ok(j(service.listConnections()));
            case 'query': {
                const r = await service.query(projectPath, requireConn(connId), assertArg(args.sql, 'sql'), args.params, challengeId, args.database);
                return ok(needConfirmText(r) ?? j(r));
            }
            case 'execute': {
                const r = await service.execute(projectPath, requireConn(connId), assertArg(args.statement ?? args.sql, 'statement'), args.params, challengeId, args.database);
                return ok(needConfirmText(r) ?? j(r));
            }
            case 'schema': {
                const conn = requireConn(connId);
                if (args.table)
                    return ok(j(await service.schema(projectPath, conn, args.table, args.database)));
                if (args.database)
                    return ok(j(await service.tables(projectPath, conn, args.database)));
                return ok(j(await service.databases(projectPath, conn)));
            }
            case 'preview': {
                const r = await service.preview(projectPath, requireConn(connId), assertArg(args.table, 'table'), args.limit, args.database, args.offset);
                return ok(j(r));
            }
            case 'run_script': {
                const r = await service.runScript(projectPath, requireConn(connId), assertArg(args.code, 'code'), challengeId);
                return ok(needConfirmText(r) ?? j(r));
            }
            default:
                throw new DbToolError('INVALID_ARGUMENT', `Unknown action: ${action} (available: list_connections/query/execute/schema/preview/run_script)`);
        }
    }
    catch (e) {
        const code = e instanceof DbToolError ? e.code : 'DRIVER_ERROR';
        return { text: j({ ok: false, error: e instanceof Error ? e.message : String(e), code }), isError: true };
    }
}
function requireConn(connId) {
    if (!connId || connId.trim() === '')
        throw new DbToolError('INVALID_ARGUMENT', 'Missing required parameter: conn_id');
    return connId;
}
function assertArg(v, label) {
    if (!v || v.trim() === '')
        throw new DbToolError('INVALID_ARGUMENT', `Missing required parameter: ${label}`);
    return v;
}
function needConfirmText(r) {
    if (!(r && typeof r === 'object' && r.needConfirmation === true))
        return null;
    const nc = r;
    return JSON.stringify({
        ok: false,
        code: 'NEEDS_CONFIRMATION',
        ...nc,
        hint: `Dangerous operation (${nc.reason}). Explain it to the user and get explicit consent first; after consent, retry the same statement with challenge_id=${nc.challengeId}. The challenge is single-use, valid for 5 minutes, and bound to this statement.`,
    }, null, 2);
}
