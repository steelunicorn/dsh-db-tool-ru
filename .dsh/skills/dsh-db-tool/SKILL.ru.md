---
name: dsh-db-tool
description: "Навык разработки dsh-db-tool-ru — TypeScript-плагина DSH, который предоставляет инструмент DatabaseManager для работы с базами данных. Используйте его при разработке, добавлении и изменении девяти адаптеров баз данных (mysql/postgresql/oracle/sqlite/dmdb/gaussdb/mongodb/redis/sqlserver), при написании кода, зависящего от диалекта SQL, при реализации и отладке переноса данных, при обработке различий между базами (кавычки в идентификаторах, пакетная запись, человекочитаемые ошибки) и при изменении API-маршрутов и конфигурации store в этом репозитории."
---

# Навык разработки dsh-db-tool

> Языки: [English](SKILL.md) · [简体中文](SKILL.zh.md)

## Карта модулей

| Путь | Ответственность |
| --- | --- |
| `lib/index.ts` | Точка входа плагина. `export const inject = ['webServer', 'sessions', 'tools', 'connection']`; `ctx.webServer.register({kind:'prefix', path:'/dsh-db-tool/api'})` монтирует HTTP; `ctx.tools.register` регистрирует инструмент `DatabaseManager` (`timeoutMs: 90_000`, шесть действий: `list_connections`/`query`/`execute`/`schema`/`preview`/`run_script`); `ctx.effect` завершается вызовом `service.dispose()`. `projectPath` берётся только из `session.header.cwd`, никогда из самоотчёта модели. **Экспорт по умолчанию запрещён** — `unwrapExports()` в cordis предпочитает `exports.default`, и форма «голая функция» теряет именованный экспорт `inject`, выдавая `cannot get property "webServer" without inject`, при этом плагин так и не активируется |
| `lib/http/index.ts` | Слой диспетчеризации API-маршрутов (только маршрутизация и параметры, бизнес-логика вынесена в менеджер); `isTrustedRequest` выполняет проверку Host/Origin, `MAX_JSON_BODY_BYTES` 2MB |
| `lib/manager.ts` | `DbToolService`: аудит (`audit`), авторизация (`authorize`), преобразование ошибок (`toDriverError`), `DbToolError`; `handleToolAction` — точка входа диспетчеризации для действий инструмента, вызываемых моделью |
| `lib/guard/index.ts` | Классификация риска операторов + одноразовые учётные данные подтверждения (см. следующий раздел) |
| `lib/script/runner.ts` | Исполнитель дочернего процесса `run_script` (родительская сторона): `fork` + флаг модели разрешений + белый список переменных окружения + SIGKILL по таймауту |
| `lib/script/worker.cjs` | Воркер `run_script` (дочерняя сторона): новая область `vm.runInNewContext`, инжектируются только `db`/`console`; вызовы `db` возвращаются в родительский процесс по IPC и проходят полную цепочку guard/audit |
| `lib/adapters/index.ts` | Единая точка входа `getAdapter(kind)`; отсутствующий драйвер единообразно приводит к `driverMissingError(kind, cause?)` |
| `lib/adapters/<kind>/index.ts` | Адаптеры диалектов: mysql, postgresql, oracle, sqlite, dmdb, gaussdb, mongodb, redis, sqlserver (девять баз данных, реестр в `LOADERS` из `lib/adapters/index.ts`) |
| `lib/adapters/types.ts` | Единый контракт адаптера `DatabaseAdapter`: `query`/`execute`/`listDatabases`/`listTables`/`describeTable`/`previewRows`/`testConnect`/`close`, необязательные `listSchemas?`/`searchTables?`/`tx?` |
| `lib/adapters/sql-shared/common.ts` | Общие утилиты SQL: `assertIdent`, `quoteIdent`, `clampLimit`, `clampOffset`, `normalizeCell`, `humanize` (горячая точка с высокой входящей связностью — перед изменением проверьте всех вызывающих) |
| `lib/adapters/sql-shared/pg-like.ts` | Общая реализация для PostgreSQL/GaussDB: `normalizeUrl` (разбор и пересборка URL с несколькими хостами), `pickHost` (выбор хоста для проверки доступности), `createPgLikeAdapter`, `TxHandle` |
| `lib/adapters/transfer/` | Модель переноса `model.ts` (`TransferCursor`/`TransferRow`/`readBatch`) + `kinds/` (семь реализаций — mongo, mysql, oralike, pg, sqlite, sqlserver, redis — покрывающих девять видов; недавно добавленный `kinds/redis.ts` — урезанная реализация для фиксированной таблицы-конверта Redis `__redis_keys`) |
| `lib/transfer.ts` | Оркестратор переноса `startTransferTask`: параллелизм на уровне таблиц + большие таблицы шардируются параллельно по `keyAt`; предел параллелизма `MAX_TRANSFER_TASKS = 8` |
| `lib/store/index.ts` | Агрегат `DbToolStore`: корень данных `<My Documents>/DSH/db-tool` (каталог `0700`, тот же корень, что и у `transfer-log.jsonl`); приоритет разрешения: явный `homeDir` (инъекция в тестах) > `DSH_DB_TOOL_DIR` > `<My Documents>/DSH`. «My Documents» разрешается через `documentsDir()` (`transfer-history.ts`, Windows Shell API `GetFolderPath`) с автоматическим следованием перенаправлению; старое расположение `$DSH_HOME/db-tool` переносится пофайлово при первом запуске (`migrateLegacyDir`, пропускается, если целевой каталог существует, старые файлы сохраняются), а при инжектированном `homeDir` перенос пропускается |
| `lib/store/io.ts` | `writeJsonAtomic` (атомарная запись: временный файл + переименование), `readJson`, `chmodBestEffort` |
| `lib/store/connections.ts` | Метаданные подключений (без паролей) + `redactUrl`, `mergeUrlCredentials`, `DuplicateConnectionError` |
| `lib/store/secrets.ts` | `SecretsBox`: пароли и полные URL, записываются в `secrets.json` (`0600`), открытый текст никогда не покидает хранилище |
| `lib/store/grants.ts` | Разрешения подключений на уровне проекта `grants.json` |
| `lib/store/audit.ts` | `AuditLog` — журнал только на дозапись `audit.jsonl` |
| `lib/store/transfer-history.ts` | `TransferLog` → `transfer-log.jsonl`, тот же корень, что и `db-tool/` (`<My Documents>/DSH/`); экспортирует `documentsDir()` для повторного использования хранилищем; под vitest (`VITEST=true`) пишет во временный корень данных, чтобы не загрязнять настоящий каталог Documents |
| `lib/store/normalize.ts` | `normalizeProjectKey` (высокая входящая связность: кроссплатформенная нормализация путей) |
| `lib/store/export-crypto.ts` | `encryptPayload`/`decryptPayload` — межмашинное шифрование парольной фразой при экспорте и импорте подключений |
| `scripts/` | `build-mongodb.mjs`/`build-sqlserver.mjs`/`build-codemirror.mjs` (артефакты esbuild), `hotfix-core.mjs` (ядро хотфиксов хоста), `apply-dsh-hotfix.ps1`/`.sh`, `diag-profile.mjs`, `verify-host.mjs`, `fix-dsh-install.ps1` |
| `patches/` | Патчи хотфиксов для хоста DSH `dsh-app-boot`, выбираемые по версии хоста взаимно однозначно (см. следующий раздел) |
| `assets/` | `feature-flow.png`/`.html` — схема потока функций, используемая в README |
| `.github/workflows/` | `ci.yml` (матрица Node 22/24: `npm ci` → `npm run build` → typecheck → test), `publish.yml` (релиз только при изменении версии) |
| `client/client.js` | Фронтенд боковой панели (один файл), загружает редактор во время исполнения через `require("../vendor/codemirror-sql.cjs")`; при ошибке загрузки деградирует до обычной textarea (после отказа одноэлементного промиса он сбрасывается в null, чтобы разрешить повторную попытку) и не выполняет same-origin fetch (во избежание отравления динамическим исполнением `Function`) |
| `tests/` | vitest, 69 тестовых файлов: `adapters-sql`(22), `store`(11), `adapters-nosql-ent`(8), `client`(9), `tool`(7), `guard`(3), `http`(3), `e2e-mock`(3), `plugin`(2), `scripts`(1); мутационное тестирование `stryker.config.json` в корне репозитория (мутирует только `lib/index.ts` и `lib/http/index.ts`) |

