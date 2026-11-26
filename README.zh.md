# dsh-db-tool-ru

[Русский](README.md) | [English](README_EN.md) | 简体中文

本仓库是 [dsh-db-tool](https://github.com/mengqi1436/dsh-db-tool)（作者 mengqi1436）的 fork：在原有能力之上新增了两项能力——授权内按数据库收窄的允许清单，以及俄语界面本地化；上游版权与 Apache-2.0 许可一并保留。本 fork 仅通过 GitHub 分发，不发布到 npm；仓库地址为 [steelunicorn/dsh-db-tool-ru](https://github.com/steelunicorn/dsh-db-tool-ru)。

DSH 宿主插件。在聊天中安全地操作数据库：九种数据库、项目级细粒度授权、危险操作确认、全量审计，配套右侧栏管理台与 SQL 控制台。

## 功能流程

一次数据库操作从入口到落库审计的完整路径——聊天工具与右侧栏两个入口共用一套语义，中间必须穿过项目级授权与语句级风险分级两道闸门：

![dsh-db-tool 功能流程](assets/feature-flow.png)

[打开交互式版本](assets/feature-flow.html) —— 支持缩放、拖动、路径高亮，可点节点查看源码证据。

> 有问题或建议？[提 Issue](https://github.com/steelunicorn/dsh-db-tool-ru/issues/new/choose)。

---

## 支持的数据库

| 类别 | 数据库 |
| --- | --- |
| 关系型 | MySQL、PostgreSQL、GaussDB、SQLite、Oracle、达梦 DM、SQL Server |
| NoSQL | Redis、MongoDB |

连接、元数据浏览、查询与预览覆盖九种数据库。数据传输按能力分层：八种数据库（MySQL / PostgreSQL / GaussDB / SQLite / MongoDB / Oracle / 达梦 / SQL Server）走原生表级互传，Redis 通过固定 envelope 表 `__redis_keys` 降级参与。Redis 原生键空间保真（stream consumer group、跨版本 `DUMP`、逻辑库 `dbN`）不在支持范围内。

方言差异在适配器内部处理，对上层统一暴露 `?` 占位符与标准结果集。

---

## 核心能力

### 模型工具 `DatabaseManager`

单一工具、多 action，减少模型选工具的歧义：

| action | 作用 |
| --- | --- |
| `list_connections` | 列出可选连接（不含凭据） |
| `query` | 执行只读查询，返回列与行 |
| `execute` | 执行写语句，危险操作需确认 |
| `schema` | 查看库 / 表 / 列结构 |
| `preview` | 预览表数据（分页，每页最多 50 行） |
| `run_script` | 在沙箱中跑脚本，可多次调用 `db.query` / `db.execute` |
| `export_to_file` | 把查询结果写到项目目录内的文件（text / JSON / CSV） |
| `execute_file` | 执行项目目录内文件里的语句（guard、确认与审计同 `execute`） |

`run_script` 的隔离边界：独立子进程 + `node:vm` 沙箱，60 秒超时后进程级强杀，只注入受限的 `db.{query,execute}` 句柄——不提供文件系统、网络与 `require`。若插件配置开启 `scriptFileBridge`，沙箱内多一个 `file.save(路径, 文本)` 方法：写盘由宿主进程按 `export_to_file` 的同一套规则完成，脚本本身依旧拿不到文件系统。

### 文件交换：结果与函数体

`export_to_file` 把查询结果直接写入文件，`execute_file` 从文件读取语句，模型不必把文本重新誊写进上下文，函数体、视图定义与大结果都能逐字节搬过去。

- 路径一律相对项目目录（项目目录同时是授权键）。绝对路径、`..`、盘符、NTFS 数据流、保留设备名（`CON`、`NUL` 等）与符号链接都会被拒绝，读写都无法越出项目目录。
- `format=text` 要求恰好 1 行 × 1 列，值原样写入：不归一化换行、不追加结尾 `\n`。由 `pg_get_functiondef(...)` 得到的文件可直接交给 `execute_file`。
- `format=json` 写出行数组（两空格缩进 + 结尾换行）；`format=csv` 写出列名表头，按 RFC 4180 转义，分隔符 `,`，行尾 CRLF。编码固定 UTF-8、无 BOM。
- 结果为空（0 行，或文本模式下 `NULL`）时报 `EMPTY_RESULT`，除非传 `allow_empty`；文件已存在且没传 `overwrite` 时报 `FILE_EXISTS`；父目录不存在且没传 `create_dirs` 时报 `PARENT_MISSING`。
- 默认上限：读 ≤ 8 MB、写 ≤ 64 MB，扩展名 `.sql`、`.txt`、`.json`、`.csv`、`.tsv`、`.md`、`.log`，均可在插件配置 `fileIo` 中调整。
- `execute_file` 原样传递整个文件内容（不裁剪空格与换行）：危险语句照旧返回 `NEEDS_CONFIRMATION` 与一次性 `challenge_id`，审计记录方向、路径、字节数、`md5` 与文本前 200 个字符。
- `search_path`（可选，PostgreSQL）：函数体里常有不带 schema 的类型与例程（`citext`、`varlist`），而 `pg_get_functiondef` 原样返回文本。传入 `search_path="sys, dbo, public"` 即可让插件在同一批语句里执行 `set_config('search_path', …, true)`，可见性路径只对本次运行生效、不会留在连接池的会话上。该参数不能与 `params` 同时使用（批处理走简单查询协议）。

典型函数体搬运：

```text
export_to_file(conn_id="<源>", sql="select pg_get_functiondef(27896227) as d",
               path="fn/pdt_income_storageobject_t.sql", create_dirs=true)
在编辑器里修改文件
execute_file(conn_id="<目标>", path="fn/pdt_income_storageobject_t.sql")   → commandtag = CREATE FUNCTION
```

### 项目级授权（ro / rw）

授权以「项目路径 → 连接 → 模式」三级存储（`grants.json`）：

- **ro（只读）**：允许查询与浏览，拒绝一切写操作
- **rw（读写）**：允许执行语句、脚本与事务

授权与连接一样以卡片展示：按数据库类型分组的网格，卡片描边与模式徽标同色——灰（无授权）、绿（ro）、红（rw）。颜色与文字同时编码，不用颜色也能辨认模式。

未授权的项目对任何连接一律拒绝。授权模式变更（含 rw → ro 降级）会立即作废旧会话，无需重连。

Windows 下路径按 NTFS 语义归一（大小写不敏感），`E:\GitHub\MyApp` 与 `e:\github\myapp` 视为同一项目。

**库级允许清单**：每条授权可附带 `databases` 字段（面板「项目授权」中的「库范围」），在该连接内收窄可见的库。勾选即保存，没有单独的保存按钮：只有用户主动勾选的库才可访问，刚建立的授权清单为空，未勾选任何库就一个库都不可用。只有在本字段出现之前建立的授权（以及不带清单的程序化授权）才会缺省该字段——这类记录仍表示「全部库」；空数组 `[]` 表示「一个库都不允许」。名称精确匹配、大小写不敏感。面板里是可展开的勾选列表（带按库名过滤的输入框和「全选」「全不选」；过滤只收窄可见列表，「全选」「全不选」作用于可见的库，保存值仍按完整集合计算）。PostgreSQL / GaussDB 的目标写成 `db.schema` 时按 `db` 部分判定；SQLite 不参与校验（其「库」是文件路径）。

允许清单在 `query`、`execute`、`schema`、`preview`、控制台事务会话与数据传输两端都会校验；目标库不在清单内时，在建立到该库的连接之前即拒绝。库列表（`databases`）只返回允许的库，全局表名搜索也只覆盖允许的库。授权面板里的勾选列表例外：它取的是不按清单收窄的库全集（`GET /api/grant-databases`），否则收窄之后连未授权的库都看不到，也就无法再放开。

### 危险操作确认

DDL、`FLUSHALL`、`dropDatabase` 等语句先返回 `NEEDS_CONFIRMATION`，不会直接执行：

1. 首次调用返回待确认状态与一次性 `challengeId`
2. `challengeId` 绑定语句的 SHA256，5 分钟内有效、用后即废
3. 用户确认后携同一 `challengeId` 重试才真正执行

聊天工具侧经对话确认，SQL 控制台侧经弹窗确认——两条路径共用同一套语义，任一处都无法绕过。

### 全量审计

每次执行（包括被拒绝的请求）都追加一行到 `audit.jsonl`：语句、危险级别、是否经过确认、结果与耗时。右侧栏可实时查看。

### 数据浏览

- 连接 → 库 → schema → 表四级树形展开
- 树中只出现当前账号可用的对象：PostgreSQL / GaussDB 隐藏无 `CONNECT` 的库、无 `USAGE` 或没有任何可 `SELECT` 表的 schema；SQL Server 隐藏无 `HAS_DBACCESS` 的库与无 `SELECT` 的 schema / 对象。项目授权仍是第二道独立限制
- 库筛选 + 跨库表名模糊搜索（MySQL / PostgreSQL / GaussDB 走 `information_schema` 原生查询，其余库回退内存过滤）
- 表 / 视图结构查看与数据预览（Oracle 与达梦表、视图合并列出；MongoDB 视图结构页不读索引），结果网格支持排序、分页、单元格复制
- Navicat 式分页器：按页码直接跳转、「首页」/「末页」按钮，页码旁显示表的全量行数
- 按值查找：表格上方不再有独立搜索框，改用逐字段筛选（包含 / 区间 / 列表），同一谓词下发到服务端并计入行数（Redis 除外）
- Navicat 式字段筛选：每个字段可设置条件（包含 / 不包含 / 开头是 / 结尾是 / 为空 / 非空 / 空串 / 区间 / 列表及其否定），多字段条件按「且」或「或」组合；筛选在服务端完成，分页与行数均按筛选后的结果计算。筛选窗格中每行都有启用复选框（未启用的行保留但不参与查询），行与行之间可单独选择「且」/「或」，因此可以表达「A 且 B 或 C」这类条件

### SQL 控制台

Navicat 风格的右侧栏多标签编辑器（CodeMirror 6）：

- **多标签**：每标签独立保存 SQL、结果与历史（50 条上限，点击回填）
- **语法高亮与补全**：按方言自动切换（MySQL / PostgreSQL / SQLite / PL-SQL / T-SQL），表列元数据注入补全
- **快捷键**：`Ctrl/Cmd+Enter` 执行全部，`Ctrl/Cmd+Shift+Enter` 执行选中
- **格式化**：按方言调用 sql-formatter，解析失败回退原文
- **逐条执行**：客户端预分类读写语句，分别路由到查询与执行通道；ro 授权下写语句自动跳过并标注
- **批分隔符 `GO`**：支持 `GO` 与 `GO n`（sqlcmd 语义，`GO 0` / `GO 1` 均等同 1 次），重复上限 1000 次防放大
- **事务**：rw 授权下可开始 / 提交 / 回滚，服务端粘性连接；空闲 5 分钟自动回滚并审计
- **结果网格**：三态排序、每页 50 行、CSV / JSON 导出

### 数据传输

同类或跨类数据库之间的表数据搬运：

- **写入模式**：`insert`（追加）、`ignore`（跳过冲突）、`replace`（覆盖）、`truncate`（先清空）
- **自动建表**：目标表不存在时按源表结构生成 DDL
- **依赖顺序**：目标端已有外键关系时自动排序——删除/清空先处理子表、装载先处理父表；互为引用的表组按各库官方机制整组删除（装载顺序不保证，外键冲突如实报错）；被未选中表引用时覆盖删除提前失败并给出明确提示
- **结构随迁**：源端的二级索引（含唯一索引）、外键约束（含参照动作）、自增列随数据一同迁移；索引在全部数据装载后创建，外键在所有表数据齐备后创建；重复传输按名称去重；Oracle 与达梦的自增暂不随迁
- **分页读取**：有序游标（keyset）/ 范围 / 偏移三种策略
- **进度与历史**：实时进度推送 + 按项目隔离的传输历史
- **传输配置**：按项目保存，自动保存、重启后回填、失效连接自动清空
- **中间类型模型**：异构列先归一化到统一中间类型再映射目标列，避免九库点对点转换
- **两端授权校验**：源与目标分别校验连接授权及其库级允许清单
- **Redis envelope 降级**：Redis 以固定表 `__redis_keys` 参与，六列语义如下

| 列 | 语义 |
| --- | --- |
| `key` | 键名 |
| `type` | string / hash / list / set / zset / stream 等 |
| `ttl_ms` | 剩余 TTL 毫秒，无过期为 0 |
| `encoding` | `OBJECT ENCODING` 内存编码诊断值，与 `payload` 的序列化无关 |
| `payload` | 按类型展平的值，恒为 UTF-8 JSON 字符串 |
| `dump` | `DUMP` 的 RDB 序列化字节，仅同构 Redis 经 `RESTORE` 恢复用 |

### 连接导出 / 导入

一键把所有连接（含密码）导出为口令加密文件，用于跨机器迁移：

- scrypt 派生密钥 + AES-256-GCM 整体加密，文件打开无明文
- 口令最短 8 位，由服务端强制校验
- 导入时已存在的连接 id 一律跳过不覆盖，返回「已导入 / 跳过 / 失败」摘要

---

## 右侧栏

通过 DSH 官方右侧栏（`@deepseek-ai/dsh-client-ui-sidebar-right`）注册一个页签，不依赖任何第三方侧边栏。页签内含五个面板（中、英、俄三套词典，跟随宿主语言）：

| 面板 | 用途 |
| --- | --- |
| 连接管理 | 新增 / 编辑 / 删除连接，测试连通性，导出导入 |
| 项目授权 | 为当前项目勾选各连接的 ro / rw，并维护授权内的库级允许清单 |
| 数据浏览 | 树形浏览库表、搜索、预览数据 |
| SQL 控制台 | 多标签编辑器、事务、历史、结果网格 |
| 数据传输 | 库表级数据迁移，批量 / 并行与写入模式可选，附传输日志 |

服务端错误消息为英文，界面原样显示，不做翻译。

### 使用须知

两条都是官方右侧栏的契约行为，容易误判为插件缺陷：

- **未选择会话时，右侧栏不显示数据库面板。** 官方右侧栏的布局状态按会话 id 键控，没有会话就没有停靠面，也就没有入口卡片与页签——先选一个会话再展开右侧栏。
- **若当前 DSH 就绪的入口卡片只有一个，「+」新建格会直接打开数据库页签而不是引导页。** 这是官方默认页规则，不是跳过引导页的异常。

---

## 安全模型

| 层次 | 机制 |
| --- | --- |
| 存储 | 密码与完整 URL 存 `secrets.json`（0600），永不返回给模型，返回给界面的连接信息密码一律脱敏为 `***` |
| 授权 | 项目级 ro / rw 白名单，可在授权内附带库级允许清单；未授权即拒绝 |
| 语句级 | 风险分级（danger / warning / none）+ 一次性确认 |
| 只读强制 | MySQL / PostgreSQL 走会话级 `SET TRANSACTION READ ONLY`；SQL Server 退化为应用层五道闸门 |
| 传输加密 | 默认优先明文建连，仅当服务器强制加密时升级；详见「传输加密」 |
| 错误脱敏 | 连接串解析失败时，错误文案中的 userinfo 已脱敏，不回显明文密码 |
| 脚本隔离 | 独立子进程 + vm 沙箱 + 60 秒强杀 + 仅注入 db 句柄 |

**库级允许清单是又一道闸门，顺序在项目授权与只读校验之后**：ro 授权上的写操作仍以只读拒绝，而不是「库未授权」；清单未命中时不会建立到该库的连接。

**SQL Server 的 ro 强度弱于 MySQL / PostgreSQL**：SQL Server 没有等价的会话级只读语句，ro 授权下由应用层五道拦截兜底——首词白名单、拒绝多语句、拒绝 `SELECT ... INTO`、拒绝 `WITH ... (INSERT|UPDATE|DELETE|MERGE)`、拒绝 `OPENQUERY` / `OPENROWSET` / `OPENDATASOURCE`。这仍是应用层拦截，需要数据库侧强隔离时请为连接配置只读账号。

### 传输加密

**默认可连即可，不强制加密。** SQL Server 默认 `encrypt=auto`：先不带加密建连；仅当服务器**强制加密**时报错，才升级到加密并信任其证书重试一次——只重试一次，只针对这一种原因，显式写 `encrypt` 时不重试。达梦同理：仅当服务器协商了本机 OpenSSL 已移除的加密算法（`[6071]`）时，才关闭通信加密重试一次。

**明文是这条策略的代价**：SQL Server 的 `auto` / `encrypt=false` 与达梦的 `loginEncrypt=false` 都会以明文传输账号密码与查询结果。可信内网无妨；跨公网或不可信网段请显式要求加密，并解决随之而来的证书或算法问题。

---

## 安装

**运行环境**：Node.js ≥ 22（部分数据库驱动要求）；DSH 宿主需提供官方右侧栏。

```bash
# 从 GitHub 安装（唯一分发渠道）
dsh plugin --profile desktop add "github:steelunicorn/dsh-db-tool-ru"

# 本地开发
dsh plugin --profile desktop add "link:D:\Projects\dsh-db-tool"
```

桌面端若 `dsh` 命令不在 PATH：打开菜单栏点 **Manage dsh command** 注册。安装完成后重启 DSH 桌面端加载插件。

**不要在同一 profile 中同时启用上游插件**：两者注册同一个工具名 `DatabaseManager`，并共用同一个数据目录（`<我的文档>/DSH/db-tool`），因此连接与授权是共享的，但工具会被注册两次——先移除或禁用上游插件，再安装本包。

**替换时数据保留**：连接、授权与审计仍位于原来的 `<我的文档>/DSH/db-tool/` 目录，用本 fork 替换上游插件后无需重新配置。

**关于 oracledb**：其安装脚本会被 pnpm 默认拦截，首次安装会报告失败。在 DSH 插件安装界面点 **Allow these scripts and retry** 即可完成——该脚本仅做 Node 版本检查与横幅打印，批准会持久化到 profile。

**前端挂载位置**：数据库面板挂在 DSH 自带的右侧栏上，不需要额外安装任何侧边栏插件；`dsh.client.inject` 已声明 `@deepseek-ai/dsh-client-ui-sidebar-right` 作为加载前置。

---

## 数据存放

`<我的文档>/DSH/db-tool/`（目录权限 0700；与传输日志同根，用户可直接打开查看）：

| 文件 | 内容 |
| --- | --- |
| `connections.json` | 连接定义（`urlSafe` 中密码脱敏为 `***`） |
| `secrets.json` | 0600，密码与完整 URL，永不返回给模型 |
| `grants.json` | 项目授权（归一化路径 → connId → ro / rw，可附带库级允许清单） |
| `transfer-config.json` | 0600，数据传输页按项目的连接与选项配置 |
| `audit.jsonl` | 追加式审计日志，每行一条 JSON |

同级还有 `transfer-log.jsonl`（传输过程日志与历史）。路径解析优先级：显式注入（测试）> `DSH_DB_TOOL_DIR` > `<我的文档>/DSH`。「我的文档」在 Windows 下由 Shell API 解析，自动跟随重定向（OneDrive 等）；非 Windows 走 `XDG_DOCUMENTS_DIR` 或 `~/Documents`。旧版本存放于 `$DSH_HOME/db-tool/` 的数据在首次启动时按文件粒度迁移（目标已存在则跳过，旧文件保留不删）。

---

## 开发

```bash
npm ci
npm run build        # 编译 + 生成 vendor bundle（mongodb / sqlserver / codemirror）
npm test             # vitest 全量
npm run typecheck    # tsc --noEmit
```

真机冒烟测试由环境变量门控，设置了才运行：

```
DBT_TEST_MYSQL_URL / DBT_TEST_PG_URL / DBT_TEST_REDIS_URL / DBT_TEST_DM_CONNECT
DBT_TEST_MONGO_URL / DBT_TEST_ORACLE_CONNECT / DBT_TEST_SQLSERVER_URL
```

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：Node 22 与 24 两档，跑 `npm ci → build → typecheck → test`。

### 目录结构

```
lib/          插件主体
  adapters/   9 种数据库适配器 + 传输实现
  store/      连接/授权/审计/密钥存储
  guard/      语句风险分级
  manager.ts  业务编排（授权、分派、确认、审计）
  http/       右侧栏 HTTP 路由
  script/     run_script 沙箱与子进程
client/       右侧栏单文件产物
skills/       db-admin skill（SKILL.md 英文、SKILL.ru.md 俄文、SKILL.zh.md 中文）
scripts/      构建与工具脚本
patches/      DSH 宿主热修复补丁
tests/        vitest（离线 mock + 真机门控）
assets/       功能流程图
vendor/       驱动与编辑器 bundle（构建产物，发布时收录）
```

---

## 贡献者

感谢所有把修复真正推进到 `master` 的外部贡献者，逐条记录见 [CONTRIBUTORS.md](CONTRIBUTORS.md)：

- [a19920714liou](https://github.com/a19920714liou) — [PR #1](https://github.com/mengqi1436/dsh-db-tool/pull/1)：ro 连接钩子卡死 + Windows 路径大小写授权错位
- [weicy98](https://github.com/weicy98) — [PR #12](https://github.com/mengqi1436/dsh-db-tool/pull/12)：达梦 DM 通信加密为 DES_CFB 时的连接失败
- 上游作者：[mengqi1436](https://github.com/mengqi1436) — [dsh-db-tool](https://github.com/mengqi1436/dsh-db-tool)
- 俄语本地化 fork：[steelunicorn/dsh-db-tool-ru](https://github.com/steelunicorn/dsh-db-tool-ru) — [issues](https://github.com/steelunicorn/dsh-db-tool-ru/issues)

欢迎提交缺陷修复与适配器支持，提交约定见 [CONTRIBUTORS.md](CONTRIBUTORS.md#贡献方式)。

---

## 许可证

[Apache License 2.0](LICENSE) © 2026 mengqi1436

可自由商用、修改、分发与再许可，需保留版权与许可声明，修改过的文件需标注改动；附带的专利授权不可撤回，但对本作品发起专利诉讼时终止。

本 fork 以同一许可分发；上游项目见 [mengqi1436/dsh-db-tool](https://github.com/mengqi1436/dsh-db-tool)。
