/**
 * Oracle 适配器（oracledb thin/thick 双模式，thin 为默认）。
 *
 * 设计要点（依据官方文档调研）：
 *  - oracledb.createPool({ user, password, connectString, poolAlias: <逐池唯一>,
 *    poolMin: 1, poolMax: 10, poolTimeout: 60 })。
 *    禁止 SYSDBA 等特权连接（不透传 privilege）。
 *  - poolAlias 显式传唯一值：不传则落到匿名池（不可经 getPool() 检索），见 createOraPool 注释。
 *  - Thick（OCI）模式：fields.ociLibDir / URL ?ociLibDir= 指定 Oracle Instant Client
 *    库目录时，建池前调用 oracledb.initOracleClient（进程级一次性、不可逆，见
 *    ensureOracleClient 注释）。服务器报 NJS-138（Thin 模式不支持其 TNS 协议版本，
 *    常见于 10g/9i 等老服务器）时，这是 Navicat（走 OCI）能连、Thin 模式不能连的场景。
 *  - 服务名/SID（对齐 Navicat）：fields.serviceType = 'service'（默认，EZConnect
 *    host:port/service）| 'sid'（完整 TNS 描述符 CONNECT_DATA=(SID=…)，老实例常用）。
 *  - CLOB 经全局 fetchAsString 转字符串；BLOB 经全局 fetchAsBuffer 转 Buffer。
 *    （fetchInfo 的键是【列名】而非类型名，按类型统一转换只能用全局 fetchXXX 属性——
 *    官方 connection.rst「fetchInfo」节：「Each column is specified by name」）
 *    NUMBER 保持 number（超精度损失由用户承担，见文档标注）。
 *  - query() 仅允许 SELECT/WITH；execute() DML/DDL，autoCommit: true 单语句语义。
 *  - Oracle 无 BEGIN，事务用 SET TRANSACTION READ WRITE + commit/rollback（tx 成员）。
 *  - DDL 隐式提交：execute 对 DDL 的 message 附注「DDL 已隐式提交，不可回滚」。
 *  - 标识符默认大写存储：listTables/describeTable 内部统一 toUpperCase 匹配。
 *  - 锁号/密码验证器等常见连接错误转人类可读提示（见 ORA_HINTS）。
 */
import * as path from 'node:path';
import oracledb from 'oracledb';
import { sqlHead, SQL_READ_HEADS } from '../../guard/index.js';
import { escapeLikePattern, validPort } from '../sql-shared/common.js';
import { conciseServerInfo } from '../connect-feedback.js';
import type {
  AccessMode,
  AdapterFactory,
  ColumnInfo,
  DatabaseAdapter,
  ExecResult,
  NormalizedCell,
  QueryResult,
  ResolvedConnection,
  TableInfo,
  TestConnectResult,
} from '../types.js';

// CLOB 统一按字符串返回；BLOB 统一按 Buffer 返回。均为官方全局按类型转换
// （fetchInfo 的键是列名而非类型名，`{ BLOB: … }` 只会匹配恰好名为 "BLOB" 的列，
// 按类型统一转换须用全局 fetchAsString/fetchAsBuffer——官方 connection.rst
// 「fetchInfo」节原文「Each column is specified by name, using Oracle's standard
// naming convention.」；fetchInfo 自 6.0 标记 deprecated，官方建议全局属性/fetchTypeHandler）
if (!oracledb.fetchAsString.includes(oracledb.CLOB)) {
  oracledb.fetchAsString = [...oracledb.fetchAsString, oracledb.CLOB];
}
if (!oracledb.fetchAsBuffer.includes(oracledb.BLOB)) {
  oracledb.fetchAsBuffer = [...oracledb.fetchAsBuffer, oracledb.BLOB];
}

const ROWS_MAX = 500;
const CELL_TRUNC = 1000;
const DDL_KEYWORDS = new Set([
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE',
  'COMMENT', 'ANALYZE', 'AUDIT', 'NOAUDIT', 'FLASHBACK', 'PURGE',
]);

