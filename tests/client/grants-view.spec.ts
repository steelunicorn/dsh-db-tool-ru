/**
 * 「项目授权」页布局与库白名单控件回归测试（源码结构断言）。
 *
 * 布局来自上游 #54：授权列表改为卡片网格（按数据库类型分组），整卡描边与
 * 模式徽标同色（未授权灰 / 只读绿 / 读写红）。本分叉在卡片内追加库白名单
 * 选择器。契约：
 *  1) `grantCard` 渲染 `.dbt-conncard`，`borderColor` 取 `MODE_TONES[m]`；
 *  2) 卡头依次是 kind 胶囊、名称（可收缩）、模式徽标；名称列 flex + minWidth: 0；
 *  3) ro/rw 分段是卡片内独立一块（不是卡头的兄弟行），排在卡头之后；
 *  4) 库白名单（`GrantDbPicker`）在分段之后，且仅在已授权时渲染；
 *  5) 网格用 `groupByKind` + `.dbt-conncards`，卡片按 `list.map(grantCard)` 展开。
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

describe('项目授权：卡片网格 + 三态着色', () => {
	const region = functionBody('GrantsView');
	const cardIdx = region.findIndex((l) => l.includes('function grantCard(c) {'));
	const card = cardIdx > 0 ? region.slice(cardIdx) : [];
	const cardText = card.join('\n');
	const headIdx = card.findIndex((l) => l.includes('className: "dbt-conncard-head"'));
	const segIdx = card.findIndex((l) => l.includes('className: "dbt-seg"'));
	const dbIdx = card.findIndex((l) => l.includes('React.createElement(GrantDbPicker'));

	it('卡片按模式着色，卡头含 kind 胶囊、名称与模式徽标', () => {
		expect(cardText).toContain('className: "dbt-conncard"');
		expect(cardText).toContain('style: { borderColor: MODE_TONES[m] }');
		expect(headIdx).toBeGreaterThan(-1);
		expect(card[headIdx + 1]).toContain('dbt-kindchip');
		expect(card[headIdx + 2]).toContain('dbt-conncard-name');
		expect(card[headIdx + 3]).toContain('modeBadge(m)');
	});

	it('名称列可收缩，长名不会挤掉徽标', () => {
		expect(cardText).toContain('className: "dbt-conncard-name"');
		// 名称省略由样式表负责（.dbt-conncard-name），源码里不应再写 inline flex
		const nameLine = card.find((l) => l.includes('dbt-conncard-name'))!;
		expect(nameLine).toBeDefined();
		expect(nameLine).not.toContain('whiteSpace: "nowrap"');
	});

	it('ro/rw 分段排在卡头之后，库白名单在分段之后', () => {
		expect(segIdx).toBeGreaterThan(headIdx);
		expect(dbIdx).toBeGreaterThan(segIdx);
	});

	it('库白名单仅在已授权时渲染', () => {
		expect(card[dbIdx]!.trimStart().startsWith('m ? React.createElement(GrantDbPicker')).toBe(true);
	});

	it('网格按类型分组，卡片走 list.map(grantCard)', () => {
		expect(region.join('\n')).toContain('groupByKind(conns).map(([kind, list])');
		expect(region.join('\n')).toContain('{ className: "dbt-conncards" }, list.map(grantCard)');
	});

	it('模式段是「пиктограмма + подпись»：图标 ⊘/RO/RW，文案在 label 里', () => {
		expect(cardText).toContain('className: "dbt-modecell"');
		expect(cardText).toContain('className: "dbt-modeicon"');
		expect(cardText).toContain('className: "dbt-modelabel"');
		expect(cardText).toContain('const glyph = mode === "" ? "⊘" : mode === "ro" ? "RO" : "RW";');
		expect(cardText).toContain('const label = mode === "" ? t("modeNone") : mode === "ro" ? t("modeRo") : t("modeRw");');
		// 图标对读屏隐藏，语义留在按钮的 aria-label/title 上
		expect(cardText).toContain('"aria-hidden": "true"');
		expect(cardText).toContain('"aria-label": label,');
		expect(cardText).toContain('title: label,');
		// 长文案不再直接作为 button 文本（那是互相撞车的根因）
		expect(cardText).not.toContain('}, mode === "" ? t("modeNone")');
	});

	it('窄卡只留图标：样式表按容器宽度隐藏 label', () => {
		expect(src).toContain('.dbt-seg{container-type:inline-size;}');
		expect(src).toContain('@container (max-width: 400px){.dbt-modecell .dbt-modelabel{display:none;}}');
		expect(src).toContain('.dbt-modelabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}');
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
