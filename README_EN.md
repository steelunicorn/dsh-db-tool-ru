# dsh-db-tool-ru

[Русский](README.md) | [简体中文](README.zh.md) | English

This repository is a fork of [dsh-db-tool](https://github.com/mengqi1436/dsh-db-tool) by mengqi1436. It adds two capabilities on top: per-grant database allowlists inside a connection grant, and Russian UI localization; upstream copyright and the Apache-2.0 license are preserved. The fork is distributed through GitHub only and is not published to npm; the repository is [steelunicorn/dsh-db-tool-ru](https://github.com/steelunicorn/dsh-db-tool-ru).

A DSH host plugin. Operate databases safely from chat: nine databases, project-scoped fine-grained grants, dangerous-operation confirmation, full audit logging, plus a right-sidebar admin console and SQL console.

## Feature flow

The full path of one database operation, from entry point to audit record — both entries (chat tool and right sidebar) share one set of semantics and must pass through two gates: project-scoped authorization and statement-level risk classification.

![dsh-db-tool feature flow](assets/feature-flow.png)

[Open the interactive version](assets/feature-flow.html) — supports zoom, pan, path highlighting, and source-evidence inspection per node.

> Questions or suggestions? [Open an issue](https://github.com/steelunicorn/dsh-db-tool-ru/issues/new/choose).

---

## Supported databases

| Category | Databases |
| --- | --- |
| Relational | MySQL, PostgreSQL, GaussDB, SQLite, Oracle, Dameng DM, SQL Server |
| NoSQL | Redis, MongoDB |

Connections, metadata browsing, queries and previews cover all nine databases. Data transfer is layered by capability: eight kinds (MySQL / PostgreSQL / GaussDB / SQLite / MongoDB / Oracle / Dameng / SQL Server) transfer natively table-to-table, while Redis takes part through the fixed envelope table `__redis_keys`. Redis keyspace fidelity beyond that is out of scope (stream consumer groups, cross-version `DUMP`, logical databases `dbN`).

Dialect differences are handled inside the adapters; the upper layers see a uniform `?` placeholder and a standard result set.

---

## Core capabilities

### Model tool `DatabaseManager`

One tool with several actions, reducing ambiguity in tool selection:

| action | Purpose |
| --- | --- |
| `list_connections` | List available connections (no credentials) |
| `query` | Run a read-only query, return columns and rows |
| `execute` | Run a write statement; dangerous operations need confirmation |
| `schema` | Inspect database / table / column structure |
| `preview` | Preview table data (paged, up to 50 rows per page) |
| `run_script` | Run a script in the sandbox, calling `db.query` / `db.execute` repeatedly |
| `export_to_file` | Write a query result to a file inside the project folder (text / JSON / CSV) |
| `execute_file` | Execute a statement read from a file inside the project folder (guard, confirmation and audit as for `execute`) |

`run_script` isolation boundary: a separate child process plus a `node:vm` sandbox, killed at 60 seconds, with only a restricted `db.{query,execute}` handle injected — no filesystem, no network, no `require`. With the plugin setting `scriptFileBridge` enabled the sandbox gains one extra method, `file.save(path, text)`: the host process performs the write under the same rules as `export_to_file`, so the script itself still has no filesystem access.

### File exchange: results and function bodies

`export_to_file` writes a query result straight to a file and `execute_file` reads a statement from a file, so the agent never re-types text through its own context: function bodies, view definitions and large exports move byte-for-byte.

- The path is always relative; the project folder (also the grant key) is the root. Absolute paths, `..`, drive letters, NTFS streams, reserved device names (`CON`, `NUL`, …) and symbolic links are refused, so neither reads nor writes can leave the project folder.
- `format=text` requires exactly one row and one column and writes the value as is — no newline normalization, no added trailing `\n`. A file produced from `pg_get_functiondef(...)` runs through `execute_file` unchanged.
- `format=json` writes the rows array with two-space indentation and a trailing newline; `format=csv` writes a header of column names with RFC 4180 quoting, `,` separator and CRLF line endings. Files are always UTF-8 without BOM.
- An empty result is `EMPTY_RESULT` (no rows, or `NULL` in text mode) unless `allow_empty` is passed. An existing file is not replaced without `overwrite`, and the parent folder is not created without `create_dirs`.
- Default limits: read ≤ 8 MB, write ≤ 64 MB, extensions `.sql`, `.txt`, `.json`, `.csv`, `.tsv`, `.md`, `.log`; all configurable through the plugin settings (`fileIo`).
- `execute_file` passes the whole content through, without trimming spaces or line endings: dangerous statements still return `NEEDS_CONFIRMATION` with a single-use `challenge_id`, and the audit records direction, path, size, `md5` and the first 200 characters of the text.
- `search_path` (optional, PostgreSQL): a function body often names types and routines without a schema (`citext`, `varlist`), and `pg_get_functiondef` returns the text verbatim. Pass `search_path="sys, dbo, public"` and the plugin runs the file in one batch with `set_config('search_path', …, true)`, so the visibility path lasts for that run only and does not linger on the pooled session. It cannot be combined with `params` (a batch goes through the simple query protocol).

Typical function-body transfer:

```text
export_to_file(conn_id="<source>", sql="select pg_get_functiondef(27896227) as d",
               path="fn/pdt_income_storageobject_t.sql", create_dirs=true)
edit the file in your editor
execute_file(conn_id="<target>", path="fn/pdt_income_storageobject_t.sql")   → commandtag = CREATE FUNCTION
```

### Project-scoped grants (ro / rw)

Grants are stored in three levels (project path → connection → mode) in `grants.json`:

- **ro (read-only)**: queries and browsing allowed, all writes rejected
- **rw (read-write)**: statements, scripts and transactions allowed

An unauthorized project is rejected for every connection. Changing a grant mode (including rw → ro downgrade) invalidates old sessions immediately, no reconnect needed.

On Windows, paths are normalized with NTFS semantics (case-insensitive), so `E:\GitHub\MyApp` and `e:\github\myapp` are the same project.

**Database-level allowlist**: each grant may carry a `databases` field (the "Databases" field in the "Project grants" panel) that narrows the visible databases within that connection. Ticks are saved immediately — there is no separate save button — and access opens only for the databases the user deliberately ticked: a freshly granted connection starts with an empty list, so no database is reachable until something is ticked. The field is absent only on grants created before it existed (and on programmatic grants without a list); such records still mean "every database", while an empty array `[]` means "no database". Names are matched case-insensitively; the panel offers an expandable checkbox list with a name filter and «Select all» / «Clear all» (the filter narrows only the visible list, while «select all» / «clear all» apply to the visible databases and the stored value still covers the full set). For PostgreSQL / GaussDB a target written as `db.schema` is judged by the `db` part; SQLite is exempt (its "database" is a file path).

The allowlist is checked on `query`, `execute`, `schema`, `preview`, the console transaction session and both ends of a data transfer; a mismatch is rejected before any connection to that database is made. Listing databases (`databases`) returns only the allowed ones, and a global table-name search only covers allowed databases. The checkbox list in the grants panel is the exception: it is fed by an ungated listing (`GET /api/grant-databases`) that ignores the allowlist — otherwise a narrowed grant could not be widened again.

### Dangerous-operation confirmation

DDL, `FLUSHALL`, `dropDatabase` and similar statements return `NEEDS_CONFIRMATION` first instead of executing:

1. The first call returns a pending state with a one-time `challengeId`
2. The `challengeId` is bound to the statement's SHA256, valid for 5 minutes, single use
3. Execution happens only when the user confirms and retries with the same `challengeId`

The chat tool confirms through conversation and the SQL console confirms through a dialog — both paths share the same semantics, and neither can be bypassed.

### Full audit logging

Every execution (including rejected requests) appends one line to `audit.jsonl`: statement, danger level, whether it was confirmed, result and duration. The right sidebar shows it live.

### Data browsing

- Four-level tree: connection → database → schema → table
- The tree lists only what the current account may use: in PostgreSQL / GaussDB databases without `CONNECT` and schemas without `USAGE` or without a single `SELECT`-able table are hidden; in SQL Server databases without `HAS_DBACCESS` and schemas/objects without `SELECT` are hidden. Project grants stay a second, independent restriction
- Database filter plus cross-database table-name search (MySQL / PostgreSQL / GaussDB query `information_schema` natively; other kinds fall back to in-memory filtering)
- Table and view structure viewing and data preview (Oracle and DM list tables and views together; in MongoDB a view's description skips index lookups); the result grid supports sorting, paging and cell copying
- Navicat-style pager: jump to a page by number, «First» / «Last» buttons, and the total row count of the table next to the page number
- Content search: the search field above the table keeps rows whose any column contains the substring (case-insensitive), shows the number of matches and pages through them; Redis (a key-value store) has no row-level search, so the field is hidden there
- Navicat-style column filters: each column can carry a condition (`contains`, `does not contain`, `begins with`, `ends with`, `is null`, `is not null`, `is empty`, `is between`, `is in list` and their negations); conditions of several columns are joined with `AND` or `OR`; filtering runs on the server, so paging and the row count are computed over the filtered set

### SQL console

A Navicat-style multi-tab editor in the right sidebar (CodeMirror 6):

- **Multiple tabs**: each tab keeps its own SQL, results and history (50 entries, click to restore)
- **Highlighting and completion**: dialect switches automatically (MySQL / PostgreSQL / SQLite / PL-SQL / T-SQL), with table and column metadata feeding completion
- **Shortcuts**: `Ctrl/Cmd+Enter` runs everything, `Ctrl/Cmd+Shift+Enter` runs the selection
- **Formatting**: sql-formatter per dialect, falling back to the original text when parsing fails
- **Per-statement execution**: the client pre-classifies read and write statements and routes them to the query and execute channels; under an ro grant, write statements are skipped and marked
- **Batch separator `GO`**: supports `GO` and `GO n` (sqlcmd semantics, `GO 0` / `GO 1` both mean once), with a repeat cap of 1000 to prevent amplification
- **Transactions**: under an rw grant you can begin / commit / roll back on a sticky server-side connection; idle sessions roll back automatically after 5 minutes and are audited
- **Result grid**: three-state sorting, 50 rows per page, CSV / JSON export

### Data transfer

Moving table data between databases of the same or different kinds:

- **Write modes**: `insert` (append), `ignore` (skip conflicts), `replace` (overwrite), `truncate` (clear first)
- **Automatic table creation**: generates DDL from the source table structure when the target table is absent
- **Dependency ordering**: when the target schema already has foreign keys, operations are ordered automatically — child tables are dropped/cleared first, parent tables are loaded first; mutually referencing table groups are dropped as a group via each database's official mechanism (their load order is not guaranteed and foreign key conflicts fail as-is); target tables referenced by tables outside the selection fail fast with a clear message on overwrite
- **Paged reads**: ordered cursor (keyset), range, or offset strategies
- **Progress and history**: live progress push plus per-project transfer history
- **Transfer configuration**: saved per project, auto-saved, restored after restart, cleared when a connection becomes invalid
- **Intermediate type model**: heterogeneous columns are normalized to a common intermediate type before mapping to the target column, avoiding point-to-point conversion across nine databases
- **Authorization at both ends**: the source and the target each check the connection grant and its database-level allowlist
- **Redis envelope fallback**: Redis participates through the fixed table `__redis_keys` with these six columns

| Column | Meaning |
| --- | --- |
| `key` | Key name |
| `type` | string / hash / list / set / zset / stream, etc. |
| `ttl_ms` | Remaining TTL in milliseconds, 0 when no expiry |
| `encoding` | `OBJECT ENCODING` memory-encoding diagnostic value, unrelated to `payload` serialization |
| `payload` | Value flattened by type, always a UTF-8 JSON string |
| `dump` | `DUMP` RDB serialized bytes, used only by homogeneous Redis via `RESTORE` |

### Connection export / import

Export every connection (including passwords) into a passphrase-encrypted file for cross-machine migration:

- scrypt-derived key plus AES-256-GCM over the whole payload; the file has no plaintext when opened
- Passphrase minimum length 8, enforced server-side
- On import, existing connection ids are skipped and never overwritten; the summary reports imported / skipped / failed

---

## Right sidebar

Registers one tab through the official DSH right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`), with no third-party sidebar dependency. The tab contains five panels (Chinese, English and Russian dictionaries, following the host locale):

| Panel | Purpose |
| --- | --- |
| Connections | Create / edit / delete connections, adaptive card layout, per-connection or one-click connectivity test, export and import |
| Project grants | Tick ro / rw per connection for the current project and maintain the database-level allowlist inside the grant |
| Data browsing | Tree browsing, search, data preview |
| SQL console | Multi-tab editor, transactions, history, result grid |
| Data transfer | Table-level migration with batch / parallel options and a transfer log |

Server error messages are in English and are shown in the UI as-is; they are not translated.

### Notes

Both are contracts of the official right sidebar and are easily mistaken for plugin defects:

- **With no session selected, the right sidebar shows no database panel.** The official right sidebar keys its layout state by session id; without a session there is no docking surface, hence no entry card or tab — select a session first, then expand the right sidebar.
- **When DSH has exactly one ready entry card, the "+" new-slot cell opens the database tab directly instead of the guide page.** This is the official default-page rule, not a skipped guide page.

---

## Security model

| Layer | Mechanism |
| --- | --- |
| Storage | Passwords and full URLs live in `secrets.json` (0600) and are never returned to the model; connection info returned to the UI is always masked as `***` |
| Authorization | Project-scoped ro / rw allowlist with an optional database-level allowlist inside the grant; no grant means rejection |
| Statement level | Risk classification (danger / warning / none) plus one-time confirmation |
| Read-only enforcement | MySQL / PostgreSQL use session-level `SET TRANSACTION READ ONLY`; SQL Server degrades to five application-level gates |
| Transport encryption | Plaintext first, upgrading only when the server insists; see "Transport encryption" |
| Error redaction | When connection-string parsing fails, userinfo in the error text is redacted; plaintext passwords are never echoed |
| Script isolation | Separate child process + vm sandbox + 60-second hard kill + only the db handle injected |

**The database-level allowlist is one more gate, ordered after the project grant and after the read-only check**: a write on an ro grant still fails as read-only, not as "database not granted", and a mismatch is rejected without opening a connection to that database.

**SQL Server's ro enforcement is weaker than MySQL / PostgreSQL**: SQL Server has no equivalent session-level read-only statement, so under an ro grant five application-level gates apply — first-word allowlist, multi-statement rejection, `SELECT ... INTO` rejection, `WITH ... (INSERT|UPDATE|DELETE|MERGE)` rejection, and `OPENQUERY` / `OPENROWSET` / `OPENDATASOURCE` rejection. This remains application-level interception; for hard isolation, configure a database-side read-only account for the connection.

### Transport encryption

**Connecting first, encrypting only when required.** SQL Server defaults to `encrypt=auto`: connect without encryption first; only when the server **forces encryption** does it upgrade and retry once, trusting the server certificate — one retry, for that reason only, and never when `encrypt` is written explicitly. Dameng behaves the same way: only when the server negotiates an algorithm that the local OpenSSL has dropped (`[6071]`) does it disable transport encryption and retry once.

**Plaintext is the cost of that policy**: SQL Server's `auto` / `encrypt=false` and Dameng's `loginEncrypt=false` all send credentials and results in the clear. Fine on a trusted internal network; for public or untrusted networks, demand encryption explicitly and deal with the certificate or algorithm issues it brings.

---

## Installation

**Runtime requirements**: Node.js ≥ 22 (required by some database drivers); the DSH host must provide the official right sidebar.

```bash
# From GitHub (the only distribution channel)
dsh plugin --profile desktop add "github:steelunicorn/dsh-db-tool-ru"

# Local development
dsh plugin --profile desktop add "link:D:\Projects\dsh-db-tool"
```

If the `dsh` command is not on PATH in the desktop app, open the menu bar and click **Manage dsh command** to register it. Restart the DSH desktop app after installing.

**Do not enable it together with the upstream plugin in the same profile**: both register the same tool name (`DatabaseManager`) and share the same data directory (`<My Documents>/DSH/db-tool`), so connections and grants are shared but the tool would be registered twice — remove or disable the upstream plugin before installing this package.

**Data survives the switch**: connections, grants and audit records stay in the existing `<My Documents>/DSH/db-tool/` directory, so replacing the upstream plugin with this fork needs no reconfiguration.

**About oracledb**: its install script is blocked by pnpm by default, so the first install reports a failure. Click **Allow these scripts and retry** in the DSH plugin installation UI — the script only checks the Node version and prints a banner, and the approval persists in the profile.

**Where the frontend mounts**: the database panel mounts on DSH's built-in right sidebar; no extra sidebar plugin is needed. `dsh.client.inject` already declares `@deepseek-ai/dsh-client-ui-sidebar-right` as a load prerequisite.

---

## Data layout

`<My Documents>/DSH/db-tool/` (directory mode 0700; shares its root with the transfer log so users can open it directly):

| File | Contents |
| --- | --- |
| `connections.json` | Connection definitions (`urlSafe` masks passwords as `***`) |
| `secrets.json` | 0600, passwords and full URLs, never returned to the model |
| `grants.json` | Project grants (normalized path → connId → ro / rw, optionally with a database-level allowlist) |
| `transfer-config.json` | 0600, per-project connection and option config for the transfer page |
| `audit.jsonl` | Append-only audit log, one JSON object per line |

`transfer-log.jsonl` (transfer process log and history) sits alongside. Path resolution priority: explicit injection (tests) > `DSH_DB_TOOL_DIR` > `<My Documents>/DSH`. On Windows "My Documents" is resolved through the Shell API and follows redirection (OneDrive etc.); elsewhere it uses `XDG_DOCUMENTS_DIR` or `~/Documents`. Data from older versions stored under `$DSH_HOME/db-tool/` is migrated file-by-file on first start (skipped when the target exists; old files are kept).

---

## Development

```bash
npm ci
npm run build        # compile + build vendor bundles (mongodb / sqlserver / codemirror)
npm test             # full vitest run
npm run typecheck    # tsc --noEmit
```

Real-database smoke tests are gated by environment variables and only run when set:

```
DBT_TEST_MYSQL_URL / DBT_TEST_PG_URL / DBT_TEST_REDIS_URL / DBT_TEST_DM_CONNECT
DBT_TEST_MONGO_URL / DBT_TEST_ORACLE_CONNECT / DBT_TEST_SQLSERVER_URL
```

CI lives in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): Node 22 and 24, running `npm ci → build → typecheck → test`.

### Repository layout

```
lib/          plugin body
  adapters/   9 database adapters + transfer implementations
  store/      connection / grant / audit / secret storage
  guard/      statement risk classification
  manager.ts  business orchestration (authorize, dispatch, confirm, audit)
  http/       right-sidebar HTTP routes
  script/     run_script sandbox and child process
client/       right-sidebar single-file bundle
skills/       db-admin skill (SKILL.md — English, SKILL.ru.md — Russian, SKILL.zh.md — Chinese)
scripts/      build and tooling scripts
patches/      DSH host hotfix patches
tests/        vitest (offline mocks + gated real-database tests)
assets/       feature flow diagram
vendor/       driver and editor bundles (build artifacts, included on publish)
```

---

## Contributors

Thanks to every external contributor whose work landed on `master`; per-item details are in [CONTRIBUTORS.md](CONTRIBUTORS.md):

- [a19920714liou](https://github.com/a19920714liou) — [PR #1](https://github.com/mengqi1436/dsh-db-tool/pull/1): ro connection hook hang + Windows path case mismatch in grants
- [weicy98](https://github.com/weicy98) — [PR #12](https://github.com/mengqi1436/dsh-db-tool/pull/12): Dameng DM connection failure when communication encryption is DES_CFB
- Upstream author: [mengqi1436](https://github.com/mengqi1436) — [dsh-db-tool](https://github.com/mengqi1436/dsh-db-tool)
- Russian-localized fork: [steelunicorn/dsh-db-tool-ru](https://github.com/steelunicorn/dsh-db-tool-ru) — [issues](https://github.com/steelunicorn/dsh-db-tool-ru/issues)

Bug fixes and adapter support are welcome; contribution conventions are in [CONTRIBUTORS.md](CONTRIBUTORS.md#贡献方式).

---

## License

[Apache License 2.0](LICENSE) © 2026 mengqi1436

Free to use commercially, modify, distribute and sublicense, provided copyright and license notices are retained and modified files are marked. The included patent grant is irrevocable, but terminates if you bring a patent suit over this work.

This fork is distributed under the same license; the upstream project is [mengqi1436/dsh-db-tool](https://github.com/mengqi1436/dsh-db-tool).