Поверхность API (`lib/http/index.ts`, реальные пути несут префикс `/dsh-db-tool`): `/api/state`, `/api/project-context`, `/api/connections` (CRUD + `/export`, `/import` — межмашинный перенос с шифрованием парольной фразой), `/api/test-draft`, `/api/grants`, `/api/databases`, `/api/tables`, `/api/schemas`, `/api/schema`, `/api/search-tables`, `/api/preview`, `/api/query`, `/api/execute`, `/api/script`, `GET/PUT /api/transfer-config` (конфигурация переноса, сохраняемая на проект, автосохранение, восстановление при перезапуске, очистка при недействительном подключении), `/api/transfer/start`, `/api/transfer/live`, `/api/transfer-log`, `/api/transfer-history`, `/api/transfer-history/clear`, `/api/console/begin|exec|commit|rollback` (закреплённое подключение, begin выдаёт токен, чтения внутри транзакции должны идти через то же подключение), `/api/audit`. Новые маршруты должны синхронизировать контрактные утверждения в `tests/http/api.spec.ts`.

### guard: классификация риска и учётные данные подтверждения

`classifyStatement(kind, statement, op)` — единственная точка входа классификации, возвращает `{ level: 'danger'|'warning'|'none', reason?: string }`, диспетчеризуясь по виду в `classifySql`/`classifyRedis`/`classifyMongo`.

