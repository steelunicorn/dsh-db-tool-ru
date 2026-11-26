/** DbToolService 构造默认值、DbToolError 契约、create_connection 审计 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DbToolError, DbToolService, type NeedConfirm } from '../../lib/manager.js';
import { DbToolStore, normalizeProjectKey } from '../../lib/store/index.js';
import { CONN_ID, CONN_URL, fakeAdapter, makeFixture } from './fixture.js';
import { cleanupDir, makeTempHome } from '../store/helpers.js';

function isConfirm(v: unknown): v is NeedConfirm {
  return Boolean(v && typeof v === 'object' && (v as NeedConfirm).needConfirmation === true);
}

describe('DbToolService: 构造与错误契约', () => {
  it('DbToolError.name 固定为 DbToolError', () => {
    expect(new DbToolError('NOT_FOUND', 'x').name).toBe('DbToolError');
  });

  it('必填参数为空白或非字符串 → INVALID_ARGUMENT，消息含字段名', async () => {
    const fx = await makeFixture('rw');
    try {
      await expect(fx.service.query(fx.projectA, CONN_ID, '   ')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'Missing required parameter: sql',
      });
      await expect(
        fx.service.query(fx.projectA, CONN_ID, undefined as unknown as string),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'Missing required parameter: sql',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('默认构造（不传 opts）成功，listConnections 与默认 ChallengeStore 可用', () => {
    const home = makeTempHome();
    let service: DbToolService | undefined;
    try {
      const store = new DbToolStore(home);
      store.connections.create({ id: CONN_ID, kind: 'mysql', url: CONN_URL });
      service = new DbToolService(store);
      expect(service.listConnections().map((m) => m.id)).toEqual([CONN_ID]);
      expect(service.challenges).toBeDefined();
    } finally {
      void service?.dispose();
      cleanupDir(home);
    }
  });

  it('仅注入 adapterResolver（不传 challenges）→ 默认 ChallengeStore 走危险确认流程', async () => {
    const home = makeTempHome();
    let service: DbToolService | undefined;
    try {
      const store = new DbToolStore(home);
      store.connections.create({ id: CONN_ID, kind: 'mysql', url: CONN_URL });
      const projectA = path.join(os.tmpdir(), 'dbt-test-proj-a');
      store.grants.grant(normalizeProjectKey(projectA), CONN_ID, 'rw');
      service = new DbToolService(store, {
        adapterResolver: async () => (conn) => Promise.resolve(fakeAdapter({ connId: conn.meta.id })),
      });

      const r = await service.execute(projectA, CONN_ID, 'DROP TABLE t'); // DDL → danger → 需确认
      expect(isConfirm(r)).toBe(true);
      expect((r as NeedConfirm).challengeId).toBeTruthy();
      expect((r as NeedConfirm).danger).toBe('danger');
    } finally {
      await service?.dispose();
      cleanupDir(home);
    }
  });

  it('createConnection 写入审计：projectPathKey 为空、ok=true、confirmed=false', async () => {
    const fx = await makeFixture('rw');
    try {
      fx.service.createConnection({ id: 'c9', kind: 'mysql', url: CONN_URL });
      const last = fx.store.audit.tail(1)[0];
      expect(last).toMatchObject({
        projectPathKey: '',
        connId: 'c9',
        action: 'create_connection',
        statement: 'c9',
        danger: 'none',
        confirmed: false,
        ok: true,
      });
    } finally {
      await fx.dispose();
    }
  });

  it('testDraft 带 connId：编辑场景拼回已存机密（url 未改动→原 url；密码留空→原密码），绝不回传客户端', async () => {
    const fx = await makeFixture('rw');
    try {
      // 连接 c1 以 url 方式创建（CONN_URL 含密码 s3cret），另建一个分字段连接
      fx.service.createConnection({
        id: 'cf', kind: 'mysql',
        fields: { host: 'h1', port: 3306, user: 'app', password: 'FIELDSECRET' },
      });
      const seen: { url?: string; fields?: Record<string, unknown>; metaId?: string } = {};
      const svc = new DbToolService(fx.store, {
        adapterResolver: async () => async (conn) => {
          seen.url = conn.url;
          seen.fields = conn.fields;
          seen.metaId = conn.meta.id;
          return fakeAdapter({ connId: conn.meta.id });
        },
      });
      try {
        // url 模式编辑、url 未改动（不发 url）→ 拼回已存 url
        await svc.testDraft({ kind: 'mysql', connId: CONN_ID });
        expect(seen.url).toBe(CONN_URL);
        expect(seen.metaId).toBe(CONN_ID);
        // fields 模式编辑、密码留空 → 拼回已存密码；用户手改 host 保留
        await svc.testDraft({ kind: 'mysql', connId: 'cf', fields: { host: 'h2', user: 'app' } });
        expect(seen.fields).toEqual({ host: 'h2', user: 'app', password: 'FIELDSECRET' });
        // 密码手改 → 用新密码不覆盖
        await svc.testDraft({ kind: 'mysql', connId: 'cf', fields: { host: 'h1', password: 'NEWPASS' } });
        expect(seen.fields).toEqual({ host: 'h1', password: 'NEWPASS' });
        // 不传 connId → 纯草稿不拼回（原行为）
        await svc.testDraft({ kind: 'mysql', fields: { host: 'h1', user: 'app' } });
        expect(seen.fields).toEqual({ host: 'h1', user: 'app' });
        // 返回值只是测试结果，无机密泄漏面
      } finally {
        await svc.dispose();
      }
    } finally {
      await fx.dispose();
    }
  });
});

describe('DbToolService: 连接导出/导入', () => {
  it('round-trip：导出 → 删除 → 导入恢复（含机密）', async () => {
    const fx = await makeFixture('rw');
    try {
      const json = fx.service.exportConnections('口令-12345');
      expect(typeof json).toBe('string');
      // 密文不得含明文机密
      expect(json).not.toContain('s3cret');
      expect(json).not.toContain(CONN_URL);

      // 删除连接后导入恢复
      expect(fx.service.removeConnection(CONN_ID)).toBe(true);
      expect(fx.service.listConnections()).toHaveLength(0);

      const summary = fx.service.importConnections(json, '口令-12345');
      expect(summary.imported).toBe(1);
      expect(summary.errors).toEqual([]);
      const restored = fx.service.listConnections();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.id).toBe(CONN_ID);
      // 机密一并恢复（testTarget 能拼回真实 URL）
      expect(fx.store.connections.testTarget(CONN_ID).url).toBe(CONN_URL);
    } finally {
      await fx.dispose();
    }
  });

  it('错口令导入 → INVALID_ARGUMENT（口令错误或文件已损坏）', async () => {
    const fx = await makeFixture('rw');
    try {
      const json = fx.service.exportConnections('正确口令-abc');
      expect(() => fx.service.importConnections(json, '错误口令-abc')).toThrowError(
        expect.objectContaining({
          code: 'INVALID_ARGUMENT',
          message: 'Incorrect passphrase or corrupted file',
        }) as Error,
      );
    } finally {
      await fx.dispose();
    }
  });

  it('空口令导出/空参数导入 → INVALID_ARGUMENT', async () => {
    const fx = await makeFixture('rw');
    try {
      expect(() => fx.service.exportConnections('')).toThrowError(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }) as Error,
      );
      expect(() => fx.service.importConnections('', 'pass-1234')).toThrowError(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }) as Error,
      );
      expect(() => fx.service.importConnections('{}', '')).toThrowError(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }) as Error,
      );
    } finally {
      await fx.dispose();
    }
  });

  it('导出与导入均写审计（记条数，不落口令）', async () => {
    const fx = await makeFixture('rw');
    try {
      const json = fx.service.exportConnections('秘密口令-abc');
      let last = fx.store.audit.tail(1)[0];
      expect(last).toMatchObject({
        projectPathKey: '',
        action: 'export_connections',
        danger: 'none',
        ok: true,
      });
      expect(last?.statement).toContain('1');
      expect(last?.statement).not.toContain('秘密口令');

      fx.service.removeConnection(CONN_ID);
      fx.service.importConnections(json, '秘密口令-abc');
      last = fx.store.audit.tail(1)[0];
      expect(last).toMatchObject({
        projectPathKey: '',
        action: 'import_connections',
        danger: 'none',
        ok: true,
      });
      expect(last?.statement).toContain('1');
      expect(last?.statement).not.toContain('秘密口令');
    } finally {
      await fx.dispose();
    }
  });
});

describe('DbToolService: searchTables 跨库表搜索', () => {
  it('适配器原生 searchTables：透传 trim 后 keyword 与 database，limit 钳 1..200，审计落 search_tables', async () => {
    const seen: { kw?: string; db?: string; limit?: number } = {};
    const fx = await makeFixture('rw', {
      searchTables: async (kw, database, limit) => {
        seen.kw = kw;
        seen.db = database;
        seen.limit = limit;
        return [
          { database: database ?? 'app', name: 'orders', type: 'TABLE' },
          { database: database ?? 'app', name: 'order_items', type: 'TABLE' },
          { database: database ?? 'app', name: 'users', type: 'TABLE' },
        ];
      },
    });
    try {
      const hits = await fx.service.searchTables(fx.projectA, CONN_ID, '  order  ', undefined, 9999);
      expect(seen).toEqual({ kw: 'order', db: undefined, limit: 200 });
      expect(hits).toHaveLength(3);
      expect(hits[0]).toMatchObject({ database: 'app', name: 'orders' });
      // 未传 limit → 默认 100
      await fx.service.searchTables(fx.projectA, CONN_ID, 'order');
      expect(seen.limit).toBe(100);
      const last = fx.store.audit.tail(1)[0];
      expect(last).toMatchObject({ action: 'search_tables', danger: 'none', ok: true });
      expect(last?.statement).toContain('order');
      expect(last?.rowsAffected).toBe(3);
    } finally {
      await fx.dispose();
    }
  });

  it('无原生实现 + 限定库 → listTables+filterTables 回退（大小写不敏感；空关键词 INVALID_ARGUMENT）', async () => {
    const fx = await makeFixture('rw');
    try {
      const hits = await fx.service.searchTables(fx.projectA, CONN_ID, 'USERS', 'app');
      expect(hits).toEqual([{ database: 'app', name: 'users', type: 'TABLE' }]);
      expect(await fx.service.searchTables(fx.projectA, CONN_ID, 'nope', 'app')).toEqual([]);
      await expect(fx.service.searchTables(fx.projectA, CONN_ID, '   ')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('非白名单 kind（redis 语义不兼容）不走回退 → 返回空而非错标来源', async () => {
    const fx = await makeFixture('rw', { kind: 'redis' });
    try {
      // 若误走回退，fake adapter 的 app/test 两库会各返回 users 两条；断言空即白名单生效
      expect(await fx.service.searchTables(fx.projectA, CONN_ID, 'users')).toEqual([]);
    } finally {
      await fx.dispose();
    }
  });
});

describe('DbToolService: 数据库级授权白名单', () => {
  it('databases 白名单限定可用库；未列入 → DATABASE_NOT_GRANTED；空数组＝一个库都不允许', async () => {
    const fx = await makeFixture('rw');
    try {
      // 入口归一化项目键；undefined 表示保持既有清单，数组表示覆盖
      fx.store.grants.grant(fx.projectA, CONN_ID, 'rw', ['app']);
      expect(fx.service.grantsFor(fx.projectA)).toEqual([{ connId: CONN_ID, mode: 'rw', databases: ['app'] }]);

      const allowed = await fx.service.query(fx.projectA, CONN_ID, 'SELECT 1', undefined, undefined, 'app');
      expect(allowed).toMatchObject({ rowCount: 1 });

      await expect(
        fx.service.query(fx.projectA, CONN_ID, 'SELECT 1', undefined, undefined, 'test'),
      ).rejects.toMatchObject({ code: 'DATABASE_NOT_GRANTED' });

      // 空数组 = 显式关闭该连接的所有库；省略参数才是保持既有清单
      fx.store.grants.grant(fx.projectA, CONN_ID, 'rw', []);
      expect(fx.service.grantsFor(fx.projectA)).toEqual([{ connId: CONN_ID, mode: 'rw', databases: [] }]);
      await expect(
        fx.service.query(fx.projectA, CONN_ID, 'SELECT 1', undefined, undefined, 'test'),
      ).rejects.toMatchObject({ code: 'DATABASE_NOT_GRANTED' });
      await expect(
        fx.service.query(fx.projectA, CONN_ID, 'SELECT 1', undefined, undefined, 'app'),
      ).rejects.toMatchObject({ code: 'DATABASE_NOT_GRANTED' });
      // 库清单也只返回空集
      expect(await fx.service.databases(fx.projectA, CONN_ID)).toEqual([]);

      // 撤销该连接的授权后才能回到「无限制」的旧形态（字段缺省）
      fx.store.grants.revoke(fx.projectA, CONN_ID);
      fx.store.grants.grant(fx.projectA, CONN_ID, 'rw');
      await expect(
        fx.service.query(fx.projectA, CONN_ID, 'SELECT 1', undefined, undefined, 'test'),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await fx.dispose();
    }
  });

  it('库清单入口不被白名单收窄：默认库被排除时仍可打开清单（grantDatabases 给全集）', async () => {
    const fx = await makeFixture('rw');
    try {
      // 连接默认库 app 被白名单排除：databases() 只回授权库，但不得因此报 DATABASE_NOT_GRANTED，
      // 否则授权面板里既看不到 app 也无法把它勾回来（白名单编辑死锁）。
      fx.store.connections.create({
        id: 'c2',
        kind: 'mysql',
        name: 'with-default-db',
        fields: { host: '127.0.0.1', port: 3306, user: 'root', password: 's3cret', database: 'app' },
      });
      fx.store.grants.grant(fx.projectA, 'c2', 'rw', ['test']);

      await expect(fx.service.databases(fx.projectA, 'c2')).resolves.toEqual(['test']);
      await expect(fx.service.grantDatabases(fx.projectA, 'c2')).resolves.toEqual(['app', 'test']);

      // 具体库操作仍按白名单裁决（不带 database 时回退连接默认库 app）
      await expect(fx.service.query(fx.projectA, 'c2', 'SELECT 1')).rejects.toMatchObject({
        code: 'DATABASE_NOT_GRANTED',
      });
      await expect(
        fx.service.query(fx.projectA, 'c2', 'SELECT 1', undefined, undefined, 'test'),
      ).resolves.toMatchObject({ rowCount: 1 });

      // 列出全集同样要求项目授权，不能当连接探测口子
      await expect(fx.service.grantDatabases(fx.projectB, 'c2')).rejects.toMatchObject({
        code: 'UNAUTHORIZED_PROJECT',
      });
    } finally {
      await fx.dispose();
    }
  });

  it('内容搜索同样受白名单约束：未授权库 → DATABASE_NOT_GRANTED，不得借搜索绕开', async () => {
    const fx = await makeFixture('rw', {
      searchRows: async () => ({ columns: ['id'], rows: [[1]], rowCount: 1 }),
      countRows: async () => 1,
    });
    try {
      fx.store.grants.grant(fx.projectA, CONN_ID, 'rw', ['app']);
      // 白名单内的库照常搜索
      await expect(
        fx.service.previewSearch(fx.projectA, CONN_ID, 'users', 'alice', 10, 'app', 0),
      ).resolves.toBeTruthy();
      // 白名单外：authorize 在连接前就拦下，绝不触达适配器
      await expect(
        fx.service.previewSearch(fx.projectA, CONN_ID, 'users', 'alice', 10, 'test', 0),
      ).rejects.toMatchObject({ code: 'DATABASE_NOT_GRANTED' });
    } finally {
      await fx.dispose();
    }
  });
});
