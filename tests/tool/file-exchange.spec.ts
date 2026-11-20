/**
 * 文件交换（export_to_file / execute_file / run_script 的 file.save 桥）。
 * 全部离线：假适配器 + 临时 home + 临时项目目录，真实读写文件系统（路径校验必须在真实 fs 上验证）。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DbToolService } from '../../lib/manager.js';
import type { ExportFileResult } from '../../lib/manager.js';
import { normalizeProjectKey, DbToolStore } from '../../lib/store/index.js';
import { ChallengeStore } from '../../lib/guard/index.js';
import type { ExecResult, NormalizedCell, QueryResult } from '../../lib/adapters/types.js';
import type { FileIoOptions } from '../../lib/fileio.js';
import { CONN_ID, CONN_URL, fakeAdapter, type FakeAdapterOptions } from './fixture.js';
import { cleanupDir, makeTempHome } from '../store/helpers.js';

const md5 = (buf: string | Buffer): string => crypto.createHash('md5').update(buf).digest('hex');

interface FileFixture {
  home: string;
  dir: string;
  store: DbToolStore;
  service: DbToolService;
  /** 适配器实际收到的语句（验证 execute_file 不做裁剪） */
  seen: { statements: string[]; queries: string[] };
  dispose: () => Promise<void>;
}

function makeFileFixture(
  mode: 'ro' | 'rw',
  options?: {
    fileIo?: Partial<FileIoOptions>;
    scriptFileBridge?: boolean;
    adapter?: FakeAdapterOptions;
  },
): FileFixture {
  const home = makeTempHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-file-'));
  const store = new DbToolStore(home);
  store.connections.create({ id: CONN_ID, kind: 'mysql', url: CONN_URL });
  store.grants.grant(normalizeProjectKey(dir), CONN_ID, mode);
  const seen = { statements: [] as string[], queries: [] as string[] };
  const base = options?.adapter;
  const service = new DbToolService(store, {
    adapterResolver: async () => async (conn) =>
      fakeAdapter({
        ...base,
        connId: conn.meta.id,
        ...(base?.query !== undefined
          ? { query: base.query }
          : {}),
        ...(base?.execute !== undefined
          ? { execute: base.execute }
          : {}),
      }),
    challenges: new ChallengeStore({ sweepIntervalMs: 0 }),
    fileIo: options?.fileIo,
    scriptFileBridge: options?.scriptFileBridge,
  });
  // 记录语句的包装：直接替换 store 里连接查询不现实，改为在用例里传自定义适配器
  return {
    home,
    dir,
    store,
    service,
    seen,
    dispose: async () => {
      await service.dispose();
      cleanupDir(home);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function queryRows(columns: string[], rows: NormalizedCell[][]): FakeAdapterOptions['query'] {
  return async (): Promise<QueryResult> => ({ columns, rows, rowCount: rows.length });
}

const TEXT = 'create or replace function f() returns int\r\n-- комментарий «тест», кириллица\r\nas $$ select 1; $$ language sql;\r\n';

describe('export_to_file: text', () => {
  it('байт-в-байт: CRLF и кириллица сохраняются, перевод строки не добавляется, md5 совпадает', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [[TEXT]]) } });
    try {
      const r = await fx.service.exportToFile(fx.dir, CONN_ID, 'select pg_get_functiondef(1) as d', {
        path: 'out/fn.sql',
        format: 'text',
        createDirs: true,
      });
      const bytes = fs.readFileSync(path.join(fx.dir, 'out', 'fn.sql'));
      expect(bytes.toString('utf8')).toBe(TEXT);
      expect(bytes.length).toBe(Buffer.byteLength(TEXT, 'utf8'));
      expect(r).toMatchObject({ path: 'out/fn.sql', bytes: bytes.length, md5: md5(bytes), rows: 1, format: 'text' });
      // повторный экспорт того же текста даёт тот же md5 (идемпотентность файла)
      const again = await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', {
        path: 'out/fn.sql',
        format: 'text',
        overwrite: true,
      });
      expect((again as ExportFileResult).md5).toBe(md5(bytes));
    } finally {
      await fx.dispose();
    }
  });

  it('файл без завершающего перевода строки не получает его (bytes = длине текста)', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['abc']]) } });
    try {
      const r = await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'a.sql' });
      expect((r as ExportFileResult).bytes).toBe(3);
      expect(fs.readFileSync(path.join(fx.dir, 'a.sql'), 'utf8')).toBe('abc');
    } finally {
      await fx.dispose();
    }
  });

  it('2 строки → NOT_SCALAR; 0 строк → EMPTY_RESULT; allow_empty → пустой файл', async () => {
    const two = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['a'], ['b']]) } });
    try {
      await expect(
        two.service.exportToFile(two.dir, CONN_ID, 'select 1', { path: 'x.sql' }),
      ).rejects.toMatchObject({ code: 'NOT_SCALAR' });
    } finally {
      await two.dispose();
    }
    const empty = makeFileFixture('rw', { adapter: { query: queryRows(['d'], []) } });
    try {
      await expect(
        empty.service.exportToFile(empty.dir, CONN_ID, 'select 1', { path: 'x.sql' }),
      ).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
      const r = await empty.service.exportToFile(empty.dir, CONN_ID, 'select 1', { path: 'x.sql', allowEmpty: true });
      expect(r).toMatchObject({ bytes: 0, rows: 0 });
      expect(fs.existsSync(path.join(empty.dir, 'x.sql'))).toBe(true);
    } finally {
      await empty.dispose();
    }
  });

  it('NULL в скалярном режиме → EMPTY_RESULT (allow_empty → пустой файл)', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [[null]]) } });
    try {
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'n.sql' }),
      ).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
      const r = await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'n.sql', allowEmpty: true });
      expect((r as ExportFileResult).bytes).toBe(0);
    } finally {
      await fx.dispose();
    }
  });

  it('существующий файл → FILE_EXISTS, overwrite=true перезаписывает', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['new']]) } });
    try {
      fs.writeFileSync(path.join(fx.dir, 'b.sql'), 'old', 'utf8');
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'b.sql' }),
      ).rejects.toMatchObject({ code: 'FILE_EXISTS' });
      expect(fs.readFileSync(path.join(fx.dir, 'b.sql'), 'utf8')).toBe('old');
      await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'b.sql', overwrite: true });
      expect(fs.readFileSync(path.join(fx.dir, 'b.sql'), 'utf8')).toBe('new');
    } finally {
      await fx.dispose();
    }
  });
});

