/**
 * 「项目授权」页布局与库白名单控件回归测试（源码结构断言）。
 *
 * 回归背景：授权行内新增「库白名单」控件时，曾把 ro/rw 分段控件挪到连接名的
 * 下一行，侧栏里授权按钮与连接名脱节。契约：
 *  1) 授权行仍是「kind 徽标 + 名称 + 模式徽标 + ro/rw 分段」同一行；
 *  2) 分段控件嵌在 `dbt-row` 内（缩进比 `dbt-row` 深一层），不是它的兄弟；
 *  3) 名称列可收缩（flex + minWidth: 0 + ellipsis），不会把分段控件挤出容器；
 *  4) 库白名单是折叠列表（`GrantDbPicker`）另起一行，且仅在已授权时渲染；
 *  5) 列表用 checkbox 勾选，带「全选/全不选」，勾满全部库时保存为空数组（＝不限库）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientFile = join(here, '..', '..', 'client', 'client.js');
const src = readFileSync(clientFile, 'utf8');
const lines = src.split('\n');

function tabsOf(line: string): number {
	let n = 0;
	while (line[n] === '\t') n++;
	return n;
}

/** 从某个 `function Xxx(props) {` 起到同缩进的收尾 `}` 为止。 */
function functionBody(name: string): string[] {
	const start = lines.findIndex((l) => l.includes('function ' + name + '(props) {'));
	expect(start).toBeGreaterThan(-1);
	const indent = tabsOf(lines[start]!);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i] === '\t'.repeat(indent) + '}') {
			end = i + 1;
			break;
		}
	}
	return lines.slice(start, end);
}

describe('项目授权行：ro/rw 分段与连接名同一行', () => {
	const region = functionBody('GrantsView');
	const rowIdx = region.findIndex((l) => l.includes('{ className: "dbt-row", style: { width: "100%", minWidth: 0 } },'));
	const segIdx = region.findIndex((l) => l.includes('className: "dbt-seg"'));
	const dbRowIdx = region.findIndex((l) => l.includes('React.createElement(GrantDbPicker'));

	it('授权行按「同一行容器 → 分段控件 → 库白名单选择器」排列', () => {
		expect(rowIdx).toBeGreaterThan(-1);
		expect(segIdx).toBeGreaterThan(rowIdx);
		expect(dbRowIdx).toBeGreaterThan(segIdx);
	});

	it('分段控件嵌在 dbt-row 内，而不是独立成行', () => {
		const rowOpen = rowIdx - 2;
		expect(region[rowOpen]).toContain('React.createElement(');
		let segOpen = segIdx;
		while (segOpen > 0 && !region[segOpen]!.includes('React.createElement(')) segOpen--;
		expect(tabsOf(region[segOpen]!)).toBe(tabsOf(region[rowOpen]!) + 1);
	});

	it('名称列可收缩，避免挤掉分段控件', () => {
		const nameLine = region.slice(rowIdx, segIdx).find((l) => l.includes('c.name || c.id)'));
		expect(nameLine).toBeDefined();
		expect(nameLine).toContain('flex: "1 1 auto"');
		expect(nameLine).toContain('minWidth: 0');
		expect(nameLine).toContain('textOverflow: "ellipsis"');
	});

	it('库白名单选择器仅在已授权时渲染', () => {
		expect(region[dbRowIdx]!.trimStart().startsWith('m ? React.createElement(GrantDbPicker')).toBe(true);
	});
});

describe('库白名单选择器：折叠列表 + 勾选', () => {
	const picker = functionBody('GrantDbPicker');
	const text = picker.join('\n');

	it('折叠头带 aria-expanded，展开时才拉库列表', () => {
		expect(text).toContain('"aria-expanded": open');
		expect(text).toContain('api("grant-databases" + qs({ project: props.projectPath, connId: g.connId })');
		expect(text).toContain('if (!props.projectPath) { setErr(t("needProjectPath")); return; }');
		expect(text).toContain('if (next && list === null && !sqlite) load();');
	});

	it('列表用 checkbox 勾选，并区分全选/全不选', () => {
		expect(text).toContain('type: "checkbox"');
		expect(text).toContain('onClick: () => setAll(true)');
		expect(text).toContain('onClick: () => setAll(false)');
	});

	it('勾选即保存：防抖后 PUT 显式库清单，不再有「保存」按钮', () => {
		expect(text).toContain('async function flush() {');
		expect(text).toContain('body: { projectPath: props.projectPath, connId: g.connId, mode: g.mode, databases: next }');
		expect(text).toContain('}, 250);');
		expect(text).toContain('setSaveErr(String((e && e.message) || e));');
		expect(text).not.toContain('grantDbSaveBtn');
		expect(text).not.toContain('commit()');
	});

	it('空清单＝一个库都不允许（不再是「全部库」）', () => {
		expect(text).toContain('const savedList = Array.isArray(g.databases) ? g.databases.map(String) : null;');
		expect(text).toContain('schedule(on ? candidates.slice() : []);');
		expect(text).toContain('t("grantDbNoneSelected")');
		expect(text).toContain('t("grantDbEmptySel")');
		expect(text).not.toContain('chosen.length === candidates.length ? [] : chosen');
	});

	it('sqlite 单文件库不显示库级限制', () => {
		expect(text).toContain('(props.conn && props.conn.kind) === "sqlite"');
		expect(text).toContain('t("grantDbSqlite")');
	});
});

describe('库白名单选择器：按库名过滤', () => {
	const picker = functionBody('GrantDbPicker');
	const text = picker.join('\n');
	const inputIdx = picker.findIndex((l) => l.includes('placeholder: t("grantDbFilter")'));
	const typeIdx = picker.findIndex((l) => l.includes('type: "search"'));
	const allIdx = picker.findIndex((l) => l.includes('onClick: () => setAll(true)'));

	it('过滤框排在「全选/全不选」左侧，并带无障碍标签', () => {
		expect(inputIdx).toBeGreaterThan(-1);
		expect(typeIdx).toBeGreaterThan(-1);
		expect(allIdx).toBeGreaterThan(-1);
		expect(typeIdx).toBeLessThan(allIdx);
		expect(picker[typeIdx + 1]).toContain('className: "dbt-dbfilter"');
		expect(text).toContain('"aria-label": t("grantDbFilter")');
	});

	it('过滤只收窄可见列表，候选集不变（保存语义不受影响）', () => {
		expect(text).toContain('const visible = needle === "" ? candidates : candidates.filter((n) => n.toLowerCase().includes(needle));');
		expect(text).toContain('visible.map((name) => React.createElement(');
		expect(text).toContain('schedule(on ? candidates.slice() : []);');
	});

	it('有过滤词时全选/全不选只作用于可见子集', () => {
		expect(text).toContain('if (needle === "") {');
		expect(text).toContain('shown.has(n.toLowerCase()) || keep.has(n.toLowerCase())');
		expect(text).toContain('keep.has(n.toLowerCase()) && !shown.has(n.toLowerCase())');
	});

	it('无匹配与命中计数都有提示，避免看起来像空列表', () => {
		expect(text).toContain('t("grantDbFilterNone")');
		expect(text).toContain('t("grantDbFilterCount", { shown: visible.length, total: candidates.length })');
	});
});
