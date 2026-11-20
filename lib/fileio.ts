/**
 * 文件交换层：把「数据库结果 → 项目内文件」和「项目内文件 → 数据库」两个方向的
 * 实际读写收在一处，所有路径校验只有一个实现（export_to_file / execute_file /
 * run_script 的 file.save 桥共用）。
 *
 * 设计要点：
 *  - 路径一律相对项目目录解释，绝对路径/`..`/盘符/ADS/设备名一律拒绝；
 *  - 符号链接是明确的拒绝项（文件本身 lstat 判 symlink，父目录 realpath 后重验前缀），
 *    避免项目内链接把读写带到项目外；
 *  - 写文件用 O_EXCL（flag 'wx'）实现 overwrite=false 的「创建或失败」，不做
 *    「先 existsSync 再写」的竞态写法；
 *  - 大小与扩展名限制由调用方传入（默认见 DEFAULT_FILE_IO），错误码机器可读。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DbToolError } from './errors.js';

export interface FileIoOptions {
  /** 单次读取上限（字节），默认 8 MB */
  maxReadBytes: number;
  /** 单次写入上限（字节），默认 64 MB */
  maxWriteBytes: number;
  /** 允许的扩展名（小写、带点） */
  extensions: string[];
}

export const DEFAULT_FILE_IO: FileIoOptions = {
  maxReadBytes: 8 * 1024 * 1024,
  maxWriteBytes: 64 * 1024 * 1024,
  extensions: ['.sql', '.txt', '.json', '.csv', '.tsv', '.md', '.log'],
};

/** 配置收敛：数字钳到 >=1，扩展名统一小写+带点去重；非法值回退默认 */
export function normalizeFileIoOptions(input?: Partial<FileIoOptions> | null): FileIoOptions {
  const cap = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.floor(n);
  };
  const exts = (() => {
    const raw = input?.extensions;
    if (!Array.isArray(raw)) return DEFAULT_FILE_IO.extensions;
    const list = raw
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.trim().toLowerCase())
      .map((e) => (e.startsWith('.') ? e : `.${e}`))
      .filter((e) => e.length > 1);
    return list.length > 0 ? [...new Set(list)] : DEFAULT_FILE_IO.extensions;
  })();
  return {
    maxReadBytes: cap(input?.maxReadBytes, DEFAULT_FILE_IO.maxReadBytes),
    maxWriteBytes: cap(input?.maxWriteBytes, DEFAULT_FILE_IO.maxWriteBytes),
    extensions: exts,
  };
}

/** Windows 保留设备名（不分大小写；带扩展名同样保留，如 con.txt） */
const DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 平台相关的路径比较归一（Windows 大小写不敏感，对齐 normalizeProjectKey 的做法） */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 相对路径的静态检查：绝对路径、盘符、UNC/设备前缀、ADS 冒号、`..`、设备名 */
function assertRelativePath(relPath: string): string {
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (raw === '') throw new DbToolError('INVALID_PATH', 'Path is empty: pass a file path relative to the project folder');
  if (raw.includes('\0')) throw new DbToolError('INVALID_PATH', 'Path contains a NUL byte');
  // 绝对路径：path.isAbsolute 覆盖当前平台形态；盘符/UNC/设备前缀单独判，
  // 保证在 POSIX 上也不会把 "C:\Windows\win.ini" 当成普通文件名。
  if (
    path.isAbsolute(raw) ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.startsWith('\\') ||
    raw.startsWith('//')
  ) {
    throw new DbToolError('INVALID_PATH', `Path must be relative to the project folder: ${raw}`);
  }
  // 冒号在 Windows 上是盘符或 ADS（file.txt:stream），一律拒绝
  if (raw.includes(':')) {
    throw new DbToolError('INVALID_PATH', `Path must not contain ':': ${raw}`);
  }
  const segments = raw.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) throw new DbToolError('INVALID_PATH', `Path does not name a file: ${raw}`);
  if (segments.some((s) => s === '..')) {
    throw new DbToolError('PATH_OUTSIDE_PROJECT', `Path must not contain '..': ${raw}`);
  }
  for (const seg of segments) {
    const stem = seg.split('.')[0]?.toLowerCase() ?? '';
    if (DEVICE_NAMES.has(stem)) {
      throw new DbToolError('INVALID_PATH', `Path uses a reserved device name: ${seg}`);
    }
  }
  return segments.join(path.sep);
}

