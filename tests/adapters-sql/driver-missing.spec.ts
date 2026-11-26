/**
 * 驱动加载失败的提示文案测试。
 *
 * 背景：`driverMissingError` 把「驱动不可用」的所有成因都塞进同一句话，
 * 于是 ESM 导出不匹配（插件文件与本进程不同步）也会被建议成 `npm install pg`，
 * 用户会去装依赖，而真正需要做的是重装插件并重启 DSH。这里钉住两种成因的分叉。
 */
import { describe, expect, it } from 'vitest';
import { driverMissingError } from '../../lib/adapters/index.js';

describe('driverMissingError：只有「模块不存在」才建议安装依赖', () => {
	it('ERR_MODULE_NOT_FOUND → 给出安装指引', () => {
		const cause = Object.assign(new Error("Cannot find package 'pg' imported from /x/dist/a.js"), { code: 'ERR_MODULE_NOT_FOUND' });
		const msg = driverMissingError('postgresql', cause).message;
		expect(msg).toContain('postgresql driver unavailable');
		expect(msg).toContain("Cannot find package 'pg'");
		expect(msg).toContain('Install it and retry: npm install pg');
	});

	it('MODULE_NOT_FOUND（CJS require 失败）→ 同样给安装指引', () => {
		const cause = Object.assign(new Error("Cannot find module 'mysql2'"), { code: 'MODULE_NOT_FOUND' });
		expect(driverMissingError('mysql', cause).message).toContain('npm install mysql2');
	});

	it('ESM 导出不匹配 → 明确指出不是缺依赖，要求重装并重启，且不再提 npm install', () => {
		const cause = new Error("The requested module './common.js' does not provide an export named 'escapeLikePattern'");
		const err = driverMissingError('postgresql', cause);
		expect(err.name).toBe('DriverMissingError');
		expect(err.message).toContain('does not provide an export named');
		expect(err.message).toContain('not a missing dependency');
		expect(err.message).toContain('rebuild and reinstall the plugin, then restart DSH');
		expect(err.message).not.toContain('npm install');
	});

	it('无 cause 时保持原文案的主干，并走「非缺依赖」分支（没有可判定的缺失证据）', () => {
		const msg = driverMissingError('redis').message;
		expect(msg).toBe(
			'redis driver unavailable. This is not a missing dependency: the plugin files and the running process are out of sync — rebuild and reinstall the plugin, then restart DSH.',
		);
	});
});
