/**
 * audit.jsonl：追加式审计日志。每行一条 JSON，供侧边栏 tail 查看。
 * 追加写天然原子（单行 < 4KB 时 POSIX/Windows 均保证不交错），
 * tail 解析时跳过损坏行，单行损坏不影响其余历史。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
export class AuditLog {
    file;
    constructor(dir) {
        this.file = path.join(dir, 'audit.jsonl');
    }
    /** 追加一条审计；ts 省略时自动填充当前 UTC 时间 */
    append(entry) {
        const full = { ...entry, ts: entry.ts ?? new Date().toISOString() };
        fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
        return full;
    }
    /** 最近 n 条（时间正序）。文件不存在返回空数组；损坏行跳过。
     *  设计取舍：tail 全量读入后取尾。审计日志不轮转（保留完整历史是审计语义），
     *  单用户桌面工具的量级（数十万行 ≈ 数十 MB）一次性读取在可接受范围；
     *  反向块读的复杂度不值得。若未来出现服务端长驻场景再优化。 */
    tail(n) {
        if (!fs.existsSync(this.file))
            return [];
        const lines = fs.readFileSync(this.file, 'utf8').split('\n');
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
            const line = lines[i]?.trim();
            if (!line)
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch {
                // 跳过损坏行
            }
        }
        return out.reverse();
    }
}
