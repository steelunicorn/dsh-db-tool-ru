/**
 * 面板「项目键」编辑入口的语义提示（离线源码级断言）：
 * - 铅笔按钮必须带 title（projectEditTitle），否则 читается как «сменить проект агента»；
 * - 编辑态必须有 dbt-muted 说明（projectKeyHint），解释改动只影响面板授权所对照的项目键，
 *   代理始终使用会话目录，面板改不了它的路径；
 * - 三个语言字典都要有这两个键，且文案里明确「не может менять путь агента」。
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

let src = '';

beforeAll(() => {
	src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../client/client.js'), 'utf8');
});

/** 取某个字典的原文（`const ru = {` 到同缩进的 `};`）。 */
function dict(name: string): string {
	const start = src.indexOf('\t\tconst ' + name + ' = {');
	if (start < 0) throw new Error('dict not found: ' + name);
	const end = src.indexOf('\n\t\t};', start);
	return src.slice(start, end);
}

describe('面板项目键：铅笔与说明文案', () => {
	it('铅笔是开关：点一次打开输入框，再点一次收起，且有 aria-pressed 与态样式', () => {
		// 重复点击必须收起，而不是再次 setProjectEdited(true)（旧实现点了不关）
		expect(src).toContain('onClick: () => setProjectEdited((x) => (projectPath ? !x : false)),');
		expect(src).toContain('"aria-pressed": projectEditing,');
		expect(src).toContain('className: projectEditing ? "dbt-btn active" : "dbt-btn",');
		// 可见性标志：路径未知时强制显示（唯一输入入口），否则跟随开关
		expect(src).toContain('const projectEditing = projectEdited || !projectPath;');
		// 编辑态标题切换成「结束编辑」，与按下态呼应
		expect(src).toContain('title: projectEditing ? t("projectEditClose") : t("projectEditTitle"),');
		// 按下态需要有可见样式，否则只有 aria-pressed 没有视觉反馈
		expect(src).toContain('.dbt-btn.active{background:var(--dbt-seg-active)');
	});

	it('编辑态显示 projectKeyHint 说明', () => {
		expect(src).toContain('React.createElement("div", { className: "dbt-muted" }, t("projectKeyHint")),');
		// 说明必须和输入框同在一个纵向容器里，否则会挤在同一行右侧
		expect(src).toContain('{ style: { display: "flex", flexDirection: "column", gap: 4 } },');
	});

	it('三个字典都有两个键，且文案不同（真翻译而非占位）', () => {
		const zh = dict('zh');
		const en = dict('en');
		const ru = dict('ru');
		for (const [name, body] of [['zh', zh], ['en', en], ['ru', ru]] as const) {
			expect(body, name).toContain('projectEditTitle:');
			expect(body, name).toContain('projectEditClose:');
			expect(body, name).toContain('projectKeyHint:');
		}
		const pick = (body: string, key: string): string => (new RegExp('\\b' + key + ': "((?:[^"\\\\]|\\\\.)*)"').exec(body) || ['', ''])[1];
		const titles = [pick(zh, 'projectEditTitle'), pick(en, 'projectEditTitle'), pick(ru, 'projectEditTitle')];
		const hints = [pick(zh, 'projectKeyHint'), pick(en, 'projectKeyHint'), pick(ru, 'projectKeyHint')];
		for (const t of titles) expect(t.length).toBeGreaterThan(10);
		for (const h of hints) expect(h.length).toBeGreaterThan(30);
		expect(new Set(titles).size).toBe(3);
		expect(new Set(hints).size).toBe(3);
	});

	it('说明明确「面板不改代理的工作目录」，三种语言各用各的说法', () => {
		expect(dict('ru')).toContain('каталоге сессии');
		expect(dict('ru')).toContain('не может');
		expect(dict('en')).toContain('session directory');
		expect(dict('en')).toContain('cannot change');
		expect(dict('zh')).toContain('会话目录');
		expect(dict('zh')).toContain('无法修改');
	});

	it('提示文案不承诺扩展代理权限（不得出现「代理将使用此路径」类措辞）', () => {
		const all = dict('zh') + dict('en') + dict('ru');
		expect(all).not.toMatch(/agent will use this path/i);
		expect(all).not.toMatch(/агент будет использовать этот путь/i);
		expect(all).not.toMatch(/代理将使用此路径/);
	});
});