| Измерение | Правило | Уровень |
| --- | --- | --- |
| Белый список чтения | Совпадение первого слова с `SQL_READ_HEADS` (`select/with/show/describe/desc/explain/use/set/help/table`) | Продолжить подклассификацию, иначе считается неизвестным |
| Опасность, скрытая в теле чтения | `SQL_HIDDEN_DANGER_RE`: несколько операторов, `INTO OUTFILE/DUMPFILE`, `LOAD_FILE(`, `SET GLOBAL/PERSIST`, `FOR UPDATE` | danger |
| Запись, скрытая в теле чтения | `SQL_WRITE_BODY_RE`: `insert/update/delete/merge/drop/alter/truncate` (класс `WITH...DELETE`) | danger |
| DDL | `SQL_DDL_RE`: `drop/truncate/alter/create/rename/comment/grant/revoke/flashback/purge` | danger (неявный commit, откат невозможен) |
| DML | `SQL_DML_RE`: `insert/update/delete/merge/replace/upsert/call/do` | danger в канале `query`; warning в канале `execute` |
| Команды обслуживания | `SQL_MAINT_RE`: `shutdown/startup/archive log/recover/analyze/optimize/check table/repair/lock/unlock/kill/flush` | danger |
| Неизвестное первое слово | Не совпадает ни с одним списком | danger в канале `query`; warning в канале `execute` |
| Первые слова, специфичные для T-SQL | `SQLSERVER_DANGER_HEADS`: `backup/restore/dbcc/reconfigure/bulk/shutdown/sp_configure/xp_cmdshell`, **включается только для kind=sqlserver** | danger |
| Динамическое исполнение T-SQL | `EXEC/EXECUTE`, за которым следует `xp_*`/`sp_configure`/`sp_executesql` (в пределах 200 символов), `EXEC('…')`/`EXEC N'…'`/`EXEC @sql` | danger |
| T-SQL `SELECT ... INTO` | Создаёт объект; псевдоним `AS into` и `INTO @variable` разрешены | danger |
| Redis | `DANGEROUS_COMMANDS` (экспортируются адаптером) — danger; `WRITE_COMMANDS` — по каналу; `READ_COMMANDS` — none; неразбираемое или нераспознанное — fail-closed | См. слева |
| MongoDB | `DANGEROUS_OPS` (`READ_OPS`/`DANGEROUS_OPS` оба экспортируются адаптером — единый источник истины) + `drop` как запасной danger; `MONGO_WRITE_OPS` — по каналу; нераспознанное — fail-closed | См. слева |

Учтите, что `SQL_READ_HEADS` и `SQLSERVER_DANGER_HEADS` — оба `ReadonlySet`: вызывающие не могут добавлять или удалять элементы в примитивах безопасности, а изменение списка означает изменение этого кода.

`ChallengeStore`: `ttlMs` по умолчанию 5min, `sweepIntervalMs` по умолчанию 60s (`0` отключает таймер для тестов), инжектируемые часы `now` служат для тестов истечения срока; id = `c_` + hex из 12 байт; `statementHash` — SHA256 оператора; `consume(id, statement, scope)` **вызывает `delete` до проверки** (значение забирается независимо от успеха или неудачи, что предотвращает разведочные повторы), а scope `connId + projectKey` должен точно совпадать с созданным, что не даёт повторно использовать один и тот же оператор в других базах или проектах.

### Модель изоляции run_script

Два уровня: отдельный дочерний процесс + модель разрешений Node (**без fs**; Node ≥22 использует `--permission`, 20/21 используют `--experimental-permission`), а сам скрипт выполняется в **новой области vm** воркера (`vm.runInNewContext`, `vm timeout 60s`), куда инжектируются только `db.query`/`db.execute`/`console`. `vm` не является границей безопасности (конструктор `Function` позволяет выйти из неё), поэтому настоящая опора — отсутствие файловых разрешений у дочернего процесса.

| Параметр | Значение | Расположение |
| --- | --- | --- |
| Переменные окружения | Белый список из 11 элементов: `PATH/SYSTEMROOT/SYSTEMDRIVE/TEMP/TMP/COMSPEC/PATHEXT/USERPROFILE/HOME/LANG/TZ` | `ENV_ALLOWLIST`, `minimalEnv()` в `runner.ts` |
| Таймаут по умолчанию | 60s, обеспечивается **`SIGKILL` от родительского процесса** (`vm timeout` ограничивает только синхронное исполнение и не управляет асинхронной работой) | `runner.ts` `runScriptInChild` |
| Побочные эффекты таймаута | Запускает `onTimeout` → закрывает адаптер, выделенный сессии, прерывая выполняющиеся вызовы db | То же, что выше |
| Вызовы db | Возвращаются в родительский процесс по IPC, проходя полную цепочку guard/challenge/audit | `worker.cjs` |

## Матрица возможностей адаптеров

`✅` — необязательный метод реализован; `—` — не реализован (необязателен по контракту); `native` / `fallback` / `empty` — см. примечание к столбцу `searchTables`.

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

`searchTables` имеет три уровня: **native** (mysql — один LIKE по `information_schema`; pg/gaussdb выполняют `ILIKE` по каждой базе, причём `database` совместим с тремя формами «имя базы / `database.schema` / схема»); **fallback** (`SEARCH_FALLBACK_KINDS = mysql/mongodb/sqlite`, `listTables` по каждой базе + фильтрация в памяти — у mysql есть нативная реализация, поэтому на практике fallback используют только sqlite/mongodb); **empty** (redis `listTables` игнорирует имя базы, поэтому цикл по базам повторно возвращал бы ту же партию ключей; семантика `database` в oracle/dmdb — это владелец, поэтому межбазовый fallback пометил бы источник неверно; sqlserver отсутствует в белом списке). Белый список fallback — граница безопасности; прежде чем его расширять, убедитесь, что семантика `listTables(database)` целевого вида действительно «имя базы».

Возможность транзакций делится на три уровня:

