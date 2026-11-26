/**
 * MongoDB 适配器（mongodb v7，Server 4.4+）。
 *
 * 设计要点（依据官方文档调研）：
 *  - new MongoClient(uri, { maxPoolSize: 10, readPreference: 'primary', w: 'majority', family: 4 })
 *    + 显式 await connect()。family:4 规避 Node localhost IPv6 DNS 解析坑（官方 README）。
 *  - query() 入参为命令 JSON 文档字符串，读白名单：find/aggregate/count/countDocuments/
 *    estimatedDocumentCount/distinct/listCollections/dbStats/collStats/indexes。
 *  - find 自动 clamp limit ≤ 50，默认按 _id 排序；$where 拒绝（代码注入面）。
 *  - execute() 写白名单；updateMany/deleteMany 空 filter 直接拒绝（适配器级防线）。
 *  - 错误判定用 instanceof MongoServerError（官方建议不解析 message）。
 *  - 只读账号由用户配置官方内置角色 read / readWrite（见文档）。
 *  - 驱动不进依赖树：mongodb 经 esbuild bundle 成 vendor/mongodb-driver.cjs（见
 *    scripts/build-mongodb.mjs），运行时经 createRequire 相对加载（不经宿主
 *    dsh-app-boot 的模块解析器，规避其 resolve.paths 未防护的 for..of bug，
 *    该 bug 会因依赖树中的 punycode 等核心模块同名包直接炸掉插件加载）。
 *    bson 保持 dependencies（bundle 的 external），保证 BSON 类实例与外部一致。
 */
import { createRequire } from 'node:module';
import { validPort } from '../sql-shared/common.js';
let vendorCache;
/** 容错加载 vendor bundle：缺失时返回 undefined（调用方降级处理），成功后缓存。
 * 失败不缓存 → vendor 构建完成后无需重启即可恢复。 */
function vendorOrNull() {
    if (vendorCache === undefined) {
        try {
            // 相对路径从本模块出发：dist/adapters/mongodb/ 或 lib/adapters/mongodb/ 均指向包根 vendor/
            vendorCache = createRequire(import.meta.url)('../../../vendor/mongodb-driver.cjs');
        }
        catch {
            return undefined;
        }
    }
    return vendorCache;
}
/** 严格加载 vendor bundle：缺失时抛带修复指引的错误 */
function vendor() {
    const m = vendorOrNull();
    if (m === undefined) {
        throw new Error('mongodb driver unavailable: vendor/mongodb-driver.cjs is missing. Run npm run build:mongodb in the plugin directory to build it, then retry');
    }
    return m;
}
/** 危险操作：服务层拦截器用于确认流程。deleteMany/updateMany 仅空 filter 时危险（适配器已拦截）；createIndex 在大集合上可能阻塞。createIndexes/dropIndexes 为单数形式别名，renameCollection 影响集合可见性。 */
export const DANGEROUS_OPS = new Set([
    'dropDatabase', 'dropCollection', 'renameCollection', 'deleteMany', 'updateMany',
    'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'shutdown', 'replSetStepDown',
]);
/** 只读操作白名单（guard 层确认分级用，导出） */
export const READ_OPS = new Set([
    'find', 'aggregate', 'count', 'countDocuments', 'estimatedDocumentCount',
    'distinct', 'listCollections', 'dbStats', 'collStats', 'indexes',
]);
const WRITE_OPS = new Set([
    'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
    'deleteOne', 'deleteMany', 'createCollection', 'dropCollection',
    'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'renameCollection',
]);
const FIND_MAX_LIMIT = 50;
const ROWS_MAX = 500;
const CELL_TRUNC = 1000;
function trunc(s, max = CELL_TRUNC) {
    return s.length > max ? `${s.slice(0, max)}…[truncated, ${s.length} chars total]` : s;
}
/** NormalizedCell 规范化：ObjectId/Decimal128/Long/Timestamp → toString()；Binary → hex 截断；Date → ISO；嵌套对象/数组 → JSON 截断 1000。
 * BSON 类型判别依赖 vendor bundle 的类（external bson，与外部 require('bson') 同实例）；
 * vendor 缺失时降级为普通对象处理，不阻断非 BSON 值的规范化。 */
