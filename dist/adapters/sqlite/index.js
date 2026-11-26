/**
 * SQLite 适配器（同步 API 包装 Promise）。
 * fields.database / fields.path 为文件路径；ro 模式 readonly 打开。
 *
 * 驱动双路径（离线环境友好）：
 *  1. node:sqlite（Node ≥ 22.5 内置，零原生依赖，离线/无编译工具链环境直接可用）
 *  2. better-sqlite3（optionalDependency；预构建缺失或本地编译失败时 pnpm 会
 *     自动排除该包，不影响插件整体安装，动态加载失败时回退到明确报错）
 */
import { basename } from 'node:path';
import { assertIdent, clampLimit, clampOffset, escapeLikePattern, humanize, normalizeCell, quoteIdent } from '../sql-shared/common.js';
import { bareLikeDialect, buildFilterWhereSql, parseBrowseFilters } from '../sql-shared/filters.js';
let cached = null;
let cachedFor = '';
/**
 * 惰性加载驱动（缓存结果）；失败时抛带指引的错误。
 * 可用 DBT_SQLITE_DRIVER=node|better 强制单一路径（不回退），便于测试与显式选型。
 */
async function loadDriver() {
    const forced = process.env.DBT_SQLITE_DRIVER;
    if (cached && cachedFor === forced)
        return cached;
    const result = await (async () => {
        // 1) node:sqlite：Node 22.5+ 内置（22.5–23.3 需 --experimental-sqlite）。
        if (forced !== 'better') {
            try {
                const mod = await import('node:sqlite');
                const ctor = mod.DatabaseSync;
                if (typeof ctor === 'function') {
                    return { ctor: ctor, driver: 'node:sqlite' };
                }
            }
            catch (e) {
                if (forced === 'node')
                    throw new Error(`Forcing node:sqlite failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        // 2) better-sqlite3（optionalDependency，可能被离线环境排除或构建失败）。
        if (forced !== 'node') {
            try {
                const mod = (await import('better-sqlite3'));
                if (mod && typeof mod.default === 'function') {
                    return { ctor: mod.default, driver: 'better-sqlite3' };
                }
            }
            catch (e) {
                if (forced === 'better')
                    throw new Error(`Forcing better-sqlite3 failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        throw new Error('SQLite driver unavailable: this Node has no built-in node:sqlite (requires Node ≥ 22.5), and the optional dependency better-sqlite3 is not installed or failed to build.' +
            'Upgrade Node to ≥ 22.5, or run `npm install better-sqlite3` in an environment with a build toolchain or prebuilt binaries;' +
            'the other 7 databases are unaffected.');
    })();
    cached = result;
    cachedFor = forced;
    return result;
}
function resolveFile(conn) {
    if (conn.fields) {
        const f = conn.fields;
        const path = f.database ?? f.path ?? f.file;
        if (path != null && String(path) !== '')
            return String(path);
    }
    if (conn.url) {
        return conn.url.startsWith('file://') ? conn.url.slice('file://'.length) : conn.url;
    }
    throw new Error('sqlite connection is missing the file path (fields.database / fields.path or url)');
}
/**
 * 打开原始数据库句柄（不包适配器规范化）。数据传输读写端用：
 * 必须绕过 normalizeCell（BLOB 截断 / bigint 降位）保真搬运原始值。
 */
export async function openRaw(conn, readOnly) {
    const file = resolveFile(conn);
    const { ctor, driver } = await loadDriver();
    try {
        // 选项名按驱动区分：node:sqlite 用 readOnly（打开不存在文件即报错；官方签名
        // new DatabaseSync(location[, options])，options 为可选参数，空对象与不传/undefined
        // 等价，open 默认 true —— https://nodejs.org/docs/latest-v24.x/api/sqlite.html）；
        // better-sqlite3 用 readonly + fileMustExist。rw 模式两驱动均传空对象。
        const db = driver === 'node:sqlite'
            ? new ctor(file, readOnly ? { readOnly: true } : {})
            : new ctor(file, readOnly ? { readonly: true, fileMustExist: true } : {});
        return { db, driver };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 只带文件名不带完整路径：错误会经驱动错误通道外发（传输失败快照等），避免内网路径泄露
        throw new Error(`sqlite open failed (${basename(file)}, driver ${driver}): ${msg}`);
    }
}
function toQueryResult(raw, columns) {
    return {
        columns,
        rows: raw.map((r) => columns.map((c) => normalizeCell(r[c]))),
        rowCount: raw.length,
    };
}
/**
 * 取 SELECT 列名。stmt.columns() 在 node:sqlite 需 Node ≥ 22.16.0（官方文档
 * "Added in: v22.16.0"，https://nodejs.org/docs/latest-v22.x/api/sqlite.html），
 * 而本适配器放行的最低版本是 22.5——22.13.0–22.15.x 上 columns 为 undefined，
 * 无条件调用即 TypeError（浏览主路径 query/previewRows 每次必崩）。旧版本回退
 * 到结果首行的 keys（对象字符串键保序 = SELECT 列序；纯数字列名会被当作整数
 * 索引键排前，属降级路径已知盲区）。空结果集无行可推，返回空列头。
 */
export function stmtColumns(stmt, raw) {
    if (typeof stmt.columns === 'function')
        return stmt.columns().map((c) => c.name);
    const first = raw[0];
    return first ? Object.keys(first) : [];
}
/** 内容搜索谓词（countRows/searchRows 共用）：全部列 CAST AS TEXT 后 LIKE。
 *  显式 ESCAPE '#'（SQLite LIKE 无默认转义符）；LIKE 对 ASCII 默认大小写不敏感。 */
export function sqliteSearchWhere(cols) {
    return '(' + cols.map((c) => `CAST(${quoteIdent(c)} AS TEXT) LIKE ? ESCAPE '#'`).join(' OR ') + ')';
}
/** 字段筛选方言（filterRows/countRows 共用）：CAST AS TEXT 文本化 + ? 占位 */
export const sqliteFilterDialect = bareLikeDialect((c) => quoteIdent(c), () => '?', (c) => `CAST(${c} AS TEXT)`);
export async function createSqliteAdapter(conn, opts) {
    const readOnly = opts?.mode === 'ro';
    const { db, driver } = await openRaw(conn, readOnly);
    /** close 幂等：node:sqlite 的 DatabaseSync.close() 二次调用抛 "database is not open"，
     *  而 manager 的 runScript 超时路径会对同一会话适配器重复 close
     *  （onTimeout 与 finally 各一次）——重复 close 必须为 no-op。 */
    let closed = false;
    /** 列名清单（内容搜索谓词用）：PRAGMA table_info 一次往返（describeTable 同源）。
     *  不走 stmtColumns——其旧 Node 降级路径对空结果集返回空列头，会误判「无列」。 */
    function sqliteColumnNames(table) {
        const raw = db
            .prepare(`PRAGMA table_info(${quoteIdent(assertIdent(table, 'table name'))})`)
            .all();
        return raw.map((r) => String(r.name));
    }
    return {
        kind: 'sqlite',
        connId: conn.meta.id,
        testConnect: () => humanize('sqlite connection test', async () => {
            const row = db.prepare('SELECT sqlite_version() AS v').get();
            return { ok: true, serverInfo: `SQLite ${String(row?.v ?? '')} (${driver})` };
        }),
        query: (sql, params) => humanize('sqlite query failed', async () => {
            const stmt = db.prepare(sql);
            const raw = stmt.all(...(params ?? []));
            return toQueryResult(raw, stmtColumns(stmt, raw));
        }),
        execute: (statement, params) => humanize('sqlite execute failed', async () => {
            const stmt = db.prepare(statement);
            const info = stmt.run(...(params ?? []));
            const n = Number(info.changes);
            return {
                affectedRows: Number.isFinite(n) ? n : undefined,
                message: `Execution succeeded, ${n} rows affected`,
            };
        }),
        listDatabases: () => humanize('sqlite list databases', async () => ['main']),
        listTables: () => humanize('sqlite list tables', async () => {
            const raw = db
                .prepare(`SELECT name, type FROM sqlite_master
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
                .all();
            return raw.map((r) => ({
                name: String(r.name),
                type: String(r.type).toUpperCase(),
            }));
        }),
        describeTable: (table) => humanize('sqlite describe table', async () => {
            const tbl = assertIdent(table, 'table name');
            const raw = db
                .prepare(`PRAGMA table_info(${quoteIdent(tbl)})`)
                .all();
            if (raw.length === 0)
                throw new Error(`Table does not exist: ${tbl}`);
            return raw.map((r) => {
                const dflt = r.dflt_value;
                const pk = Number(r.pk) > 0;
                return {
                    name: String(r.name),
                    dataType: String(r.type ?? ''),
                    // 主键按非空展示（SQLite INTEGER PRIMARY KEY 即便 notnull=0 也不可存 NULL）
                    nullable: Number(r.notnull) === 0 && !pk,
                    key: pk ? 'PRI' : undefined,
                    default: dflt == null ? null : String(dflt),
                };
            });
        }),
        previewRows: (table, limit, _database, offset) => humanize('sqlite preview rows', async () => {
            const tbl = quoteIdent(assertIdent(table, 'table name'));
            const lim = clampLimit(limit);
            const off = clampOffset(offset);
            const stmt = db.prepare(`SELECT * FROM ${tbl} LIMIT ? OFFSET ?`);
            const raw = stmt.all(lim, off);
            return toQueryResult(raw, stmtColumns(stmt, raw));
        }),
        countRows: (table, _database, search, filters, logic, logics) => humanize('sqlite count rows', async () => {
            const tbl = quoteIdent(assertIdent(table, 'table name'));
            let sql = `SELECT COUNT(*) AS n FROM ${tbl}`;
            let params = [];
            if (filters != null) {
                // 字段筛选计数：谓词与 filterRows 完全一致（parse 双保险，见 filters.ts）
                const conds = parseBrowseFilters(filters);
                if (conds.length === 0)
                    return 0;
                const built = buildFilterWhereSql(conds, logic ?? 'and', sqliteFilterDialect, logics);
                sql += ' WHERE ' + built.where;
                params = built.params;
            }
            else if (search != null && search !== '') {
                const cols = await sqliteColumnNames(table);
                if (cols.length === 0)
                    return 0; // 无列恒无匹配
                sql += ' WHERE ' + sqliteSearchWhere(cols);
                params = cols.map(() => '%' + escapeLikePattern(search) + '%');
            }
            const row = db.prepare(sql).get(...params);
            return row ? Number(row.n) : 0;
        }),
        searchRows: (table, keyword, limit, _database, offset) => humanize('sqlite content search', async () => {
            const tbl = quoteIdent(assertIdent(table, 'table name'));
            const lim = clampLimit(limit);
            const off = clampOffset(offset);
            const cols = await sqliteColumnNames(table);
            if (cols.length === 0)
                return { columns: [], rows: [], rowCount: 0 };
            const stmt = db.prepare(`SELECT * FROM ${tbl} WHERE ${sqliteSearchWhere(cols)} LIMIT ? OFFSET ?`);
            const raw = stmt.all(...cols.map(() => '%' + escapeLikePattern(keyword) + '%'), lim, off);
            return toQueryResult(raw, stmtColumns(stmt, raw));
        }),
        filterRows: (table, filters, logic, limit, _database, offset, logics) => humanize('sqlite filter rows', async () => {
            const tbl = quoteIdent(assertIdent(table, 'table name'));
            const lim = clampLimit(limit);
            const off = clampOffset(offset);
            const conds = parseBrowseFilters(filters);
            if (conds.length === 0)
                return { columns: [], rows: [], rowCount: 0 };
            const { where, params } = buildFilterWhereSql(conds, logic, sqliteFilterDialect, logics);
            const stmt = db.prepare(`SELECT * FROM ${tbl} WHERE ${where} LIMIT ? OFFSET ?`);
            const raw = stmt.all(...params, lim, off);
            return toQueryResult(raw, stmtColumns(stmt, raw));
        }),
        close: () => humanize('sqlite close connection', async () => {
            if (closed)
                return; // 幂等：重复 close 为 no-op（见 closed 声明处注释）
            closed = true;
            db.close();
        }),
    };
}
export const factory = (conn) => createSqliteAdapter(conn);