/** 前缀校验：child 必须位于 root 之内；allowEqual=true 时允许 child 就是 root（父目录 == 项目根） */
function assertInside(root: string, child: string, shown: string, allowEqual = false): void {
  const rel = path.relative(root, child);
  if (rel === '' && allowEqual) return;
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DbToolError(
      rel === ''
        ? 'INVALID_PATH'
        : 'PATH_OUTSIDE_PROJECT',
      rel === ''
        ? `Path must name a file inside the project folder, not the folder itself: ${shown}`
        : `Path resolves outside the project folder: ${shown}`,
    );
  }
}

export interface ResolvedFile {
  /** 绝对路径（已确认位于项目内） */
  full: string;
  /** 归一化后的相对路径，正斜杠分隔（审计与回显用） */
  rel: string;
}

/**
 * 唯一的路径解析入口：静态检查 → 拼接 → 前缀校验 → 符号链接与父目录校验。
 * createDirs=true 时按需创建父目录，并在创建后用 realpath 再验一次前缀。
 */
export function resolveInsideProject(
  projectPath: string,
  relPath: string,
  opts: { createDirs?: boolean; extensions?: string[] } = {},
): ResolvedFile {
  const root = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (root === '') {
    throw new DbToolError(
      'UNAUTHORIZED_PROJECT',
      'Project path is empty: fill in the current project path at the top of the panel (or reopen the sidebar so the plugin resolves it automatically) before reading or writing files',
    );
  }
  const rel = assertRelativePath(relPath);
  const full = path.resolve(root, rel);
  assertInside(root, full, relPath);

  // 扩展名白名单：读写两侧都卡，避免借 .exe/.ps1 落盘再执行
  const allowed = opts.extensions ?? DEFAULT_FILE_IO.extensions;
  const ext = path.extname(full).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new DbToolError(
      'EXTENSION_DENIED',
      `File extension ${ext === '' ? '(none)' : ext} is not allowed here; allowed: ${allowed.join(', ')}`,
    );
  }

  // 目标文件本身：存在且为符号链接 → 拒绝（文件可指向项目外）
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(full);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) {
    throw new DbToolError('SYMLINK_DENIED', `Refusing to touch a symbolic link: ${relPath}`);
  }
  if (existing && !existing.isFile()) {
    throw new DbToolError('INVALID_PATH', `Path is not a regular file: ${relPath}`);
  }

  // 父目录：不存在时只有 createDirs=true 才创建；存在时 realpath 后重验前缀
  const dir = path.dirname(full);
  const rootReal = realpathOrSelf(root);
  let dirExists = false;
  try {
    const st = fs.statSync(dir);
    dirExists = st.isDirectory();
    if (!dirExists) throw new DbToolError('PARENT_MISSING', `Parent path is not a directory: ${path.relative(root, dir) || '.'}`);
  } catch (e) {
    if (e instanceof DbToolError) throw e;
    dirExists = false;
  }
  if (!dirExists) {
    if (opts.createDirs !== true) {
      throw new DbToolError(
        'PARENT_MISSING',
        `Parent folder does not exist: ${path.relative(root, dir) || '.'} (pass create_dirs=true to create it inside the project)`,
      );
    }
    fs.mkdirSync(dir, { recursive: true });
  }
  // realpath 必须仍在项目 realpath 之内：挡住「项目内链接目录 → 项目外」的写法。
  // 父目录等于项目根是正常情况（文件直接放在项目里），故允许相等。
  const dirReal = realpathOrSelf(dir);
  assertInside(foldCase(rootReal), foldCase(dirReal), relPath, true);

  return { full, rel: path.relative(root, full).split(path.sep).join('/') };
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** 统一的 fs 错误翻译（EEXIST 单独处理为 FILE_EXISTS） */
function fsError(e: unknown, relPath: string): DbToolError {
  if (e instanceof DbToolError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'EEXIST') return new DbToolError('FILE_EXISTS', `File already exists: ${relPath} (pass overwrite=true to replace it)`);
  if (err?.code === 'ENOENT') return new DbToolError('FILE_NOT_FOUND', `File not found: ${relPath}`);
  return new DbToolError('DRIVER_ERROR', `File operation failed for ${relPath}: ${err?.message ?? String(e)}`);
}

export interface ReadFileResult extends ResolvedFile {
  text: string;
  bytes: number;
  md5: string;
}

