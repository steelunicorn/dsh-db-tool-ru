/**
 * 新连接表单「字段列表」布局测试（离线；浅渲染 ConnForm）。
 *
 * 背景：表单原先是一排没有标签的输入框，用户只能靠 placeholder 猜字段含义（填上内容后
 * placeholder 消失，字段含义也随之消失）。本测试锁住改动后的结构契约：
 *   1) 首行（类型 / 名称 / id / ssl）保持原样，不参与重排；
 *   2) 分字段模式下主机与端口同排，其余字段各占一行「固定宽度标签 + 输入框」：
 *      所有输入框左缘对齐（固定标签列），右缘对齐到同一竖线（同行字段除外）；
 *   3) aria-label 与 placeholder 的既有语义不变（只读屏与既有测试依赖它们）；
 *   4) 标签文案来自字典（zh/en/ru 三份都有），且输入框仍然写回表单值。
 *
 * 手法沿用 tests/client/sqlserver-tls-form.spec.ts：stub React 浅渲染 + 源码注入探针。
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

type El = { type: any; props: any; children: any[] };

/* ---------- stub React ---------- */

const reactStub = (() => {
	const slots = new Map<string, any>();
	let hookIdx = 0;
	let effects: { i: number; fn: () => any }[] = [];
	function regEffect(fn: any, deps?: any[]) {
		const i = hookIdx++;
		const dk = 'd' + i;
		const prev = slots.get(dk);
		if (deps && prev && Array.isArray(prev) && prev.length === deps.length && prev.every((d, k) => d === deps[k])) return;
		slots.set(dk, deps ? deps.slice() : null);
		effects.push({ i, fn });
	}
	const R: any = {
		createElement(type: any, props: any, ...kids: any[]) {
			return { type, props: props || {}, children: kids };
		},
		useState(init: any) {
			const i = hookIdx++;
			const key = 's' + i;
			if (!slots.has(key)) slots.set(key, typeof init === 'function' ? init() : init);
			return [slots.get(key), (v: any) => slots.set(key, typeof v === 'function' ? v(slots.get(key)) : v)];
		},
		useRef(init: any) {
			const i = hookIdx++;
			const key = 'r' + i;
			if (!slots.has(key)) slots.set(key, { current: init });
			return slots.get(key);
		},
		useCallback(fn: any) {
			const i = hookIdx++;
			const key = 'cb' + i;
			if (!slots.has(key)) slots.set(key, fn);
			return slots.get(key);
		},
		useMemo(fn: any) {
			return fn();
		},
		useEffect: regEffect,
		useLayoutEffect: regEffect,
	};
	return {
		React: R,
		render(comp: (props: any) => any, props: any): El {
			hookIdx = 0;
			return comp(props);
		},
		reset() {
			slots.clear();
			effects = [];
			hookIdx = 0;
		},
	};
})();

function collect(node: any, out: El[] = []): El[] {
	if (Array.isArray(node)) { node.forEach((x) => collect(x, out)); return out; }
	if (!node || typeof node !== 'object' || !node.type) return out;
	out.push(node);
	const kids = Array.isArray(node.children) ? node.children : [node.children];
	for (const k of kids) {
		if (Array.isArray(k)) k.forEach((x) => collect(x, out));
		else collect(k, out);
	}
	return out;
}
function flatText(n: any): string {
	if (n === null || n === undefined || n === false || n === true) return '';
	if (Array.isArray(n)) return n.map(flatText).join('');
	if (typeof n !== 'object') return String(n);
	const kids = Array.isArray(n.children) ? n.children : [n.children];
	return kids.map(flatText).join('');
}

/* ---------- 装载 client.js ---------- */

let T: any;
let probe: any;
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../client/client.js'), 'utf8');

beforeAll(() => {
	const fakeWindow: any = { __ModuleLoader__: { load(def: any) { fakeWindow.__DEF__ = def; } } };
	const marker = 'exports.__testables = {';
	if (!src.includes(marker)) throw new Error('client.js 结构变更：未找到 __testables 导出点');
	const patched = src.replace(marker, 'exports.__probe = { t };\n\t\t' + marker);
	new Function('window', 'console', 'fetch', patched)(fakeWindow, console, () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true,"data":[]}') }));
	const mod = fakeWindow.__DEF__.factory((name: string) => {
		if (name === 'react') return reactStub.React;
		throw new Error('未预期的依赖: ' + name);
	});
	T = mod.__testables;
	probe = mod.__probe;
});