| Форма | kind | Использование |
| --- | --- | --- |
| Объектная `tx: { begin, commit, rollback }` | mysql, postgresql, gaussdb, sqlserver | Явные три шага |
| Функциональная `tx(fn)` | oracle, dmdb | Операторы внутри `fn(exec)` идут через транзакционное подключение, а `exec` диспетчеризует по началу оператора обратно в `QueryResult`/`ExecResult` |
| Без `tx` | sqlite, redis, mongodb | Междокументные транзакции mongodb требуют replica set и выходят за рамки обязательств этого инструмента |

Семантика входных данных `query`/`execute` различается по видам; при написании адаптера не копируйте семейство SQL дословно:

| kind | Вход `query` | Вход `execute` | Параметр `database` |
| --- | --- | --- | --- |
| mysql | SQL + заполнители `?` | Как слева | Маршрутизация в другую базу через выделенный пул (пул ro при этом тоже только для чтения) |
| postgresql/gaussdb | SQL + `$1` | Как слева | Как выше, поддерживает маршрутизацию по базе |
| sqlserver | SQL + `?` (внутренне переписывается в `@p1`) | Как слева | Как выше |
| oracle/dmdb | SQL + `:name` | Как слева | Игнорируется (сценарии, где семантика `database` — это владелец, обрабатываются через `listTables`) |
| sqlite | SQL + `?` | Как слева | Игнорируется (единственная база `main`) |
| redis | **JSON-массив команд** (`["GET","key"]` или `GET key`) | Как слева | Игнорируется (`db0`) |
| mongodb | **JSON-документ BSON-команды** (`{"find":"users","filter":{}}`) | Как слева | Целевая база |

## Правила разработки адаптеров

1. Прежде чем добавлять или менять диалект, сравните с ближайшим существующим адаптером: семейство PG переиспользует `sql-shared/pg-like.ts`; семейство Oracle/DM разделяет `transfer/kinds/oralike.ts`.
2. Образец экспорта (сравните с `lib/adapters/mysql/index.ts`): `export async function createXxxAdapter(conn)` + `export const factory: AdapterFactory = (conn) => createXxxAdapter(conn)`; не обходите фабрику и не вызывайте `new` напрямую.
3. Отсутствующий пакет драйвера всегда выбрасывается через `driverMissingError` в `lib/adapters/index.ts` (уже обрабатывается единообразно внутри `getAdapter`); не придумывайте текст ошибки внутри адаптеров.
4. Идентификаторы оформляются только через `quoteIdent`/`assertIdent`; конкатенация имён таблиц или столбцов строками запрещена; на стороне запросов переиспользуйте `clampLimit`/`clampOffset` и `normalizeCell`, а для обёртки ошибок — `humanize`.
5. Общие утилиты SQL (common.ts, pg-like.ts, normalizeProjectKey) — горячие точки с высокой входящей связностью: перед изменением найдите всех вызывающих, исправляйте в одном месте внутри общей функции и никогда не латайте отдельные места вызова.
6. Ячейки единообразно `NormalizedCell` (`string | number | null`): DECIMAL/NUMERIC остаются строками ради предотвращения потери точности, даты выдаются в ISO, Lobs преобразуются в строки и помечаются как усечённые, Mongo `ObjectId`/`Decimal128`/`Long` единообразно используют `toString()`.

## Краткий справочник различий девяти баз данных