/** 常见 ORA/NJS/DPI 错误 → 人类可读提示 */
export const ORA_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/NJS-138/, 'node-oracledb Thin mode does not support this server version (the TNS protocol version is too old; typical for Oracle 10g/9i or some gateways); fill in the Oracle Instant Client (OCI) library directory in the connection\'s "Advanced options" to enable Thick mode and retry (the same path Navicat uses)'],
  [/NJS-118/, 'Thick (OCI) mode must be enabled before the first Oracle connection in the process: restart the host, then test or use the connection that carries an OCI library path'],
  [/DPI-1047/, 'cannot load the Oracle Instant Client (OCI) library: check the OCI library path, that the library bitness matches the host (x64/x86), and that the client version is compatible with the server version'],
  [/ORA-01017/, 'invalid username or password'],
  [/ORA-12154/, 'cannot resolve the service name in the connect string; check connectString / service_name'],
  [/ORA-12505/, 'the listener does not recognize this SID; use a service name (service_name) instead of a SID'],
  [/ORA-12514/, 'the listener has not registered this service name; check the service name spelling and the database registration state'],
  [/ORA-12541/, 'cannot reach the listener; check the host and port'],
  [/ORA-12543/, 'the target host is unreachable; check the host/port/firewall'],
  [/ORA-12560/, 'TNS protocol adapter error; check the connect string format (expected host:port/service_name)'],
  [/ORA-28040/, 'client and server password verifier versions are incompatible (the server SQLNET.ALLOWED_LOGON_VERSION_SERVER setting must be relaxed)'],
  [/ORA-28000/, 'the account is locked; contact a DBA to unlock it'],
  [/ORA-28001/, 'the password has expired; contact a DBA to reset it'],
  [/ORA-00942/, 'table or view does not exist (Oracle stores identifiers in uppercase by default; mind the case and the owner)'],
  [/ORA-00904/, 'invalid column name (Oracle stores identifiers in uppercase by default; mind the case)'],
];

export function humanizeOraError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const hint = ORA_HINTS.find(([re]) => re.test(msg))?.[1];
  return new Error(hint ? `Oracle error: ${msg} (hint: ${hint})` : `Oracle error: ${msg}`);
}

/** 标识符基本校验（引用创建的 Oracle 名字可含任意字符，白名单会误杀）：
 *  非空、≤128、无 NUL/换行。防注入靠数据字典参数绑定 + preview 处 escIdent 转义。
 *  保留原名不强制大写：describeTable 的 SQL 用 UPPER(:tab) 兜底匹配未引用建表。 */
export function sanitizeIdentifier(name: string, label: string): string {
  if (
    typeof name !== 'string' || name.length === 0 || name.length > 128 ||
    /[\0\r\n]/.test(name)
  ) {
    throw new Error(`Invalid Oracle ${label} "${name}": must not be empty, exceed 128 characters, or contain NUL/newline`);
  }
  return name;
}

/** 双引号标识符转义（" → ""），拼接进 SQL 前必须过此函数 */
function escIdent(name: string): string {
  return name.replaceAll('"', '""');
}

/** LIKE 模式：通配符/转义符字面化（ESCAPE '#'）后 %…% 包裹（关键字本体走绑定） */
function likePattern(kw: string): string {
  return '%' + escapeLikePattern(kw) + '%';
}

/** 内容搜索谓词（countRows/searchRows 共用）：UPPER(TO_CHAR(col)) LIKE UPPER(:bN)。
 *  TO_CHAR 统一转文本（数字/日期按会话格式），UPPER 两端大小写不敏感；
 *  绑定名逐列唯一（b1..bN，与 :o/:n 按出现顺序对应位置数组），避免重名绑定歧义。 */
function searchWhereSql(cols: string[]): string {
  return '(' + cols.map((c, i) => `UPPER(TO_CHAR("${escIdent(c)}")) LIKE UPPER(:b${i + 1}) ESCAPE '#'`).join(' OR ') + ')';
}