/** 渲染分字段模式表单（默认 kind=mysql） */
function renderFields(initial?: any): El {
	reactStub.reset();
	return reactStub.render(T.ConnForm, {
		initial: { ...T.EMPTY_FORM, mode: 'fields', ...(initial || {}) },
		busy: false,
		onSubmit: () => {},
		onCancel: () => {},
	});
}

/** 渲染 URL 模式表单 */
function renderUrl(): El {
	reactStub.reset();
	return reactStub.render(T.ConnForm, {
		initial: { ...T.EMPTY_FORM, mode: 'url' },
		busy: false,
		onSubmit: () => {},
		onCancel: () => {},
	});
}

/** 所有「标签 + 输入框」字段行 */
function fields(tree: El): El[] {
	return collect(tree).filter((n) => n.type === 'label' && n.props.className === 'dbt-field');
}
/** 字段行里的标签文本 */
function fieldLabel(row: El): string {
	const span = row.children.find((c: any) => c && c.type === 'span');
	return flatText(span);
}
/** 字段行里的输入框 */
function fieldInput(row: El): El {
	return collect(row).find((n) => n.type === 'input')!;
}
/** 按 aria-label 找控件（精确匹配） */
function byLabel(tree: El, label: string): El | undefined {
	return collect(tree).find((n) => n.props && n.props['aria-label'] === label);
}

describe('1 首行保持原样（类型 / 名称 / id / ssl 不参与重排）', () => {
	it('四个控件仍在，且都不带字段标签', () => {
		const tree = renderFields();
		const kind = byLabel(tree, probe.t('fieldKind'));
		const name = byLabel(tree, probe.t('connName'));
		expect(kind, '缺类型下拉').toBeDefined();
		expect(kind!.type).toBe('select');
		expect(name, '缺名称输入').toBeDefined();
		// 首行输入框不是 .dbt-field 的子节点
		const labelledInputs = fields(tree).map((r) => fieldInput(r));
		expect(labelledInputs).not.toContain(name);
		expect(labelledInputs.some((i) => i.props.type === 'checkbox')).toBe(false);
	});
});

describe('2 分字段模式：每个输入框一行「标签 + 输入框」', () => {
	it('标签顺序与文案：主机 / 端口 / 数据库 / 用户名 / 密码', () => {
		const tree = renderFields();
		const rows = fields(tree);
		const labels = rows.map(fieldLabel);
		expect(labels).toEqual([
			probe.t('lblHost'),
			probe.t('lblPort'),
			probe.t('lblDatabase'),
			probe.t('lblUser'),
			probe.t('lblPassword'),
		]);
	});

	it('主机与端口同一行，其余各占一行；同行字段之外没有内联宽度', () => {
		const tree = renderFields();
		const rows = fields(tree);
		expect(rows).toHaveLength(5);
		// 主机藏在同一 .dbt-row 里与端口同排（.dbt-row 会换行，窄侧栏时端口自动落到下一行）
		const hostRow = rows[0]!;
		const portRow = rows[1]!;
		const sharedRow = collect(tree).find((n) => n.props && n.props.className === 'dbt-row'
			&& collect(n).includes(hostRow) && collect(n).includes(portRow));
		expect(sharedRow, '主机与端口不在同一个 .dbt-row 内').toBeDefined();
		// 单独成行的字段不带内联样式：宽度由固定标签列 + flex 决定，右缘自然对齐
		for (const row of rows.slice(2)) {
			expect(row.props.style, '单独成行的字段不应带内联样式').toBeUndefined();
		}
	});

	it('端口的标签和输入框都是自适应宽（不吃掉固定标签列，也不吃满剩余宽度）', () => {
		const tree = renderFields();
		const rows = fields(tree);
		const portRow = rows[1]!;
		expect(portRow.props.style).toMatchObject({ flex: '0 0 auto', minWidth: 0 });
		const span = portRow.children.find((c: any) => c && c.type === 'span');
		expect(span.props.style).toMatchObject({ flex: '0 0 auto' });
		const portInput = fieldInput(portRow);
		expect(portInput.props.style).toMatchObject({ flex: '0 0 auto', width: 64 });
	});

	it('aria-label 保持既有语义（含必填标记）', () => {
		const tree = renderFields();
		expect(byLabel(tree, probe.t('fieldsHost') + probe.t('requiredMark'))).toBeDefined();
		expect(byLabel(tree, probe.t('fieldsPort'))).toBeDefined();
		expect(byLabel(tree, probe.t('fieldsDatabase'))).toBeDefined();
		expect(byLabel(tree, probe.t('fieldsUser') + probe.t('requiredMark'))).toBeDefined();
		expect(byLabel(tree, probe.t('fieldsPassword'))).toBeDefined();
	});

	it('输入框仍写回表单值（标签不阻断 onChange）', () => {
		const tree = renderFields({ host: '' });
		const hostInput = byLabel(tree, probe.t('fieldsHost') + probe.t('requiredMark'))!;
		hostInput.props.onChange({ target: { value: 'db.example' } });
		// 保留状态槽重渲染：stub 的 setState 只改槽不自动渲染（与 sqlserver-tls-form.spec 同法）
		const next = reactStub.render(T.ConnForm, {
			initial: { ...T.EMPTY_FORM, mode: 'fields' },
			busy: false,
			onSubmit: () => {},
			onCancel: () => {},
		});
		expect(collect(next).some((n) => n.props && n.props.value === 'db.example')).toBe(true);
	});

	it('sqlserver 主机保留命名实例提示，端口不显示多余 placeholder', () => {
		const tree = renderFields({ kind: 'sqlserver' });
		const hostInput = byLabel(tree, probe.t('fieldsHost') + probe.t('requiredMark'))!;
		const portInput = byLabel(tree, probe.t('fieldsPort'))!;
		expect(hostInput.props.placeholder).toBe(probe.t('fieldsHostInstance'));
		expect(portInput.props.placeholder).toBeUndefined();
	});
	it('端口行不带 placeholder（只有 sqlserver 主机有命名实例提示）', () => {
		const tree = renderFields();
		const portInput = byLabel(tree, probe.t('fieldsPort'))!;
		expect(portInput.props.placeholder).toBeUndefined();
	});
});

