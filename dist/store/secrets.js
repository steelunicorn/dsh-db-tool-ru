/**
 * secrets.json：连接级机密存储（密码、完整 URL、其余敏感键值）。
 *
 * 硬性约束：
 *  - 文件落盘后设置权限 0600（Windows 上尽力而为，失败不崩溃）；
 *  - 本类的任何返回值都是浅拷贝，外部改动不污染内部状态；
 *  - 机密绝不进入 connections.json / grants.json / 审计等其它文件。
 */
import * as path from 'node:path';
import { readJson, writeJsonAtomic } from './io.js';
const FILE_MODE = 0o600;
export class SecretsBox {
    file;
    constructor(dir) {
        this.file = path.join(dir, 'secrets.json');
    }
    load() {
        return readJson(this.file, { secrets: {} });
    }
    save(data) {
        writeJsonAtomic(this.file, data, FILE_MODE);
    }
    /** 读取某连接的机密（浅拷贝）。不存在返回 undefined。 */
    get(connId) {
        const entry = this.load().secrets[connId];
        return entry ? { ...entry } : undefined;
    }
    /** 合并写入机密（保留未提及的旧键） */
    set(connId, patch) {
        const data = this.load();
        data.secrets[connId] = { ...(data.secrets[connId] ?? {}), ...patch };
        this.save(data);
    }
    /** 删除某连接的全部机密。不存在时静默返回。 */
    delete(connId) {
        const data = this.load();
        if (!(connId in data.secrets))
            return;
        delete data.secrets[connId];
        this.save(data);
    }
}