describe('export_to_file: json / csv', () => {
  it('json — массив строк с отступом 2 и завершающим \\n', async () => {
    const rows = [[1, 'a'], [2, null]];
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['id', 'name'], rows) } });
    try {
      const r = await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'r.json', format: 'json' });
      expect(fs.readFileSync(path.join(fx.dir, 'r.json'), 'utf8')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
      expect((r as ExportFileResult).rows).toBe(2);
    } finally {
      await fx.dispose();
    }
  });

  it('csv — заголовок, RFC 4180 экранирование, CRLF', async () => {
    const fx = makeFileFixture('rw', {
      adapter: { query: queryRows(['id', 'name'], [[1, 'a,b'], [2, 'q"q'], [3, null]]) },
    });
    try {
      await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'r.csv', format: 'csv' });
      expect(fs.readFileSync(path.join(fx.dir, 'r.csv'), 'utf8')).toBe('id,name\r\n1,"a,b"\r\n2,"q""q"\r\n3,\r\n');
    } finally {
      await fx.dispose();
    }
  });
});

describe('файловые пути: отказы', () => {
  const bad: Array<[string, string]> = [
    ['..\\..\\secret.json', 'PATH_OUTSIDE_PROJECT'],
    ['../secret.json', 'PATH_OUTSIDE_PROJECT'],
    ['C:\\Windows\\win.ini', 'INVALID_PATH'],
    ['\\\\?\\C:\\x.sql', 'INVALID_PATH'],
    ['/etc/passwd', 'INVALID_PATH'],
    ['CON', 'INVALID_PATH'],
    ['sub\\nul.sql', 'INVALID_PATH'],
    ['ads.sql:stream', 'INVALID_PATH'],
    ['.', 'INVALID_PATH'],
    ['tool.exe', 'EXTENSION_DENIED'],
    ['noext', 'EXTENSION_DENIED'],
  ];
  it.each(bad)('%s → %s', async (relPath, code) => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['x']]) } });
    try {
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: relPath }),
      ).rejects.toMatchObject({ code });
    } finally {
      await fx.dispose();
    }
  });

  it('нет родительской папки → PARENT_MISSING; create_dirs=true создаёт внутри проекта', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['x']]) } });
    try {
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'deep/nested/a.sql' }),
      ).rejects.toMatchObject({ code: 'PARENT_MISSING' });
      const r = await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', {
        path: 'deep/nested/a.sql',
        createDirs: true,
      });
      expect((r as ExportFileResult).path).toBe('deep/nested/a.sql');
      expect(fs.existsSync(path.join(fx.dir, 'deep', 'nested', 'a.sql'))).toBe(true);
    } finally {
      await fx.dispose();
    }
  });

  it('лимиты: маленький maxWriteBytes → FILE_TOO_LARGE, большой файл на чтение → FILE_TOO_LARGE', async () => {
    const fx = makeFileFixture('rw', {
      adapter: { query: queryRows(['d'], [['0123456789']]) },
      fileIo: { maxWriteBytes: 5, maxReadBytes: 5 },
    });
    try {
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'big.sql' }),
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
      fs.writeFileSync(path.join(fx.dir, 'in.sql'), '0123456789', 'utf8');
      await expect(fx.service.executeFile(fx.dir, CONN_ID, { path: 'in.sql' })).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    } finally {
      await fx.dispose();
    }
  });
});

