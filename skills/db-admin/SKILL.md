---
name: db-admin
description: "Operate 9 database kinds through the dsh-db-tool-ru plugin's DatabaseManager tool: connections, queries, DDL/DML with confirmation, schema browsing, previews, sandboxed scripts, and moving results/statements between the project folder and the database."
---

# db-admin: Database Management and Queries

> Languages: English (this file) · [Русский](SKILL.ru.md) · [简体中文](SKILL.zh.md)

This project has the dsh-db-tool-ru plugin installed, which lets the model operate databases in a controlled way through the **DatabaseManager** tool. Every operation is constrained by the "project path → connection → ro/rw" authorization model: connections not authorized for the current project are unavailable, and under a read-only grant any write operation is rejected.

## Tool call ground rules

- Every call must carry `action`; except for `list_connections`, every call must carry `conn_id` (call `list_connections` first to get the connection id).
- Parameter names are mostly snake_case, with camelCase accepted (`conn_id`/`connId` both work).
- The overall tool timeout is **90 seconds**; slow queries / large scripts that time out count as failures and must be split and retried.
- The tool returns `{text, isError}`: `text` is JSON text — on success a result object; on failure shaped like `{"ok":false,"error":"...","code":"..."}`. `isError=true` is only used for rejections/failures; `NEEDS_CONFIRMATION` is not a failure (`isError=false`), but `code` in `text` has that value, see the confirmation flow below.
- `query`/`execute`/`run_script`/`execute_file` all accept an optional `challenge_id`, used to retry after confirming a dangerous operation.
- The tool has only 8 actions. **Table name search, connection export/import, data transfer and transaction control have no corresponding action** — they are sidebar (HTTP API) capabilities, see "The five sidebar panels and auxiliary capabilities".
- Authorization has four levels: "project → connection → ro/rw → database list": a freshly granted connection has an empty database list, and the user must tick databases in the sidebar "Project authorization" panel (ticking saves immediately); until then no database is reachable.

### Error codes and handling (8 data-side + 10 file-side)

| code | Meaning | Correct handling |
|---|---|---|
| `UNAUTHORIZED_PROJECT` | The project path is empty, or the current project is not authorized for this connection | Guide the user to tick ro/rw for the current project in the sidebar "Project authorization" panel; do not retry the original call |
| `READ_ONLY` | A write operation was received under a ro grant (including `run_script`, `execute_file`, console transactions) | Tell the user the grant must be upgraded to rw; **do not retry repeatedly** |
| `DATABASE_NOT_GRANTED` | The target database is not in this connection's database-level allowlist; an empty list means "no database is allowed" | Ask the user to tick the needed databases in the sidebar "Project authorization" (changes are saved immediately); **do not probe other database names, and do not try to bypass** |
| `NEEDS_CONFIRMATION` | A dangerous operation is pending confirmation; the response contains `challengeId` | Explain to the user, then retry the same statement with the same `challenge_id` |
| `INVALID_CHALLENGE` | The challenge does not exist, was already used, has expired (5 minutes), or the statement changed | Re-issue the original call unchanged to get a new challenge, then repeat the full confirmation flow |
| `NOT_FOUND` | The connection does not exist, the transaction session has gone stale, or the transfer task does not exist | Call `list_connections` again / `begin` again / check the history |
| `INVALID_ARGUMENT` | A parameter is missing or invalid: over the limit, invalid `writeMode`, passphrase shorter than 8 characters, sqlite with transactions, a transaction with a database specified, etc. | Fix the parameters per the error message and retry; retrying unchanged is pointless |
| `DRIVER_ERROR` | A database/driver-side failure; also used when the ro-mode query gate rejects a statement (the message starts with `DRIVER_ERROR:`) | Fix the SQL, connection string or permissions per the message; **this is not an operation requiring confirmation** |
| `SCRIPT_TIMEOUT` | `run_script` timed out and was hard-killed (two layers: script 60s / tool 90s) | Reduce the script's work or split it into batches; retrying the same script will inevitably time out again |
| `INVALID_PATH` | The path is empty, points at the project directory itself, is not a regular file, or has a Windows device/ADS shape | Pass a relative file path inside the project instead |
| `PATH_OUTSIDE_PROJECT` | The path contains `..` or resolves outside the project directory | Only relative paths inside the project directory are allowed; do not try to bypass |
| `SYMLINK_DENIED` | The target is a symbolic link, or the parent directory resolves outside the project after realpath | Use a real file path, or have the user recreate it inside the project first |
| `PARENT_MISSING` | The parent directory does not exist and `create_dirs` was not passed | Add `create_dirs: true`, or use a subdirectory that already exists |
| `EXTENSION_DENIED` | The extension is not on the allowlist (`.sql/.txt/.json/.csv/.tsv/.md/.log`) | Use a compliant extension; the allowlist can be adjusted via the plugin setting `fileIo.extensions` |
| `FILE_EXISTS` | The target file already exists and `overwrite` was not passed | Pass `overwrite: true` if replacement is intended, otherwise use another file name |
| `FILE_TOO_LARGE` | Read above 8 MB or write above 64 MB | Export in batches, or have the user raise the limits in the plugin setting `fileIo` |
| `FILE_NOT_FOUND` | The target file for `execute_file`/`export_to_file` does not exist | Export it first / confirm the path; do not guess file names |
| `NOT_SCALAR` | Under `format=text` the result is not 1 row × 1 column | Use `json`/`csv`, or aggregate into a single value in the SQL |
| `EMPTY_RESULT` | 0 rows, or the value is `NULL` in text mode (`allow_empty` was not passed) | Check the query conditions; if an empty result is genuinely acceptable, pass `allow_empty: true` |