describe('3 保存过的密码只用 placeholder 提示，不作为标签', () => {
	it('hasPassword 时密码 placeholder 为「已保存」，标签仍是「密码」', () => {
		const tree = renderFields({ hasPassword: true });
		const rows = fields(tree);
		const pwRow = rows[rows.length - 1]!;
		expect(fieldLabel(pwRow)).toBe(probe.t('lblPassword'));
		expect(fieldInput(pwRow).props.placeholder).toBe(probe.t('passwordSaved'));
	});
});

describe('4 URL 模式同样带标签（连接串 / 用户名 / 密码）', () => {
	it('三行字段，aria-label 不变', () => {
		const tree = renderUrl();
		const labels = fields(tree).map(fieldLabel);
		expect(labels).toEqual([probe.t('lblUrl'), probe.t('lblUser'), probe.t('lblPassword')]);
		expect(byLabel(tree, probe.t('url') + probe.t('requiredMark'))).toBeDefined();
		expect(byLabel(tree, probe.t('urlUser'))).toBeDefined();
		expect(byLabel(tree, probe.t('urlPassword'))).toBeDefined();
	});
});

describe('5 样式契约：固定标签列左对齐，输入框右缘拉到同一条线', () => {
	it('标签列固定 92px（所有输入框左缘对齐），文案过长才省略', () => {
		expect(src).toContain('.dbt-field{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 0;}');
		const spanRule = /\.dbt-field>span\{([^}]*)\}/.exec(src);
		expect(spanRule, '缺 .dbt-field>span 规则').not.toBeNull();
		expect(spanRule![1]).toContain('flex:0 0 92px');
		expect(spanRule![1]).toContain('text-overflow:ellipsis');
	});

	it('字段内输入框拉满剩余宽度（覆盖 .dbt-card input 的 min-width，不再有宽度上限）', () => {
		const rule = /\.dbt-card \.dbt-field>input,\.dbt-card \.dbt-field>select\{([^}]*)\}/.exec(src);
		expect(rule, '缺字段内输入框规则').not.toBeNull();
		expect(rule![1]).toContain('flex:1 1 auto');
		expect(rule![1]).toContain('min-width:0');
		expect(rule![1]).not.toContain('max-width');
	});

	it('同行字段保留最小宽度，窄侧栏让端口换行而不是把主机挤成一条缝', () => {
		expect(src).toContain('.dbt-row>.dbt-field{min-width:150px;}');
	});
});
