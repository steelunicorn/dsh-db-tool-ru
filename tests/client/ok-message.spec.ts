/**
 * 面板顶部绿条（成功回执）的语义与时效（源码断言，离线）：
 *  1) 回执带主语：save / del / export / import / grant / grantdb 各映射到专属文案，不再是一句「完成」；
 *  2) 3 秒后自动收起，避免绿字长期挂在面板上；
 *  3) 切页签立即清空，避免回执跟着用户跑到无关面板。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'client', 'client.js'), 'utf8');

const ACTIONS = ['save', 'del', 'export', 'import', 'grant', 'grantdb'];
const KEYS = ['okSaved', 'okDeleted', 'okExported', 'okImported', 'okGrant', 'okGrantDb'];

/** 取出某个词典对象（const zh/en/ru = {…};），值都是纯字符串字面量，可直接求值 */
function dict(name: string): Record<string, string> {
	const start = src.indexOf(`const ${name} = {`);
	expect(start, `缺少 ${name} 词典`).toBeGreaterThan(-1);
	const end = src.indexOf('\n\t\t};', start);
	expect(end, `${name} 词典未闭合`).toBeGreaterThan(start);
	const body = src.slice(src.indexOf('{', start), end) + '}';
	return new Function(`return ${body};`)() as Record<string, string>;
}

describe('1 成功回执带主语', () => {
	it('RUN_DONE 覆盖六个动作，且每个键在三种语言里都有文案', () => {
		const runDone = /const RUN_DONE = \{([\s\S]*?)\n\t\t\};/.exec(src);
		expect(runDone, '缺少 RUN_DONE 动作→文案映射').toBeTruthy();
		for (const action of ACTIONS) {
			expect(runDone![1]).toMatch(new RegExp(`\\b${action}: "`));
		}
		for (const [lang, table] of [['zh', dict('zh')], ['en', dict('en')], ['ru', dict('ru')]] as const) {
			for (const key of KEYS) {
				expect(table[key], `${lang} 缺少 ${key}`).toBeTruthy();
				// 主语必须在：不能与通用 ok 文案相同
				expect(table[key], `${lang}.${key} 退化成通用回执`).not.toBe(table['ok']);
			}
		}
	});

	it('run() 用动作名解析文案，成功路径不再固定 t("ok")', () => {
		expect(src).toContain('setMessage(t(RUN_DONE[name] || "ok"))');
		expect(src).not.toContain('.then(() => setMessage(t("ok")))');
	});
});

describe('2 回执自动收起', () => {
	it('3 秒后清空，并在依赖变化时清理定时器（不泄漏）', () => {
		const block = /if \(!message\) return undefined;([\s\S]{0,220}?)\}, \[message\]\);/.exec(src);
		expect(block, '缺少成功回执的定时清理副作用').toBeTruthy();
		expect(block![1]).toContain('setTimeout(() => setMessage(""), 3000)');
		expect(block![1]).toContain('clearTimeout(id)');
	});
});

describe('3 切页签立即清空', () => {
	it('view 变化时清掉回执，绿字不跨面板残留', () => {
		expect(src).toMatch(/React\.useEffect\(\(\) => \{\s*setMessage\(""\);\s*\}, \[view\]\);/);
	});
});
