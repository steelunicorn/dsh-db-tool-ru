---
name: dsh-db-tool
description: "Development skill for dsh-db-tool-ru (a TypeScript DSH host plugin that exposes the DatabaseManager database tool). Use it when developing, adding or changing the nine database adapters (mysql/postgresql/oracle/sqlite/dmdb/gaussdb/mongodb/redis/sqlserver), writing SQL-dialect code, implementing or debugging data transfer, handling per-database differences (identifier quoting, bulk writes, human-friendly errors), or adjusting API routes and store configuration in this repository."
---

# dsh-db-tool Development Skill

> Languages: English (this file) · [Русский](SKILL.ru.md) · [简体中文](SKILL.zh.md)

## Module Map

| Path | Responsibility |
| --- | --- |
| `lib/index.ts` | Plugin entry point. `export const inject = ['webServer', 'sessions', 'tools', 'connection']`; `ctx.webServer.register({kind:'prefix', path:'/dsh-db-tool/api'})` mounts HTTP; `ctx.tools.register` registers the `DatabaseManager` tool (`timeoutMs: 90_000`, six actions: `list_connections`/`query`/`execute`/`schema`/`preview`/`run_script`); `ctx.effect` finishes with `service.dispose()`. `projectPath` is taken only from `session.header.cwd`, never from the model's self-report. **Default export is forbidden** — cordis's `unwrapExports()` prefers `exports.default`, and a bare-function shape loses the `inject` named export, reporting `cannot get property "webServer" without inject` while the plugin never activates |
| `lib/http/index.ts` | API route dispatch layer (routing and parameters only, business logic pushed down to the manager); `isTrustedRequest` performs Host/Origin validation, `MAX_JSON_BODY_BYTES` 2MB |
| `lib/manager.ts` | `DbToolService`: audit (`audit`), authorization (`authorize`), error conversion (`toDriverError`), `DbToolError`; `handleToolAction` is the dispatch entry point for model tool actions |
| `lib/guard/index.ts` | Statement risk grading + one-time challenge credentials (see the next section) |
| `lib/script/runner.ts` | `run_script` child-process executor (parent side): `fork` + permission model flag + environment variable allowlist + timeout SIGKILL |
| `lib/script/worker.cjs` | `run_script` worker (child side): `vm.runInNewContext` new realm, only `db`/`console` injected; `db` calls return to the parent process over IPC and go through the full guard/audit chain |
| `lib/adapters/index.ts` | Unified entry `getAdapter(kind)`; a missing driver uniformly throws `driverMissingError(kind, cause?)` |
| `lib/adapters/<kind>/index.ts` | Dialect adapters: mysql, postgresql, oracle, sqlite, dmdb, gaussdb, mongodb, redis, sqlserver (nine databases, registry in `LOADERS` of `lib/adapters/index.ts`) |
| `lib/adapters/types.ts` | Unified adapter contract `DatabaseAdapter`: `query`/`execute`/`listDatabases`/`listTables`/`describeTable`/`previewRows`/`testConnect`/`close`, optional `listSchemas?`/`searchTables?`/`tx?` |
| `lib/adapters/sql-shared/common.ts` | Shared SQL utilities: `assertIdent`, `quoteIdent`, `clampLimit`, `clampOffset`, `normalizeCell`, `humanize` (high fan-in hotspot, check every caller before changing) |
| `lib/adapters/sql-shared/pg-like.ts` | PostgreSQL/GaussDB shared implementation: `normalizeUrl` (multi-host URL parsing/reassembly), `pickHost` (liveness probe host selection), `createPgLikeAdapter`, `TxHandle` |
| `lib/adapters/transfer/` | Transfer model `model.ts` (`TransferCursor`/`TransferRow`/`readBatch`) + `kinds/` (seven implementations — mongo, mysql, oralike, pg, sqlite, sqlserver, redis — covering nine kinds; the newly added `kinds/redis.ts` is the degraded implementation for the Redis fixed envelope table `__redis_keys`) |
| `lib/transfer.ts` | Transfer orchestrator `startTransferTask`: table-level parallelism + large tables sharded in parallel by `keyAt`; concurrency cap `MAX_TRANSFER_TASKS = 8` |
| `lib/store/index.ts` | `DbToolStore` aggregate: data root `<My Documents>/DSH/db-tool` (directory `0700`, same root as `transfer-log.jsonl`); resolution priority: explicit `homeDir` (test injection) > `DSH_DB_TOOL_DIR` > `<My Documents>/DSH`. "My Documents" is resolved by `documentsDir()` (`transfer-history.ts`, Windows Shell API `GetFolderPath`), automatically following redirection; the old location `$DSH_HOME/db-tool` is migrated per file on first startup (`migrateLegacyDir`, skipped when the target exists, old files kept), and migration is skipped when `homeDir` is injected |
| `lib/store/io.ts` | `writeJsonAtomic` (temp file + rename atomic write), `readJson`, `chmodBestEffort` |
| `lib/store/connections.ts` | Connection metadata (no passwords) + `redactUrl`, `mergeUrlCredentials`, `DuplicateConnectionError` |
| `lib/store/secrets.ts` | `SecretsBox`: passwords/full URLs, written to `secrets.json` (`0600`), plaintext never leaves the store |
| `lib/store/grants.ts` | Project-level connection grants `grants.json` |
| `lib/store/audit.ts` | `AuditLog` append-only `audit.jsonl` |
| `lib/store/transfer-history.ts` | `TransferLog` → `transfer-log.jsonl`, same root as `db-tool/` (`<My Documents>/DSH/`); exports `documentsDir()` for reuse by the store; under vitest (`VITEST=true`) writes to a temporary data root to avoid polluting the real Documents directory |
| `lib/store/normalize.ts` | `normalizeProjectKey` (high fan-in: cross-platform path normalization) |
| `lib/store/export-crypto.ts` | `encryptPayload`/`decryptPayload`, cross-machine passphrase encryption for connection export/import |
| `scripts/` | `build-mongodb.mjs`/`build-sqlserver.mjs`/`build-codemirror.mjs` (esbuild artifacts), `hotfix-core.mjs` (host hotfix core), `apply-dsh-hotfix.ps1`/`.sh`, `diag-profile.mjs`, `verify-host.mjs`, `fix-dsh-install.ps1` |
| `patches/` | Hotfix patches for the DSH host `dsh-app-boot`, chosen one-to-one by host version (see the next section) |
| `assets/` | `feature-flow.png`/`.html`, the feature flow diagram used by the README |
| `.github/workflows/` | `ci.yml` (Node 22/24 matrix: `npm ci` → `npm run build` → typecheck → test), `publish.yml` (releases only when the version changes) |
| `client/client.js` | Sidebar frontend (single file), loads the editor at runtime via `require("../vendor/codemirror-sql.cjs")`; on load failure it degrades to a plain textarea (after the singleton promise fails it is reset to null to allow a retry), and it performs no same-origin fetch (to prevent `Function` dynamic-execution poisoning) |
| `tests/` | vitest, 69 test files: `adapters-sql`(22), `store`(11), `adapters-nosql-ent`(8), `client`(9), `tool`(7), `guard`(3), `http`(3), `e2e-mock`(3), `plugin`(2), `scripts`(1); repository-root `stryker.config.json` mutation testing (mutates only `lib/index.ts` and `lib/http/index.ts`) |

