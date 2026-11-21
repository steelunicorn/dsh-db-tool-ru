import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 技能文档有三个语言版本：SKILL.md（英语）、SKILL.ru.md（俄语）、SKILL.zh.md（原始中文）。
 * 三者结构必须逐行对齐：译者在某一版里漏掉表格行或代码块时，模型读到的说明会自相矛盾，
 * 这比没有说明更危险。目录清单写在这里，新增技能时同步加一条即可。
 */

const ROOT = path.resolve(__dirname, '../..');
const SKILL_DIRS = ['skills/db-admin', '.dsh/skills/dsh-db-tool'];

const LANGS = { en: 'SKILL.md', ru: 'SKILL.ru.md', zh: 'SKILL.zh.md' } as const;
type Lang = keyof typeof LANGS;

function read(dir: string, lang: Lang): string {
	return fs.readFileSync(path.join(ROOT, dir, LANGS[lang]), 'utf8');
}

/** 逐行结构：代码块内的 `#` 是注释，不应当作标题统计。 */
function structure(text: string) {
	const lines = text.split('\n');
	let fence = false;
	const headings: string[] = [];
	const fences: number[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] as string;
		if (line.startsWith('```')) {
			fences.push(i + 1);
			fence = !fence;
			continue;
		}
		if (!fence && /^#{1,6} /.test(line)) headings.push(line.split(' ')[0] as string);
	}
	return {
		lines: lines.length,
		headings,
		fences,
		tableRows: lines.filter((l) => l.trim().startsWith('|')).map((l) => l.split('|').length),
		bullets: lines.filter((l) => /^- /.test(l)).length,
	};
}

const CJK = /[\u4e00-\u9fff]/;

describe.each(SKILL_DIRS)('技能文档三语版本对齐：%s', (dir) => {
	it('三份文件都存在且非空', () => {
		for (const lang of Object.keys(LANGS) as Lang[]) {
			const text = read(dir, lang);
			expect(text.length, `${dir}/${lang}`).toBeGreaterThan(1000);
			expect(text.startsWith('---\n'), `${dir}/${lang}`).toBe(true);
			expect(text, `${dir}/${lang}`).toMatch(/^name: [a-z0-9-]+$/m);
		}
	});

	it('三份文件的技能名称一致', () => {
		const names = (Object.keys(LANGS) as Lang[]).map((lang) => {
			const m = read(dir, lang).match(/^name: ([a-z0-9-]+)$/m);
			return m?.[1];
		});
		expect(new Set(names).size).toBe(1);
	});

	it('行数、标题层级、表格列数、代码块位置、列表项数量一致', () => {
		const en = structure(read(dir, 'en'));
		for (const lang of ['ru', 'zh'] as const) {
			const other = structure(read(dir, lang));
			expect(other.lines, `${lang} lines`).toBe(en.lines);
			expect(other.headings, `${lang} headings`).toEqual(en.headings);
			expect(other.tableRows, `${lang} table rows`).toEqual(en.tableRows);
			expect(other.fences, `${lang} fences`).toEqual(en.fences);
			expect(other.bullets, `${lang} bullets`).toBe(en.bullets);
		}
	});

	it('每份文件都链接到另外两份', () => {
		for (const lang of Object.keys(LANGS) as Lang[]) {
			const text = read(dir, lang);
			for (const [otherLang, file] of Object.entries(LANGS)) {
				if (otherLang === lang) continue;
				expect(text.includes(`(${file})`), `${dir}/${lang} -> ${file}`).toBe(true);
			}
		}
	});

	it('英俄版本不残留中文（语言切换行除外）', () => {
		for (const lang of ['en', 'ru'] as const) {
			const offenders = read(dir, lang)
				.split('\n')
				.filter((l) => CJK.test(l) && !l.startsWith('> '));
			expect(offenders, `${dir}/${lang}`).toEqual([]);
		}
	});

	it('中文版本保留原始正文', () => {
		const text = read(dir, 'zh');
		expect(CJK.test(text)).toBe(true);
		expect(text.length).toBeGreaterThan(1000);
	});

	it('三份文件都有代码块与表格', () => {
		for (const lang of Object.keys(LANGS) as Lang[]) {
			const s = structure(read(dir, lang));
			expect(s.fences.length, `${dir}/${lang} fences`).toBeGreaterThan(0);
			expect(s.tableRows.length, `${dir}/${lang} table rows`).toBeGreaterThan(0);
		}
	});
});