const canSymlink = (): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-sym-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Windows 下 junction 不需要管理员权限，文件符号链接需要（CI/本地可能没有），两者分别探测 */
const canJunction = (): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-junc-'));
  try {
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dir, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('файловые пути: симлинки', () => {
  it.runIf(canSymlink())('файл-симлинк → SYMLINK_DENIED', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['x']]) } });
    try {
      const outside = path.join(os.tmpdir(), `dbt-outside-${Date.now()}.sql`);
      fs.writeFileSync(outside, 'secret', 'utf8');
      fs.symlinkSync(outside, path.join(fx.dir, 'link.sql'));
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'link.sql', overwrite: true }),
      ).rejects.toMatchObject({ code: 'SYMLINK_DENIED' });
      expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
      fs.rmSync(outside, { force: true });
    } finally {
      await fx.dispose();
    }
  });

  it.runIf(canJunction())('папка-симлинк за пределы проекта → PATH_OUTSIDE_PROJECT', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['x']]) } });
    try {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-outdir-'));
      fs.symlinkSync(outsideDir, path.join(fx.dir, 'escape'), 'junction');
      await expect(
        fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'escape/a.sql', overwrite: true }),
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
      expect(fs.readdirSync(outsideDir)).toHaveLength(0);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } finally {
      await fx.dispose();
    }
  });
});