function trunc(s: string, max = CELL_TRUNC): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated, ${s.length} chars total]` : s;
}

/** 行值规范化为 NormalizedCell（Lob 兜底转字符串并截断） */
async function normalizeCell(v: unknown): Promise<NormalizedCell> {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return trunc(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return trunc(`0x${v.toString('hex')}`); // fetchAsBuffer 产出的 BLOB
  if (v instanceof oracledb.Lob) {
    // 官方 Lob 类成员仅 getData()/read()/close()/destroy() 等，无 toString()（官方 lob.rst；
    // 实测 Lob.prototype.toString 即 Object.prototype.toString）——曾误用 toString()
    // 致 LOB 列恒显示 '[object Object]'。getData() 按 CLOB/BFILE 返回 string、按
    // 未转换 BLOB 返回 Buffer。判别用官方导出类 instanceof（constructor.name 非
    // 官方承诺，esbuild 压缩改名场景会失效）。
    const data = await v.getData();
    const s = typeof data === 'string' ? data : `0x${Buffer.from(data).toString('hex')}`;
    return trunc(s);
  }
  return trunc(String(v));
}

/** 连接标识类型：service（服务名，默认）/ sid（实例 SID，老实例常用，对齐 Navicat 的下拉） */
export type OraServiceType = 'service' | 'sid';

export interface ResolvedOraConn {
  user: string;
  password: string;
  connectString: string;
  /** Thick（OCI）模式的 Instant Client 库目录；undefined = Thin 模式（默认） */
  ociLibDir?: string;
  serviceType: OraServiceType;
}

/** 可选字符串字段解析：trim 后空串视为未提供（表单留空的官方语义，与 validPort 同口径） */
function optStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

/**
 * OCI 库路径归一化（纯字符串处理，不碰文件系统）：
 *  - 去掉成对包裹引号：Windows 资源管理器「复制文件地址」给出 `"C:\instantclient_19_19"`，
 *    带引号路径传给 initOracleClient 会 DPI-1047；
 *  - 指向库文件（oci.dll / libclntsh.so 等）时改取其所在目录：initOracleClient 的
 *    libDir 语义是目录，直接粘 oci.dll 文件路径是常见误解。
 * 纯串判定文件：文件名以 .dll/.dylib 结尾或形如 *.so(.N)（版本化 soname），含 `\` 用 win32 规则解析、否则 posix。
 */
export function normalizeOciLibDir(raw: string): string {
  let s = raw.trim();
  const head = s[0] ?? '';
  const q = s.length >= 2 && (head === '"' || head === "'") && s.endsWith(head) ? head : '';
  if (q !== '') s = s.slice(1, -1).trim();
  if (s === '') return raw.trim();
  const p = s.includes('\\') ? path.win32 : path.posix;
  const base = p.basename(s).toLowerCase();
  const isLibFile = base.endsWith('.dll') || base.endsWith('.dylib') || /\.so(\.\d+)*$/.test(base);
  if (!isLibFile) return s;
  const dir = p.dirname(s);
  return dir === '' || dir === '.' ? s : dir;
}

/** OCI 库路径入口：optStr 之后过 normalizeOciLibDir（fields 与 URL 同口径） */
function ociLibDirOf(v: unknown): string | undefined {
  const s = optStr(v);
  return s === undefined ? undefined : normalizeOciLibDir(s);
}

/** SID 校验（fail-closed）：SID 会被拼进 TNS 描述符 CONNECT_DATA=(SID=…)，
 *  `()` `=` 引号与空白会破坏描述符结构，白名单字符集覆盖合法 SID（字母/数字/_ $ # -）。
 *  服务名走 EZConnect 拼接不受此限（现状行为不变）。 */
export function assertOraSid(sid: string): string {
  if (!/^[A-Za-z0-9_$#-]{1,64}$/.test(sid)) {
    throw new Error(`Oracle connection SID is invalid: "${sid}" (1-64 characters of letters/digits/_/$/#/-; no whitespace or parentheses; old instances use SIDs like XE/ORCL)`);
  }
  return sid;
}

/** SID 模式的完整 TNS 描述符（EZConnect 无 SID 形态，官方 connectString 接受完整描述符）。
 *  host 仅允许主机名/IP 常规字符（IPv6 字面量含 []，描述符里不合法，报错引导改用服务名模式）。 */
