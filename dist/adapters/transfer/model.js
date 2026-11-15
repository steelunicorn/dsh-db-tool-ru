/** 源库 DEFAULT 表达式白名单：纯数字/单引号字符串/NULL/CURRENT_TIMESTAMP 才内联进
 *  目标 DDL（default 文本来自源库系统表，白名单防意外表达式注入），其余丢弃。 */
export function safeDefaultExpr(raw) {
    const s = raw.trim();
    if (/^NULL$/i.test(s) || /^CURRENT_TIMESTAMP$/i.test(s))
        return s.toUpperCase();
    if (/^-?\d+(\.\d+)?$/.test(s))
        return s;
    if (/^'([^']|'')*'$/.test(s))
        return s;
    return null;
}
/** 分发：按 kind 创建读写端。mongo 在 kinds/mongo.ts；未注册的 kind 给出明确错误 */
export async function createTransferReader(rc, loc) {
    const kind = rc.meta.kind;
    if (kind === 'sqlite') {
        const { createSqliteTransferReaderFromConn } = await import('./kinds/sqlite.js');
        return createSqliteTransferReaderFromConn(rc); // sqlite 无层级，loc 忽略
    }
    if (kind === 'mysql') {
        const { createMysqlTransferReaderFromConn } = await import('./kinds/mysql.js');
        return createMysqlTransferReaderFromConn(rc, loc);
    }
    if (kind === 'postgresql' || kind === 'gaussdb') {
        const { createPgTransferReaderFromConn } = await import('./kinds/pg.js');
        const driver = kind === 'postgresql'
            ? (await import('../postgresql/index.js')).getPgDriver()
            : (await import('../gaussdb/index.js')).loadGaussDriver();
        return createPgTransferReaderFromConn(kind, driver, rc, loc);
    }
    if (kind === 'oracle' || kind === 'dmdb') {
        const oralike = await import('./kinds/oralike.js');
        // oracledb.Pool / DmPoolLike 与 OraLikePool 结构兼容（驱动最小面），按契约收窄——
        // 与 dmdb 适配器内部 as unknown as DmPoolLike 同款桥接
        const pool = kind === 'oracle'
            ? (await (await import('../oracle/index.js')).openOraclePool(rc))
            : (await (await import('../dmdb/index.js')).openDmPool(rc));
        // owner = 定位第一层（oracle/dm 单库多 schema 模型），缺省连接用户。
        // owner 非法（超长/含 NUL 换行）或缺失在构造期同步抛错，此时池已建而无人持有 →
        // 登记项永不释放（池泄漏）。故构造期任何抛错都要回收该池。
        try {
            return oralike.createOraLikeTransferReader(kind, pool, loc?.database ?? oralike.ownerOfFromConn(rc));
        }
        catch (e) {
            await pool.close().catch(() => { });
            throw e;
        }
    }
    if (kind === 'mongodb') {
        const { createMongoTransferReaderFromConn } = await import('./kinds/mongo.js');
        return createMongoTransferReaderFromConn(rc, loc);
    }
    if (kind === 'sqlserver') {
        const { createSqlserverTransferReaderFromConn } = await import('./kinds/sqlserver.js');
        return createSqlserverTransferReaderFromConn(rc, loc);
    }
    if (kind === 'redis') {
        const { createRedisTransferReaderFromConn } = await import('./kinds/redis.js');
        return createRedisTransferReaderFromConn(rc); // redis 无库/模式层级，loc 忽略
    }
    throw new Error(`Data transfer does not yet support reading ${kind} (planned for a later version)`);
}
export async function createTransferWriter(rc, writeMode = 'insert', loc) {
    const kind = rc.meta.kind;
    if (kind === 'sqlite') {
        const { createSqliteTransferWriterFromConn } = await import('./kinds/sqlite.js');
        return createSqliteTransferWriterFromConn(rc, writeMode); // sqlite 无层级，loc 忽略
    }
    if (kind === 'mysql') {
        const { createMysqlTransferWriterFromConn } = await import('./kinds/mysql.js');
        return createMysqlTransferWriterFromConn(rc, writeMode, loc);
    }
    if (kind === 'postgresql' || kind === 'gaussdb') {
        const { createPgTransferWriterFromConn } = await import('./kinds/pg.js');
        const driver = kind === 'postgresql'
            ? (await import('../postgresql/index.js')).getPgDriver()
            : (await import('../gaussdb/index.js')).loadGaussDriver();
        return createPgTransferWriterFromConn(kind, driver, rc, writeMode, loc);
    }
    if (kind === 'oracle' || kind === 'dmdb') {
        const oralike = await import('./kinds/oralike.js');
        const pool = kind === 'oracle'
            ? (await (await import('../oracle/index.js')).openOraclePool(rc))
            : (await (await import('../dmdb/index.js')).openDmPool(rc));
        // 写入 owner = 定位第一层，缺省连接用户默认 schema（写端以 owner 前缀显式限定）。
        // 与读端同理：owner 非法/缺失在构造期同步抛错，池已建而无人持有 → 必须回收。
        try {
            return oralike.createOraLikeTransferWriter(kind, pool, writeMode, loc?.database ?? oralike.ownerOfFromConn(rc));
        }
        catch (e) {
            await pool.close().catch(() => { });
            throw e;
        }
    }
    if (kind === 'mongodb') {
        const { createMongoTransferWriterFromConn } = await import('./kinds/mongo.js');
        return createMongoTransferWriterFromConn(rc, writeMode, loc);
    }
    if (kind === 'sqlserver') {
        const { createSqlserverTransferWriterFromConn } = await import('./kinds/sqlserver.js');
        return createSqlserverTransferWriterFromConn(rc, writeMode, loc);
    }
    if (kind === 'redis') {
        const { createRedisTransferWriterFromConn } = await import('./kinds/redis.js');
        return createRedisTransferWriterFromConn(rc, writeMode); // redis 无库/模式层级，loc 忽略
    }
    throw new Error(`Data transfer does not yet support writing ${kind} (planned for a later version)`);
}