API surface (`lib/http/index.ts`, real paths carry the `/dsh-db-tool` prefix): `/api/state`, `/api/project-context`, `/api/connections` (CRUD + `/export`, `/import` passphrase-encrypted cross-machine migration), `/api/test-draft`, `/api/grants`, `/api/databases`, `/api/tables`, `/api/schemas`, `/api/schema`, `/api/search-tables`, `/api/preview`, `/api/query`, `/api/execute`, `/api/script`, `GET/PUT /api/transfer-config` (transfer configuration persisted per project, auto-saved, restored on restart, cleared when the connection is invalid), `/api/transfer/start`, `/api/transfer/live`, `/api/transfer-log`, `/api/transfer-history`, `/api/transfer-history/clear`, `/api/console/begin|exec|commit|rollback` (sticky connection, begin issues a token, reads inside a transaction must go through the same connection), `/api/audit`. New routes must synchronize the contract assertions in `tests/http/api.spec.ts`.

### guard: risk grading and confirmation credentials

`classifyStatement(kind, statement, op)` is the single grading entry point, returning `{ level: 'danger'|'warning'|'none', reason?: string }`, dispatched by kind to `classifySql`/`classifyRedis`/`classifyMongo`.

| Dimension | Rule | Level |
| --- | --- | --- |
| Read allowlist | `SQL_READ_HEADS` (`select/with/show/describe/desc/explain/use/set/help/table`) first word hit | Continue sub-classification, otherwise treated as unknown |
| Danger hidden in a read body | `SQL_HIDDEN_DANGER_RE`: multiple statements, `INTO OUTFILE/DUMPFILE`, `LOAD_FILE(`, `SET GLOBAL/PERSIST`, `FOR UPDATE` | danger |
| Write hidden in a read body | `SQL_WRITE_BODY_RE`: `insert/update/delete/merge/drop/alter/truncate` (`WITH...DELETE` class) | danger |
| DDL | `SQL_DDL_RE`: `drop/truncate/alter/create/rename/comment/grant/revoke/flashback/purge` | danger (implicit commit, cannot be rolled back) |
| DML | `SQL_DML_RE`: `insert/update/delete/merge/replace/upsert/call/do` | danger on the `query` channel; warning on the `execute` channel |
| Maintenance commands | `SQL_MAINT_RE`: `shutdown/startup/archive log/recover/analyze/optimize/check table/repair/lock/unlock/kill/flush` | danger |
| Unknown first word | Matches no list | danger on the `query` channel; warning on the `execute` channel |
| T-SQL-specific first words | `SQLSERVER_DANGER_HEADS`: `backup/restore/dbcc/reconfigure/bulk/shutdown/sp_configure/xp_cmdshell`, **enabled only for kind=sqlserver** | danger |
| T-SQL dynamic execution | `EXEC/EXECUTE` followed by `xp_*`/`sp_configure`/`sp_executesql` (within 200 characters), `EXEC('…')`/`EXEC N'…'`/`EXEC @sql` | danger |
| T-SQL `SELECT ... INTO` | Creates an object; the `AS into` alias and `INTO @variable` are allowed | danger |
| Redis | `DANGEROUS_COMMANDS` (exported by the adapter) danger; `WRITE_COMMANDS` by channel; `READ_COMMANDS` none; unparsable/unrecognized fail-closed | See left |
| MongoDB | `DANGEROUS_OPS` (`READ_OPS`/`DANGEROUS_OPS` both exported from the adapter, single source of truth) + `drop` as a fallback danger; `MONGO_WRITE_OPS` by channel; unrecognized fail-closed | See left |