function sidConnectString(host: string, port: number, sid: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(host)) {
    throw new Error(`Oracle SID connection has an invalid host: "${host}" (in SID mode the host supports only hostname/IPv4/domain; for IPv6 use the service-name mode or a full TNS descriptor URL)`);
  }
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${sid})))`;
}

/** serviceType 解析：未提供='service'；仅接受 'service'/'sid'，其余 fail-closed */
function parseServiceType(v: unknown, source: string): OraServiceType {
  if (v === undefined || v === null || v === '') return 'service';
  if (v === 'service' || v === 'sid') return v;
  const where = source ? ` (${source})` : '';
  throw new Error(`Oracle connection${where} has an invalid serviceType: ${JSON.stringify(String(v))} (allowed: service/sid; default: service)`);
}

/** 连接参数解析：url（oracle://user:pass@host:1521/service[?serviceType=sid&ociLibDir=…]）或 fields */
export function resolveOracleConn(conn: ResolvedConnection): ResolvedOraConn {
  if (conn.url) {
    const u = new URL(conn.url);
    const service = u.pathname.replace(/^\//, '');
    if (!u.hostname || service === '') {
      throw new Error('Oracle URL must be in the form oracle://user:pass@host:1521/SERVICE_NAME');
    }
    const user = decodeURIComponent(u.username);
    if (user === '') {
      throw new Error('Oracle URL is missing the username: expected oracle://user:pass@host:1521/SERVICE_NAME');
    }
    const port = u.port ? validPort(u.port, 1521, 'oracle') : 1521;
    const serviceType = parseServiceType(u.searchParams.get('serviceType'), 'URL');
    const ociLibDir = ociLibDirOf(u.searchParams.get('ociLibDir'));
    const host = u.hostname;
    const ident = serviceType === 'sid' ? assertOraSid(service) : service;
    return {
      user,
      password: decodeURIComponent(u.password),
      connectString: serviceType === 'sid'
        ? sidConnectString(host, port, ident)
        : `${host}:${port}/${service}`, // 端口段校验：':0' 等非法值抛中文错误，不再 host:0 直传驱动
      serviceType,
      ...(ociLibDir !== undefined ? { ociLibDir } : {}),
    };
  }
  const f = conn.fields ?? {};
  const host = typeof f.host === 'string' ? f.host : '';
  // 前端原样发字符串端口：显式校验；历史 typeof==='number' 门把一切字符串（含合法 '14330'）
  // 静默丢弃回退 1521
  const port = validPort(f.port, 1521, 'oracle');
  const service = typeof f.service === 'string' ? f.service : typeof f.database === 'string' ? f.database : '';
  if (host === '' || service === '') {
    throw new Error('Oracle connection requires a url (oracle://user:pass@host:1521/SERVICE) or fields (host/port/service)');
  }
  const user = typeof f.user === 'string' ? f.user : '';
  if (user === '') {
    throw new Error('Oracle connection is missing the username (fields.user)');
  }
  const serviceType = parseServiceType(f.serviceType, '');
  const ident = serviceType === 'sid' ? assertOraSid(service.trim()) : service;
  const ociLibDir = ociLibDirOf(f.ociLibDir);
  return {
    user,
    password: typeof f.password === 'string' ? f.password : '',
    connectString: serviceType === 'sid' ? sidConnectString(host, port, ident) : `${host}:${port}/${service}`,
    serviceType,
    ...(ociLibDir !== undefined ? { ociLibDir } : {}),
  };
}

/**
 * Thick（OCI）模式进程级状态：oracledb.initOracleClient 是模块级一次性、不可逆操作——
 * 启用后进程内所有 Oracle 连接都走 OCI；且一旦建过任何 Thin 连接（驱动加载 thin 协议栈）
 * 再启用会抛 NJS-118。thickLibDir：null=未启用；'' =以默认搜索路径启用；其它=以该 libDir 启用。
 */
const oraClientState: { thickLibDir: string | null; thinPoolCreated: boolean } = {
  thickLibDir: null,
  thinPoolCreated: false,
};

/** 测试注入的最小驱动面（真实 oracledb 满足此结构） */
export interface OraClientDriverLike {
  initOracleClient(options?: { libDir?: string }): void;
}

/** 测试隔离：重置进程级 thick/thin 状态（仅 vitest 使用） */
export function resetOraClientStateForTest(): void {
  oraClientState.thickLibDir = null;
  oraClientState.thinPoolCreated = false;
}

/**
 * 启用 Thick（OCI）模式（幂等）：ociLibDir 相同直接跳过；不同 libDir / 已建过 thin 池时
 * 抛带行动指引的中文错误（比驱动的 NJS-090/NJS-118 原文更可操作）。必须在 createPool 之前调用。
 */
export function ensureOracleClient(libDir: string, driver: OraClientDriverLike = oracledb): void {
  if (oraClientState.thickLibDir !== null) {
    if (libDir === oraClientState.thickLibDir) return;
    throw new Error(`Oracle Thick (OCI) mode is already enabled with a different OCI library path (enabled: ${oraClientState.thickLibDir === '' ? 'default search path' : oraClientState.thickLibDir}); it can be enabled only once per process — use the same path or restart the host`);
  }
  if (oraClientState.thinPoolCreated) {
    throw new Error('This process has already created a Thin mode connection, so Thick (OCI) mode can no longer be enabled (driver limitation NJS-118); restart the host and use the connection with an OCI library path before any other Oracle connection');
  }
  try {
    driver.initOracleClient({ libDir });
  } catch (e) {
    // DPI-1047（库无法加载）等：统一加行动指引；NJS-118 兜底（驱动侧的 thin 状态对我们不可见）
    throw humanizeOraError(e);
  }
  oraClientState.thickLibDir = libDir;
}

export interface OracleAdapterOptions {
  mode?: AccessMode;
  /** 测试注入：跳过真实连接池创建 */
  pool?: unknown;
}

/**
 * 连接池别名：oracledb 的规则与 dmdb 不同——只有「显式传入的别名」或
 * 「'default' 尚空闲时取到的缺省值」会登记进模块级 poolCache；两者都被占用时
 * 驱动创建的是 poolAlias === undefined 的匿名池（不报错，也无法经 getPool() 检索），
 * 只有显式重复别名才抛 NJS-046（lib/oracledb.js:640-649、lib/errors.js:352）。
 * 本插件同进程内可并存多个池（连接的 ro/rw 各一份缓存、testConnection/testDraft 的
 * 一次性池、控制台事务会话、数据传输独立池），故显式传唯一别名：每池身份可检索，
 * 且不抢占 getPool() 的缺省键 'default'。回收靠 '_afterPoolClose' 事件（close 抛错则不触发）。
 */
let poolSeq = 0;
function nextPoolAlias(conn: ResolvedConnection): string {
  return `dsh-ora-${conn.meta.id}-${++poolSeq}`;
}

/** 建池（连接串解析、thick/thin 模式、池参数与别名单点维护，供适配器与数据传输入口共用） */
async function createOraPool(conn: ResolvedConnection): Promise<oracledb.Pool> {
  const { user, password, connectString, ociLibDir } = resolveOracleConn(conn);
  // Thick（OCI）初始化必须发生在 createPool 之前：thin 协议栈在首次建池时加载，
  // 一旦加载（哪怕建池失败），后续 initOracleClient 会被驱动以 NJS-118 拒绝
  if (ociLibDir !== undefined) ensureOracleClient(ociLibDir);
  try {
    return await oracledb.createPool({
      user,
      password,
      connectString,
      poolAlias: nextPoolAlias(conn),
      poolMin: 1,
      poolMax: 10,
      poolTimeout: 60,
    });
  } catch (e) {
    throw humanizeOraError(e);
  } finally {
    // 保守标记：仅统计 thin 建池尝试（成败都算）；thick 池不影响该标记
    if (ociLibDir === undefined) oraClientState.thinPoolCreated = true;
  }
}

export async function createOracleAdapter(
  conn: ResolvedConnection,
  opts?: OracleAdapterOptions,
): Promise<DatabaseAdapter> {
  const mode: AccessMode = opts?.mode ?? 'rw';
  let pool: oracledb.Pool;
  if (opts?.pool) {
    pool = opts.pool as oracledb.Pool;
  } else {
    pool = await createOraPool(conn);
  }

  function requireRw(action: string): void {
    if (mode === 'ro') {
      throw new Error(`Connection is in read-only (ro) mode; refusing to execute ${action}; use an rw connection or send queries (query) only`);
    }
  }

  function isDdl(sql: string): boolean {
    const first = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    return DDL_KEYWORDS.has(first);
  }

  async function toExecResult(sql: string, r: oracledb.ExecuteResult): Promise<ExecResult> {
    const ddlNote = isDdl(sql) ? ' (DDL is committed implicitly and cannot be rolled back)' : '';
    return {
      affectedRows: typeof r.rowsAffected === 'number' && r.rowsAffected > 0 ? r.rowsAffected : undefined,
      message: `${sql.trim().split(/\s+/)[0]?.toUpperCase() ?? 'SQL'} completed${r.rowsAffected ? `, ${r.rowsAffected} rows affected` : ''}${ddlNote}`,
    };
  }

  /** 执行结果 → QueryResult（行值规范化 + 超限截断）；query 与事务内读语句共用 */
  async function rowsToQueryResult(r: oracledb.ExecuteResult): Promise<QueryResult> {
    const allRows = (r.rows as Record<string, unknown>[] | undefined) ?? [];
    const truncated = allRows.length > ROWS_MAX;
    const columns = (r.metaData ?? []).map((m) => m.name);
    const rows: NormalizedCell[][] = [];
    for (const row of allRows.slice(0, ROWS_MAX)) {
      rows.push(await Promise.all(Object.values(row).map(normalizeCell)));
    }
    return { columns, rows, rowCount: rows.length, truncated: truncated || undefined };
  }

  // autoCommit 默认 true：query/元数据 SELECT 结束隐式事务避免 ro 事务悬挂；tx 专用连接显式 autoCommit:false 覆盖
  const execOpts: oracledb.ExecuteOptions = { outFormat: oracledb.OBJECT, maxRows: ROWS_MAX + 1, autoCommit: true };

  /**
   * 从池借一条连接执行后归还。⚠️ oracledb 的 Pool 没有 execute，
   * 一切语句必须在 Connection 上执行；close() 即归还连接。
   */
  async function withConn<T>(fn: (c: oracledb.Connection) => Promise<T>): Promise<T> {
    const c = await pool.getConnection();
    try {
      return await fn(c);
    } finally {
      await c.close().catch(() => { /* 归还失败忽略 */ });
    }
  }

  // 注意：currentUser / 系统 schema 名单在 adapter 对象之前声明，
  // 不再依赖「方法仅运行期调用」的隐式 TDZ 保证（审查项：脆弱模式消除）
  const currentUser = resolveOracleConn(conn).user.toUpperCase();

  /** Oracle 内建系统 schema（核心名单 + APEX/flows 组件前缀）：业务不可查询，列表中过滤 */
  const ORA_SYSTEM_SCHEMAS = new Set([
    'SYS', 'SYSTEM', 'OUTLN', 'XDB', 'CTXSYS', 'MDSYS', 'OLAPSYS', 'ORDDATA', 'ORDSYS',
    'WMSYS', 'DBSNMP', 'APPQOSSYS', 'AUDSYS', 'LBACSYS', 'DVSYS', 'OJVMSYS', 'DBSFWUSER',
    'GSMADMIN_INTERNAL', 'GSMCATUSER', 'GGSYS', 'REMOTE_SCHEDULER_AGENT', 'ANONYMOUS',
  ]);
  const isOraSystemSchema = (o: string) =>
    ORA_SYSTEM_SCHEMAS.has(o) || /^(APEX|FLOWS)_/.test(o);

  /** owner 解析：database 参数或默认当前用户（保留原样——引用创建的 schema 大小写敏感） */
  function ownerOf(database?: string): string {
    return sanitizeIdentifier(database ?? currentUser, 'schema/owner name');
  }

  /**
   * tx 为可选扩展成员：契约 DatabaseAdapter 尚未声明 tx（types.ts 为共享文件，本阶段不改），
   * 用交叉类型承载，运行时存在于返回对象上；注册/服务层可按需取用。
   * exec 回调按语句头分流：读语句返回 QueryResult，其余返回 ExecResult。
   */
  type AdapterWithTx = DatabaseAdapter & {
    tx?: <T>(
      fn: (exec: (sql: string, binds?: unknown[]) => Promise<ExecResult | QueryResult>) => Promise<T>,
    ) => Promise<T>;
  };

  /** 列名清单（内容搜索谓词用）：`WHERE 1=0` 借 metaData 元数据一次往返 */
  async function searchColumnNames(owner: string, tab: string): Promise<string[]> {
    const r = await withConn((c) => c.execute(
      `SELECT * FROM "${escIdent(owner)}"."${escIdent(tab)}" WHERE 1=0`,
      [],
      execOpts,
    ));
    return (r.metaData ?? []).map((m) => String(m.name));
  }

  const adapter: AdapterWithTx = {
    kind: 'oracle',
    connId: conn.meta.id,

    async testConnect(): Promise<TestConnectResult> {
      try {
        const r = await withConn((c) => c.execute('SELECT banner FROM v$version WHERE ROWNUM = 1', [], execOpts));
        const row = (r.rows as Record<string, unknown>[] | undefined)?.[0];
        const banner = row ? String(Object.values(row)[0] ?? '') : '';
        return { ok: true, serverInfo: conciseServerInfo('oracle', banner) };
      } catch {
        // v$version 在部分受限环境对普通用户不可读（ORA-00942/ORA-01031）：
        // 版本信息尽力而为，连通性本身用 dual 兜底判定，避免误报连接失败
        try {
          await withConn((c) => c.execute('SELECT 1 FROM dual', [], execOpts));
          return { ok: true, serverInfo: 'Oracle (version information unreadable: no permission on v$version)' };
        } catch (e) {
          return { ok: false, error: humanizeOraError(e).message };
        }
      }
    },

    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const head = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
      if (head !== 'SELECT' && head !== 'WITH') {
        throw new Error('Oracle query only allows SELECT/WITH statements; use execute for writes or DDL');
      }
      try {
        const r = await withConn((c) => c.execute(sql, params ?? [], execOpts));
        return await rowsToQueryResult(r);
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    async execute(statement: string, params?: unknown[]): Promise<ExecResult> {
      requireRw('execute');
      try {
        const r = await withConn((c) => c.execute(statement, params ?? [], execOpts));
        return await toExecResult(statement, r);
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    /**
     * 事务：从池取专用连接执行多条语句，成功 commit、异常 rollback。
     * Oracle 无 BEGIN，用 SET TRANSACTION READ WRITE 开始显式事务。
     * exec 回调按语句头分流：读语句（SQL_READ_HEADS 命中首词，如 SELECT/WITH）在
     * 本事务连接上执行并返回结果集（事务内读未提交数据是官方标准用法）；
     * 其余语句返回执行回执。所有语句同处一个事务，随 commit/rollback 收口。
     */
    async tx<T>(
      fn: (exec: (sql: string, binds?: unknown[]) => Promise<ExecResult | QueryResult>) => Promise<T>,
    ): Promise<T> {
      requireRw('transaction (tx)');
      const c = await pool.getConnection();
      try {
        await c.execute('SET TRANSACTION READ WRITE');
        const exec = async (sql: string, binds?: unknown[]): Promise<ExecResult | QueryResult> => {
          const r = await c.execute(sql, binds ?? [], { ...execOpts, autoCommit: false });
          return SQL_READ_HEADS.has(sqlHead(sql)) ? rowsToQueryResult(r) : toExecResult(sql, r);
        };
        const out = await fn(exec);
        await c.commit();
        return out;
      } catch (e) {
        try {
          await c.rollback();
        } catch { /* 已断开等场景忽略 */ }
        throw humanizeOraError(e);
      } finally {
        try {
          await c.close();
        } catch { /* 归还失败忽略 */ }
      }
    },

    async listDatabases(): Promise<string[]> {
      // Oracle 为单库多 schema 模型：「数据库」下拉列出可浏览的 schema（有表或有视图者），
      // 失败回退当前用户 schema，绝不用 service 名等占位值（会污染 owner 参数）。
      // 内建系统 schema（数据字典/组件账户）业务不可查询，列出只会让展开时报
      // ORA-00942/ORA-01031 类错误，故过滤（保留当前用户自身）。
      try {
        const r = await withConn((c) => c.execute(
          'SELECT owner FROM all_tables UNION SELECT owner FROM all_views ORDER BY owner',
          [],
          execOpts,
        ));
        const owners = ((r.rows as Record<string, unknown>[] | undefined) ?? [])
          .map((row) => String(row.OWNER ?? '').trim())
          .filter(Boolean)
          .filter((o) => o === currentUser || !isOraSystemSchema(o.toUpperCase()));
        return owners.length > 0 ? owners : [currentUser];
      } catch {
        return [currentUser];
      }
    },

    async listTables(database?: string): Promise<TableInfo[]> {
      const owner = ownerOf(database);
      try {
        // 表 + 视图一次取全（UNION ALL 派生表统一排序/截断）：视图与表共用 describeTable
        // （ALL_TAB_COLUMNS）与 previewRows（SELECT *）路径，视图不列出即无法浏览视图数据；
        // 纯视图 schema 由 listDatabases 的 all_tables/all_views 并集保证可见。
        // 注释同源 ALL_TAB_COMMENTS（视图注释也存此表），LEFT JOIN 不放大行数
        const r = await withConn((c) => c.execute(
          `SELECT name, obj_type, comments FROM (
             SELECT t.table_name AS name, 'TABLE' AS obj_type, c.comments AS comments
             FROM all_tables t
             LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
             WHERE t.owner = :owner
             UNION ALL
             SELECT v.view_name, 'VIEW', cv.comments
             FROM all_views v
             LEFT JOIN all_tab_comments cv ON cv.owner = v.owner AND cv.table_name = v.view_name
             WHERE v.owner = :owner
           ) ORDER BY name FETCH FIRST 500 ROWS ONLY`,
          [owner, owner],
          execOpts,
        ));
        const rows = (r.rows as Record<string, unknown>[] | undefined) ?? [];
        return rows.map((row) => {
          const comment = row.COMMENTS;
          const objType = String(row.OBJ_TYPE ?? '');
          return {
            name: String(row.NAME ?? ''),
            type: objType === 'VIEW' ? 'VIEW' : 'TABLE',
            comment: comment != null && comment !== '' ? String(comment) : undefined,
          };
        });
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    async describeTable(table: string, database?: string): Promise<ColumnInfo[]> {
      const owner = ownerOf(database);
      // 原名精确匹配优先；未引用创建的表名在字典中为大写存储，UPPER 兜底
      const tab = sanitizeIdentifier(table, 'table name');
      try {
        // 同连接内两查保证一致性
        const { colsR, pkR } = await withConn(async (c) => ({
          colsR: await c.execute(
            `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, data_default
            FROM all_tab_columns WHERE owner = :owner AND (table_name = :tab OR table_name = UPPER(:tab)) ORDER BY column_id`,
            [owner, tab],
            execOpts,
          ),
          pkR: await c.execute(
            `SELECT cols.column_name
            FROM all_constraints cons
            JOIN all_cons_columns cols
              ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
            WHERE cons.constraint_type = 'P' AND cons.owner = :owner AND (cons.table_name = :tab OR cons.table_name = UPPER(:tab))`,
            [owner, tab],
            execOpts,
          ),
        }));
        const pkSet = new Set(
          ((pkR.rows as Record<string, unknown>[] | undefined) ?? []).map((r2) => String(r2.COLUMN_NAME ?? '')),
        );
        return ((colsR.rows as Record<string, unknown>[] | undefined) ?? []).map((row) => {
          const dataType = String(row.DATA_TYPE ?? '');
          const precision = row.DATA_PRECISION;
          const scale = row.DATA_SCALE;
          const length = row.DATA_LENGTH;
          let typeStr = dataType;
          if (precision !== null && precision !== undefined) {
            typeStr = scale !== null && scale !== undefined && Number(scale) > 0
              ? `${dataType}(${Number(precision)},${Number(scale)})`
              : `${dataType}(${Number(precision)})`;
          } else if (/^(VARCHAR|NVARCHAR|CHAR|NCHAR|RAW)/.test(dataType) && length !== null && length !== undefined) {
            typeStr = `${dataType}(${Number(length)})`;
          }
          const def = row.DATA_DEFAULT;
          return {
            name: String(row.COLUMN_NAME ?? ''),
            dataType: typeStr,
            nullable: String(row.NULLABLE ?? 'Y') === 'Y',
            ...(pkSet.has(String(row.COLUMN_NAME ?? '')) ? { key: 'PRI' as const } : {}),
            default: def === null || def === undefined ? null : trunc(String(def).trim()),
          };
        });
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    async previewRows(table: string, limit: number, database?: string, offset?: number): Promise<QueryResult> {
      const owner = ownerOf(database);
      const tab = sanitizeIdentifier(table, 'table name'); // 拼接前经 escIdent 转义
      const n = Math.max(1, Math.min(Math.floor(limit) || 20, ROWS_MAX));
      const off = Math.max(0, Math.floor(offset ?? 0) || 0);
      try {
        const r = await withConn((c) => c.execute(
          `SELECT * FROM "${escIdent(owner)}"."${escIdent(tab)}" OFFSET :o ROWS FETCH NEXT :n ROWS ONLY`,
          [off, n],
          execOpts,
        ));
        const rows = (r.rows as Record<string, unknown>[] | undefined) ?? [];
        const columns = (r.metaData ?? []).map((m) => m.name);
        const normRows: NormalizedCell[][] = [];
        for (const row of rows) {
          normRows.push(await Promise.all(Object.values(row).map(normalizeCell)));
        }
        return { columns, rows: normRows, rowCount: normRows.length };
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    async countRows(table: string, database?: string, search?: string): Promise<number> {
      const owner = ownerOf(database);
      const tab = sanitizeIdentifier(table, 'table name'); // 拼接前经 escIdent 转义
      try {
        let sql = `SELECT COUNT(*) AS N FROM "${escIdent(owner)}"."${escIdent(tab)}"`;
        const binds: unknown[] = [];
        if (search != null && search !== '') {
          const cols = await searchColumnNames(owner, tab);
          if (cols.length === 0) return 0; // 无列恒无匹配
          sql += ' WHERE ' + searchWhereSql(cols);
          binds.push(...cols.map(() => likePattern(search)));
        }
        const r = await withConn((c) => c.execute(sql, binds, execOpts));
        const row = (r.rows as Record<string, unknown>[] | undefined)?.[0];
        return row ? Number(row.N) : 0;
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    async searchRows(table: string, keyword: string, limit: number, database?: string, offset?: number): Promise<QueryResult> {
      const owner = ownerOf(database);
      const tab = sanitizeIdentifier(table, 'table name'); // 拼接前经 escIdent 转义
      const n = Math.max(1, Math.min(Math.floor(limit) || 20, ROWS_MAX));
      const off = Math.max(0, Math.floor(offset ?? 0) || 0);
      try {
        const cols = await searchColumnNames(owner, tab);
        if (cols.length === 0) return { columns: [], rows: [], rowCount: 0 };
        const r = await withConn((c) => c.execute(
          `SELECT * FROM "${escIdent(owner)}"."${escIdent(tab)}" WHERE ${searchWhereSql(cols)} OFFSET :o ROWS FETCH NEXT :n ROWS ONLY`,
          [...cols.map(() => likePattern(keyword)), off, n],
          execOpts,
        ));
        return await rowsToQueryResult(r);
      } catch (e) {
        throw humanizeOraError(e);
      }
    },

    async close(): Promise<void> {
      try {
        await pool.close();
      } catch { /* 已关闭忽略 */ }
    },
  };

  return adapter;
}

export const factory: AdapterFactory = async (conn) => createOracleAdapter(conn);

/** 数据传输读写端用的独立连接池（别名逐池唯一，可与主连接池并存） */
export async function openOraclePool(conn: ResolvedConnection): Promise<oracledb.Pool> {
  return await createOraPool(conn);
}