export function normalizeMongoCell(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'string')
        return trunc(v);
    if (typeof v === 'boolean')
        return v ? 'true' : 'false';
    if (v instanceof Date)
        return v.toISOString();
    const M = vendorOrNull();
    if (M && (v instanceof M.ObjectId || v instanceof M.Decimal128 || v instanceof M.Long || v instanceof M.Timestamp)) {
        return trunc(v.toString());
    }
    if (M && v instanceof M.Binary)
        return trunc(Buffer.from(v.buffer ?? []).toString('hex') || String(v));
    if (typeof v === 'object') {
        try {
            return trunc(JSON.stringify(v) ?? String(v));
        }
        catch {
            return trunc(String(v));
        }
    }
    return trunc(String(v));
}
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** 可执行服务端 JS 的键（代码注入面） */
const JS_INJECTION_KEYS = new Set(['$where', '$function', '$accumulator']);
/** 有写副作用的聚合阶段（只读 query 通道禁止） */
const WRITE_STAGE_KEYS = new Set(['$out', '$merge', '$unionWith']);
/** 递归检测命令文档：拒绝服务端 JS 键（$where/$function/$accumulator）与写副作用聚合阶段（$out/$merge/$unionWith） */
function assertNoWhere(node, path = '$') {
    if (Array.isArray(node)) {
        node.forEach((child, i) => assertNoWhere(child, `${path}[${i}]`));
        return;
    }
    if (isPlainObject(node)) {
        for (const [k, v] of Object.entries(node)) {
            if (JS_INJECTION_KEYS.has(k)) {
                throw new Error(`MongoDB query refuses to use ${k} (${path}.${k}): it can execute server-side JS code, which is an injection risk; use query operators instead`);
            }
            if (WRITE_STAGE_KEYS.has(k)) {
                throw new Error(`MongoDB query refuses aggregation stage ${k} (${path}.${k}): the stage has write side effects (writes or creates the target collection) and the read-only channel does not allow it; use the execute channel and assess permissions if you really need to persist data`);
            }
            assertNoWhere(v, `${path}.${k}`);
        }
    }
}
/** 解析命令文档字符串为对象（首个键为操作名） */
function parseCommandDoc(input) {
    let doc;
    try {
        doc = JSON.parse(input);
    }
    catch (e) {
        throw new Error(`MongoDB command is not valid JSON: ${e instanceof Error ? e.message : String(e)}. Example: {"find":"users","filter":{},"limit":10}`);
    }
    if (!isPlainObject(doc) || Object.keys(doc).length === 0) {
        throw new Error('MongoDB command must be a non-empty JSON document object with the operation name as its first key, e.g. {"find":"users"}');
    }
    return doc;
}
/** 空 filter 校验：updateMany/deleteMany 必须显式 filter（危险操作确认前的适配器级防线） */
export function assertExplicitFilter(op, filter) {
    const empty = filter === null || filter === undefined ||
        (isPlainObject(filter) && Object.keys(filter).length === 0);
    if (empty) {
        throw new Error(`MongoDB ${op} requires an explicit filter: an empty condition applies to the whole collection. If a whole-collection operation is really intended, use an explicit condition (such as {"_id":{"$exists":true}}) and pass the dangerous-operation confirmation`);
    }
}
function requireObject(v, label) {
    if (!isPlainObject(v))
        throw new Error(`MongoDB ${label} must be a JSON object`);
    return v;
}
export async function createMongoAdapter(conn, opts) {
    const mode = opts?.mode ?? 'rw';
    let client;
    if (opts?.client) {
        client = opts.client;
    }
    else {
        const uri = conn.url ?? buildUri(conn.fields, conn.ssl);
        client = new (vendor().MongoClient)(uri, {
            maxPoolSize: 10,
            readPreference: 'primary',
            w: 'majority',
            family: 4,
        });
        try {
            await client.connect();
        }
        catch (e) {
            throw new Error(`MongoDB connection failed (${sanitizeUri(uri)}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const dbName = typeof conn.meta.database === 'string' && conn.meta.database !== ''
        ? conn.meta.database
        : conn.url
            ? urlDbName(conn.url)
            : defaultDbName(conn.fields);
    const db = client.db(dbName);
    /** 库定位：database 指定且非连接默认库时切库（client.db() 是轻量句柄，不建新连接）；
     *  表清单/预览按所选库真实返回，避免「清单来自固定库、定位发所选库」的错位 */
    function dbOf(database) {
        return database && database !== dbName ? client.db(database) : db;
    }
    function wrap(e) {
        const M = vendorOrNull();
        if (M && e instanceof M.MongoServerError) {
            return new Error(`MongoDB server error: ${e.message}${e.codeName ? ` (${e.codeName})` : ''}`);
        }
        return new Error(`MongoDB error: ${e instanceof Error ? e.message : String(e)}`);
    }
    function requireRw(action) {
        if (mode === 'ro') {
            throw new Error(`Connection is in read-only (ro) mode; refusing to run ${action}; use an rw connection or send queries (query) only`);
        }
    }
    function collOf(cmd, op) {
        const name = cmd[op];
        if (typeof name !== 'string' || name === '') {
            throw new Error(`MongoDB ${op} requires a collection name string, e.g. {"${op}":"users"}`);
        }
        return name;
    }
    const adapter = {
        kind: 'mongodb',
        connId: conn.meta.id,
        async testConnect() {
            try {
                // hello 响应没有 version 字段（官方手册字段表仅 isWritablePrimary/topologyVersion/
                // maxBsonObjectSize/maxWireVersion 等），软件版本属 buildInfo 命令 → 取
                // buildInfo.version；权限不足等失败回退 hello 仅判连通（版本信息尽力而为）
                try {
                    const info = (await client.db('admin').command({ buildInfo: 1 }));
                    return { ok: true, serverInfo: `MongoDB ${String(info.version ?? '')}` };
                }
                catch {
                    await client.db('admin').command({ hello: 1 });
                    return { ok: true, serverInfo: 'MongoDB (version information unavailable)' };
                }
            }
            catch (e) {
                return { ok: false, error: wrap(e).message };
            }
        },
        async query(sql) {
            try {
                const cmd = parseCommandDoc(sql);
                assertNoWhere(cmd);
                const op = Object.keys(cmd)[0];
                if (!READ_OPS.has(op)) {
                    throw new Error(`MongoDB query does not support operation ${op}. Read operations: ${[...READ_OPS].sort().join('/')}; use execute for write operations`);
                }
                switch (op) {
                    case 'find': {
                        const name = collOf(cmd, 'find');
                        const filter = isPlainObject(cmd.filter) ? cmd.filter : {};
                        const sort = isPlainObject(cmd.sort) ? cmd.sort : { _id: 1 };
                        const limitRaw = typeof cmd.limit === 'number' && cmd.limit > 0 ? Math.floor(cmd.limit) : 20;
                        const limit = Math.min(limitRaw, FIND_MAX_LIMIT);
                        const skip = typeof cmd.skip === 'number' && cmd.skip > 0 ? Math.floor(cmd.skip) : undefined;
                        const projection = isPlainObject(cmd.projection) ? cmd.projection : undefined;
                        const cursor = db.collection(name).find(filter, {
                            sort: sort,
                            limit,
                            ...(skip !== undefined ? { skip } : {}),
                            ...(projection ? { projection: projection } : {}),
                        });
                        const docs = await cursor.toArray();
                        return docsToResult(docs, false);
                    }
                    case 'aggregate': {
                        let stages;
                        if (Array.isArray(cmd.aggregate)) {
                            stages = cmd.aggregate;
                        }
                        else if (Array.isArray(cmd.pipeline)) {
                            stages = cmd.pipeline;
                        }
                        else {
                            throw new Error('MongoDB aggregate requires a stages array: {"aggregate":"coll","pipeline":[{"$match":{}}]}');
                        }
                        const name = typeof cmd.aggregate === 'string' ? cmd.aggregate : undefined;
                        if (name === undefined)
                            throw new Error('MongoDB aggregate requires a collection name: {"aggregate":"coll","pipeline":[...]}');
                        const docs = await db.collection(name).aggregate(stages).limit(ROWS_MAX).toArray();
                        return docsToResult(docs, docs.length >= ROWS_MAX);
                    }
                    case 'count': {
                        const name = collOf(cmd, 'count');
                        const n = await db.collection(name).countDocuments(isPlainObject(cmd.query) ? cmd.query : {});
                        return { columns: ['count'], rows: [[n]], rowCount: 1 };
                    }
                    case 'countDocuments': {
                        const name = collOf(cmd, 'countDocuments');
                        const n = await db.collection(name).countDocuments(isPlainObject(cmd.filter) ? cmd.filter : {});
                        return { columns: ['count'], rows: [[n]], rowCount: 1 };
                    }
                    case 'estimatedDocumentCount': {
                        const name = collOf(cmd, 'estimatedDocumentCount');
                        const n = await db.collection(name).estimatedDocumentCount();
                        return { columns: ['count'], rows: [[n]], rowCount: 1 };
                    }
                    case 'distinct': {
                        const name = collOf(cmd, 'distinct');
                        if (typeof cmd.key !== 'string' || cmd.key === '') {
                            throw new Error('MongoDB distinct requires a key field name: {"distinct":"coll","key":"field","query":{}}');
                        }
                        const vals = await db.collection(name).distinct(cmd.key, isPlainObject(cmd.query) ? cmd.query : {});
                        const rows = vals.map((v) => [normalizeMongoCell(v)]);
                        return { columns: [cmd.key], rows, rowCount: rows.length, truncated: rows.length >= ROWS_MAX || undefined };
                    }
                    case 'listCollections': {
                        const infos = await db.listCollections().toArray();
                        const rows = infos.map((c) => [c.name, c.type ?? 'collection']);
                        return { columns: ['name', 'type'], rows, rowCount: rows.length };
                    }
                    case 'dbStats': {
                        const stats = await db.command({ dbStats: 1 });
                        return objectToResult(stats);
                    }
                    case 'collStats': {
                        const name = collOf(cmd, 'collStats');
                        const stats = await db.command({ collStats: name });
                        return objectToResult(stats);
                    }
                    case 'indexes': {
                        const name = collOf(cmd, 'indexes');
                        const idxs = await db.collection(name).indexes();
                        const rows = idxs.map((ix) => [
                            String(ix.name ?? ''),
                            normalizeMongoCell(ix.key),
                            ix.unique === true ? 'true' : 'false',
                        ]);
                        return { columns: ['name', 'key', 'unique'], rows, rowCount: rows.length };
                    }
                    default:
                        throw new Error(`MongoDB query does not yet implement operation ${op}`);
                }
            }
            catch (e) {
                throw wrap(e);
            }
        },
        async execute(statement) {
            requireRw('write operations (execute)');
            try {
                const cmd = parseCommandDoc(statement);
                assertNoWhere(cmd);
                const op = Object.keys(cmd)[0];
                if (!WRITE_OPS.has(op)) {
                    throw new Error(`MongoDB execute does not support operation ${op}. Write operations: ${[...WRITE_OPS].sort().join('/')}`);
                }
                if (op === 'createCollection') {
                    const name = collOf(cmd, 'createCollection');
                    await db.createCollection(name);
                    return { message: `Created collection ${name}` };
                }
                if (op === 'dropCollection') {
                    const name = collOf(cmd, 'dropCollection');
                    const dropped = await db.dropCollection(name);
                    return dropped
                        ? { message: `Dropped collection ${name}` }
                        : { message: `Collection ${name} does not exist; nothing was dropped` };
                }
                if (op === 'renameCollection') {
                    const from = collOf(cmd, 'renameCollection');
                    if (typeof cmd.to !== 'string' || cmd.to === '') {
                        throw new Error('MongoDB renameCollection requires a "to" target name: {"renameCollection":"a","to":"b"}');
                    }
                    await db.collection(from).rename(cmd.to);
                    return { message: `Renamed collection ${from} to ${cmd.to}` };
                }
                if (op === 'createIndex' || op === 'createIndexes') {
                    const name = collOf(cmd, op);
                    const specs = isPlainObject(cmd.index)
                        ? [cmd.index]
                        : Array.isArray(cmd.index)
                            ? cmd.index
                            : isPlainObject(cmd.indexes) ? [cmd.indexes] : Array.isArray(cmd.indexes) ? cmd.indexes : null;
                    if (!specs)
                        throw new Error('MongoDB createIndex requires an index spec object or array: {"createIndex":"coll","index":{"key":{"a":1},"name":"a_1"}}');
                    // 官方返回索引名数组（mongodb.d.ts: createIndexes(...): Promise<string[]>），
                    // 无 createdNewIndexes 字段（曾按记忆臆造，恒 undefined）；驱动不区分
                    // 新建/已存在，affectedRows = 规格数
                    const created = await db.collection(name).createIndexes(specs);
                    return { affectedRows: created.length, message: `Created indexes on collection ${name} (${created.length} in total)` };
                }
                if (op === 'dropIndex' || op === 'dropIndexes') {
                    const name = collOf(cmd, op);
                    const index = typeof cmd.index === 'string' ? cmd.index : undefined;
                    if (index === undefined)
                        throw new Error('MongoDB dropIndex requires an index name: {"dropIndex":"coll","index":"a_1"}');
                    await db.collection(name).dropIndex(index);
                    return { message: `Dropped index ${index} on collection ${name}` };
                }
                // ---- 文档级 DML ----
                const name = collOf(cmd, op);
                const c = db.collection(name);
                switch (op) {
                    case 'insertOne': {
                        // 不设 cmd.insert 别名：该键语义是集合名（insertMany 命令形态），混用会误导报错方向
                        const doc = reviveEjson(requireObject(cmd.document, 'insertOne.document'));
                        const r = await c.insertOne(doc);
                        return { affectedRows: 1, message: `Inserted 1 document into ${name} (_id=${String(r.insertedId)})` };
                    }
                    case 'insertMany': {
                        if (!Array.isArray(cmd.documents ?? cmd.docs) || (cmd.documents ?? cmd.docs).length === 0) {
                            throw new Error('MongoDB insertMany requires a non-empty documents array: {"insertMany":"coll","documents":[{...}]}');
                        }
                        const docs = (cmd.documents ?? cmd.docs).map((d) => reviveEjson(requireObject(d, 'insertMany.documents[]')));
                        const r = await c.insertMany(docs);
                        return { affectedRows: r.insertedCount, message: `Inserted ${r.insertedCount} documents into ${name}` };
                    }
                    case 'updateOne':
                    case 'updateMany': {
                        if (op === 'updateMany')
                            assertExplicitFilter(op, cmd.filter);
                        const filter = reviveEjson(requireObject(cmd.filter, `${op}.filter`));
                        const update = reviveEjson(requireObject(cmd.update, `${op}.update`));
                        const r = op === 'updateOne'
                            ? await c.updateOne(filter, update)
                            : await c.updateMany(filter, update);
                        return {
                            affectedRows: r.modifiedCount,
                            message: `${op} complete: ${r.matchedCount} matched, ${r.modifiedCount} modified (${name})`,
                        };
                    }
                    case 'replaceOne': {
                        const filter = reviveEjson(requireObject(cmd.filter, 'replaceOne.filter'));
                        const replacement = reviveEjson(requireObject(cmd.replacement ?? cmd.update, 'replaceOne.replacement'));
                        const r = await c.replaceOne(filter, replacement);
                        return {
                            affectedRows: r.modifiedCount,
                            message: `replaceOne complete: ${r.matchedCount} matched, ${r.modifiedCount} replaced (${name})`,
                        };
                    }
                    case 'deleteOne':
                    case 'deleteMany': {
                        if (op === 'deleteMany')
                            assertExplicitFilter(op, cmd.filter);
                        const filter = reviveEjson(requireObject(cmd.filter, `${op}.filter`));
                        const r = op === 'deleteOne'
                            ? await c.deleteOne(filter)
                            : await c.deleteMany(filter);
                        return { affectedRows: r.deletedCount, message: `${op} complete: ${r.deletedCount} deleted (${name})` };
                    }
                    default:
                        throw new Error(`MongoDB execute does not yet implement operation ${op}`);
                }
            }
            catch (e) {
                throw wrap(e);
            }
        },
        async listDatabases() {
            try {
                const infos = await client.db('admin').admin().listDatabases();
                return infos.databases.map((d) => d.name);
            }
            catch (e) {
                throw wrap(e);
            }
        },
        async listTables(database) {
            try {
                const infos = await dbOf(database).listCollections().toArray();
                return infos.map((c) => ({ name: c.name, type: c.type === 'view' ? 'view' : 'collection' }));
            }
            catch (e) {
                throw wrap(e);
            }
        },
        async describeTable(name) {
            try {
                const c = db.collection(name);
                // 视图没有索引（listIndexes 报 CommandNotSupportedOnView，浏览树点开视图会整页报错）：
                // 先探类型，视图跳过索引注入；集合路径行为不变
                const infos = await db.listCollections({ name }).toArray();
                const idxs = infos[0]?.type === 'view' ? [] : await c.indexes();
                const sample = await c.find({}).limit(10).toArray();
                const cols = new Map();
                for (const doc of sample) {
                    for (const [k, v] of Object.entries(doc)) {
                        const entry = cols.get(k) ?? { types: new Set(), present: 0 };
                        entry.types.add(inferBsonType(v));
                        entry.present += 1;
                        cols.set(k, entry);
                    }
                }
                const indexByField = new Map();
                for (const ix of idxs) {
                    for (const field of Object.keys((ix.key ?? {}))) {
                        indexByField.set(field, [...(indexByField.get(field) ?? []), String(ix.name ?? '')]);
                    }
                }
                const out = [];
                for (const [field, entry] of cols) {
                    const types = [...entry.types].sort().join('|');
                    const indexNames = indexByField.get(field);
                    out.push({
                        name: field,
                        dataType: `${types} (inferred)`,
                        nullable: sample.length > 0 && entry.present < sample.length,
                        ...(field === '_id' ? { key: 'PRI' } : {}),
                        comment: indexNames && indexNames.length > 0 ? `index: ${indexNames.join(', ')}` : undefined,
                    });
                }
                // _id 未出现在样本中（空集合）也要给出主键提示
                if (!out.some((c) => c.name === '_id')) {
                    out.unshift({ name: '_id', dataType: 'ObjectId (inferred)', nullable: false, key: 'PRI', comment: 'inferred from empty collection sample' });
                }
                return out;
            }
            catch (e) {
                throw wrap(e);
            }
        },
        async previewRows(name, limit, database, offset) {
            try {
                const n = Math.max(1, Math.min(Math.floor(limit) || 20, FIND_MAX_LIMIT));
                const skip = Math.max(0, Math.floor(offset ?? 0) || 0);
                const docs = await dbOf(database).collection(name).find({}).sort({ _id: 1 }).skip(skip).limit(n).toArray();
                return docsToResult(docs, false);
            }
            catch (e) {
                throw wrap(e);
            }
        },
        async close() {
            await client.close();
        },
    };
    /** 文档数组 → QueryResult（列 = 字段并集，保持首次出现顺序） */
    function docsToResult(docs, truncated) {
        const columns = [];
        for (const d of docs) {
            for (const k of Object.keys(d)) {
                if (!columns.includes(k))
                    columns.push(k);
            }
        }
        const rows = docs.map((d) => columns.map((c) => normalizeMongoCell(d[c])));
        return { columns, rows, rowCount: rows.length, truncated: truncated || undefined };
    }
    return adapter;
}
/** 单层统计对象 → ['name','value'] 两列 */
function objectToResult(obj) {
    const rows = Object.entries(obj).map(([k, v]) => [k, normalizeMongoCell(v)]);
    return { columns: ['name', 'value'], rows, rowCount: rows.length };
}
function inferBsonType(v) {
    if (v === null)
        return 'null';
    const M = vendorOrNull();
    if (M) {
        if (v instanceof M.ObjectId)
            return 'ObjectId';
        if (v instanceof M.Decimal128)
            return 'Decimal128';
        if (v instanceof M.Long)
            return 'Long';
        if (v instanceof M.Timestamp)
            return 'Timestamp';
        if (v instanceof M.Binary)
            return 'Binary';
    }
    if (v instanceof Date)
        return 'date';
    if (Array.isArray(v))
        return 'array';
    if (typeof v === 'object')
        return 'object';
    return typeof v;
}
/** Mongo Extended JSON（$oid/$date）→ BSON 原生类型：前端单元格写回以 JSON 表达 ObjectId/Date，
 * driver 不识别 EJSON 形态，须经此复活。最小集：仅 $oid/$date；其余键原样递归保留。
 * $oid 需 24 位十六进制，非法抛中文可读错误；vendor 缺失时 $oid 原样返回不抛（降级可用）。 */
const OID_HEX_RE = /^[0-9a-f]{24}$/i;
export function reviveEjson(v) {
    if (Array.isArray(v))
        return v.map(reviveEjson);
    if (!isPlainObject(v))
        return v;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$oid') {
        const s = v.$oid;
        if (typeof s !== 'string' || !OID_HEX_RE.test(s)) {
            throw new Error(`Invalid MongoDB $oid value (${String(s)}): expected a 24-character hexadecimal string, e.g. {"$oid":"507f1f77bcf86cd799439011"}`);
        }
        const M = vendorOrNull();
        return M ? new M.ObjectId(s) : v;
    }
    if (keys.length === 1 && keys[0] === '$date') {
        const d = v.$date;
        if (typeof d !== 'string' && typeof d !== 'number')
            return v;
        return new Date(d);
    }
    const out = {};
    for (const [k, val] of Object.entries(v))
        out[k] = reviveEjson(val);
    return out;
}
export function buildUri(fields, ssl) {
    const host = typeof fields?.host === 'string' && fields.host !== '' ? fields.host : '127.0.0.1';
    // 前端原样发字符串端口：显式校验；历史 typeof==='number' 门把一切字符串（含合法 '14330'）
    // 静默丢弃回退 27017，分字段模式用户所填端口实际永不生效
    const port = validPort(fields?.port, 27017, 'mongodb');
    const user = typeof fields?.user === 'string' ? encodeURIComponent(fields.user) : '';
    const pass = typeof fields?.password === 'string' ? `:${encodeURIComponent(fields.password)}` : '';
    const auth = user !== '' ? `${user}${pass}@` : '';
    // tls 用查询参数表达：mongodb+srv 是 DNS seedlist 形态（禁止显式端口），与 TLS 无关，不可混用
    const params = [];
    if (typeof fields?.authDatabase === 'string' && fields.authDatabase !== '') {
        params.push(`authSource=${fields.authDatabase}`);
    }
    if (ssl || fields?.ssl === true || fields?.tls === true)
        params.push('tls=true');
    const qs = params.length > 0 ? `?${params.join('&')}` : '';
    return `mongodb://${auth}${host}:${port}${qs}`;
}
/** URL 模式库名：取 URL path 首段（percent 解码），无则 'test' 兜底（与 pg-like mainDb 同口径） */
function urlDbName(url) {
    try {
        return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || 'test';
    }
    catch {
        return 'test';
    }
}
function defaultDbName(fields) {
    return typeof fields?.database === 'string' && fields.database !== '' ? fields.database : 'test';
}
function sanitizeUri(uri) {
    return uri.replace(/:\/\/[^@/]*@/, '://***:***@');
}
export const factory = async (conn) => createMongoAdapter(conn);
export async function openMongoRaw(conn) {
    const M = vendor();
    const uri = conn.url ?? buildUri(conn.fields, conn.ssl);
    const client = new M.MongoClient(uri, {
        maxPoolSize: 10,
        readPreference: 'primary',
        w: 'majority',
        family: 4,
    });
    try {
        await client.connect();
    }
    catch (e) {
        throw new Error(`MongoDB connection failed (${sanitizeUri(uri)}): ${e instanceof Error ? e.message : String(e)}`);
    }
    const dbName = typeof conn.meta.database === 'string' && conn.meta.database !== ''
        ? conn.meta.database
        : conn.url
            ? urlDbName(conn.url)
            : defaultDbName(conn.fields);
    return { client, db: client.db(dbName), M };
}