### Hard limits and quotas

| Item | Value | Notes |
|---|---|---|
| `preview` limit | 1..50, default 10 | Values beyond are clamped server-side |
| `preview` offset | ≥0, default 0 | Paging |
| Table name search limit (sidebar) | 1..200, default 100 | No such tool action |
| Audit limit | 1..500, default 50 | |
| Transfer history limit | 1..200, default 50 | |
| Transfer log limit | 1..2000, default 200 | |
| Redis keys per single `SCAN` | 200 | Returns `truncated` when the limit is hit |
| Redis collection reads (hgetall/lrange/smembers/zrange) | 500 rows | |
| Redis key list (table list) | 500 | |
| Redis `preview` | ≤50 | |
| MongoDB `find` | limit ≤50, default 20 | Clamped automatically when exceeded |
| MongoDB `aggregate` result read | 500 rows | |
| Oracle / DM result set | 500 rows | `truncated` when over the limit |
| Script execution | 60s | Same value at the worker and vm layers |
| Whole tool | 90s | |
| HTTP request body | 2MB | `INVALID_ARGUMENT` when over the limit |
| Export passphrase | ≥8 characters | Enforced server-side |
| Concurrent transaction sessions per connection | 4 | `INVALID_ARGUMENT` when over the limit |
| Global concurrent transfer tasks | 8 | |
| Tables per task | 1000 | and table names must be unique |
| Transfer `batchSize` | ≤5000, default 1000 | |
| Transfer `tableConcurrency` | ≤16, default 4 | |
| Transfer `shardConcurrency` | ≤32, default 4 | Shards per table ≤32 |
| Idle transaction reclamation | 5 minutes | Scan period 30s; reclamation rolls back and audits |
| File read | ≤8 MB | Configure `fileIo.maxReadBytes` |
| File write | ≤64 MB | Configure `fileIo.maxWriteBytes` |
| File extensions | `.sql .txt .json .csv .tsv .md .log` | Configure `fileIo.extensions` |
| SQL text in the audit | 200 characters | Truncated beyond that, ending with `…` |

## The eight actions

### 1. list_connections

Lists the connections **authorized for the current project** (including id, kind, name, safeUrl — secrets such as passwords are never returned).

```
DatabaseManager({ action: "list_connections" })
```

Call it before starting any task to determine the available connections; an empty return means the current project has no authorized connections, so guide the user to grant ro or rw for the project path in the sidebar "Project authorization" panel.

### 2. query — run a query (read-only intent)

```
DatabaseManager({ action: "query", conn_id: "c1", sql: "SELECT id, name FROM users WHERE age > ?", params: [18] })
```

- `sql` is required; `params` is an array of parameters (placeholders in the dialect cheat sheet); an optional `challenge_id` (for retrying after a dangerous read such as Redis `KEYS *` triggers confirmation).
- Optional `database`: cross-database execution target (Navicat-style). For pg/gaussdb, passing a database name (e.g. `gycwd`) executes on that database (a separate connection with the same credentials; read-only is still enforced under a ro grant); for the other database kinds prefer fully qualified names inside the statement (MySQL `db.table`, SQL Server `db.schema.table`).
- Returns `{columns, rows, rowCount, truncated?}`; every cell is normalized to string/number/null.
- Available under both ro and rw grants, but a non-query statement received by the read-only interface is rejected.

### 3. execute — execute a single write statement (requires rw)

```
DatabaseManager({ action: "execute", conn_id: "c1", statement: "UPDATE users SET age = ? WHERE id = ?", params: [20, 42] })
```