describe('execute_file', () => {
  const ddl = 'create table t (id int);\n';

  it('ro-грант → READ_ONLY', async () => {
    const fx = makeFileFixture('ro');
    try {
      fs.writeFileSync(path.join(fx.dir, 'ddl.sql'), ddl, 'utf8');
      await expect(fx.service.executeFile(fx.dir, CONN_ID, { path: 'ddl.sql' })).rejects.toMatchObject({
        code: 'READ_ONLY',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('DDL без подтверждения → NEEDS_CONFIRMATION; с challenge_id выполняется и возвращает commandtag', async () => {
    const statements: string[] = [];
    const fx = makeFileFixture('rw', {
      adapter: {
        execute: async (statement): Promise<ExecResult> => {
          statements.push(statement);
          return { affectedRows: 0, message: 'ok', commandTag: 'CREATE TABLE' };
        },
      },
    });
    try {
      fs.writeFileSync(path.join(fx.dir, 'ddl.sql'), ddl, 'utf8');
      const first = await fx.service.executeFile(fx.dir, CONN_ID, { path: 'ddl.sql' });
      // 危险语句不走异常：返回 NEEDS_CONFIRMATION 结构（与 execute 一致）
      expect(first).toMatchObject({ needConfirmation: true });
      const challengeId = (first as unknown as { challengeId: string }).challengeId;
      expect(challengeId).toBeTruthy();
      expect(statements).toHaveLength(0);

      const done = await fx.service.executeFile(fx.dir, CONN_ID, { path: 'ddl.sql', challengeId });
      expect(done).toMatchObject({ path: 'ddl.sql', bytes: Buffer.byteLength(ddl, 'utf8'), commandtag: 'CREATE TABLE' });
      expect(statements).toEqual([ddl]);

      // одноразовость: тот же challenge повторно уже недействителен
      await expect(
        fx.service.executeFile(fx.dir, CONN_ID, { path: 'ddl.sql', challengeId }),
      ).rejects.toMatchObject({ code: 'INVALID_CHALLENGE' });
    } finally {
      await fx.dispose();
    }
  });

  it('содержимое передаётся без обрезки trailing whitespace', async () => {
    const statements: string[] = [];
    const fx = makeFileFixture('rw', {
      adapter: {
        execute: async (statement): Promise<ExecResult> => {
          statements.push(statement);
          return { affectedRows: 1, message: 'ok' };
        },
      },
    });
    try {
      const body = 'update t set a = 1;\r\n\r\n   \r\n';
      fs.writeFileSync(path.join(fx.dir, 'upd.sql'), body, 'utf8');
      await fx.service.executeFile(fx.dir, CONN_ID, { path: 'upd.sql' });
      expect(statements).toEqual([body]);
    } finally {
      await fx.dispose();
    }
  });

  it('search_path уходит отдельной инструкцией, файл на диске не меняется', async () => {
    const statements: string[] = [];
    const fx = makeFileFixture('rw', {
      adapter: {
        execute: async (statement): Promise<ExecResult> => {
          statements.push(statement);
          return { affectedRows: 0, message: 'ok', commandTag: 'CREATE FUNCTION' };
        },
      },
    });
    try {
      const body = ddl;
      fs.writeFileSync(path.join(fx.dir, 'fn.sql'), body, 'utf8');

      const first = await fx.service.executeFile(fx.dir, CONN_ID, { path: 'fn.sql', searchPath: ' sys , dbo , sys ' });
      const challengeId = (first as unknown as { challengeId: string }).challengeId;
      expect(challengeId).toBeTruthy();

      const done = await fx.service.executeFile(fx.dir, CONN_ID, { path: 'fn.sql', challengeId, searchPath: 'sys, dbo' });
      expect(done).toMatchObject({ commandtag: 'CREATE FUNCTION' });
      expect(statements).toEqual([`select pg_catalog.set_config('search_path', 'sys, dbo', true);\n${body}`]);
      // файл не переписан: префикс живёт только в тексте инструкции
      expect(fs.readFileSync(path.join(fx.dir, 'fn.sql'), 'utf8')).toBe(body);
      const entry = fx.service.auditTail(fx.dir, 5).find((e) => e.action === 'execute' && e.ok);
      expect(entry?.statement.startsWith('[search_path=sys, dbo]')).toBe(true);

      // пустое значение = обычное поведение без префикса (не-danger инструкция — без подтверждения)
      statements.length = 0;
      const plain = 'update t set a = 1;';
      fs.writeFileSync(path.join(fx.dir, 'upd.sql'), plain, 'utf8');
      await fx.service.executeFile(fx.dir, CONN_ID, { path: 'upd.sql', searchPath: '   ' });
      expect(statements).toEqual([plain]);
    } finally {
      await fx.dispose();
    }
  });

  it('search_path: несовместим с params, кавычки и точки с запятой отклоняются', async () => {
    const fx = makeFileFixture('rw');
    try {
      fs.writeFileSync(path.join(fx.dir, 'fn.sql'), ddl, 'utf8');
      await expect(
        fx.service.executeFile(fx.dir, CONN_ID, { path: 'fn.sql', searchPath: 'public', params: [1] }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(
        fx.service.executeFile(fx.dir, CONN_ID, { path: 'fn.sql', searchPath: '"sys"' }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(
        fx.service.executeFile(fx.dir, CONN_ID, { path: 'fn.sql', searchPath: 'sys; drop table t' }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await fx.dispose();
    }
  });

  it('нет файла → FILE_NOT_FOUND; пустой файл → INVALID_ARGUMENT', async () => {
    const fx = makeFileFixture('rw');
    try {
      await expect(fx.service.executeFile(fx.dir, CONN_ID, { path: 'nope.sql' })).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
      });
      fs.writeFileSync(path.join(fx.dir, 'empty.sql'), ' \r\n\t', 'utf8');
      await expect(fx.service.executeFile(fx.dir, CONN_ID, { path: 'empty.sql' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fx.dispose();
    }
  });
});

describe('аудит файловых операций', () => {
  it('export_file: направление, относительный путь, bytes, md5', async () => {
    const fx = makeFileFixture('rw', { adapter: { query: queryRows(['d'], [['abc']]) } });
    try {
      const r = await fx.service.exportToFile(fx.dir, CONN_ID, 'select 1', { path: 'audit/out.sql', createDirs: true });
      const entry = fx.service.auditTail(fx.dir, 10).find((e) => e.action === 'export_file' && e.ok);
      expect(entry).toBeDefined();
      expect(entry?.file).toMatchObject({ direction: 'export', path: 'audit/out.sql', bytes: 3, md5: (r as ExportFileResult).md5 });
      expect(entry?.statement.length).toBeLessThanOrEqual(201);
    } finally {
      await fx.dispose();
    }
  });

  it('execute_file: SQL в аудите усечён до 200 символов, file.direction = import', async () => {
    const long = `update t set a = '${'x'.repeat(400)}';\n`;
    const fx = makeFileFixture('rw', {
      adapter: { execute: async (): Promise<ExecResult> => ({ affectedRows: 1, message: 'ok' }) },
    });
    try {
      fs.writeFileSync(path.join(fx.dir, 'long.sql'), long, 'utf8');
      await fx.service.executeFile(fx.dir, CONN_ID, { path: 'long.sql' });
      const entry = fx.service.auditTail(fx.dir, 10).find((e) => e.action === 'execute' && e.ok);
      expect(entry?.statement.length).toBe(201); // 200 + '…'
      expect(entry?.statement.endsWith('…')).toBe(true);
      expect(entry?.file).toMatchObject({ direction: 'import', path: 'long.sql', bytes: Buffer.byteLength(long, 'utf8') });
    } finally {
      await fx.dispose();
    }
  });
});

describe('run_script: file.save 桥', () => {
  it('по умолчанию (scriptFileBridge=false) в sandbox нет file', async () => {
    const fx = makeFileFixture('rw');
    try {
      await expect(fx.service.runScript(fx.dir, CONN_ID, 'return typeof file')).resolves.toBe('undefined');
    } finally {
      await fx.dispose();
    }
  });

  it('включённый мост пишет внутри проекта и возвращает bytes/md5', async () => {
    const fx = makeFileFixture('rw', { scriptFileBridge: true });
    try {
      const r = await fx.service.runScript(
        fx.dir,
        CONN_ID,
        'return await file.save("report.txt", "привет")',
      );
      expect(r).toMatchObject({ path: 'report.txt', bytes: Buffer.byteLength('привет', 'utf8') });
      expect(fs.readFileSync(path.join(fx.dir, 'report.txt'), 'utf8')).toBe('привет');
      const entry = fx.service.auditTail(fx.dir, 20).find((e) => e.action === 'script_file_save');
      expect(entry?.file).toMatchObject({ direction: 'save', path: 'report.txt' });
    } finally {
      await fx.dispose();
    }
  });

  it('мост не даёт выйти за пределы проекта', async () => {
    const fx = makeFileFixture('rw', { scriptFileBridge: true });
    try {
      await expect(
        fx.service.runScript(fx.dir, CONN_ID, 'return await file.save("../escape.txt", "x")'),
      ).rejects.toThrow(/outside the project folder|must not contain '\.\.'/);
      expect(fs.existsSync(path.join(path.dirname(fx.dir), 'escape.txt'))).toBe(false);
    } finally {
      await fx.dispose();
    }
  });
});
