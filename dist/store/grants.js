/**
 * grants.json：项目级连接授权（ro/rw）。
 * 键是 normalizeProjectKey 归一化后的项目路径。
 */
import * as path from 'node:path';
import { normalizeProjectKey } from './normalize.js';
import { readJson, writeJsonAtomic } from './io.js';
/** 库白名单归一：去首尾空白、丢弃空项、大小写不敏感去重；无有效项返回 undefined（= 全部库） */
export function normalizeDatabases(value) {
    if (!Array.isArray(value))
        return undefined;
    const seen = new Set();
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const name = item.trim();
        if (name === '')
            continue;
        const key = name.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(name);
    }
    return out.length > 0 ? out : undefined;
}
/** 两条授权的库白名单合并：非空优先（首条非空生效），都空则保持不限制 */
function mergeDatabases(a, b) {
    return normalizeDatabases(a) ?? normalizeDatabases(b);
}
/** 迁移合并：同键两条授权列表按连接去重，rw 胜出（rw > ro，对齐 check），grantedAt 取较新 */
function mergeGrantLists(a, b) {
    const map = new Map();
    for (const g of [...a, ...b]) {
        const prev = map.get(g.connId);
        if (!prev) {
            const entry = { ...g };
            const databases = normalizeDatabases(entry.databases);
            if (databases)
                entry.databases = databases;
            else
                delete entry.databases;
            map.set(g.connId, entry);
            continue;
        }
        const mode = prev.mode === 'rw' || g.mode === 'rw' ? 'rw' : g.mode;
        const merged = { connId: g.connId, mode, grantedAt: prev.grantedAt > g.grantedAt ? prev.grantedAt : g.grantedAt };
        const databases = mergeDatabases(prev.databases, g.databases);
        if (databases)
            merged.databases = databases;
        map.set(g.connId, merged);
    }
    return [...map.values()];
}
/** 绝对路径形态的键（盘符开头或 POSIX 根开头）：仅这类键参与迁移归一 */
const PATH_KEY = /^(?:[a-z]:[\\/]|\/)/i;
export class GrantStore {
    file;
    constructor(dir) {
        this.file = path.join(dir, 'grants.json');
    }
    /**
     * 读入 + 兼容迁移：修复前的 grants.json 键未做 Windows 全路径小写归一
     * （仅盘符小写），同一目录可能存在多个大小写变体键。读入时把「绝对路径
     * 形态」的键统一归一化，变体合并为同一键（同连接多模式时 rw 胜出、
     * grantedAt 取最新，与 check 语义一致），下次 save 自然落盘为新键。
     * 非路径形态的键（历史遗留/测试桩，非 normalizeProjectKey 产出物）
     * 原样保留——resolve 会把它们误改写为绝对路径。归一化幂等，对新格式文件零开销。
     */
    load() {
        const raw = readJson(this.file, { grants: {} });
        const grants = {};
        for (const [k, list] of Object.entries(raw.grants ?? {})) {
            const key = PATH_KEY.test(k) ? normalizeProjectKey(k) : k;
            const prev = grants[key];
            grants[key] = prev ? mergeGrantLists(prev, list) : list;
        }
        return { grants };
    }
    save(data) {
        // 0600 对齐 dsh-ssh-tunnel：授权关系本身也是敏感面（泄露项目↔库映射）
        writeJsonAtomic(this.file, data, 0o600);
    }
    /** 某项目的全部授权（含可选库白名单，不含 grantedAt，展示层无需时间戳） */
    grantsFor(projectKey) {
        const key = normalizeProjectKey(projectKey);
        return (this.load().grants[key] ?? []).map(({ connId, mode, databases }) => {
            const out = { connId, mode };
            const normalized = normalizeDatabases(databases);
            if (normalized)
                out.databases = normalized;
            return out;
        });
    }
    /**
     * 授权或改授权（同连接重复授权视为更新模式）。键在入口归一化，调用方传原始路径亦可。
     * databases 为 undefined 表示「保持既有库白名单不变」，数组表示覆盖（空数组 = 解除限制）。
     */
    grant(projectKey, connId, mode, databases) {
        const key = normalizeProjectKey(projectKey);
        const data = this.load();
        const list = data.grants[key] ?? [];
        const existing = list.find((g) => g.connId === connId);
        const normalized = databases === undefined ? undefined : normalizeDatabases(databases);
        if (existing) {
            existing.mode = mode;
            existing.grantedAt = new Date().toISOString();
            if (databases !== undefined) {
                if (normalized)
                    existing.databases = normalized;
                else
                    delete existing.databases;
            }
        }
        else {
            const entry = { connId, mode, grantedAt: new Date().toISOString() };
            if (normalized)
                entry.databases = normalized;
            list.push(entry);
        }
        data.grants[key] = list;
        this.save(data);
    }
    /** 撤销某项目对某连接的授权。不存在时静默返回 */
    revoke(projectKey, connId) {
        const key = normalizeProjectKey(projectKey);
        const data = this.load();
        const list = data.grants[key];
        if (!list)
            return;
        const next = list.filter((g) => g.connId !== connId);
        if (next.length === list.length)
            return;
        if (next.length === 0)
            delete data.grants[key];
        else
            data.grants[key] = next;
        this.save(data);
    }
    /**
     * 解析某项目对某连接的授权：模式 + 库白名单；未授权返回 undefined。
     * 同连接存在多条（历史迁移残留）时 rw 覆盖 ro，库白名单取首条非空。
     */
    resolve(projectKey, connId) {
        const key = normalizeProjectKey(projectKey);
        const entries = (this.load().grants[key] ?? []).filter((g) => g.connId === connId);
        if (entries.length === 0)
            return undefined;
        const mode = entries.some((g) => g.mode === 'rw') ? 'rw' : 'ro';
        let databases;
        for (const e of entries) {
            databases = normalizeDatabases(e.databases);
            if (databases)
                break;
        }
        const out = { mode };
        if (databases)
            out.databases = databases;
        return out;
    }
    /** 检查授权模式；未授权返回 undefined（ro < rw，rw 覆盖 ro）。键在入口归一化 */
    check(projectKey, connId) {
        return this.resolve(projectKey, connId)?.mode;
    }
    /** 级联清理：删除某连接在全项目范围的授权（由 ConnectionStore.remove 调用） */
    removeConn(connId) {
        const data = this.load();
        let dirty = false;
        for (const key of Object.keys(data.grants)) {
            const list = data.grants[key];
            if (!list)
                continue;
            const next = list.filter((g) => g.connId !== connId);
            if (next.length !== list.length) {
                dirty = true;
                if (next.length === 0)
                    delete data.grants[key];
                else
                    data.grants[key] = next;
            }
        }
        if (dirty)
            this.save(data);
    }
}
