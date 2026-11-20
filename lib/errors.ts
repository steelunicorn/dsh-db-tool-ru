/**
 * 机器可读错误：HTTP 层直接映射 {ok:false,error,code}，模型工具层回 {code} 文本。
 *
 * 单独成模块（而非留在 manager.ts）是为了让文件层 lib/fileio.ts 能抛同一类错误，
 * 同时避免 manager ⇄ fileio 的循环导入。manager.ts 继续 re-export，调用方无需改。
 */
export type DbToolErrorCode =
  | 'UNAUTHORIZED_PROJECT'
  | 'READ_ONLY'
  | 'DATABASE_NOT_GRANTED'
  | 'NEEDS_CONFIRMATION'
  | 'INVALID_CHALLENGE'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'DRIVER_ERROR'
  | 'SCRIPT_TIMEOUT'
  /* 文件交换（export_to_file / execute_file / run_script 的 file.save 桥） */
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_PROJECT'
  | 'SYMLINK_DENIED'
  | 'PARENT_MISSING'
  | 'EXTENSION_DENIED'
  | 'FILE_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'FILE_NOT_FOUND'
  | 'NOT_SCALAR'
  | 'EMPTY_RESULT';

export class DbToolError extends Error {
  constructor(
    readonly code: DbToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DbToolError';
  }
}