Note that `SQL_READ_HEADS` and `SQLSERVER_DANGER_HEADS` are both `ReadonlySet` — callers may not add or remove entries on security primitives, and changing the list means changing this code.

`ChallengeStore`: `ttlMs` defaults to 5min, `sweepIntervalMs` defaults to 60s (`0` disables the timer for tests), the injected clock `now` serves expiry tests; id = `c_` + 12-byte hex; `statementHash` is the statement SHA256; `consume(id, statement, scope)` **calls `delete` before validating** (it is taken regardless of success or failure, preventing replay probing), and the scope `connId + projectKey` must match exactly the one at creation, preventing the same statement from being replayed across databases or projects.

### run_script isolation model

Two layers: a separate child process + the Node permission model (**no fs**; Node ≥22 uses `--permission`, 20/21 use `--experimental-permission`), and the script itself runs in the worker's **new vm realm** (`vm.runInNewContext`, `vm timeout 60s`), with only `db.query`/`db.execute`/`console` injected. `vm` is not a security boundary (the `Function` constructor can escape), so the real backstop is that the child process has no file permissions.

| Parameter | Value | Location |
| --- | --- | --- |
| Environment variables | Allowlist of 11 entries: `PATH/SYSTEMROOT/SYSTEMDRIVE/TEMP/TMP/COMSPEC/PATHEXT/USERPROFILE/HOME/LANG/TZ` | `ENV_ALLOWLIST`, `minimalEnv()` in `runner.ts` |
| Default timeout | 60s, enforced by the **parent process `SIGKILL`** (`vm timeout` only constrains synchronous execution and cannot govern async work) | `runner.ts` `runScriptInChild` |
| Timeout side effects | Triggers `onTimeout` → closes the session-dedicated adapter, interrupting in-flight db calls | Same as above |
| db calls | Return to the parent process over IPC, going through the full guard/challenge/audit chain | `worker.cjs` |

## Adapter Capability Matrix

`✅` = the optional method is implemented; `—` = not implemented (contract-optional); `native` / `fallback` / `empty` see the `searchTables` column note.

| kind | testConnect | query | execute | listDatabases | listSchemas | listTables | describeTable | previewRows | searchTables |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mysql | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | native |
| postgresql | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | native |
| gaussdb | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | native |
| sqlserver | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | empty |
| oracle | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | empty |
| dmdb | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | empty |
| sqlite | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | fallback |
| mongodb | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | fallback |
| redis | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | empty |

