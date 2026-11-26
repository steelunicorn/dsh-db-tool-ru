/**
 * MySQL 适配器（mysql2/promise）。
 * query=读用 pool.query()；execute=写用 pool.execute()（真 prepare，占位符 ?）。
 * DECIMAL 官方默认 string 保持；dateStrings:true 使 DATE/DATETIME 直接输出字符串。
 * ro 模式：multipleStatements 固定 false（防堆叠注入）；建连后会话级只读（SET SESSION
 * TRANSACTION READ ONLY）+ query 首词只读白名单双保险；服务层拦截 execute。
 */
import mysql from 'mysql2/promise';
import { assertIdent, clampLimit, clampOffset, escapeLikePattern, humanize, normalizeCell, quoteIdent, validPort } from '../sql-shared/common.js';
/** ro 模式下 query 允许的读语句首词白名单 */
const RO_READ_PREFIX = /^(select|show|desc|describe|explain|use|help|table)\b/i;
// 【历史教训，勿回退】'connection' 钩子里 SET 的失败处理只能走回调参数吞掉，
// 不得给返回的 Query 命令挂 error 监听防 uncaughtException——
// 该监听会打断池接管前的命令处理序列并使连接永久卡死（1.7.4 真机复现，见 ro 钩子处注释）。
function connOptions(conn) {
    const base = {
        waitForConnections: true,
        connectionLimit: 10,
        maxIdle: 10,
        idleTimeout: 60000,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        multipleStatements: false,
        dateStrings: true,
        connectTimeout: 10000,
        charset: 'utf8mb4_general_ci',
    };
    if (conn.url) {
        const u = new URL(conn.url);
        base.host = u.hostname;
        // 端口段校验：':0' 等非法值抛中文错误，不再被 Number()|| 静默改写 3306
        base.port = u.port ? validPort(u.port, 3306, 'mysql') : 3306;
        try {
            if (u.username)
                base.user = decodeURIComponent(u.username);
            if (u.password)
                base.password = decodeURIComponent(u.password);
        }
        catch {
            throw new Error('mysql connection URL has invalid percent-encoding in the username or password (e.g. an unencoded %); URL-encode it and retry');
        }
        const db = u.pathname.replace(/^\//, '');
        if (db)
            base.database = db;
        const ssl = u.searchParams.get('ssl');
        if (conn.ssl || ssl === 'true' || ssl === 'require')
            base.ssl = { rejectUnauthorized: false };
    }
    else if (conn.fields) {
        const f = conn.fields;
        base.host = String(f.host ?? '127.0.0.1');
        // 前端原样发字符串端口：显式校验，NaN/0 等不再被驱动 `|| 3306` 静默改写后连错服务
        base.port = validPort(f.port, 3306, 'mysql');
        base.user = String(f.user ?? f.username ?? 'root');
        if (f.password != null)
            base.password = String(f.password);
        if (f.database != null)
            base.database = String(f.database);
        if (conn.ssl)
            base.ssl = { rejectUnauthorized: false };
    }
    else {
        throw new Error('mysql connection is missing url or fields configuration');
    }
    return base;
}
export async function createMysqlAdapter(conn, opts) {
    const baseOpts = connOptions(conn);
    // 驱动注入与 sqlserver 对齐（opts?.driver ?? 真实模块）：让 ro 钩子这类
    // 「注册形态」契约能在离线测试里断言，不依赖真实 MySQL 实例。
    const Driver = opts?.driver ?? mysql;
    const pool = Driver.createPool(baseOpts);
    const readOnly = opts?.mode === 'ro';
    // 跨库（Navicat 式）：按库名缓存独立池。mysql2 官方多库方案即多池管理——池上
    // changeUser/USE 只影响被调用的那条池内连接，池保持建池配置，切库不可靠。
    const mainDb = typeof baseOpts.database === 'string' ? baseOpts.database : '';
    const dbPools = new Map();
    /**
     * 关闭幂等标志（对齐 pg-like/sqlserver）：关闭后一切访问必须被拦下——
     * 否则跨库访问会新建池（关不掉的连接泄漏），主池请求则报英文驱动错。
     */
    let closed = false;
    const assertOpen = () => {
        if (closed)
            throw new Error('mysql connection is closed: reconnect and retry');
    };
    /** ro 模式：每个新底层连接自动设为只读会话（应用层另有 query 白名单双保险）。
     *  mysql2 promise 池 'connection' 回调拿到的是 callback 版连接；SET 必须回调式执行，
     *  且绝不能对返回的 Query 命令对象挂 error 监听——swallowSetError 的 .on('error') 会
     *  打断池接管前的命令处理序列，连接状态机卡死，该连接后续一切查询永挂
     *  （真机复现：ro 模式列库/列表/预览全部永久 pending，即「表显示不出来」直接根因；
     *  非回调式与「回调式+error 监听」两种形态均挂，唯「回调式+空回调」正常）。
     *  主池与跨库池共用同一注册。 */
    const attachReadOnly = (p) => {
        if (!readOnly)
            return;
        p.on('connection', (c) => {
            c.query('SET SESSION TRANSACTION READ ONLY', () => { });
        });
    };
    attachReadOnly(pool);
    const poolFor = (db) => {
        assertOpen();
        if (db === mainDb)
            return pool;
        let p = dbPools.get(db);
        if (!p) {
            // connOptions 已把 URL/fields 拆成纯字段，覆盖 database 即建出目标库的池
            // （用注入的 Driver，保证离线测试能覆盖跨库池的 ro 钩子注册）
            p = Driver.createPool({ ...baseOpts, database: db });
            dbPools.set(db, p);
            attachReadOnly(p);
        }
        return p;
    };
    /** 事务激活期间路由到同一连接，保证 BEGIN/COMMIT 生效 */
    let txConn = null;
    // PoolConnection 与 Pool 的联合会让 mysql2 的 query/execute 重载解析失败，收窄为 Pool 视图
    const runner = () => (txConn ?? pool);
    function toQueryResult(rows, fields) {
        const columns = fields.map((f) => String(f.name));
        return {
            columns,
            rows: rows.map((r) => columns.map((c) => normalizeCell(r[c]))),
            rowCount: rows.length,
        };
    }
    /** LIKE 模式：通配符/转义符字面化（ESCAPE '#'）后 %…% 包裹（关键字本体走绑定） */
    const likePattern = (kw) => '%' + escapeLikePattern(kw) + '%';
    /** 跨列 LIKE 谓词（countRows/searchRows 共用）。显式 ESCAPE '#' 与其余方言统一；
     *  MySQL 默认 collation 大小写不敏感，跟随即可。 */
    const likeWhere = (cols) => '(' + cols.map((c) => `${quoteIdent(c, '`')} LIKE ? ESCAPE '#'`).join(' OR ') + ')';
    /** 列名清单（内容搜索谓词用）：`SELECT * … WHERE 1=0` 借 fields 元数据一次往返 */
    async function columnNames(target) {
        const [, fields] = await pool.query(`SELECT * FROM ${target} WHERE 1=0`);
        return (fields ?? []).map((f) => String(f.name));
    }
    const tx = {
        begin: () => humanize('mysql transaction begin', async () => {
            if (txConn)
                throw new Error('Transaction already open; do not call begin again');
            txConn = await pool.getConnection();
            try {
                await txConn.beginTransaction();
            }
            catch (e) {
                txConn.release();
                txConn = null;
                throw e;
            }
        }),
        commit: () => humanize('mysql transaction commit', async () => {
            const c = txConn;
            if (!c)
                throw new Error('No transaction in progress');
            txConn = null;
            try {
                await c.commit();
            }
            finally {
                c.release();
            }
        }),
        rollback: () => humanize('mysql transaction rollback', async () => {
            const c = txConn;
            if (!c)
                throw new Error('No transaction in progress');
            txConn = null;
            try {
                await c.rollback();
            }
            finally {
                c.release();
            }
        }),
    };
    const defaultDb = () => {
        let db = conn.fields?.database != null ? String(conn.fields.database) : '';
        if (!db && conn.url) {
            // URL 配置：默认库取 pathname 首段（与 connOptions 的解析一致）
            const p = new URL(conn.url).pathname.slice(1);
            if (p)
                db = p;
        }
        if (!db)
            throw new Error('No database specified: pass a database parameter or configure a default database');
        // fields/URL 提供的库名统一过标识符校验（防注入）
        return assertIdent(db, 'database name');
    };
    return {
        kind: 'mysql',
        connId: conn.meta.id,
        tx,
        testConnect: () => humanize('mysql connection test', async () => {
            const [rows] = await pool.query('SELECT VERSION() AS v');
            return { ok: true, serverInfo: `MySQL ${String(rows[0]?.v ?? '')}` };
        }),
        query: (sql, params, database) => humanize('mysql query failed', async () => {
            if (readOnly && !RO_READ_PREFIX.test(sql.trimStart())) {
                throw new Error('DRIVER_ERROR: in read-only (ro) mode, query only allows read statements (select/show/desc/describe/explain/use/help/table); use a writable connection for writes');
            }
            // 跨库请求路由到该库自己的池（白名单校验在前，拒绝发生在建池之前；
            // 缺省判断用 != null：空串等非法值必须进 assertIdent 被拒，不能落回主池）；
            // 无 database 时维持事务粘主池语义（服务层已拒绝事务携带 database）
            const target = database != null ? poolFor(assertIdent(database, 'database name')) : runner();
            const [rows, fields] = await target.query(sql, params ?? []);
            if (!Array.isArray(rows))
                return { columns: [], rows: [], rowCount: 0 };
            return toQueryResult(rows, fields);
        }),
        execute: (statement, params, database) => humanize('mysql execute failed', async () => {
            // mysql2 的 ExecuteValues 不接受 unknown[]，此处值均为绑定参数（string|number|null）
            const target = database != null ? poolFor(assertIdent(database, 'database name')) : runner();
            const [result] = await target.execute(statement, (params ?? []));
            const header = (Array.isArray(result) ? result[0] : result);
            const n = header?.affectedRows;
            return {
                affectedRows: typeof n === 'number' ? n : undefined,
                message: typeof n === 'number'
                    ? `Executed successfully, ${n} rows affected`
                    : 'Executed successfully',
            };
        }),
        listDatabases: () => humanize('mysql list databases', async () => {
            const [rows] = await pool.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
            return rows.map((r) => String(r.SCHEMA_NAME));
        }),
        listTables: (database) => humanize('mysql list tables', async () => {
            const db = database ? assertIdent(database, 'database name') : defaultDb();
            const [rows] = await pool.query(`SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
            return rows.map((r) => {
                const rawType = String(r.TABLE_TYPE);
                const comment = r.TABLE_COMMENT;
                return {
                    name: String(r.TABLE_NAME),
                    type: rawType === 'BASE TABLE' ? 'TABLE' : rawType,
                    comment: comment != null && comment !== '' ? String(comment) : undefined,
                    database: db,
                };
            });
        }),
        searchTables: (keyword, database, limit) => humanize('mysql search tables', async () => {
            // 以 | 为 LIKE 转义符（避开反斜杠在 SQL 字面量/NO_BACKSLASH_ESCAPES 模式下的歧义）：
            // % _ | \ 四字符全部转义后子串匹配，命中值经参数绑定传输、无注入面
            const esc = keyword.replace(/[\\%_|]/g, (m) => `|${m}`);
            const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
            const [rows] = await pool.query(`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT
           FROM information_schema.TABLES
           WHERE TABLE_NAME LIKE CONCAT('%', ?, '%') ESCAPE '|'
             ${database ? 'AND TABLE_SCHEMA = ?' : "AND TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')"}
           ORDER BY TABLE_SCHEMA, TABLE_NAME
           LIMIT ${cap}`, database ? [esc, database] : [esc]);
            return rows.map((r) => {
                const rawType = String(r.TABLE_TYPE);
                const comment = r.TABLE_COMMENT;
                return {
                    database: String(r.TABLE_SCHEMA),
                    name: String(r.TABLE_NAME),
                    type: rawType === 'BASE TABLE' ? 'TABLE' : rawType,
                    comment: comment != null && comment !== '' ? String(comment) : undefined,
                };
            });
        }),
        describeTable: (table, database) => humanize('mysql describe table', async () => {
            const db = database ? assertIdent(database, 'database name') : defaultDb();
            const tbl = assertIdent(table, 'table name');
            const [rows] = await pool.query(`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, tbl]);
            if (rows.length === 0)
                throw new Error(`Table not found: ${db}.${tbl}`);
            return rows.map((r) => {
                const dflt = r.COLUMN_DEFAULT;
                const comment = r.COLUMN_COMMENT;
                return {
                    name: String(r.COLUMN_NAME),
                    dataType: String(r.COLUMN_TYPE),
                    nullable: r.IS_NULLABLE === 'YES',
                    key: r.COLUMN_KEY ? String(r.COLUMN_KEY) : undefined,
                    default: dflt == null ? null : String(dflt),
                    comment: comment != null && comment !== '' ? String(comment) : undefined,
                };
            });
        }),
        previewRows: (table, limit, database, offset) => humanize('mysql preview rows', async () => {
            const db = quoteIdent(database ? assertIdent(database, 'database name') : defaultDb(), '`');
            const tbl = quoteIdent(assertIdent(table, 'table name'), '`');
            const lim = clampLimit(limit);
            const off = clampOffset(offset);
            const [rows, fields] = await pool.query(`SELECT * FROM ${db}.${tbl} LIMIT ? OFFSET ?`, [lim, off]);
            if (!Array.isArray(rows))
                return { columns: [], rows: [], rowCount: 0 };
            return toQueryResult(rows, fields);
        }),
        countRows: (table, database, search) => humanize('mysql count rows', async () => {
            const db = quoteIdent(database ? assertIdent(database, '库名') : defaultDb(), '`');
            const tbl = quoteIdent(assertIdent(table, 'table name'), '`');
            let where = '';
            let params = [];
            if (search != null && search !== '') {
                const cols = await columnNames(`${db}.${tbl}`);
                if (cols.length === 0)
                    return 0; // 无列恒无匹配
                where = ' WHERE ' + likeWhere(cols);
                params = cols.map(() => likePattern(search));
            }
            const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${db}.${tbl}${where}`, params);
            const r = rows[0];
            return r ? Number(r.n) : 0;
        }),
        searchRows: (table, keyword, limit, database, offset) => humanize('mysql content search', async () => {
            const db = quoteIdent(database ? assertIdent(database, '库名') : defaultDb(), '`');
            const tbl = quoteIdent(assertIdent(table, 'table name'), '`');
            const lim = clampLimit(limit);
            const off = clampOffset(offset);
            const cols = await columnNames(`${db}.${tbl}`);
            if (cols.length === 0)
                return { columns: [], rows: [], rowCount: 0 };
            const [rows, fields] = await pool.query(`SELECT * FROM ${db}.${tbl} WHERE ${likeWhere(cols)} LIMIT ? OFFSET ?`, [...cols.map(() => likePattern(keyword)), lim, off]);
            if (!Array.isArray(rows))
                return { columns: [], rows: [], rowCount: 0 };
            return toQueryResult(rows, fields);
        }),
        close: () => humanize('mysql close connection', async () => {
            if (closed)
                return; // 幂等：重复 close 为 no-op（pg-pool 二次 end() 会抛的教训）
            closed = true;
            await Promise.all([pool.end(), ...[...dbPools.values()].map((p) => p.end())]);
        }),
    };
}
export const factory = (conn) => createMysqlAdapter(conn);
export async function openMysqlRaw(conn) {
    const opts = connOptions(conn);
    const pool = mysql.createPool({ ...opts, dateStrings: true });
    // 回调式 query（带 err 回调吞错）。两点缺一不可（1.7.4 真机复现）：
    // 1) 必须回调式——非回调式命令无 onResult，与 promise 池连接建立序列冲突；
    // 2) 绝不能对返回的 Query 命令挂 error 监听——会打断池接管前的命令处理，
    //    连接状态机卡死 → 该连接所有后续 query 永挂（mysql2 3.24.4）
    pool.on('connection', (c) => {
        // 运行时 c 是 callback 版连接（promise 池类型标注不反映），按回调式调用
        c.query("SET time_zone = '+00:00'", () => { });
    });
    return { pool, database: typeof opts.database === 'string' ? opts.database : '' };
}
