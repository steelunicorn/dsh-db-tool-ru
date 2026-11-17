/** 版本横幅 → 「产品 + 短版本」。已简短的（mysql/mongo/redis/sqlite）原样返回。 */
export function conciseServerInfo(kind, raw) {
    const s = String(raw ?? '').trim();
    if (s === '')
        return s;
    switch (kind) {
        case 'postgresql':
        case 'gaussdb': {
            // GaussDB 的 version() 形如 "PostgreSQL 9.2.4 (GaussDB Kernel 505.x build ...)"，
            // 内核版本才是用户关心的事实；纯 PostgreSQL 形如 "PostgreSQL 17.11 (Ubuntu ...) on ..."
            const g = /GaussDB Kernel ([\w.-]+)/.exec(s);
            if (g)
                return `GaussDB Kernel ${g[1]}`;
            return (s.split('(')[0] ?? s).trim() || s;
        }
        case 'oracle': {
            // banner: "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Version 19.3.0.0.0"
            const m = /^(Oracle Database \S+)/.exec(s);
            if (m && m[1])
                return m[1];
            return (s.split(/(\s+Release\s+|\()/)[0] ?? s).trim() || s;
        }
        case 'dmdb': {
            // DM banner: "DM Database Server 64 bit V8.1.2.128 (Build ...)" → "DM V8.1.2.128"
            const m = /\bV(\d[\w.-]*)/.exec(s);
            if (m)
                return `DM V${m[1]}`;
            return (s.split('(')[0] ?? s).trim() || s;
        }
        default:
            return s;
    }
}
/** 从错误文本提取 host:port（ECONNREFUSED 等提示指向具体目标） */
function extractHostPort(raw) {
    return /((?:\d{1,3}(?:\.\d{1,3}){3}|\[[\w:]+\]|[\w.-]+):\d{2,5})/.exec(raw)?.[1];
}
/**
 * 连接失败 → 准确可操作的中文提示。返回 null 表示没有把握，
 * 调用方保留原错误文案（诊断细节不丢）。
 */
export function friendlyConnectError(kind, err) {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    if (!raw)
        return null;
    // sqlserver/oracle/dmdb 的适配器层已有按错误码整形的中文文案（含 TLS 两族区分、
    // ORA/DM 码针对性提示与 e2e 契约测试），manager 层不再二次解读，原样保留。
    if (kind === 'sqlserver' || kind === 'oracle' || kind === 'dmdb')
        return null;
    /* ---- 网络层：全库通用，特征最可靠，优先判定 ---- */
    const target = extractHostPort(raw);
    if (/ECONNREFUSED/.test(raw)) {
        return `Connection refused: nothing is listening on ${target ?? 'the target port'}; check that the database is running and that the host and port are correct (ECONNREFUSED)`;
    }
    if (/ENOTFOUND/.test(raw)) {
        const host = /getaddrinfo ([\w.-]+)/i.exec(raw)?.[1] ?? target?.split(':')[0];
        return `Host name cannot be resolved: ${host ?? ''} — check the spelling and DNS (ENOTFOUND)`;
    }
    if (/ETIMEDOUT/.test(raw) || /connection timeout/i.test(raw) || /Server selection timed out/i.test(raw)) {
        return `Connection timed out: the host is unreachable or the port is blocked by a firewall (ETIMEDOUT)`;
    }
    if (/ECONNRESET/.test(raw)) {
        return `Connection reset: the network dropped or the server closed it (ECONNRESET)`;
    }
    if (/EHOSTUNREACH|ENETUNREACH/.test(raw)) {
        return `Network unreachable: check the local network and firewall (EHOSTUNREACH)`;
    }
    /* ---- 各库错误码 / 消息特征（人形化消息会被 humanize 保留原文，码与文本按包含匹配） ---- */
    switch (kind) {
        case 'mysql':
            if (/Access denied for user/i.test(raw))
                return 'Wrong user name or password (MySQL Access denied)';
            if (/Unknown database/i.test(raw))
                return `Database does not exist (MySQL Unknown database)`;
            if (/does not support authentication/i.test(raw)) {
                return 'Client and server authentication plugins are incompatible: switch the account to mysql_native_password on the server or upgrade the server (MySQL 1251)';
            }
            break;
        case 'postgresql':
        case 'gaussdb':
            if (/password authentication failed|28P01/.test(raw))
                return 'Wrong user name or password (PostgreSQL 28P01)';
            if (/does not exist|3D000/.test(raw) && /database/i.test(raw))
                return `Database does not exist (PostgreSQL 3D000)`;
            if (/role "[^"]+" does not exist|28000/.test(raw))
                return 'Role does not exist or the authentication configuration is wrong (PostgreSQL 28000)';
            if (/57P03|the database system is starting/i.test(raw))
                return 'Database is temporarily unavailable: it is starting or recovering, retry later (PostgreSQL 57P03)';
            break;
        case 'mongodb':
            if (/AuthenticationFailed|auth(entication)? failed/i.test(raw)) {
                return 'Authentication failed: wrong user, password or authSource (MongoDB)';
            }
            break;
        case 'redis':
            if (/NOAUTH|WRONGPASS|invalid password/i.test(raw)) {
                return 'Authentication failed: wrong password, or the URL has no password while the server enables requirepass/ACL (Redis)';
            }
            break;
        case 'sqlite':
            if (/unable to open database file/i.test(raw)) {
                return 'Cannot open the database file: check that the path exists and the process can read and write it (SQLite)';
            }
            break;
    }
    /* ---- 通用 TLS/证书（各库驱动文案不同，统一给配置方向） ---- */
    if (/self.signed certificate|certificate verify failed|unable to verify|TLS|SSL/i.test(raw)) {
        return `TLS/certificate verification failed: the certificate is untrusted or the host name does not match; configure a trusted CA or check the certificate and encryption options (${raw.slice(0, 60).trim()})`;
    }
    return null;
}