- `statement` (or `sql`) is required, a single statement; DDL/DML/maintenance commands all trigger danger confirmation.
- Optional `database`: cross-database execution target, same semantics as query (pg/gaussdb route per database; the target database's privileges are controlled by the database-side user permissions).
- Returns `{affectedRows?, message}`; `message` is a Chinese result description.
- Under a ro grant it returns the `READ_ONLY` error directly.

### 4. schema — browse databases/tables/structure (three levels)

One action with three uses, degrading automatically by parameter:

```
DatabaseManager({ action: "schema", conn_id: "c1" })                                            // → database list
DatabaseManager({ action: "schema", conn_id: "c1", database: "shop" })                          // → table list
DatabaseManager({ action: "schema", conn_id: "c1", database: "shop", table: "users" })          // → column structure
```

- The table list returns `TableInfo[]`: `{name, type?, comment?, database?}` (Redis `type` is hash|list|set|zset|string|stream).
- PostgreSQL/GaussDB have three-level semantics "database → schema → table" and support cross-database browsing (Navicat behavior): pass `database` as `"dbname.schema"` to browse a database other than the connected one (e.g. `gycwd.public`; the server automatically opens a connection pointing at that database with the same credentials); passing only a schema name (e.g. `public`) queries the connection's own database. The parameter of `listSchemas(database)` is a **bare database name**. When unsure about the schema, first run `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'`.
- The column structure returns `ColumnInfo[]`: `{name, dataType, nullable, key?, default?, comment?}`.
- When a table name cannot be found, do not blindly walk every database: when the table name is known and the question is "which table is it in", try `database` one at a time, or guide the user to the sidebar cross-database table name search (see below); there is no equivalent action on the model side.

### 5. preview — preview table data

```
DatabaseManager({ action: "preview", conn_id: "c1", table: "users", limit: 20, offset: 0, database: "shop" })
```

- `table` is required; `limit` is 1..50 (default 10, truncated server-side); `offset` is ≥0 (paging); `database` is optional.
- Returns `{columns, rows, rowCount, truncated?}`; `truncated: true` means there are more rows, increment `offset` for the next page.

### 6. run_script — sandbox scripts / Redis commands / Mongo documents (requires rw, dangerous handles trigger confirmation)

`code` is a JS script executed in a **subprocess-isolated sandbox** (no require/process/fs/network, 60-second timeout). The sandbox injects two handles, both going through the full guard/challenge/audit chain:

- `db.query(sql, params)` — read-only query, returns the result object;
- `db.execute(statement, params)` — write execution; a dangerous statement throws inside the sandbox as a `NEEDS_CONFIRMATION` JSON exception, and must be retried per the confirmation flow with `challenge_id`.

The script's return value is the tool's return value (must be JSON-serializable). Example:

```
DatabaseManager({ action: "run_script", conn_id: "c1", code: "return (await db.query('SELECT count(*) AS n FROM users', [])).rows" })
```

Two hard constraints:

- **Always requires rw**: `run_script` requires rw at the authorization check, even for purely read-only Redis/Mongo scripts — there is no "read-only script channel". ro connections can only use `query` (Redis/Mongo `query` can pass a command JSON directly).
- **At most the first dangerous statement in a script can be confirmed and executed**: all `db.query`/`db.execute` calls inside a script share the same `challenge_id` input, and a challenge is single-use — the first dangerous statement consumes it, so subsequent dangerous statements will inevitably get `INVALID_CHALLENGE`. Do not put several write statements that need confirmation into one script; for multi-step confirmation use `execute` one at a time (each confirmed separately), or use the sidebar console transaction.

Redis and MongoDB have no SQL; pass the JSON text of a **command array / BSON command document** as `code` (in that case the script body is that JSON):

```
DatabaseManager({ action: "run_script", conn_id: "redis1", code: '["GET","user:1"]' })
DatabaseManager({ action: "run_script", conn_id: "mongo1", code: '{"find":"users","filter":{"age":{"$gt":18}}}' })
```

These two database kinds' `query` and `execute` also accept command JSON directly (read commands go through `query`, write commands through `execute`), as two language-specific channels; `run_script` is the only entry point that can do "multi-step composition".

### 7. export_to_file — write query results to disk (recommended for long text)

```
DatabaseManager({ action: "export_to_file", conn_id: "c1",
                  sql: "SELECT pg_get_functiondef(27896227) AS d",
                  path: "fn/pdt_income_storageobject_t.sql", create_dirs: true })
```

- `sql` and `path` are required; `path` must be a **relative path inside the project directory** (the project directory is the authorization key); absolute paths, `..`, drive letters, `CON` and the like are all rejected.
- `format`: `text` (default, requires 1 row × 1 column, the value is written verbatim, newlines are not normalized and no `\n` is appended), `json` (`JSON.stringify(rows, null, 2)` + trailing newline), `csv` (column-name header + RFC 4180, `\r\n`). Encoding is UTF-8 without BOM.
- `overwrite` (default false, `FILE_EXISTS` if it already exists), `create_dirs` (default false, `PARENT_MISSING` if the parent directory is missing), `allow_empty` (default false, `EMPTY_RESULT` on 0 rows or `NULL`).
- Returns `{path, bytes, md5, rows, format}` — `md5` is computed from the written bytes and can be checked against the database side's `md5(convert_to(..., 'UTF8'))`.
- **Long text (function bodies, view definitions, large JSON) must go through this channel**, do not fetch it with `query` and then transcribe it: the model introduces roughly one deviation per 8 KB of text, and losing a single character in base64 also misaligns every fragment after it.

### 8. execute_file — execute statements from a file (requires rw)

```
DatabaseManager({ action: "execute_file", conn_id: "dev1", path: "fn/pdt_income_storageobject_t.sql" })
```

- `path` is required, relative to the project directory; the file is submitted **verbatim**, with trailing spaces and newlines not trimmed — that is precisely why a file output by `export_to_file` can be executed directly.
- It goes through exactly the same chain as `execute`: guard classification, dangerous statements `NEEDS_CONFIRMATION` + single-use `challenge_id`, ro grant `READ_ONLY`, audit (records direction, path, byte count, `md5` and the first 200 characters of the text).
- Returns `{path, bytes, md5, commandtag?}`; on PostgreSQL `commandtag` is e.g. `CREATE FUNCTION`.
- An empty file or one containing only whitespace reports `INVALID_ARGUMENT`; do not use it to run multi-statement scripts — for multiple steps use `run_script` or the sidebar console transaction.
- `search_path` (optional, PostgreSQL): function bodies often contain types and routines without a schema (`citext`, `varlist`), and `pg_get_functiondef` returns the text as-is, so on a "clean" session you get "type ... does not exist". In that case pass `search_path: "sys, dbo, public"` — the plugin executes the file and `set_config('search_path', …, true)` in the same batch, so the path applies only to this run and does not linger on the connection pool session. Only plain identifiers are accepted (comma-separated, at most 16), and it cannot be used together with `params`.

**Typical scenario: moving a function body from one database to another**

1. `export_to_file` (source connection): `sql: "SELECT pg_get_functiondef(<oid>) AS d"`, `path: "fn/<function name>.sql"`;
2. Edit the file in an editor (rename, change owner, adjust comments);
3. `execute_file` (target connection, rw): the same `path`, returns `commandtag = CREATE FUNCTION`;
4. Final check: on the target `SELECT md5(prosrc) FROM pg_proc WHERE oid = '<oid>'::regproc` matches the expected value before wrapping up.

## Nine-database dialect cheat sheet

| DB | Placeholders | Metadata entry point | Paging | Notes |
|---|---|---|---|---|
| MySQL | `?` | `information_schema` | `LIMIT n OFFSET m` | |
| PostgreSQL | `$1, $2…` | `information_schema` / `pg_catalog` | `LIMIT n OFFSET m` | |
| GaussDB | `$1, $2…` | `information_schema` / `pg_catalog` | `LIMIT n OFFSET m` | PG family (default port 8000, see the note below) |
| SQLite | `?` | `sqlite_master` / `PRAGMA` | `LIMIT n OFFSET m` | database list is fixed to `['main']` |
| Redis | None (command array) | `SCAN` (`KEYS` traversal disabled) | `SCAN cursor` | `run_script` passes `["SCAN","0","MATCH","user:*","COUNT","100"]`; transfer degrades via the `__redis_keys` envelope |
| MongoDB | None (BSON document) | `listCollections` | `find().skip().limit()` | `run_script` passes `{"find":"users","filter":{},"limit":20,"skip":40}` |
| Oracle | `:name` | `ALL_TABLES` / `USER_TABLES` | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` | |
| DM | `:name` | system views, Oracle style | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` (`LIMIT` supported in 8a) | |
| SQL Server | `?` (rewritten internally by the adapter to `@p1`) | `sys.*` catalog views | 2012+ `OFFSET m ROWS FETCH NEXT n ROWS ONLY`; 2008/2008R2 degrades to `ROW_NUMBER` | identifiers `[x]`, a `]` inside a name is doubled to `]]`; **SQL authentication only** (Windows integrated authentication / Azure AD are not supported); for other boundaries see "SQL Server coverage and boundaries" below |

**Redis transfer semantics (degraded, not lossless table-to-table)**: the Redis row above is the command and browsing semantics; in data transfer Redis participates in degraded form through the fixed envelope table `__redis_keys`, with six columns: `key`/`type`/`ttl_ms`/`encoding`/`payload`/`dump`. Here `ttl_ms` is 0 when there is no expiry (PTTL `-1` becomes `0n`; if PTTL returns `-2` the key had already disappeared at read time and the key is skipped; positive values are milliseconds as-is), `encoding` is the `OBJECT ENCODING` in-memory encoding diagnostic value (e.g. raw/hashtable/listpack/quicklist, unrelated to the serialization of the `payload` column), and `payload` is always a UTF-8 JSON string. `ttl_ms` comes from [TTL](https://redis.io/docs/latest/commands/ttl/) (and PTTL), `dump` comes from [DUMP](https://redis.io/docs/latest/commands/dump/), and is restored via [RESTORE](https://redis.io/docs/latest/commands/restore/) only between homogeneous Redis→Redis; the cursor semantics of [SCAN](https://redis.io/docs/latest/commands/scan/) mean keyspace enumeration is not a single snapshot. [Official docs confirmed] [Redis data types](https://redis.io/docs/latest/develop/data-types/) defines Redis as a data structure server; [project inference] therefore native keyspace semantics such as stream consumer groups, cross-version `DUMP` and logical databases `dbN` are explicitly excluded, and "cannot be lossless table-to-table" is a project judgement based on the official command semantics, not a literal statement in the official docs. The basis for using an intermediate type model for heterogeneous migration is [official docs confirmed] [AWS DMS built-in data types](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Reference.DataTypes.html) and [Airbyte supported data types](https://docs.airbyte.com/platform/understanding-airbyte/supported-data-types); the product basis for task configuration persistence is [DBeaver Task management](https://dbeaver.com/docs/dbeaver/Task-Management) and [Navicat Save Profiles](https://www.navicat.com/manual/pdf_manual/en/navicat_16/win_manual/navicat_en.pdf) (the latter being a PDF summary [confirmed via official page dynamic shell/search snippet], not parsed page by page).

**Type normalization** (already handled by the tool's return values; keep it in mind when citing results): `DECIMAL/NUMERIC` → string (to avoid precision loss); `Date/TIMESTAMP` → ISO 8601 string; `LOB/CLOB/BLOB` → string; MongoDB `ObjectId` → string. When generating write statements, pass DECIMAL values as strings directly and dates as ISO strings.

**SQL Server type exceptions (per-side semantics)**:
- **decimal/numeric**: the browsing side (`query` / `preview` / the data browsing grid) **does not guarantee digit-for-digit fidelity** — the driver has already converted it to a JS number during parsing (>15 significant digits lose precision); converting it to a string only prevents later numeric conversion, and values >1e21 are displayed in scientific notation; when digit-for-digit fidelity is needed, explicitly `CONVERT(nvarchar(...), col)` in the SQL. Data transfer's read side has `CONVERT(nvarchar(64), col)` built in, and the write side binds as a string, so precision does not pass through JS floats.
- **Spatial/hierarchical UDTs**: `hierarchyid` / `geometry` / `geography` are moved as binary (bytes) during transfer, and the target creates `VARBINARY(MAX)` — values are faithful but **UDT type semantics are not preserved** (the target has no `ST_*` / `hierarchyid` methods); when spatial semantics are needed the target must alter the column type itself.
- **sql_variant**: the transfer read side converts to text with `CONVERT(nvarchar(max), col)`, **losing the original type information** (the driver returns a scalar according to the value's actual type, so it cannot be moved uniformly).
- **Character columns keep capacity**: a source `varchar` / `char` length of 4001–8000 maps to an `NVARCHAR(MAX)`-like target type, with no implicit narrowing.
- **Date/time fidelity**: `datetime2` uses `CONVERT(nvarchar(33), col, 126)` on the read side, `time` uses `CONVERT(nvarchar(16), col, 126)`.

## GaussDB official alignment notes (HCS 26.861.0, centralized/distributed)

Based on the Huawei Cloud GaussDB official documentation (doc.hcs.huawei.com/db/zh-cn, 26.861.0 for both forms) and aligned with the openGauss official documentation source repository; where real-hardware verification is missing, the annotations in the code are authoritative.

- **Authentication**: the driver implements the openGauss SHA256 / MD5-SHA256 / SM3 handshake, matching the server default `password_encryption_type = 2` (sha256). When a connection reports `Invalid username/password, login denied`, check in this order: ① the authentication configuration (gs_hba.conf) must contain `host all all 0.0.0.0/0 sha256`; ② after the server's password encryption method changes, the password must be reset or a new user created (old passwords keep the old encryption); ③ for a locked account use `ALTER USER ... ACCOUNT UNLOCK`.
- **Default port 8000** (centralized DN / distributed CN, the official gsql example uses `-p 8000`); SSL is not enforced by default (the server can enforce it with require_ssl). This tool's SSL is on/off only and **does not support** the sslmode (require/verify-ca/verify-full) certificate verification distinctions.
- **ro read-only session**: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` is official syntax (supported in both centralized and distributed, rf-dist/gaussdb-08-0400, rf-cent/gaussdb-38-0416); it is executed once when the connection is established and applies to all subsequent transactions on that connection.
- **Isolation level differences**: READ UNCOMMITTED is equivalent to READ COMMITTED; **SERIALIZABLE is not supported and is equivalent to REPEATABLE READ** — different from PG's true SSI behavior; scripts relying on PG serialization semantics should take note.
- **Metadata**: `pg_database` / `pg_catalog.pg_namespace` are official system tables; `information_schema.tables/columns` has official view documentation for centralized deployments, while the distributed reference has no native views (only in M-Compatibility mode), so browsing on distributed instances follows real-hardware behavior.
- **Compatibility modes**: openGauss has sql_compatibility modes (A/B/C/PG), and some syntax semantics change with the mode (e.g. in B mode SET SESSION TRANSACTION only takes effect when `b_format_behavior_compat_options` includes set_session_transaction); this tool uses PG semantics.
- For in-code evidence of driver/default-value differences and evidence URLs see the header comment of `lib/adapters/gaussdb/index.ts` and `lib/adapters/sql-shared/pg-like.ts`.