`searchTables` has three tiers: **native** (mysql — a single `information_schema` LIKE; pg/gaussdb pool `ILIKE` per database, with `database` compatible with the three forms "database name / `database.schema` / schema"); **fallback** (`SEARCH_FALLBACK_KINDS = mysql/mongodb/sqlite`, per-database `listTables` + in-memory filtering — mysql has a native implementation, so in practice only sqlite/mongodb take the fallback); **empty** (redis `listTables` ignores the database name, so a per-database loop would return the same batch of keys repeatedly; oracle/dmdb's `database` semantics are the owner, so cross-database fallback would mislabel the source; sqlserver is not in the allowlist). The fallback allowlist is a security boundary; before extending it, confirm that the target kind's `listTables(database)` semantics really are "database name".

Transaction capability falls into three tiers:

| Form | kind | Usage |
| --- | --- | --- |
| Object-style `tx: { begin, commit, rollback }` | mysql, postgresql, gaussdb, sqlserver | Explicit three steps |
| Functional `tx(fn)` | oracle, dmdb | Statements inside `fn(exec)` go through the transaction connection, and `exec` dispatches by statement head back to `QueryResult`/`ExecResult` |
| No `tx` | sqlite, redis, mongodb | mongodb cross-document transactions require a replica set and are outside this tool's commitments |

`query`/`execute` input semantics branch by kind; when writing an adapter do not copy the SQL family verbatim:

| kind | `query` input | `execute` input | `database` parameter |
| --- | --- | --- | --- |
| mysql | SQL + `?` placeholders | Same as left | Cross-database routing to a dedicated pool (the ro pool is likewise read-only) |
| postgresql/gaussdb | SQL + `$1` | Same as left | Same as above, supports routing by database |
| sqlserver | SQL + `?` (internally rewritten to `@p1`) | Same as left | Same as above |
| oracle/dmdb | SQL + `:name` | Same as left | Ignored (scenarios where `database` semantics are the owner are handled by `listTables`) |
| sqlite | SQL + `?` | Same as left | Ignored (single database `main`) |
| redis | **command array JSON** (`["GET","key"]` or `GET key`) | Same as left | Ignored (`db0`) |
| mongodb | **BSON command document JSON** (`{"find":"users","filter":{}}`) | Same as left | Target database |

## Adapter Development Rules

1. Before adding or changing a dialect, compare against the closest existing adapter: the PG family reuses `sql-shared/pg-like.ts`; the Oracle/DM family shares `transfer/kinds/oralike.ts`.
2. Export pattern (compare `lib/adapters/mysql/index.ts`): `export async function createXxxAdapter(conn)` + `export const factory: AdapterFactory = (conn) => createXxxAdapter(conn)`; do not bypass the factory and `new` directly.
3. A missing driver package is always thrown through `driverMissingError` in `lib/adapters/index.ts` (already handled uniformly inside `getAdapter`); do not invent error text inside adapters.
4. Identifiers use only `quoteIdent`/`assertIdent`; string-concatenating table or column names is forbidden; on the query side reuse `clampLimit`/`clampOffset` and `normalizeCell`, and reuse `humanize` for error wrapping.
5. SQL shared utilities (common.ts, pg-like.ts, normalizeProjectKey) are high fan-in hotspots: grep every caller before modifying, fix in one place inside the shared function, and never patch at individual call sites.
6. Cells are uniformly `NormalizedCell` (`string | number | null`): DECIMAL/NUMERIC stay strings to prevent precision loss, dates come out as ISO, Lobs are converted to strings and marked as truncated, Mongo `ObjectId`/`Decimal128`/`Long` uniformly use `toString()`.

## Nine-Database Differences Quick Reference

| Scenario | Pitfall |
| --- | --- |
| Bulk writes | The Oracle family binds `:b1..` placeholders, and the total number of bound parameters per batch is capped (DPI-1015), so wide tables need smaller batches; DM compatibility relies on message matching for unique conflicts (ORA-00001 / `-6602`), so do not match error codes exactly; MongoDB `bulkWrite` uses `ordered: false` and must fully convert before writing (a conversion throw → nothing is written), with no cross-batch transactions (requires a replica set); SQLite is single-writer, so writes are wrapped in `BEGIN IMMEDIATE`; the PG family's transfer writes use parameterized INSERT batches (no COPY) |
| Identifier quoting | `quoteIdent(name, quote)` defaults to double quotes, MySQL passes `` ` ``; internally it first passes `assertIdent` to prevent injection, escaping by doubling the quote |
| Error humanization | Wrap inside adapters with `humanize(label, fn)`, then pass through `toDriverError` at the manager layer; do not throw raw driver errors bare at the routing layer |
| GaussDB | URLs support multi-host liveness probing via `normalizeUrl`+`pickHost`; runtime failover and IPv6 are known ceilings, do not promise a fix |
| SQL Server | Use only the generic 2005+ style: metadata goes only through `sys.*` catalog views; pagination branches by version (2012+ uses `OFFSET/FETCH`, 2008/2008R2 falls back to `ROW_NUMBER`; transfers follow the same rule, ordered cursors use `SELECT TOP (n)`, and a failed version probe conservatively falls back to 0); identifiers are `[x]` with `]` doubled as `]]`; the external placeholder is `?`, rewritten internally by the adapter to `@p1`; **TDS version auto-negotiation** (declares `7_4` fixed, and the server degrades by its own capability: 2005→`7_2`, 2008→`7_3_A`, 2008R2→`7_3_B`, 2012+→`7_4`; an [MS-TDS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/773a62b6-ee89-4c02-9e5e-344882630aac) MUST-level requirement, do not lower it manually); `encrypt` supports `auto`/`true`/`false`/`strict`, and **new connections default to `auto`** (no encryption first; only when the server **enforces encryption** does it report `EENCRYPT`/"the server requires an encrypted connection", and only then is it **retried once** with `encrypt=true`+`trustServerCertificate=true`; a single retry, for this one reason only, and **no retry at all when `encrypt` is written explicitly**); on servers that do not enforce encryption, `auto` is equivalent to `encrypt=false`, i.e. LOGIN7 (including account and password) is sent in plaintext, so across the public internet or untrusted network segments `encrypt=true` should be set explicitly; `strict`=TDS 8.0, only 2022+ Force Strict Encryption; in that mode `trustServerCertificate` is completely ineffective; encryption and certificate parameters are collapsed under "Advanced options" in the interface, and a regular connection only needs host/port/account/password; SQL authentication only, no Windows integrated authentication / Azure AD; **for certificate-type errors prefer `?caCert=` to install the CA (officially recommended) or `?serverName=`, and only as a last resort `?trustServerCertificate=true`**; protocol-version errors (`UNSUPPORTED_PROTOCOL`) are not fixed by changing certificate parameters and require a server-side patch (2008R2 SP3 KB4057113 / 2008 SP4 KB4057114 / 2012·2014 corresponding CU+GDR and KB3052404) or a downgrade to `?tlsMinVersion=TLSv1`; **2005 has no patch that supports TLS 1.2**; **`encrypt=false` skips the TLS handshake entirely and sends LOGIN7 in plaintext** (measured by packet capture with a fake TDS server, the client's next packet is `0x10`; "the login packet is always encrypted" applies only when the server enforces encryption or the client sets `encrypt=true`); transfer bulk writes use rows per statement = `min(floor(2100 / number of columns), 1000)`; type movement: `hierarchyid`/`geometry`/`geography` → bytes (target `VARBINARY(MAX)`, UDT semantics not preserved), `sql_variant` → text (original type lost), `varchar/char(4001–8000)` → `NVARCHAR(MAX)` class, `datetime2`/`time` read side `CONVERT(..., 126)` for fidelity, decimal is faithful only on the transfer read side via `CONVERT(nvarchar(64), col)` (not faithful on the browse side); **five ro gates** (first-word allowlist + multiple statements + `SELECT ... INTO` + `WITH` write body + `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE` all rejected); console `GO n` repeat count capped at 1000 (truncated when exceeded) |

## Transfer Workflow Essentials

- Entry: `POST /api/transfer/start` → `startTransferTask` in `lib/transfer.ts` → `lib/adapters/transfer/` picks the `kinds/*` implementation by source/target kind; `GET/PUT /api/transfer-config` saves/restores the transfer configuration per project and automatically clears invalid connections. For product rationale see [DBeaver Task management](https://dbeaver.com/docs/dbeaver/Task-Management), [Airbyte Configuring schemas](https://docs.airbyte.com/platform/using-airbyte/configuring-schema), [AWS DMS task settings](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.CustomizingTasks.TaskSettings.html) and [Navicat Save Profiles](https://www.navicat.com/manual/pdf_manual/en/navicat_16/win_manual/navicat_en.pdf) ([official page dynamic shell/search summary confirmed]: Navicat is a PDF search summary, not parsed page by page).
- Intermediate types: source columns are first normalized to `MidType`/the unified intermediate model, then mapped to target columns, avoiding point-to-point conversion across nine databases; [official documentation confirmed] [AWS DMS built-in data types](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Reference.DataTypes.html) and [Airbyte supported data types](https://docs.airbyte.com/platform/understanding-airbyte/supported-data-types) both use built-in/common type systems; the N×N→2N complexity conclusion is [project inference].
- Structure follows the migration: target-side table creation happens in `createTable` of `kinds/*` (Oracle/DM family DDL implicitly commits, requiring `autoCommit: true`).
- Cursor: `TransferCursor` supports `keyset` and `range` (shard parallelism, the hi side is always an open interval); when the source does not implement `keyAt` chunking, the orchestration layer falls back to a keyset chain.
- Redis envelope contract: Redis participates in a degraded form through the fixed table `__redis_keys`, with six columns `key`/`type`/`ttl_ms`/`encoding`/`payload`/`dump`; `ttl_ms` is 0 when there is no expiry (PTTL `-1` becomes `0n`, PTTL `-2` means the key disappeared at the moment of reading and the key is skipped, and a positive value is used as-is in milliseconds), `encoding` is the `OBJECT ENCODING` in-memory encoding diagnostic value (such as raw/hashtable/listpack/quicklist, unrelated to serialization of the `payload` column), `payload` is flattened by `type` and is always a UTF-8 JSON string, and `dump` is only the [DUMP](https://redis.io/docs/latest/commands/dump/) bytes restored via [RESTORE](https://redis.io/docs/latest/commands/restore/) on a homogeneous Redis. The source side iterates the [SCAN](https://redis.io/docs/latest/commands/scan/) cursor from 0 to 0, and [TTL](https://redis.io/docs/latest/commands/ttl/)/PTTL fetch the remaining time per key; [official documentation confirmed] [Redis data types](https://redis.io/docs/latest/develop/data-types/) states that Redis is a data structure server, hence [project inference] Redis cannot be treated as a lossless table-to-table migration, explicitly excluding stream consumer groups, cross-version `DUMP`, and logical databases `dbN`.
- Parallelism: table level gets an independent reader/writer connection per table; in-table shard parallelism depends on the source's `keyAt`; the global task cap is `MAX_TRANSFER_TASKS = 8`.
- Row width validation: validate the column count row by row before writing (`row width mismatch` error), do not skip it.
- History: `TransferLog` writes `<My Documents>/DSH/transfer-log.jsonl`, read by `GET /api/transfer-history`; clearing goes through `/api/transfer-history/clear`.
- Related tests: `tests/adapters-sql/transfer-*.test.ts` (locate/mapping/oralike/sqlite/sqlserver/stress/task) plus the Redis envelope read-side and write-side equivalence cases.
- Running a transfer: fetch the source/target connections from `/api/connections` (passwords stored encrypted, cross-machine migration goes through the export/import interfaces, do not hand-assemble connection strings) → `POST /api/transfer/start`; before starting, restate to the user the source database, target database, involved tables, and whether parallelism is used.
- Transfer verification (complete only when all pass): ① source and target table counts match; ② sample by primary key and compare field by field (watch for precision, time zone, and binary mapping differences); ③ use `describeTable` to check whether column names/types/nullability/defaults migrated consistently. When it fails, report the difference details (table, row, field, expected value and actual value), do not silently re-transfer.

## Planning Before Changes

1. Determine the type: new feature (decide which layer to extend: http → manager → adapters/store) / fix (reproduce the symptom first, give a root-cause hypothesis and the verification method) / refactor (commit to unchanged behaviour, list the equivalence verification) / transfer-related (additionally check the boundaries on both the source-read and target-write sides).
2. Locate: if the repository root has `.codegraph/`, use `codegraph explore "<symbol or problem>"` plus `node`/`callers`/`callees`/`impact`, and do not grep the whole tree; otherwise locate by module path, and after finding the symbol enumerate **every caller**.
3. Output: root cause or change point → impact surface list (concrete files, which behaviours change / which commitments stay unchanged) → test strategy (write the failing reproduction case first, covering happy path + boundary/null/exception, and name the vitest file to run) → risks and the minimal rollback method.
4. Change code only after the plan is confirmed by the user.

## Build and Release

### Build: skip this step and the tests turn red as "environment problems"

```bash
npm ci
npm run build      # vendor/*.cjs must be generated first
npm run typecheck
npm test
```

`npm run build` = `tsc -p tsconfig.build.json` (emitting `dist/`) → copy `lib/script/worker.cjs` to `dist/script/` → `build-mongodb.mjs` → `build-sqlserver.mjs` → `build-codemirror.mjs` (esbuild, seconds, a full rebuild every time, no idempotent skipping, to avoid "source upgraded, artifact stale").

`vendor/` is ignored by `.gitignore`, but several test groups depend directly on the artifacts; when they are missing the tests fail as "wrong format / missing module", **masking real regressions**:

| Artifact | Who depends on it | Behaviour when missing |
| --- | --- | --- |
| `vendor/mongodb-driver.cjs` | The mongodb adapter's `vendorOrNull()` loads it fault-tolerantly (degrades when missing, no throw), but the `bson` inside the bundle is the source of `instanceof` checks | `ObjectId`/`Decimal128`/`Binary`/`Long`/`Timestamp` fall into the plain-object branch and get JSON-serialized, and `normalizeMongoCell` plus Extended JSON revival fail a total of 5 assertions with "wrong format" |
| `vendor/sqlserver-driver.cjs` | Both the adapter and `tests/adapters-sql/sqlserver*.test.ts` go through `require('../../vendor/sqlserver-driver.cjs')` | The entire `sqlserver-driver-real.test.ts` file fails to load; `multi-instance-contract` 3 cases + `sqlserver-offline` 1 case fail |
| `vendor/codemirror-sql.cjs` | The client requires `../vendor/codemirror-sql.cjs` at runtime; `tests/client/console-tools.spec.ts` verifies the artifact contains the sqlserver wiring | Frontend dialect wiring assertions fail (the client side itself degrades to a textarea, but the test assertion is red) |

Measured comparison (same machine, same commit):

| State | Result |
| --- | --- |
| Without building vendor | 6 files fail, **13 failed** / 1029 passed |
| After `npm run build` | 2 files fail, **4 failed** / 1061 passed |
| After build + `core.autocrlf=false` | 1 file fails, **1 failed** / 1064 passed (only the DNS hijack one left) |

The missing 10 are all false failures caused by missing artifacts. Note that without the build the 1 DNS case actually "disappears" — the file it lives in fails to load entirely and never runs; so "fewer failures" can be a worse signal.

Why the two bundles exist (must read before changing build scripts): when the DSH host `@deepseek-ai/dsh-app-boot` (≤ 0.1.7-rc.2) loads a plugin, it calls `require.resolve.paths(name)` on every package in the dependency tree without guarding the `null` return, so core modules with same-named packages (`punycode`/`buffer`/`events`/`process`/`string_decoder`) make the whole plugin fail to load. After bundling, these packages are all inlined and no longer appear in the production dependency tree. Therefore **`mssql` can only be a devDependency**, and likewise `mongodb`. In `build-mongodb.mjs`, `bson` is deliberately external: to keep the same module instance as the runtime `require('bson')` (`instanceof` compatibility); in `build-sqlserver.mjs`, `@azure/*` **must not** be external (`tedious/lib/connection.js` has a static require at the top, and a missing module is a direct `MODULE_NOT_FOUND`).

### Release: three version numbers must match

```bash
# change version: synchronize three places
#   package.json                                   "version"
#   package-lock.json                              "version"
#   package-lock.json  packages[""].version
npm ci          # a mismatch fails directly with EUSAGE, and CI breaks at the first step
```

The `publish.yml` mechanism: push to `master` → compare the `package.json` version with `npm view dsh-db-tool version` → **if identical, skip entirely**, only if different does it run `npm install` → `npm run build` → `npm test` → `npm publish --provenance` → automatically tag `v<version>` (skips tagging if a tag with the same name already exists remotely). So "releasing" means changing the version number + merging into `master`, with no manual publish needed.

The published content is determined by the `files` allowlist in `package.json`: `dist`, `client`, `skills`, `patches`, `scripts`, **the three vendor artifacts listed one by one**, `cordis.patch.yml`, plus `LICENSE`/`README.md`/`README_EN.md`/`CHANGELOG.md`. `prepack` runs `npm run build` automatically; check the published content locally with:

```bash
npm pack --dry-run
```

### Node Version

`engines.node` is `>=22`, and the CI matrix is `[22, 24]`. **Node 20 cannot run it**: `tedious` 20.x and its `@azure/*` transitive dependencies require `>=22` in engines, and under Node 20 connecting reports `Promise.withResolvers is not a function` — moreover this TypeError **overwrites the real TLS/network error**, sending troubleshooting in a completely wrong direction. Do not attempt compatibility on 20.

### Host Hotfix Patches

`patches/` fixes the `resolve.paths` null-return defect of `dsh-app-boot`, in two same-shaped places: `routeScoped()` and `nativePackageDir()`. `scripts/hotfix-core.mjs` holds both the built-in replacement blocks and the patch-file selection table:

| Host version | Patch file |
| --- | --- |
| `0.1.7-rc.2` | `dsh-app-boot-route-scoped-hotfix.patch` |
| `0.2.0-rc.1` | `...-0.2.0-rc.1.patch` |
| `0.2.0-rc.2` | `...-0.2.0-rc.2.patch` |
| `0.2.1-rc.3` | `...-0.2.1-rc.3.patch` |

The anchor lines of the four versions are **byte-for-byte identical**, with only the overall line-number offsets differing (npd and routeScoped have different offsets), so the built-in replacement path is version-independent; only the `git apply` path needs a file chosen by version. When changing a patch, update three places in sync: the hunk header of the `.patch`, the `ORIGINAL_LINE`/`ORIGINAL_NPD_BLOCK`/`PATCH_BY_VERSION` of `hotfix-core.mjs`, and the corresponding contract block in `tests/scripts/hotfix.spec.ts`. Unlisted versions default to exit code 2, and `--force` forces it. Usage:

```bash
npm run patch:dsh          # Windows (PowerShell)
npm run patch:dsh:sh       # bash
node scripts/hotfix-core.mjs --dry-run   # only show what would change
```

## Development Traps

### Line endings must be LF (otherwise 3 contract cases are guaranteed red)

`.gitattributes` enforces `* text=auto eol=lf`. Reason: `tests/scripts/hotfix.spec.ts` compares the `+` lines of `patches/*.patch` with the built-in block of `scripts/hotfix-core.mjs` **byte for byte**, and requires the `git apply` result to be byte-for-byte identical to the built-in replacement result. With Windows' default `core.autocrlf=true`, `git apply` produces CRLF while the built-in block is LF → the three `patch applies cleanly to the pristine upstream ... via git apply` cases are guaranteed red (`gitApplyContract` in `hotfix.spec.ts`, around line 383). The patch files themselves must also be LF, otherwise applying them on Linux/CI brings CR into the target file.

Local verification and temporary workaround:

```bash
git config --get core.autocrlf                       # true means you are in the trap
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf \
  GIT_CONFIG_VALUE_0=false npx vitest run tests/scripts/hotfix.spec.ts
# measured: autocrlf=true → 3 red; the command above → 32 all pass
```

The proper fix is to re-checkout according to `.gitattributes`, not to bypass it with environment variables long-term.

### pnpm layout ≠ CI's flat npm layout

This repository uses npm (`package-lock.json`, `pnpm-lock.yaml` is gitignored). If the local `node_modules` was installed by pnpm, strict isolation makes transitive packages that **the tests `require` directly but that are not declared as direct dependencies** unresolvable at the top level. The three known offenders: `tedious`, `pg-connection-string`, `semver` (`semver` is already in devDependencies, but an old pnpm install may not have linked it yet).

```bash
node -e "for (const p of ['tedious','pg-connection-string','semver']) { try { require.resolve(p); console.log(p,'OK') } catch { console.log(p,'MISSING') } }"
```

If the probe reports `MISSING`, reinstall with the npm layout before judging; such failures do not reproduce in CI, **do not change code because of them**.

### Local DNS hijacking

The "host name resolution failure" case (around line 612) of `tests/adapters-sql/sqlserver-driver-real.test.ts` connects to `no-such-host.invalid` and expects `ENOTFOUND`. If the local machine hijacks `.invalid` to a real IP (measured: resolves to `198.18.0.x` and actually connects), that case is guaranteed red while CI is normal. How to determine:

```bash
node -e "require('node:dns').lookup('host.invalid',(e,a)=>console.log(e?e.code:a))"
# returns an IP = hijacked; returns ENOTFOUND = environment normal
```

## Verification Discipline

- For a bug fix, write a failing reproduction test first, then locate the root cause and fix it in one place inside the shared function; refactoring unrelated code opportunistically is forbidden.
- Run only the relevant tests: `npx vitest run tests/adapters-sql/<relevant>.test.ts`; for HTTP route changes pair with `tests/http/api.spec.ts`, for guard changes pair with `tests/guard/classify.spec.ts` + `challenge.spec.ts`, for store changes pair with `tests/store/<relevant>.spec.ts`, for frontend changes pair with `tests/client/<relevant>.spec.ts`.
- Full baseline (after `npm run build`, local pnpm + Windows): 67 test files, 1269 cases, **1200 passed / 0 failed / 69 skipped** (measured 2026-11-05, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false npx vitest run`). Historically 4 known failures have appeared = 3 line-ending ones (the `.gitattributes` not taking effect; adding `core.autocrlf=false` turns them all green) + 1 DNS hijack (`host.invalid` resolved to `198.18.0.x`); the latter may pass automatically as the local DNS state changes, **it is not a code fix and must not be claimed as the regression disappearing**; check with `node -e "require('node:dns').lookup('host.invalid',(e,a)=>console.log(e?e.code:a))"`, returning an IP means hijacked and returning `ENOTFOUND` means normal. Acceptance is by "failure-set comparison", not by absolute numbers.
- Mutation testing: `npx stryker run`, covering only `lib/index.ts` and `lib/http/index.ts`; surviving mutants need stronger cases. The added `GET/PUT /api/transfer-config` routes are inside `lib/http/index.ts`'s mutate range and need route-contract assertions; the new store/Redis read and write sides are outside stryker's mutate range and need manual equivalent mutations (such as deleting the save/restore fields, the cursor termination condition, TTL boundaries, the DUMP/RESTORE branch) to validate the effectiveness of the cases.
- Comments and commit messages use Simplified Chinese; the commit format is `type(scope): description`, with types: new/fix/docs/refactor/test/perf/misc.
- Windows environment: spawning npm without a shell requires `npm.cmd`.
