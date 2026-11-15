/**
 * 「项目授权」页布局回归测试（源码结构断言）。
 *
 * 回归背景：在授权行内新增「库白名单」输入框时，曾把 ro/rw 分段控件挪到
 * 连接名的下一行，侧栏里授权按钮与连接名脱节。契约：
 *  1) 授权行仍是「kind 徽标 + 名称 + 模式徽标 + ro/rw 分段」同一行；
 *  2) 分段控件嵌在 `dbt-row` 内（缩进比 `dbt-row` 深一层），不是它的兄弟；
 *  3) 名称列可收缩（flex + minWidth: 0 + ellipsis），不会把分段控件挤出容器；
 *  4) 库白名单输入框（`GrantDbRow`）另起一行，且仅在已授权时渲染。
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

/** GrantsView 函数体（到下一个分区注释为止）。 */
function grantsRegion(): string[] {
	const start = lines.findIndex((l) => l.includes('function GrantsView(props)'));
	expect(start).toBeGreaterThan(-1);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]!.trim().startsWith('/* ----------------')) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end);
}

describe('项目授权行：ro/rw 分段与连接名同一行', () => {
	const region = grantsRegion();
	const rowIdx = region.findIndex((l) => l.includes('{ className: "dbt-row", style: { width: "100%", minWidth: 0 } },'));
	const segIdx = region.findIndex((l) => l.includes('className: "dbt-seg"'));
	const dbRowIdx = region.findIndex((l) => l.includes('React.createElement(GrantDbRow'));

	it('授权行按「同一行容器 → 分段控件 → 库白名单输入」排列', () => {
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

	it('库白名单输入框仅在已授权时渲染', () => {
		expect(region[dbRowIdx]!.trimStart().startsWith('m ? React.createElement(GrantDbRow')).toBe(true);
	});
});