## SQL Server coverage and boundaries

- Covers SQL Server 2005 (9.0) → 2025 (17.0) and Azure SQL Database; SQL Server 2000 and earlier are not supported. Dialect and metadata use only 2005+ common constructs (metadata goes through `sys.*` catalog views).
- **TDS version is negotiated automatically; the user does not choose**: the client always declares `7_4`, and the server downgrades per its own capability (2005→`7_2`, 2008→`7_3_A`, 2008 R2→`7_3_B`, 2012+→`7_4`). This is a MUST-level rule of [MS-TDS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/773a62b6-ee89-4c02-9e5e-344882630aac) (when the client declares higher than the server, the server **must** use its own highest version). `tdsVersion` is only a troubleshooting override; **do not** lower it just because of an "old version" — that turns "cannot connect" into "connects but behaves oddly".
- **Authentication**: SQL authentication only (user/password); **Windows integrated authentication is not supported, nor is Azure AD authentication** — when either is required this tool is unusable. Note: this tool does **not implement** `IsIntegratedSecurityOnly` probing, so an instance that "only allows Windows authentication" merely shows up as a login failure; do not claim it can automatically detect that state.
- **Connection form**: `sqlserver://user:password@host:port/db`, with the query parameters `encrypt` / `trustServerCertificate` / `tdsVersion` / `tlsMinVersion` / `serverName` / `caCert` / `instanceName` / `useUTC` (parameter names are case-insensitive); `instanceName` and port are mutually exclusive (named instances are resolved by SQL Server Browser instead). **ADO.NET key-value connection strings are not accepted** (`Server=...;Database=...`). **A regular connection only needs host/port/account/password**; apart from `useUTC` / `instanceName`, the encryption and certificate parameters above sit in the collapsed "Advanced options" area of the UI (collapsed by default), are for troubleshooting, and should not be required from the user by default.
- **Defaults and overrides**: `encrypt=auto` (default for new connections) + `trustServerCertificate=false` + `tdsVersion=7_4` + `useUTC=true`. URL query and the per-field form have the **same semantics**, and both can override all of the above; an invalid value errors out directly with no silent fallback.
- **Semantics of `encrypt=auto` (the default policy; do not describe it as "encryption must be enabled manually")**: connect first without encryption; if the server **enforces encryption** (`EENCRYPT` / "the server requires an encrypted connection", e.g. `Force Encryption=Yes` or Azure SQL), automatically **retry once** with `encrypt=true` + `trustServerCertificate=true`. The boundaries are strict: **retries only once**; **only for the "server enforces encryption" cause** (certificate issues, protocol version issues, login failures etc. are never retried); **when `encrypt` is specified explicitly (`true`/`false`/`strict`) there is no retry at all**. **`auto` does not mean "encrypt automatically"**: on a server that does not enforce encryption it is equivalent to `encrypt=false`, i.e. plaintext transport — see the risk note below.

