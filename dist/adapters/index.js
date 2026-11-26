const LOADERS = {
    mysql: () => import('./mysql/index.js').then((m) => m.createMysqlAdapter),
    postgresql: () => import('./postgresql/index.js').then((m) => m.createPostgresqlAdapter),
    gaussdb: () => import('./gaussdb/index.js').then((m) => m.createGaussdbAdapter),
    sqlite: () => import('./sqlite/index.js').then((m) => m.createSqliteAdapter),
    redis: () => import('./redis/index.js').then((m) => m.createRedisAdapter),
    mongodb: () => import('./mongodb/index.js').then((m) => m.createMongoAdapter),
    oracle: () => import('./oracle/index.js').then((m) => m.createOracleAdapter),
    dmdb: () => import('./dmdb/index.js').then((m) => m.createDmAdapter),
    sqlserver: () => import('./sqlserver/index.js').then((m) => m.createSqlserverAdapter),
};
/** 驱动缺失时的安装指引 */
const INSTALL_HINTS = {
    mysql: 'npm install mysql2',
    postgresql: 'npm install pg',
    gaussdb: 'npm install gaussdb-node (or reinstall the plugin to restore dependencies)',
    sqlite: 'upgrade to Node ≥ 22.5 (built-in node:sqlite), or npm install better-sqlite3',
    redis: 'npm install redis',
    mongodb: 'npm run build:mongodb (builds vendor/mongodb-driver.cjs; the published package already ships the artifact, so this is only needed when it is missing)',
    oracle: 'npm install oracledb',
    dmdb: 'npm install dmdb',
    sqlserver: 'npm run build:sqlserver (rebuilds vendor/sqlserver-driver.cjs; mssql is only a devDependency)',
};
/** 是否真的「模块不存在」。只有这种情况才该建议用户安装依赖：
 *  ESM 导出不匹配、ABI 不兼容、语法错误等同样是「驱动不可用」，
 *  但它们的成因是本包文件与运行进程不同步（半拷贝/旧缓存），建议 npm install 只会把人带偏。 */
function isModuleMissing(cause) {
    const code = cause?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_SUPPORTED')
        return true;
    const text = cause instanceof Error ? cause.message : String(cause ?? '');
    return /Cannot find (module|package)/i.test(text);
}
/** 生成带安装指引的驱动缺失错误 */
export function driverMissingError(kind, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? '');
    const hint = isModuleMissing(cause)
        ? ` Install it and retry: ${INSTALL_HINTS[kind]}`
        : ' This is not a missing dependency: the plugin files and the running process are out of sync — rebuild and reinstall the plugin, then restart DSH.';
    const err = new Error(`${kind} driver unavailable${detail ? `: ${detail}` : ''}.${hint}`);
    err.name = 'DriverMissingError';
    return err;
}
const cache = new Map();
/** 取某 kind 的适配器工厂（惰性加载并缓存；失败清缓存以便重试） */
export function getAdapter(kind) {
    let p = cache.get(kind);
    if (!p) {
        p = LOADERS[kind]().catch((e) => {
            cache.delete(kind);
            throw driverMissingError(kind, e);
        });
        cache.set(kind, p);
    }
    return p;
}