/** 读取项目内文本文件：大小先判（不读进内存），内容按 UTF-8 原样返回 */
export function readProjectFile(
  projectPath: string,
  relPath: string,
  options: FileIoOptions,
): ReadFileResult {
  const resolved = resolveInsideProject(projectPath, relPath, { extensions: options.extensions });
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.full);
  } catch (e) {
    throw fsError(e, relPath);
  }
  if (st.size > options.maxReadBytes) {
    throw new DbToolError(
      'FILE_TOO_LARGE',
      `File is ${st.size} bytes, above the read limit of ${options.maxReadBytes} bytes: ${relPath}`,
    );
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved.full);
  } catch (e) {
    throw fsError(e, relPath);
  }
  return {
    ...resolved,
    text: buf.toString('utf8'),
    bytes: buf.length,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
  };
}

export interface WriteFileResult extends ResolvedFile {
  bytes: number;
  md5: string;
}

/**
 * 写入项目内文件（UTF-8，无 BOM）。
 * overwrite=false 走 'wx'（O_CREAT|O_EXCL）：文件已存在时由内核拒绝，无检查-写入竞态。
 */
export function writeProjectFile(
  projectPath: string,
  relPath: string,
  data: string | Buffer,
  opts: { overwrite?: boolean; createDirs?: boolean; options: FileIoOptions },
): WriteFileResult {
  const resolved = resolveInsideProject(projectPath, relPath, {
    createDirs: opts.createDirs === true,
    extensions: opts.options.extensions,
  });
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (buf.length > opts.options.maxWriteBytes) {
    throw new DbToolError(
      'FILE_TOO_LARGE',
      `Payload is ${buf.length} bytes, above the write limit of ${opts.options.maxWriteBytes} bytes: ${relPath}`,
    );
  }
  try {
    fs.writeFileSync(resolved.full, buf, { flag: opts.overwrite === true ? 'w' : 'wx' });
  } catch (e) {
    throw fsError(e, relPath);
  }
  return { ...resolved, bytes: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex') };
}

/**
 * 写之前的快速预检：路径合法、父目录可用、overwrite=false 时目标不存在。
 * 只用于「先跑查询前就失败」的早退；真正的排他性仍由写时的 O_EXCL 保证。
 */
export function preflightWrite(
  projectPath: string,
  relPath: string,
  opts: { overwrite?: boolean; createDirs?: boolean; options: FileIoOptions },
): ResolvedFile {
  const resolved = resolveInsideProject(projectPath, relPath, {
    createDirs: opts.createDirs === true,
    extensions: opts.options.extensions,
  });
  if (opts.overwrite !== true && fs.existsSync(resolved.full)) {
    throw new DbToolError('FILE_EXISTS', `File already exists: ${relPath} (pass overwrite=true to replace it)`);
  }
  return resolved;
}

/* ---------------- 数据库结果 → 文件内容 ---------------- */
export type ExportFormat = 'text' | 'json' | 'csv';

export function normalizeExportFormat(v: unknown): ExportFormat {
  return v === 'json' || v === 'csv' || v === 'text' ? v : 'text';
}

/** 标量要求：text 格式只接受 1 行 × 1 列，返回原始字符串（不做换行归一） */
export function scalarOf(columns: string[], rows: unknown[][], allowEmpty: boolean): string {
  if (rows.length === 0) {
    if (allowEmpty) return '';
    throw new DbToolError('EMPTY_RESULT', 'The query returned no rows, so there is nothing to export (pass allow_empty=true to write an empty file)');
  }
  if (rows.length !== 1 || columns.length !== 1) {
    throw new DbToolError(
      'NOT_SCALAR',
      `format=text requires exactly one row and one column, got ${rows.length} row(s) × ${columns.length} column(s); use format=json or format=csv`,
    );
  }
  const cell = rows[0]?.[0];
  if (cell === null || cell === undefined) {
    if (allowEmpty) return '';
    throw new DbToolError('EMPTY_RESULT', 'The query returned NULL, so there is nothing to export (pass allow_empty=true to write an empty file)');
  }
  return typeof cell === 'string' ? cell : String(cell);
}

/** RFC 4180：字段含引号/逗号/换行时加引号，内部引号翻倍；行尾 CRLF */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const head = columns.map((c) => csvField(c)).join(',');
  const body = rows.map((row) => columns.map((_, i) => csvField(row[i])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

export function toJson(rows: unknown[][]): string {
  return JSON.stringify(rows, null, 2) + '\n';
}
