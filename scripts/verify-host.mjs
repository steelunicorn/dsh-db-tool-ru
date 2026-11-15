/**
 * 独立验证：模拟 DSH host 的插件加载路径（cordis + 四个注入服务 stub），
 * 验证 dist/index.js 的 apply 全链走通（register 收到 prefix 路由、工具注册、effect 挂载）。
 * DSH_HOME 指向临时目录，不触碰真实 ~/.dsh。
 *
 * 用法：node scripts/verify-host.mjs [dist/index.js 路径]
 * 缺省加载本仓库 dist/index.js；也可指向已安装副本，例如
 * node scripts/verify-host.mjs node_modules/dsh-db-tool-ru/dist/index.js
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-verify-home-'));

const require = createRequire(import.meta.url);
const cordisPath = require.resolve('@deepseek-ai/cordis');
const { Context } = await import(pathToFileURL(cordisPath).href);

const registered = { routes: [], tools: [], effects: [] };

const app = new Context();
app.provide('webServer', {
	register(h) {
		registered.routes.push(h);
		return () => registered.routes.splice(registered.routes.indexOf(h), 1);
	},
});
app.provide('sessions', { get: () => ({ header: { cwd: process.cwd() } }) });
app.provide('tools', {
	register(tool) {
		registered.tools.push(tool);
	},
});
app.provide('webRuntime', { trustedHosts: [] });
// inject 里的 connection 是宿主栅栏服务；stub 成「不拒绝」即可让 apply 真正跑起来
app.provide('connection', { requestRejection: () => undefined });

const entry = path.resolve(process.argv[2] ?? 'dist/index.js');
const plugin = await import(pathToFileURL(entry).href);
await app.plugin(plugin.default ?? plugin);
await new Promise((r) => setTimeout(r, 200));

console.log('entry:', entry);
console.log('routes:', registered.routes.map((h) => `${h.kind}:${h.path}`));
console.log('tools:', registered.tools.map((t) => t.name));

if (registered.routes.length === 0 || registered.tools.length === 0) {
	console.error('FAIL: apply 未完成注册');
	process.exit(1);
}

// 直呼工具 execute（模拟模型调用，走真实 guard/store 链路）
const tool = registered.tools[0];
const list = await tool.execute({ action: 'list_connections' }, { agent: { session: { id: 's1' } } });
const text = typeof list === 'string' ? list : JSON.stringify(list);
console.log('tool execute list_connections →', text.slice(0, 160));

console.log('HOST APPLY OK');
process.exit(0);