### TLS handshake failures: two root causes, non-interchangeable fixes

| Error signature | Root cause | Handling (in priority order) |
|---|---|---|
| `self signed certificate` / `unable to verify` / the `CERT_` family | Failure at the certificate verification stage (self-signed, broken chain, hostname mismatch, expired) | ① Install a trusted CA with `?caCert=` (a PEM path or text; verification still applies, **officially recommended**); when the certificate is issued for a domain name but the connection uses an IP, also add `?serverName=domain`; ② only as a last resort `?trustServerCertificate=true` or `?encrypt=false` (the latter requires the server not to enforce encryption) |
| `UNSUPPORTED_PROTOCOL` / `no protocols available` / `alert protocol version` (including `SSL routines ... UNSUPPORTED`) | Failure at the protocol version negotiation stage: client and server share no TLS version, **certificate verification never even ran** | ① Enable TLS 1.2 on the server (KB4057113 for 2008 R2 SP3, KB4057114 for 2008 SP4, the corresponding CU/GDR plus KB3052404 for 2012/2014; restart the instance); ② when the server cannot be touched for now, lower the client with `?tlsMinVersion=TLSv1` |

**Do not treat protocol-version problems with certificate parameters**: `trustServerCertificate=true` / `encrypt=false` only affect certificate verification and have no effect on `UNSUPPORTED_PROTOCOL`; trial and error only wastes a round. The two diagnostic families are mutually exclusive, and the error messages already give the Chinese root cause per family; seeing `TCP connected but TLS ...` means network and port are fine, so stop checking host/firewall.

