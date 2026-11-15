/**
 * 新连接表单「字段列表」布局测试（离线；浅渲染 ConnForm）。
 *
 * 背景：表单原先是一排没有标签的输入框，用户只能靠 placeholder 猜字段含义（填上内容后
 * placeholder 消失，字段含义也随之消失）。本测试锁住改动后的结构契约：
 *   1) 首行（类型 / 名称 / id / ssl）保持原样，不参与重排；
 *   2) 分字段模式下每个输入框都有一行「固定宽度标签 + 输入框」，主机与端口同排，
 *      库名 / 用户名 / 密码各占一行；
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
	it('标签顺序与文案：主机 / 端口（同排）/ 数据库 / 用户名 / 密码', () => {
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

	it('主机与端口在同一 .dbt-row 内，其余各占一行', () => {
		const tree = renderFields();
		const rows = fields(tree);
		const hostRow = collect(tree).find((n) => n.props && n.props.className === 'dbt-row' && collect(n).includes(rows[0]!));
		expect(hostRow, '主机字段不在 dbt-row 内').toBeDefined();
		expect(collect(hostRow!).includes(rows[1]!), '端口与主机不同排').toBe(true);
		expect(collect(hostRow!).includes(rows[2]!), '数据库不应与主机同排').toBe(false);
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
	it('主机与端口同排时按 1.6:1 分配宽度（主机留更多）', () => {
		const tree = renderFields();
		const rows = fields(tree);
		expect(rows[0]!.props.style.flex).toBe('1.6 1 0');
		expect(rows[1]!.props.style.flex).toBe('1 1 0');
		// 单独成行的字段等分占满整行
		expect(rows[2]!.props.style.flex).toBe('1 1 0');
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

describe('5 样式契约：标签自适应宽度，字段内输入框可压缩', () => {
	it('dbt-field 规则存在且标签不被挤压', () => {
		expect(src).toContain('.dbt-field{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 0;}');
		const spanRule = /\.dbt-field>span\{([^}]*)\}/.exec(src);
		expect(spanRule, '缺 .dbt-field>span 规则').not.toBeNull();
		expect(spanRule![1]).toContain('flex:0 0 auto');
		expect(spanRule![1]).toContain('text-overflow:ellipsis');
		expect(spanRule![1]).not.toContain('0 0 96px');
	});

	it('字段内输入框的高优先级规则存在（覆盖 .dbt-card input 的 min-width）', () => {
		expect(src).toContain('.dbt-card .dbt-field>input,.dbt-card .dbt-field>select{flex:1 1 auto;min-width:0;}');
	});
});
