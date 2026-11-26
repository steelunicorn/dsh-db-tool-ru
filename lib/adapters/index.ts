/**
 * 适配器注册表：惰性动态 import 各驱动工厂。
 *
 * 任何单个驱动缺失（依赖未安装 / vendor 未构建）都不能拖垮整个插件：
 * 每个模块独立 import + catch，缺失时 query 该 kind 报带安装指引的 DRIVER_ERROR。
 * 惰性加载保证：只有真正用到某 kind 才会 import 对应模块。
 *
 * 注意：绑定 createXxxAdapter 而非各模块的 `factory` 导出——后者签名 (conn) 会
 * 丢弃 opts.mode（会话级只读双保险依赖 mode 透传）。
 */
import type { AccessMode, DbKind, DatabaseAdapter, ResolvedConnection } from './types.js';

/** 服务层调用签名：mode 由 grants 决定，适配器层做会话级只读双保险 */
export type ServiceAdapterFactory = (
  conn: ResolvedConnection,
  opts?: { mode?: AccessMode },
) => Promise<DatabaseAdapter>;

type Loader = () => Promise<ServiceAdapterFactory>;

const LOADERS: Record<DbKind, Loader> = {
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
const INSTALL_HINTS: Record<DbKind, string> = {
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
function isModuleMissing(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_SUPPORTED') return true;
  const text = cause instanceof Error ? cause.message : String(cause ?? '');
  return /Cannot find (module|package)/i.test(text);
}

/** 生成带安装指引的驱动缺失错误 */
export function driverMissingError(kind: DbKind, cause?: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause ?? '');
  const hint = isModuleMissing(cause)
    ? ` Install it and retry: ${INSTALL_HINTS[kind]}`
    : ' This is not a missing dependency: the plugin files and the running process are out of sync — rebuild and reinstall the plugin, then restart DSH.';
  const err = new Error(`${kind} driver unavailable${detail ? `: ${detail}` : ''}.${hint}`);
  err.name = 'DriverMissingError';
  return err;
}

const cache = new Map<DbKind, Promise<ServiceAdapterFactory>>();

/** 取某 kind 的适配器工厂（惰性加载并缓存；失败清缓存以便重试） */
export function getAdapter(kind: DbKind): Promise<ServiceAdapterFactory> {
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