**The default `auto` will not save you from certificate errors**: `auto`'s automatic retry only recognizes the "server enforces encryption" cause, and certificate verification failures are still reported as-is. That is, a self-signed-certificate instance may still fail to connect under the default values (depending on whether the server enforces encryption); in that case follow the certificate-family path in the table above — importing the CA into the system trusted roots usually makes it connect (the plugin already includes the system trust store, so `caCert` is not needed).

**Key fact: the real behavior of `encrypt=false` and the default `encrypt=auto` (verified by packet capture)**. When the server does **not** enforce encryption, `encrypt=false` **completely skips the TLS handshake and sends LOGIN7 (including account and password) in plaintext** — in the measured capture the client's next packet is TDS `0x10`, with no TLS handshake. This is a plaintext transport risk, not merely "the data packets are not encrypted". **The first step of the default `auto` is exactly this path, so on a server that does not enforce encryption `auto` and `encrypt=false` behave identically** — `auto` upgrades to TLS only when the server refuses plaintext; it is not "encrypting for you automatically". When the server **enforces** encryption (`Force Encryption=Yes` / Azure SQL), `encrypt=false` is rejected (with a message that the server requires encryption). The official statement that "the login packet is always encrypted" applies only to the scenario "the server enforces encryption or the client uses `encrypt=true`", and **must not be generalized into "`encrypt=false` always has a TLS handshake too"**. Therefore: on a trusted intranet the defaults are fine; when connecting across the public internet or an untrusted network segment, **explicitly set `encrypt=true`** (an explicit value triggers no automatic retry, so behavior is predictable), and solve certificate issues with `caCert` / `serverName`. Another note: when connecting to 2005 or an unpatched 2008, the server may only have TLS 1.0, requiring `?tlsMinVersion=TLSv1`.

### Versions and TLS 1.2 support

| Version | TLS 1.2 | Required patches |
|---|---|---|
| 2005 (9.0) | **Not supported** (no patch at all) | No solution; only lower the client TLS minimum + trust the certificate |
| 2008 SP4 / 2008 R2 SP3 | Patch required | KB4057114 / KB4057113 |
| 2012 SP4- / 2014 SP3- | Patch required | Corresponding CU/GDR + KB3052404 |
| 2012 SP4 / 2014 SP2 / 2016+ | Native support | — |
| 2022 / 2025 | Native; TLS 1.3 possible under TDS 8.0 | — |

For 2016+ the TLS version actually used is decided by the **operating system's Schannel**, not by SQL Server — the same version instance may behave differently on different machines.

### The `tlsMinVersion` parameter