| Сценарий | Подводный камень |
| --- | --- |
| Пакетная запись | Семейство Oracle связывает заполнители `:b1..`, и общее число связанных параметров на пакет ограничено (DPI-1015), поэтому широким таблицам нужны пакеты меньше; совместимость DM полагается на сопоставление сообщений для конфликтов уникальности (ORA-00001 / `-6602`), поэтому не сравнивайте коды ошибок точно; MongoDB `bulkWrite` использует `ordered: false` и должен полностью конвертировать до записи (исключение при конвертации → не записывается ничего), без транзакций между пакетами (требуется replica set); SQLite — однописательный, поэтому записи обёрнуты в `BEGIN IMMEDIATE`; пакетные записи переноса семейства PG используют параметризованные INSERT-пакеты (без COPY) |
| Кавычки в идентификаторах | `quoteIdent(name, quote)` по умолчанию использует двойные кавычки, MySQL передаёт `` ` ``; внутри сначала выполняется `assertIdent` для предотвращения инъекций, экранирование — удвоением кавычки |
| Человекочитаемые ошибки | Оборачивайте внутри адаптеров через `humanize(label, fn)`, затем пропускайте через `toDriverError` на уровне менеджера; не выбрасывайте сырые ошибки драйвера без обёртки на уровне маршрутизации |
| GaussDB | URL поддерживают проверку доступности нескольких хостов через `normalizeUrl`+`pickHost`; переключение при сбое во время работы и IPv6 — известные потолки, не обещайте исправление |
| SQL Server | Используйте только общий стиль 2005+: метаданные — только через каталоговые представления `sys.*`; пагинация ветвится по версии (2012+ использует `OFFSET/FETCH`, 2008/2008R2 откатывается к `ROW_NUMBER`; переносы следуют тому же правилу, упорядоченные курсоры используют `SELECT TOP (n)`, а неудачная проверка версии консервативно откатывается к 0); идентификаторы — `[x]`, где `]` удваивается в `]]`; внешний заполнитель — `?`, внутренне переписываемый адаптером в `@p1`; **автосогласование версии TDS** (объявляет `7_4` фиксированно, а сервер понижает по своим возможностям: 2005→`7_2`, 2008→`7_3_A`, 2008R2→`7_3_B`, 2012+→`7_4`; требование уровня MUST по [MS-TDS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/773a62b6-ee89-4c02-9e5e-344882630aac), не понижайте его вручную); `encrypt` поддерживает `auto`/`true`/`false`/`strict`, и **новые подключения по умолчанию используют `auto`** (сначала без шифрования; только когда сервер **требует шифрование**, сообщается `EENCRYPT`/«the server requires an encrypted connection», и только тогда выполняется **одна повторная попытка** с `encrypt=true`+`trustServerCertificate=true`; один повтор, только по этой причине, и **никакого повтора, если `encrypt` задан явно**); на серверах, не требующих шифрования, `auto` эквивалентен `encrypt=false`, то есть LOGIN7 (включая учётную запись и пароль) отправляется в открытом виде, поэтому в публичном интернете или недоверенных сегментах сети следует явно указывать `encrypt=true`; `strict`=TDS 8.0, только 2022+ Force Strict Encryption; в этом режиме `trustServerCertificate` полностью не действует; параметры шифрования и сертификатов свёрнуты в интерфейсе в «Дополнительные параметры», а обычному подключению нужны только host/port/account/password; только SQL-аутентификация, без Windows integrated authentication / Azure AD; **при ошибках сертификата предпочитайте `?caCert=` для установки CA (официально рекомендовано) или `?serverName=`, и только в крайнем случае `?trustServerCertificate=true`**; ошибки версии протокола (`UNSUPPORTED_PROTOCOL`) не устраняются сменой параметров сертификата и требуют исправления на стороне сервера (2008R2 SP3 KB4057113 / 2008 SP4 KB4057114 / 2012·2014 соответствующие CU+GDR и KB3052404) или понижения до `?tlsMinVersion=TLSv1`; **в 2005 нет исправления с поддержкой TLS 1.2**; **`encrypt=false` полностью пропускает рукопожатие TLS и отправляет LOGIN7 в открытом виде** (измерено захватом пакетов с поддельным TDS-сервером, следующий пакет клиента — `0x10`; утверждение «пакет входа всегда шифруется» верно только когда сервер требует шифрование или клиент задаёт `encrypt=true`); пакетные записи переноса используют строк на оператор = `min(floor(2100 / число столбцов), 1000)`; перемещение типов: `hierarchyid`/`geometry`/`geography` → байты (целевой `VARBINARY(MAX)`, семантика UDT не сохраняется), `sql_variant` → текст (исходный тип теряется), `varchar/char(4001–8000)` → класс `NVARCHAR(MAX)`, `datetime2`/`time` на стороне чтения `CONVERT(..., 126)` для точности, decimal точен только на стороне чтения переноса через `CONVERT(nvarchar(64), col)` (не точен на стороне просмотра); **пять шлюзов ro** (белый список первого слова + несколько операторов + `SELECT ... INTO` + тело записи `WITH` + `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE` — все отклоняются); счётчик повторов `GO n` в консоли ограничен 1000 (при превышении обрезается) |

## Основы процесса переноса

- Точка входа: `POST /api/transfer/start` → `startTransferTask` в `lib/transfer.ts` → `lib/adapters/transfer/` выбирает реализацию `kinds/*` по виду источника и цели; `GET/PUT /api/transfer-config` сохраняет и восстанавливает конфигурацию переноса на проект и автоматически очищает недействительные подключения. Обоснование продукта см. в [DBeaver Task management](https://dbeaver.com/docs/dbeaver/Task-Management), [Airbyte Configuring schemas](https://docs.airbyte.com/platform/using-airbyte/configuring-schema), [AWS DMS task settings](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.CustomizingTasks.TaskSettings.html) и [Navicat Save Profiles](https://www.navicat.com/manual/pdf_manual/en/navicat_16/win_manual/navicat_en.pdf) ([official page dynamic shell/search summary confirmed]: Navicat — это сводка поиска по PDF, а не страница, разобранная постранично).
- Промежуточные типы: исходные столбцы сначала нормализуются в `MidType`/единую промежуточную модель, затем отображаются на целевые столбцы, что исключает попарное преобразование между девятью базами; [official documentation confirmed] [AWS DMS built-in data types](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Reference.DataTypes.html) и [Airbyte supported data types](https://docs.airbyte.com/platform/understanding-airbyte/supported-data-types) обе используют встроенные/общие системы типов; вывод о сложности N×N→2N — [project inference].
- Структура следует за переносом: создание таблиц на целевой стороне происходит в `createTable` из `kinds/*` (DDL семейства Oracle/DM неявно коммитится, требуя `autoCommit: true`).
- Курсор: `TransferCursor` поддерживает `keyset` и `range` (параллелизм шардов, верхняя граница всегда открытый интервал); если источник не реализует разбиение по `keyAt`, слой оркестрации откатывается к цепочке keyset.
- Контракт конверта Redis: Redis участвует в урезанной форме через фиксированную таблицу `__redis_keys` с шестью столбцами `key`/`type`/`ttl_ms`/`encoding`/`payload`/`dump`; `ttl_ms` равен 0 при отсутствии срока жизни (PTTL `-1` становится `0n`, PTTL `-2` означает, что ключ исчез в момент чтения, и ключ пропускается, а положительное значение используется как есть в миллисекундах), `encoding` — диагностическое значение кодировки в памяти из `OBJECT ENCODING` (например raw/hashtable/listpack/quicklist, не связано с сериализацией столбца `payload`), `payload` сплющивается по `type` и всегда является строкой JSON в UTF-8, а `dump` — только байты [DUMP](https://redis.io/docs/latest/commands/dump/), восстанавливаемые через [RESTORE](https://redis.io/docs/latest/commands/restore/) на однородном Redis. Сторона источника итерирует курсор [SCAN](https://redis.io/docs/latest/commands/scan/) от 0 до 0, а [TTL](https://redis.io/docs/latest/commands/ttl/)/PTTL получают оставшееся время по каждому ключу; [official documentation confirmed] [Redis data types](https://redis.io/docs/latest/develop/data-types/) утверждает, что Redis — сервер структур данных, отсюда [project inference]: Redis нельзя рассматривать как перенос таблица-в-таблицу без потерь, явно исключая группы потребителей stream, `DUMP` между версиями и логические базы `dbN`.
- Параллелизм: на уровне таблиц каждая таблица получает независимое подключение для чтения и записи; параллелизм шардов внутри таблицы зависит от `keyAt` источника; глобальный предел задач — `MAX_TRANSFER_TASKS = 8`.
- Проверка ширины строки: проверяйте число столбцов построчно перед записью (ошибка `row width mismatch`), не пропускайте её.
- История: `TransferLog` пишет `<My Documents>/DSH/transfer-log.jsonl`, читается через `GET /api/transfer-history`; очистка идёт через `/api/transfer-history/clear`.
- Связанные тесты: `tests/adapters-sql/transfer-*.test.ts` (locate/mapping/oralike/sqlite/sqlserver/stress/task) плюс случаи эквивалентности чтения и записи конверта Redis.
- Запуск переноса: получите подключения источника и цели из `/api/connections` (пароли хранятся зашифрованными, межмашинный перенос идёт через интерфейсы экспорта и импорта, не собирайте строки подключения вручную) → `POST /api/transfer/start`; перед запуском перескажите пользователю базу-источник, базу-цель, задействованные таблицы и используется ли параллелизм.
- Проверка переноса (задача завершена только когда всё проходит): ① число таблиц источника и цели совпадает; ② выборочная проверка по первичному ключу и сравнение поле за полем (следите за различиями точности, часового пояса и отображения бинарных данных); ③ через `describeTable` проверьте, согласованно ли перенесены имена и типы столбцов, допустимость null и значения по умолчанию. При неудаче сообщите детали различий (таблица, строка, поле, ожидаемое и фактическое значение), не повторяйте перенос молча.

## Планирование перед изменениями

1. Определите тип: новая функция (решите, какой слой расширять: http → manager → adapters/store) / исправление (сначала воспроизведите симптом, дайте гипотезу корневой причины и метод проверки) / рефакторинг (обязуйтесь не менять поведение, перечислите проверку эквивалентности) / связанное с переносом (дополнительно проверьте границы на стороне чтения источника и на стороне записи цели).
2. Локализуйте: если в корне репозитория есть `.codegraph/`, используйте `codegraph explore "<символ или проблема>"` плюс `node`/`callers`/`callees`/`impact` и не грепайте всё дерево; иначе локализуйте по пути модуля, а найдя символ, перечислите **всех вызывающих**.
3. Результат: корневая причина или точка изменения → список затронутых поверхностей (конкретные файлы, какие поведения меняются / какие обязательства остаются неизменными) → стратегия тестов (сначала напишите падающий воспроизводящий случай, покрывая happy path + границы/null/исключения, и назовите файл vitest для запуска) → риски и минимальный способ отката.
4. Меняйте код только после того, как план подтверждён пользователем.

## Сборка и релиз

### Сборка: пропустите этот шаг — и тесты покраснеют как «проблемы окружения»

```bash
npm ci
npm run build      # сначала должны быть сгенерированы vendor/*.cjs
npm run typecheck
npm test
```

`npm run build` = `tsc -p tsconfig.build.json` (с выводом в `dist/`) → копирование `lib/script/worker.cjs` в `dist/script/` → `build-mongodb.mjs` → `build-sqlserver.mjs` → `build-codemirror.mjs` (esbuild, секунды, полная пересборка каждый раз, без идемпотентного пропуска, чтобы избежать «исходник обновлён, артефакт устарел»).

`vendor/` игнорируется `.gitignore`, но несколько групп тестов напрямую зависят от артефактов; при их отсутствии тесты падают как «неверный формат / отсутствующий модуль», **маскируя настоящие регрессии**:

| Артефакт | Кто от него зависит | Поведение при отсутствии |
| --- | --- | --- |
| `vendor/mongodb-driver.cjs` | `vendorOrNull()` адаптера mongodb загружает его отказоустойчиво (деградирует при отсутствии, без исключения), но `bson` внутри бандла — источник проверок `instanceof` | `ObjectId`/`Decimal128`/`Binary`/`Long`/`Timestamp` попадают в ветку простых объектов и JSON-сериализуются, а `normalizeMongoCell` вместе с восстановлением Extended JSON проваливают в сумме 5 утверждений с «неверным форматом» |
| `vendor/sqlserver-driver.cjs` | И адаптер, и `tests/adapters-sql/sqlserver*.test.ts` идут через `require('../../vendor/sqlserver-driver.cjs')` | Весь файл `sqlserver-driver-real.test.ts` не загружается; падают 3 случая `multi-instance-contract` + 1 случай `sqlserver-offline` |
| `vendor/codemirror-sql.cjs` | Клиент требует `../vendor/codemirror-sql.cjs` во время исполнения; `tests/client/console-tools.spec.ts` проверяет, что артефакт содержит подключение sqlserver | Утверждения о подключении диалектов во фронтенде падают (сам клиент деградирует до textarea, но утверждение теста красное) |

Измеренное сравнение (та же машина, тот же коммит):

| Состояние | Результат |
| --- | --- |
| Без сборки vendor | падают 6 файлов, **13 failed** / 1029 passed |
| После `npm run build` | падают 2 файла, **4 failed** / 1061 passed |
| После сборки + `core.autocrlf=false` | падает 1 файл, **1 failed** / 1064 passed (остался только случай с DNS-перехватом) |

Недостающие 10 — все ложные падения из-за отсутствующих артефактов. Учтите, что без сборки 1 случай с DNS фактически «исчезает» — файл, в котором он лежит, не загружается целиком и никогда не выполняется; так что «меньше падений» может быть худшим сигналом.

Зачем нужны два бандла (обязательно прочитать перед изменением скриптов сборки): когда хост DSH `@deepseek-ai/dsh-app-boot` (≤ 0.1.7-rc.2) загружает плагин, он вызывает `require.resolve.paths(name)` для каждого пакета в дереве зависимостей, не проверяя возврат `null`, поэтому ядровые модули с одноимёнными пакетами (`punycode`/`buffer`/`events`/`process`/`string_decoder`) приводят к тому, что плагин целиком не загружается. После объединения в бандл эти пакеты встроены и больше не появляются в дереве производственных зависимостей. Поэтому **`mssql` может быть только devDependency**, и точно так же `mongodb`. В `build-mongodb.mjs` `bson` намеренно вынесен во внешние: чтобы сохранить тот же экземпляр модуля, что и у `require('bson')` во время исполнения (совместимость `instanceof`); в `build-sqlserver.mjs` `@azure/*` **не должен** быть внешним (`tedious/lib/connection.js` имеет статический require в начале, и отсутствующий модуль — это прямой `MODULE_NOT_FOUND`).

### Релиз: три номера версии должны совпадать

```bash
# смена версии: синхронизируйте три места
#   package.json                                   "version"
#   package-lock.json                              "version"
#   package-lock.json  packages[""].version
npm ci          # при расхождении сразу падает с EUSAGE, и CI ломается на первом шаге
```

Механизм `publish.yml`: пуш в `master` → сравнение версии из `package.json` с `npm view dsh-db-tool version` → **если они идентичны, пропустить целиком**, и только при различии выполняется `npm install` → `npm run build` → `npm test` → `npm publish --provenance` → автоматическая простановка тега `v<version>` (простановка пропускается, если тег с тем же именем уже существует на удалённом репозитории). Так что «выпустить релиз» означает изменить номер версии + влить в `master`, без ручной публикации.

Публикуемое содержимое определяется белым списком `files` в `package.json`: `dist`, `client`, `skills`, `patches`, `scripts`, **три артефакта vendor, перечисленных по одному**, `cordis.patch.yml`, плюс `LICENSE`/`README.md`/`README_EN.md`/`CHANGELOG.md`. `prepack` автоматически запускает `npm run build`; проверяйте публикуемое содержимое локально так:

```bash
npm pack --dry-run
```

### Версия Node

`engines.node` — `>=22`, матрица CI — `[22, 24]`. **Node 20 не может это запустить**: `tedious` 20.x и его транзитивные зависимости `@azure/*` требуют `>=22` в engines, а под Node 20 подключение сообщает `Promise.withResolvers is not a function` — более того, эта TypeError **перекрывает настоящую ошибку TLS/сети**, уводя диагностику в совершенно неверном направлении. Не пытайтесь обеспечить совместимость с 20.

### Патчи хотфиксов хоста

`patches/` исправляет дефект возврата null в `resolve.paths` у `dsh-app-boot`, в двух однотипных местах: `routeScoped()` и `nativePackageDir()`. `scripts/hotfix-core.mjs` содержит как встроенные блоки замены, так и таблицу выбора файла патча:

| Версия хоста | Файл патча |
| --- | --- |
| `0.1.7-rc.2` | `dsh-app-boot-route-scoped-hotfix.patch` |
| `0.2.0-rc.1` | `...-0.2.0-rc.1.patch` |
| `0.2.0-rc.2` | `...-0.2.0-rc.2.patch` |
| `0.2.1-rc.3` | `...-0.2.1-rc.3.patch` |

Опорные строки всех четырёх версий **побайтово идентичны**, различаются только общие смещения номеров строк (у npd и routeScoped смещения разные), поэтому путь встроенной замены не зависит от версии; только путь `git apply` требует файла, выбранного по версии. При изменении патча обновляйте три места синхронно: заголовок hunk в `.patch`, `ORIGINAL_LINE`/`ORIGINAL_NPD_BLOCK`/`PATCH_BY_VERSION` в `hotfix-core.mjs` и соответствующий контрактный блок в `tests/scripts/hotfix.spec.ts`. Версии вне списка по умолчанию дают код выхода 2, а `--force` позволяет это обойти. Использование:

```bash
npm run patch:dsh          # Windows (PowerShell)
npm run patch:dsh:sh       # bash
node scripts/hotfix-core.mjs --dry-run   # только показать, что изменится
```

## Подводные камни разработки

### Переводы строк должны быть LF (иначе 3 контрактных случая гарантированно красные)

`.gitattributes` принудительно задаёт `* text=auto eol=lf`. Причина: `tests/scripts/hotfix.spec.ts` сравнивает строки `+` из `patches/*.patch` со встроенным блоком `scripts/hotfix-core.mjs` **побайтово** и требует, чтобы результат `git apply` был побайтово идентичен результату встроенной замены. При умолчании Windows `core.autocrlf=true` `git apply` выдаёт CRLF, а встроенный блок — LF → три случая `patch applies cleanly to the pristine upstream ... via git apply` гарантированно красные (`gitApplyContract` в `hotfix.spec.ts`, около строки 383). Сами файлы патчей тоже должны быть LF, иначе их применение на Linux/CI привнесёт CR в целевой файл.

Локальная проверка и временный обход:

```bash
git config --get core.autocrlf                       # true означает, что вы в ловушке
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf \
  GIT_CONFIG_VALUE_0=false npx vitest run tests/scripts/hotfix.spec.ts
# измерено: autocrlf=true → 3 красных; команда выше → 32 все проходят
```

Правильное исправление — перевыполнить checkout согласно `.gitattributes`, а не обходить его переменными окружения надолго.

### Раскладка pnpm ≠ плоская раскладка npm в CI

В этом репозитории используется npm (`package-lock.json`, `pnpm-lock.yaml` в .gitignore). Если локальный `node_modules` установлен через pnpm, строгая изоляция делает транзитивные пакеты, которые **тесты `require` напрямую, но которые не объявлены прямыми зависимостями**, неразрешимыми на верхнем уровне. Три известных случая: `tedious`, `pg-connection-string`, `semver` (`semver` уже есть в devDependencies, но старая установка pnpm могла его ещё не слинковать).

```bash
node -e "for (const p of ['tedious','pg-connection-string','semver']) { try { require.resolve(p); console.log(p,'OK') } catch { console.log(p,'MISSING') } }"
```

Если проверка сообщает `MISSING`, перед выводами переустановите в раскладке npm; такие падения не воспроизводятся в CI, **не меняйте код из-за них**.

### Локальный перехват DNS

Случай «сбой разрешения имени хоста» (около строки 612) в `tests/adapters-sql/sqlserver-driver-real.test.ts` подключается к `no-such-host.invalid` и ожидает `ENOTFOUND`. Если локальная машина перехватывает `.invalid` на реальный IP (измерено: разрешается в `198.18.0.x` и реально подключается), этот случай гарантированно красный, тогда как CI в норме. Как определить:

```bash
node -e "require('node:dns').lookup('host.invalid',(e,a)=>console.log(e?e.code:a))"
# возвращает IP = перехват; возвращает ENOTFOUND = окружение в норме
```

## Дисциплина проверки

- При исправлении ошибки сначала напишите падающий воспроизводящий тест, затем найдите корневую причину и исправьте её в одном месте внутри общей функции; попутный рефакторинг несвязанного кода запрещён.
- Запускайте только относящиеся к делу тесты: `npx vitest run tests/adapters-sql/<relevant>.test.ts`; при изменении HTTP-маршрутов дополнительно `tests/http/api.spec.ts`, при изменении guard — `tests/guard/classify.spec.ts` + `challenge.spec.ts`, при изменении store — `tests/store/<relevant>.spec.ts`, при изменении фронтенда — `tests/client/<relevant>.spec.ts`.
- Полный базовый прогон (после `npm run build`, локально pnpm + Windows): 67 тестовых файлов, 1269 случаев, **1200 passed / 0 failed / 69 skipped** (измерено 2026-11-05, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false npx vitest run`). Исторически появлялись 4 известных падения = 3 из-за переводов строк (`.gitattributes` не действует; добавление `core.autocrlf=false` делает их все зелёными) + 1 перехват DNS (`host.invalid` разрешается в `198.18.0.x`); последнее может пройти само по мере изменения локального состояния DNS, **это не исправление кода, и нельзя выдавать это за исчезновение регрессии**; проверяйте через `node -e "require('node:dns').lookup('host.invalid',(e,a)=>console.log(e?e.code:a))"`, возврат IP означает перехват, а возврат `ENOTFOUND` — норму. Приёмка идёт по «сравнению набора падений», а не по абсолютным числам.
- Мутационное тестирование: `npx stryker run`, покрывает только `lib/index.ts` и `lib/http/index.ts`; выжившие мутанты требуют более сильных случаев. Добавленные маршруты `GET/PUT /api/transfer-config` находятся внутри области мутирования `lib/http/index.ts` и требуют контрактных утверждений маршрутов; новые стороны чтения и записи store/Redis находятся вне области мутирования stryker и требуют ручных эквивалентных мутаций (например, удаления полей сохранения и восстановления, условия завершения курсора, границ TTL, ветви DUMP/RESTORE), чтобы проверить действенность случаев.
- Комментарии и сообщения коммитов — на упрощённом китайском; формат коммита — `type(scope): description`, типы: new/fix/docs/refactor/test/perf/misc.
- Окружение Windows: запуск npm без оболочки требует `npm.cmd`.