| Value | Meaning |
|---|---|
| `TLSv1` | Minimum TLS 1.0 (use when 2008/2008R2 only supports 1.0) |
| `TLSv1.1` | Minimum TLS 1.1 |
| `TLSv1.2` | Minimum TLS 1.2 (equal to Node's default lower bound when unset) |

- When unset, Node's default lower bound TLSv1.2 applies; values are **case-sensitive and not normalized**, and an invalid value reports a Chinese error directly (no silent fallback, so the user is not misled into thinking it was lowered).
- **`TLSv1.3` is not supported**: without an explicit upper bound, the underlying tedious caps `maxVersion` at TLSv1.2, so setting 1.3 makes min > max and the handshake always fails (`ERR_SSL_NO_PROTOCOLS_AVAILABLE`).
- Only the lower bound can be set; there are no ciphers / maxVersion switches; do not pass OpenSSL-proprietary cipher strings (they throw `INVALID_COMMAND` under BoringSSL).
- Example: `sqlserver://sa:pwd@10.0.0.5:1433/shop?tlsMinVersion=TLSv1`
- **Paging is dispatched automatically**: the adapter probes `SERVERPROPERTY('ProductMajorVersion')` and uses `OFFSET/FETCH` for 2012+, degrading to a `ROW_NUMBER() OVER (ORDER BY (SELECT NULL))` subquery for 2008/2008R2 — you do not need to add `TOP`/`ROW_NUMBER` yourself when generating SQL.
- **Transfer boundaries**: writes are parameterized multi-row `VALUES` INSERTs (TDS's 2100-parameter cap per statement and `VALUES`' 1000-row cap per statement; the row count per statement is the smaller of the two). Transfer paging is dispatched by target database version: 2012+ uses `OFFSET/FETCH`, and **the 2008/2008R2 degradation is available** — for ordered cursors (keyset/range) it uses `SELECT TOP (n) ... ORDER BY key`, and for offset total ordering without a shard key and for `keyAt` chunking it uses a `ROW_NUMBER() OVER (...)` subquery; when version probing fails it falls back conservatively to 0. Known limitations: when the target table already exists and the column is IDENTITY, writing an explicit value errors with 544 (currently `SET IDENTITY_INSERT ON` is not done automatically); transfer's automatic table creation does not generate IDENTITY columns.
- **Real-hardware verification**: the real-hardware test group is gated by the environment variable `DBT_TEST_SQLSERVER_URL` (`tests/adapters-sql/sqlserver.test.ts`, skipped entirely when unset); the Chinese error mapping, parameter defaults and TLS per-family diagnostics are covered by Fake-driver offline tests.
- Read-only (ro) strength is weaker than MySQL/PG; see "Correct posture under read-only (ro) mode" below.

## Dangerous operation confirmation flow (NEEDS_CONFIRMATION)

When a response like the following is received:

```json
{"ok":false,"code":"NEEDS_CONFIRMATION","challengeId":"c_9f8e7d6c5b4a3210fedcba98","statement":"DROP TABLE users","danger":"danger","reason":"DDL cannot be rolled back (implicit commit)","hint":"..."}
```

Execute in order:

1. **Stop**, and state to the user verbatim: the statement content and the danger reason (`reason`).
2. After the user **explicitly agrees**, retry the same statement with **the same `challenge_id`**:
   `DatabaseManager({ action: "execute", conn_id: "c1", statement: "DROP TABLE users", challenge_id: "c_9f8e7d6c5b4a3210fedcba98" })`
3. If the user refuses, abandon it and do not retry.

Challenge properties: **single-use** (invalid once used), bound to the statement hash (invalid after the statement changes), expires in 5 minutes. If it expired or is invalid you get `INVALID_CHALLENGE`; in that case re-issue the call and go through the full confirmation flow. **Never** retry without the user's confirmation; and **do not** rewrite the statement to bypass confirmation.

One challenge covers only one statement — multiple dangerous statements in `run_script` will inevitably report `INVALID_CHALLENGE` from the second one on; for multi-step writes use `execute` one statement at a time.

Typical operations that trigger confirmation: DDL (CREATE/ALTER/DROP/TRUNCATE), all DML writes (INSERT/UPDATE/DELETE), maintenance commands, dangerous Redis commands (FLUSHALL, CONFIG etc.) and write commands, Mongo write ops (drop, deleteMany, updateMany etc.), and some dangerous reads (e.g. Redis `KEYS *`). SQL Server additionally has: its exclusive dangerous leading words `BACKUP` (DATABASE/LOG), `RESTORE`, `DBCC`, `RECONFIGURE`, `BULK INSERT`, `SHUTDOWN`, `xp_cmdshell` and other `xp_*`, `sp_configure`; `SELECT ... INTO <table|#temp table>` (T-SQL table-creation side effect) and `WITH ... (DELETE|UPDATE|INSERT)` are also judged dangerous and require confirmation; among them `SELECT 1 INTO @t` (table variable/variable assignment) is allowed, and `INSERT INTO ...` still follows the DML rule. Note that general `EXEC sp_*` (other than `sp_configure`/`xp_*`) is **not** listed as dangerous separately and does not trigger confirmation for that reason. Also, this layer is "confirmation" semantics; **under a ro grant** `SELECT ... INTO`, `WITH` write bodies and `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE` are **rejected outright** by the adapter gate (an error is returned and there is no confirmation path).

## The five sidebar panels and auxiliary capabilities

The sidebar has **5 panels** in total (bilingual Chinese/English); when the user asks "where do I do this", point the way with the table below; most of these capabilities have no corresponding tool action.

| Panel | Capability | Underlying HTTP API (not directly callable by the model) |
|---|---|---|
| Connection management | Add/edit/delete connections, test drafts before saving, connectivity test, export/import | `/api/connections*`, `/api/test-draft` |
| Project authorization | Tick ro/rw per connection for the current project path, revoke | `/api/grants` |
| Data browsing | Three-level database/schema/table tree, cross-database table name search, data preview grid | `/api/databases`, `/api/schemas`, `/api/schema`, `/api/tables`, `/api/search-tables`, `/api/preview` |
| SQL console | Multi-tab editor, statement-by-statement execution, `GO`/`GO n` batch separators, transactions, result grid (50 rows/page, CSV/JSON export) | `/api/query`, `/api/execute`, `/api/console/*`, `/api/audit` |
| Data transfer | Table data movement, live progress; includes the "Transfer history" and "Transfer log" sub-tabs | `/api/transfer/start`, `/api/transfer/{id}`, `/api/transfer/live`, `/api/transfer-history`, `/api/transfer-log` |

### Cross-database table name search (data browsing panel only)

Fuzzy-searches table names by keyword; ro is enough; hits carry `database` to make locating and jumping easy. It **is not a tool action**, there is no equivalent entry point on the model side — either guide the user to search in the panel, or call `schema` database by database yourself.

Actual dispatch (a missing implementation does not "try its best", it returns empty directly):

| DB | Implementation |
|---|---|
| MySQL / PostgreSQL / GaussDB | Native adapter implementation (a single `information_schema` fuzzy query; the pg family can cross databases) |
| SQLite / MongoDB | Falls back to "`listTables` per database + in-memory filtering" (concurrency 8; a database without permission does not affect the whole) |
| **Redis / Oracle / DM / SQL Server** | **Always returns empty** (no implementation and incompatible semantics: Redis ignores the database name and would return the same batch of keys repeatedly; Oracle/DM's database-level semantics is the owner) |

limit 1..200 (default 100). When nothing is found, do not assert "the table does not exist"; confirm with `schema` database by database.

### Connection export / import

| Operation | Request body | Response |
|---|---|---|
| Export | `{passphrase}` | `{json, count}` |
| Import | `{json, passphrase}` | `{imported, skipped, errors}` |

- Whole-package encryption: a scrypt-derived key (N=16384, r=8, p=1) + AES-256-GCM; the file has no plaintext when opened; the passphrase is **enforced server-side to be ≥8 characters**.
- On import **id conflicts always go to `skipped`, existing connections are not overwritten**, and imports can be repeated (idempotent).
- A wrong passphrase and corrupted ciphertext both report `INVALID_ARGUMENT` (no reason distinction, to prevent passphrase probing).
- Export/import **does not require project authorization** (it belongs to connection management); the audit records only the count, never the passphrase or the ciphertext content.

### Data transfer (the sidebar "Data transfer" panel)

| Write mode | Semantics |
|---|---|
| `insert` (default) | Append; if the target table already exists the whole table fails (existing data is not overwritten) |
| `ignore` | Conflicting rows are skipped |
| `replace` | Conflicting rows are overwritten (relies on the primary key) |
| `truncate` | Truncate the target table first, then write everything, **the truncation is unrecoverable** |

- Authorization requirements: the source needs only ro, the target needs rw.
- When the target table does not exist it is created automatically from the source table structure; `overwriteStructure` can overwrite the structure.
- **Redis does not support transfer**: both the read side and the write side return "data transfer is not supported yet"; if either the source or the target is Redis, nothing can be moved.
- Parallelism degradation: a target SQLite is a single writer → table-level concurrency is clamped to 1 and shards share the same writer (writes are inherently serial); a source Oracle/DM uses a dedicated single-connection read → no sharding within a table (table-level parallelism still applies).
- Concurrency and batching: `tableConcurrency` ≤16 default 4, `shardConcurrency` ≤32 default 4, `batchSize` ≤5000 default 1000, shards per table ≤32; a failed shard is retried once — retry idempotency depends on `ignore`/`replace`, and a retry in `insert` mode may produce duplicate rows.
- Limits: 8 global concurrent tasks, 1000 tables per task, table names must be unique (a duplicate is `INVALID_ARGUMENT`).
- Starting requires danger confirmation (the challenge is bound to "source→target + table list + mode + location"; changing any field invalidates it).
- Viewing results: "live progress" while running, the terminal state goes to "transfer history" (limit ≤200, can be cleared per project), and all events go to the "transfer log" (limit ≤2000).
- There is no transfer action on the model side; **do not fabricate transfer progress or results**; only guide the user to operate in the panel and read its feedback.

### Console transactions

| Step | Behavior |
|---|---|
| Start | Requires rw and **no database selected**; returns a `sessionToken` bound to a sticky connection |
| Execute | Semantically the same as `execute`: dangerous statements are confirmed one at a time (one challenge per statement) |
| Commit/rollback | Destroys the session and closes the adapter; the token becomes invalid immediately |

- **Only rw with no database selected can begin**: ro gets `READ_ONLY` directly; passing `database` is explicitly rejected (a sticky transaction binds the connection's default database, and crossing databases would silently run against the wrong one).
- **SQLite has no transaction channel**: `begin` reports `INVALID_ARGUMENT` (the connection kind does not support console transaction sessions).
- At most 4 concurrent transaction sessions per connection; idle for 5 minutes → automatic rollback and audit (scan period 30s); after the token becomes invalid, `exec` reports `NOT_FOUND` (already committed/rolled back or reclaimed while idle).
- Revoking authorization or downgrading rw→ro immediately reclaims all transaction sessions of that connection and rolls back uncommitted transactions.

## Security rules (mandatory)

- **Always use parameter binding**: `sql: "SELECT * FROM users WHERE id = ?"` + `params: [42]`. **String concatenation** of user input into SQL is **forbidden**.
- **Identifier allowlist**: when table/column names cannot be parameterized, use only identifiers returned by the `schema` action, or wrap and escape them (MySQL `` `name` ``, PG/SQLite `"name"`, Oracle/DM `"NAME"`, SQL Server `[name]` with a `]` in the name doubled as `]]`); embedding the user's raw text as an identifier is forbidden.
- Leave quotes inside values to parameter binding; in scenarios where binding is genuinely impossible, confirm with the user first.
- Do not execute statements of unknown origin; when the user asks to execute one, follow the dangerous confirmation flow.

## Correct posture under read-only (ro) mode

- Under a ro grant, execute/write-type run_script returns `READ_ONLY` — **do not retry repeatedly**; tell the user directly that the grant needs to be upgraded to rw in the sidebar.
- For data exploration, combining `query` + `schema` + `preview` covers the vast majority of read-only tasks; for bulk export prefer paging (LIMIT/OFFSET or SCAN/fetch) over a single huge query.
- Under Redis ro use `SCAN` rather than `KEYS`; under Mongo ro only find/count-type ops are allowed.
- Result sets have row limits (Oracle/DM 500, Mongo aggregate 500, Redis collection reads 500, preview 50); for complete data, page through and check `truncated`.
- **SQL Server's ro strength is weaker than MySQL/PG**: SQL Server has no equivalent session-level read-only statement. Under ro the adapter's query gate has five layers: ① leading-word allowlist (select/with/show/describe/desc/explain/use/set/help/table); ② reject multiple statements (lexical level: any content after a top-level semicolon is rejected); ③ reject `SELECT ... INTO` (token level; an `into` inside a string/bracketed identifier/comment is not wrongly hit); ④ reject `WITH ... (INSERT|UPDATE|DELETE|MERGE)`; ⑤ reject `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE` (remote/external data sources execute arbitrary statements and cannot be audited, so even a legitimate read-only remote query is rejected). The service layer separately blocks execute, and the guard layer additionally requires confirmation for the same two kinds of "read head, write body". **Do not treat a ro connection as database-side read-only isolation**; when strong isolation is needed, switch to a database-side read-only account.
