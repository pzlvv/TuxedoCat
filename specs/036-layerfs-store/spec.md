---
status: 已收敛
---

# 改动规格：LayerFS 内核库 · 对象库地基（上游对齐版）

本仓库引入 LayerFS 语义的 Rust 内核库，按系列 spec 分层落地。本 spec 是第一份，
对应上游（[Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs)）的
C1 对象身份/封装/CDC 与 C2 存储/保存/读取、加上持久化适配器：**对象身份、`LFSO` 封装、
冻结 CDC 分块与上游逐字节兼容**；写入是 `Save` 会话 + `finish()` 确认，读取是
`Reader` 批量认证读；并发遵循上游「单全局库、单写者、短持有」模型——进程内 FIFO
准入 + Linux 父目录 flock、`busy_timeout=0`、一次 SQL 尝试、绝不重试。文件语义
（映射树与文件系统）与 Branch / Commit / 合并由系列后续 spec 承接（见「非目标」）。
本 spec 的落点在 core-rs（Rust 侧库层），不触及任何 TS 侧代码、事件或契约面。

## 上游对齐口径

- **版本锚点**：以上游 **v1.1.0**（commit `9f97a7ec95b662e9cb288704afa165feff132cfa`，
  2026-10-24）为唯一对照基线；本地参考克隆 `../layerfs` 固定在该 tag。逐字节兼容项
  （身份、封装、CDC、profile_id）的测试向量一律取自该锚点，不随上游前进。
- **逐字节兼容**（与上游一致实现）：`ObjectId = BLAKE3("layerfs/object/v2\0" ‖ 规范字节)`、
  `LFSO` 封装帧、冻结 GEAR CDC profile（8/16/32 KiB、掩码、种子、零游程特例）及其
  `profile_id`。同一字节内容在本库与上游产出相同的对象身份与分块边界。
- **持久化 profile**：只实现 `Disposable`（WAL / `synchronous=OFF`，身份串
  `sqlite-wal-off-v2`）——与上游所有者决策一致（`Durable` 已在上游停用，未经所有者
  重新授权不得执行）；持久化适配器行为（FIFO 准入、父目录 flock、一次 SQL 尝试、
  PRAGMA 清单、schema 校验、seal 交付）对照上游同代实现。
- **有意分叉**：Store 文件本身不与上游互开——schema 版本号独立（本系列从 1 起）、
  表组只含对象层所需；上游每个入口携带的遥测作用域参数不引入（本仓库无该遥测框架，
  以计数器代替）。
- **后置**：zstd 压缩、PREFIX delta、pack 分组编码、池化元数据、文件映射树、history
  由后续 spec 承接；本 spec 的物理布局与端口形状为其预留（见「非目标」的去向）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md#11-core-侧业务范围) | 1.1 Core 侧业务范围 | 新增 | Core 新增 layerfs 内核库能力面（对象库） |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md#33-构建与目标平台) | 3.3 构建与目标平台 | 新增 | bundled SQLite 的 C 编译沿用既有 zig / MSVC 链 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md#7-事实归属) | 7 事实归属 | 新增 | Store 内对象数据的事实归属与唯一写入点 |
| [docs/core/layerfs.md](../../docs/core/layerfs.md) | 全文 | 新增 | 内核库独立成篇：范围与上游对齐、身份与封装、冻结 CDC 与策略、存储与端口、适配器与并发车道、限制 |
| [docs/README.md](../../docs/README.md#地图) | 地图 | 修改 | 登记 `docs/core/layerfs.md` |

## 用户场景与验收标准

- 场景 1：创建、打开与 seal
  - **AC-1**（FR-001）：GIVEN 空目录与显式配置 WHEN `create` → `seal` → `open_writable` THEN seal 后路径处只有单个自包含文件且返回字节数，重开成功且 schema 版本与实现同代
  - **AC-2**（FR-001）：GIVEN 一个以更高 schema 版本写成的 Store WHEN `open_writable` THEN 打开失败返回版本错误，且主文件字节不变
  - **AC-3**（FR-001）：GIVEN 一个 journal_mode 非 WAL 的 SQLite 文件 WHEN 打开 THEN 拒开并返回完整性错误
- 场景 2：对象身份、去重与读取
  - **AC-4**（FR-002）：GIVEN 同一封装字节 WHEN 在不同进程分别求身份 THEN 得到相同的 `ObjectId`，且与上游算法一致（同一测试向量）
  - **AC-16**（FR-003）：GIVEN 同一非空内容 WHEN 以冻结 CDC profile 分块 THEN 块大小落在 8 / 16 / 32 KiB 界内，边界位置与上游逐字节一致（同一测试向量）
  - **AC-5**（FR-004）：GIVEN 同一 canonical 内容 WHEN 先后两次经 `Save` 写入 THEN 第二次 `WriteOutcome.reused` 计入且对象在 Store 内只占一份存储
  - **AC-6**（FR-006）：GIVEN 已提交的对象 WHEN `Reader::read_objects` 按 id 序列读取 THEN 按请求顺序逐字节返回，封装校验通过
  - **AC-7**（FR-006）：GIVEN 未提交或不存在的 id WHEN 读取 THEN 返回 `ObjectMissing(id)`
- 场景 3：Save 会话与崩溃一致
  - **AC-8**（FR-005）：GIVEN 一个 `Save` 已发布引用闭包批次后进程被强制终止 WHEN 重开并读取 THEN 已发布批次的对象可读、未发布对象不可见
  - **AC-9**（FR-005）：GIVEN `Save::finish` 返回 `WriteOutcome` WHEN 之后立即读取其中对象 THEN 全部可读（持有返回值即确认）
  - **AC-10**（FR-004）：GIVEN 保存的某对象的直接引用未存储且不在本批次 WHEN 提交 THEN 返回 `MissingDependency` 且该批次无任何效果
- 场景 4：多进程并发
  - **AC-11**（FR-007）：GIVEN 两个进程同时向同一 Store 各自 `begin_save` 写入不同对象 WHEN 双方 `finish` 后读取 THEN 两组对象都完整可读
  - **AC-12**（FR-007）：GIVEN 一个进程持有写事务 WHEN 另一进程进入写车道 THEN 后者排队等待直至前者释放后完成写入（等待无时限）
  - **AC-13**（FR-007）：GIVEN 会话被 `close` WHEN 仍在排队的调用返回 THEN 得到 `Closed`，后续调用同样 `Closed`
- 场景 5：seal 交付与路径
  - **AC-14**（FR-001）：GIVEN 存活的打开会话 WHEN `seal` THEN 消费句柄、TRUNCATE checkpoint 一次、校验无 `-wal` / `-shm` 残留，返回 `SealedStore`（路径 / 字节 / profile）
  - **AC-15**（FR-008）：GIVEN 指向同一位置的两种等价路径写法（冗余分隔符、`.` 段）WHEN 分别打开 THEN 解析为同一 Store，且库对外返回的路径为库内规范化形式

## 功能需求

### FR-001：Store 文件生命周期、profile 与 schema 校验

Store 是**单个自包含 SQLite 文件**：静止态（`seal` 或全部句柄关闭后）只剩主文件，
运行期允许 `-wal` / `-shm` 瞬时侧文件。创建与打开都需显式 `PersistenceConfig`
（路径 + 持久化 profile），无默认值。唯一实现的 profile 是 `Disposable`
（WAL / `synchronous=OFF`，进程崩溃可存活、内核崩溃无保证）——与上游所有者决策一致
（`Durable` 在上游已被停用，未经所有者重新授权不得执行）；打开时逐项实测 PRAGMA
（journal_mode、`synchronous=OFF`、page_size=4096、`busy_timeout=0` 等）不符即拒开。
schema 校验是精确的：`application_id` / `user_version` 必须与实现完全一致、表名单
不得多不少、声明校验（`STRICT`、role 边界）逐条核对；更高或更低的 schema 版本一律
拒绝且不迁移、不修改文件。在已存在路径上 `create` 报错、不覆盖。

### FR-002：对象身份与规范封装

对象身份是域分隔摘要：`ObjectId = BLAKE3("layerfs/object/v2\0" ‖ 规范字节)`，32 字节，
小写 hex 的 `Display` / 解析。规范封装帧为 `LFSO`：magic + 角色 kind + 载荷长度 +
值长度 + 值；单一对象上限 16 MiB、单一值上限 8 MiB，越界拒绝。`ObjectRole` 携带
稳定的持久化 code（1..13 与上游同一张表）；本 spec 只产出并语义校验 `WholeFile`
与 `Chunk` 两个角色，其余 code 保留编码、在引入对应解码器前拒绝解码。
`FinalizedObject` 携带五元组：id、role、canonical 字节、直接引用列表、有界建议
前驱列表（本 spec 恒为空，端口与类型为编码 spec 预留）。

### FR-003：冻结 CDC 分块 profile

内容分块使用与上游逐字节一致的冻结 GEAR CDC profile：下界 8 KiB、目标 16 KiB、
上界 32 KiB、归一化移位与种子固定、连续零游程走重复块特例；profile 自带身份
`profile_id`（BLAKE3），create 时写入 Store、open 时校验一致，不一致拒开。
文件表示由 `ConstructionPolicy` 的整文件阈值（128 KiB–1 MiB、2 的幂）选择：
非空且阈值下 → 单个 `WholeFile` 对象，阈值上 → 冻结 profile 的 `Chunk` 序列
（到文件的映射树是后续 spec 的职责；空文件的 `Empty` 表示形态同样随映射树
spec 引入，本 spec 不产出）。

### FR-004：内容寻址、首次胜出与引用闭包

相同规范字节的对象在 Store 内**只存一份**；重复提交是幂等的（`WriteOutcome` 以
`reused` 计数）。并发提交同一身份按首次胜出裁决：败方的定位行不入库，胜方与败方
字节不一致时报 `Collision(id)`。每个对象的直接引用必须在提交前已存储或同在当前
批次内，否则整批次拒绝（`MissingDependency`）且无任何效果。

### FR-005：Save 会话与确认

写入以 `Save` 会话为单位：`Storage::begin_save()` 开启（每个 `Storage` 句柄同时
只允许一个活动 `Save`，并发生产者各持句柄），`accept(FinalizedObject)` 或经
`SaveSink`（`FinalizedConsumer` 适配）逐对象提交；提交按有界批次走短事务原子发布
（单批次行数 / canonical 字节数有固定上界）。`Save::finish()` 封装并注册剩余输出，
返回 `WriteOutcome` 计数——**持有返回值即确认**，任何其他结果都是类型化错误；
确认未成立时错误带 `UnknownOutcome` 包装（结果未证明，绝不静默假定失败）。
`Save` 被 Drop 而未 finish 即放弃：已发布的引用闭包批次仍然存活，仅作废候选状态。

### FR-006：认证读取

`Storage::reader()` 创建操作级 `Reader`；`Reader::read_objects(ids)` 按请求顺序
批量返回解码后的规范字节，总量与数量有固定窗口上界。读取是认证的：每块字节的
身份必须与 id 一致，不符报 `IdentityMismatch`；缺失只能是 `ObjectMissing(id)`，
持有状态但无法服务的损坏一律报 provider 错误——两类严格分开，不冒充缺失。
`Storage` 与 `Save` 都实现统一的 `AuthenticatedObjects` 读端口（后者还能读到本
会话已接受未 finish 的对象），构造方（后续 spec 的映射树 / 文件系统）只依赖该端口。

### FR-007：单写者并发模型

一个 Store 同一时刻只有一个写者；读者（WAL 快照）不阻塞、不被阻塞。写路径的
准入顺序是：进程内 FIFO 队列（每会话一条，先来先到）→ Linux 上对 Store 父目录的
独占 `flock`（一次阻塞内核等待，绝不另开主 / WAL / SHM 文件描述符）→ 单次
`BEGIN IMMEDIATE` 尝试。**等待无时限**：排队的正确工作等待其轮次，不用 Busy 拒绝
排队者；无时限等待的类型化出口只有会话关闭（`Closed`）与信号中断（`Cancelled`）。
`busy_timeout` 固定为 0、无 busy handler：一次尝试失败即精确报错（`Busy`），绝不
重试、不重放。锁的持有范围是单个原子事务，绝不跨整个 `Save`、构造或发布序列。

### FR-008：平台抽象缝

库对外的路径一律采用库内规范化表示；平台相关操作（父目录 flock、OS 路径互转、
目录确保）收敛在单一抽象层之后，不散落平台分支。本 spec 的目标平台是 Linux；
Windows 侧未来在本层内以锁文件替代目录 flock，其他文件不动。

## 公开 API

内核库分两个 crate：`layerfs`（内容与存储算法，**无任何 I/O**，`forbid(unsafe_code)`）
与 `layerfs-sqlite`（SQLite 持久化适配器，实现端口，唯一触碰文件 / 数据库的层）。
全部入参必填、无 `Option` 参数、无带默认值的构造——策略与路径由调用方显式给出，
库内常量只有冻结 profile 的具名常量（单一来源）。`Result<T>` 是
`Result<T, StoreError>` 简写；内容层错误 `ContentError` 与存储层错误 `StorageError`
按上游口径分列。签名按契约形态书写，实现落点见同目录 plan.md。

### 身份与对象（`layerfs::object`）

| 项 | 形态 | 说明 | FR |
| --- | --- | --- | --- |
| `ObjectId` | `for_bytes(&[u8]) -> ObjectId`、`IdentityStream { update, finish }`、`from_bytes / as_bytes / to_bytes`、`Display`（小写 hex）/ `FromStr` | 域分隔身份；流式增量求身份 | FR-002 |
| `DIGEST_BYTES` / `OBJECT_DOMAIN` | `32` / `b"layerfs/object/v2\0"` | 冻结宽度与域分隔符 | FR-002 |
| `ObjectRole` | 13 变体 + `code() -> u8` / `from_code(u8)` | 稳定持久化 code，与上游同一张表；本 spec 解码仅 `WholeFile` / `Chunk` | FR-002 |
| `FinalizedObject` | `new(role, canonical)`、`with_references(Vec<ObjectId>)`、`id() / role() / canonical() / canonical_len() / references() / predecessors()`、`into_parts() -> ObjectParts` | 五元组；`into_parts` 五件全部移交，不静默丢字段 | FR-002 |
| `FinalizedConsumer` | `accept(&mut self, FinalizedObject) -> ContentResult<()>` | 构造方的有界接收端；`DiscardingConsumer` 为计数实现 | FR-002 / FR-005 |
| `AuthenticatedObjects` | `read_canonical_batch(&self, &[ObjectId]) -> ContentResult<Vec<Vec<u8>>>`（+ 默认单点 `read_canonical`） | 认证读端口：顺序一致、身份不符 `IdentityMismatch`、缺失仅 `MissingObject`、其余 `ProviderFailure` | FR-006 |
| 封装 codec | `OBJECT_MAGIC=b"LFSO"`、`BYTES_KIND=1`、`HEADER_LEN=9`、`canonical_len(value_len)`、`encode_bytes_object(_to)`、`decode_bytes_object(&[u8]) -> &[u8]`（借用） | 规范封装帧；长度 / kind / 尾随字节违规逐项拒绝 | FR-002 |
| 上限常量 | `MAX_CANONICAL_OBJECT_BYTES=16 MiB`、`MAX_OBJECT_FIELD_BYTES=8 MiB` | 单对象 / 单值上限 | FR-002 |
| `AdvisoryPredecessors` | `new / push(id, provenance) / ids()`，上限 4 | 有界建议前驱（编码 spec 的 delta 基候选）；036 中恒为空 | FR-002 |

### 分块与策略（`layerfs::cdc` / `layerfs::policy`）

| 项 | 形态 | 说明 | FR |
| --- | --- | --- | --- |
| `FastCdc` | `new()`、`scan<R: Read, F: FnMut(&[u8]) -> ContentResult<()>>(reader, on_chunk) -> CdcCounters` | 冻结 GEAR 流式扫描，逐块回调 | FR-003 |
| 冻结常量 | `MINIMUM/TARGET/MAXIMUM_CHUNK_BYTES = 8/16/32 KiB`、`NORMALIZATION_SHIFT`、`PROFILE_SEED`、`profile_id() -> [u8; 32]` | profile 身份持久化进 Store 并在 open 校验 | FR-003 |
| `ConstructionPolicy` | `frozen_default()`、`new(threshold, whole_depth, chunk_depth)`、`validated()`、`representation(logical_len) -> Representation`、`capacities()` | 阈值 128 KiB–1 MiB 且 2 的幂；深度 ≤ 50、0 = 禁用 | FR-003 |
| `Representation` | `Empty / WholeFile / Chunked` | 按逻辑长度选择的文件表示 | FR-003 |
| `ConstructionCapacities` | 只读派生字段（各上限的检查算术结果） | 构造前先充电容量，超界在源头拒绝 | FR-003 |

### 存储与端口（`layerfs::storage`）

| 项 | 形态 | 说明 | FR |
| --- | --- | --- | --- |
| `Storage::new(Arc<dyn ObjectPersistence>)` | 从端口对象打开句柄，读出并验证持久化策略 | 不做服务引导、无隐式权威 | FR-001 |
| `StoragePolicy` | `frozen_default()`、`new(profile, threshold, whole_depth, chunk_depth, metadata_depth)`、`validated()`、只读访问器、`construction() -> ConstructionPolicy` | 持久化策略（`store_policy` 单行）；`format_profile=1`，越界 `UnsupportedPolicy` | FR-001 / FR-003 |
| `Storage::policy() / capacities()` | 只读 | 持久化策略与派生容量 | FR-001 |
| `Storage::begin_save() -> Save<'_>` | 每句柄同时一个活动 `Save` | 并发生产者各持句柄 | FR-005 |
| `Storage::reader() -> Reader<'_>` | 操作级读取器 | 见 `read_objects` | FR-006 |
| `Save::accept(FinalizedObject)` / `Save::sink() -> SaveSink` | 逐对象提交；`SaveSink` 实现 `FinalizedConsumer` | 批次上界固定：对象数 512、canonical 512 KiB；事务上界 8 191 行 / 4 MiB−1 | FR-005 |
| `Save::finish(self) -> StorageResult<WriteOutcome>` | 封装并原子注册剩余输出 | **持有 `WriteOutcome` 即确认**；失败含 `UnknownOutcome` 包装 | FR-005 |
| `WriteOutcome` | `inserted / reused / packs / canonical_bytes / stored_bytes` 等计数 | 上游 delta / pool 计数器在编码 spec 引入 | FR-005 |
| `Save::read_objects(&self, ids)` | 读已接受未 finish 或已注册对象 | 构造期间的回读（引用闭包检查的基础） | FR-005 / FR-006 |
| `Reader::read_objects(&self, ids) -> StorageResult<Vec<Vec<u8>>>` | 按序认证读 | 数量 ≤ 4 096、总量 ≤ 32 MiB；越界 `CapacityExceeded` | FR-006 |
| `StorageError` | 判别联合（见下表）；`is_unknown_outcome()` | 存储层唯一错误类型；端口错误按类型映射（`Uncertain` → `UnknownOutcome`，`Closed / Cancelled` 穿透） | — |
| `ObjectPersistence`（端口 trait） | `policy / locate(ids, out) / read_packs(ids, out) / reserve(Reserve) / publish(&Publication) -> Published`，`Send + Sync` | 每方法一次尝试、无恢复循环；`layerfs-sqlite` 是唯一产品实现 | FR-004 / FR-005 |
| `PersistenceError` | `Busy / BackendUnavailable / Missing / Refused { status } / Malformed / Uncertain / Closed / Cancelled` | 端口层类型化结果；`Uncertain` 在存储层折叠为 `UnknownOutcome`，`Closed / Cancelled` 原样穿透 | FR-005 / FR-007 |
| `Publication` / `Published` | `packs: Vec<PublishedPack>`、`objects: Vec<ObjectLocation>`；`Published { lost: Vec<ObjectId> }` | 原子批次载体；`lost` 是首次胜出败方，存储层逐字节比对 | FR-004 |
| `PackInfo` / `PackDomain` / `ObjectLocation` / `LocatedObject` / `Reserve / Reserved` / `ObjectKey`（SHA-256） | 位置与分配载体类型 | 与上游同名同形；`Ordinary/Native/WholeFile/Singleton` lane 在编码 spec 引入 | FR-004 |

### `StorageError` 变体

| 变体 | 触发 | FR |
| --- | --- | --- |
| `Busy` | 写锁或会话被占，任何效果发生之前 | FR-007 |
| `Content(ContentError)` | 构造、封装或读检查失败 | FR-002 |
| `Io(std::io::Error)` | 平台 IO 错误（仅经端口 / 平台层） | FR-008 |
| `ObjectMissing(ObjectId)` | 请求的对象未存储 | FR-006 |
| `Collision(ObjectId)` | 同一身份下字节不一致（首次胜出裁决） | FR-004 |
| `MissingDependency { object, reference }` | 直接引用未存储且不在当前批次 | FR-004 |
| `OwnershipUnavailable` | 另一写者持有写权 | FR-007 |
| `UnsupportedPolicy { field }` | 策略 / profile / 预留窗口未被本实现支持 | FR-001 / FR-003 |
| `Integrity(&'static str)` | 物理帧 / 定位 / 基数不变量失败（含打开期 schema 校验） | FR-001 |
| `CapacityExceeded { what, limit, actual }` | 声明的有界资源被超出 | FR-005 / FR-006 |
| `UnknownOutcome { original }` / `Aborted` | 确认未证明 / 终止性失败后的后续操作 | FR-005 |
| `Closed` / `Cancelled` | 会话已关闭 / 信号中断了跨进程等待 | FR-007 |

### 适配器面（`layerfs_sqlite`）

| 项 | 形态 | 说明 | FR |
| --- | --- | --- | --- |
| `PersistenceConfig` | `sqlite(path, profile)` | 路径 + 显式 profile 都是必填构造参数（无默认值，收敛时由 `sqlite(path)` + `with_profile(..)` 改为必填，留痕）；本地文件、绝无网络端点 | FR-001 |
| `SqlitePersistenceProfile` | 仅 `Disposable`（WAL/OFF，身份串 `sqlite-wal-off-v2`） | 打开时逐项实测校验；`Durable` 不实现（上游已停用，重新授权前不得执行） | FR-001 |
| `Handles::create(config, policy)` / `open_writable(config)` / `open_read_only(config)` | 创建拒已存在；只读会话在任何 BEGIN / SQL 之前拒绝写 | 持有实现端口的 provider（`storage` 字段是 `Arc<StorageProvider>`，可直接作为 `Arc<dyn ObjectPersistence>` 交给 `Storage::new`） | FR-001 |
| `StorePath` | `from_os(&Path) -> Result<StorePath>`、`as_path() -> &Path`、`into_path_buf() -> PathBuf`、`parent_dir() -> PathBuf`、`Display`、`Eq + Hash` | 库内规范化路径；所有接收路径的入口只收它（收敛时 `as_os_path` 改为 `as_path` / `into_path_buf`，留痕） | FR-008 |
| `Handles::close(&self)` | 关闭准入：排队与后续调用一律 `Closed` | FR-007 |
| `Handles::seal(self) -> SealedStore` | 消费唯一会话、TRUNCATE checkpoint 一次、校验无侧文件 | 仍有活引用时报 `Busy`，不做删除猜测 | FR-001 |
| `SealedStore` | `path / profile / sqlite_version / bytes` | 已检查的闭库交付物 | FR-001 |

## 典型用例

以下示意按调用方视角串起 API，`?` 所在函数返回 `Result<_, ContentError>` 或
`Result<_, StorageError>`，省略 `use` 导入；示意块不对应任何源文件。贯穿语义：
**对象库只存对象、不记录归属**——`WholeFile` / `Chunk` 对象的根身份与块序列由
调用方持有（接入映射树后由 037（layerfs-fs） 负责），Store 不知道
「哪些对象属于哪个文件」。

用例 1 —— 创建 Store 并写入一份文件（阈值下走 `WholeFile`，阈值上走 `Chunk` 序列；
FR-001 / FR-002 / FR-003 / FR-004 / FR-005；AC-1 / AC-9）：

```rust 示意
let config = PersistenceConfig::sqlite(
    StorePath::from_os(Path::new("/var/lib/demo/project.layerfs"))?,
    SqlitePersistenceProfile::Disposable,
);
let handles = Handles::create(config, StoragePolicy::frozen_default())?;
let storage = Storage::new(Arc::clone(&handles.storage))?;
let policy = ConstructionPolicy::frozen_default();
let caps = policy.capacities();

let mut save = storage.begin_save()?;
let mut chunk_ids = Vec::new();
if policy.representation(file_bytes.len() as u64) == Representation::WholeFile {
    save.accept(FinalizedObject::new(ObjectRole::WholeFile, encode_bytes_object(&file_bytes)?))?;
} else {
    FastCdc::new().scan(&file_bytes, |chunk| -> ContentResult<()> {
        let canonical = encode_bytes_object(chunk)?;
        chunk_ids.push(ObjectId::for_bytes(&canonical));
        save.accept(FinalizedObject::new(ObjectRole::Chunk, canonical))?;
        Ok(())
    })?;
}
let outcome = save.finish()?; // 持有 WriteOutcome 即确认
handles.seal()?;              // 适配器侧：checkpoint 并闭库
```

用例 2 —— 打开 Store，按身份序列读回内容（FR-006；AC-6 / AC-7）：

```rust 示意
let handles = Handles::open_read_only(config)?;
let storage = Storage::new(Arc::clone(&handles.storage))?;
let reader = storage.reader()?;
let objects = reader.read_objects(&chunk_ids)?;   // 按请求顺序、逐块认证
for (obj, id) in objects.iter().zip(&chunk_ids) {
    assert_eq!(ObjectId::for_bytes(obj), *id);    // 身份一致由端口保证，可再验
}
```

用例 3 —— 重复内容只占一份（FR-004；AC-5）：

```rust 示意
let mut save = storage.begin_save()?;
save.accept(FinalizedObject::new(ObjectRole::WholeFile, encode_bytes_object(&file_bytes)?))?;
let first = save.finish()?;

let mut save = storage.begin_save()?;
save.accept(FinalizedObject::new(ObjectRole::WholeFile, encode_bytes_object(&file_bytes)?))?;
let second = save.finish()?;

assert_eq!(first.inserted, 1);
assert_eq!(second.reused, 1);                      // 幂等：复用计数，不重复存储
assert_eq!(second.packs, 0);
```

用例 4 —— 多进程写者与车道等待（FR-007；AC-11 / AC-12 / AC-13）：

```rust 示意
// 进程 A 与进程 B 各自 open_writable、各持一个 Handles；无需任何进程间协调
let mut save = storage.begin_save()?;             // 进入写车道：FIFO → 父目录 flock → BEGIN IMMEDIATE
save.accept(make_object(&bytes))?;
save.finish()?;                                   // 排队无时限；会话 close 后等待者与后续调用得 Closed
```

用例 5 —— 放弃会话、存储失败与结果未证明（FR-005；AC-8）：

```rust 示意
{
    let mut save = storage.begin_save()?;
    save.accept(make_object(&draft))?;
    // 作用域结束未 finish：放弃本会话；已发布批次仍然存活，未发布的不再出现
}
let mut save = storage.begin_save()?;
match save.finish() {
    Ok(outcome) => { /* 持有 outcome 即确认 */ }
    Err(e) if e.is_unknown_outcome() => {
        // 结果未证明：绝不静默假定失败，按 UnknownOutcome 的 original 精确上报
        return Err(e);
    }
    Err(e) => return Err(e),
}
```

用例 6 —— 拒绝不同代 schema 与非 Store 文件（FR-001；AC-2 / AC-3）：

```rust 示意
match Handles::open_writable(config) {
    Ok(handles) => { /* 正常使用 */ }
    Err(PersistenceError::Refused { status }) => { /* schema 版本或身份不符：不迁移、不改文件 */ }
    Err(PersistenceError::Missing) => { /* 路径不是 Store */ }
    Err(e) => return Err(e),
}
```

用例 7 —— 等价路径解析为同一 Store（FR-008；AC-15）：

```rust 示意
let a = StorePath::from_os(Path::new("/data//stores/./main.layerfs"))?;
let b = StorePath::from_os(Path::new("/data/stores/main.layerfs"))?;
assert_eq!(a, b);                                        // 词法规范化后相等
assert_eq!(a.to_string(), "/data/stores/main.layerfs"); // 对外一律是规范化形式
```

## 边界与错误路径

- Store 文件损坏（校验不通过、截断、PRAGMA 实测不符）：打开报错，不做修复尝试（架构铁律 1：不过度 fallback）。
- 在已存在的路径上创建 Store：报错，不覆盖、不打开。
- 读取的身份与字节不符：`IdentityMismatch`（内容层）；缺失与 provider 故障严格两类（`MissingObject` / `ProviderFailure`），不冒充。
- 首次胜出败方：定位行不入库；胜败字节不一致报 `Collision`，一致则计 `reused`。同一身份下字节不一致只能来自真实哈希碰撞（那时胜方字节能通过身份认证、进入字节裁决）；若胜方是无法通过身份认证的他者对象（定位行被他者占据），读回以 `IdentityMismatch` 拒绝，认证严格先于裁决（收敛留痕）。
- `finish` 失败且确认未证明（`UnknownOutcome`）：调用方按失败上报，库不重试、不重放、不猜测删除。
- 非协作写者绕过车道直接抢占 SQLite：该次 `BEGIN IMMEDIATE` 得到精确 `Busy`，不重试。
- 空内容（0 字节）：本 spec 不产出对象（`Empty` 表示形态随映射树 spec 引入）；`WholeFile` / `Chunk` 编码要求非空载荷。
- 孤儿对象（崩溃残留、不被任何引用闭包覆盖）：不影响打开与正确性；本 spec 不做清理（去向见非目标）。
- 同进程对同一 Store 的多句柄并发写：与跨进程同语义（车道排队），不因同进程而绕过互斥。
- 跨线程共享同一句柄：编译期拒绝（句柄非 `Sync`）；跨线程并发各自打开句柄。
- 网络文件系统 / 非本地卷：不受支持的放置契约（车道依赖本地 flock 与共享内存语义），与上游同口径**不做探测**、由供给流程保证本地放置；收敛时由「打开时拒绝」改为文档化契约（留痕：可靠探测需逐平台的卷类型判定，不属本 spec）。
- 非 Linux 平台没有跨进程写车道（`writer_lock` 为空锁）：并发写者的第二个 `BEGIN IMMEDIATE` 得到 SQLite 自身的精确 `Busy` 而不是排队（上游 macOS 同款）；AC-11 / AC-12 的「排队到释放」语义只在 Linux 成立，非 Linux 由同一测试断言 `Busy` 分支（收敛留痕）。

## 非目标

- 文件语义（映射树 FileState / extent、inode / 目录 / 属性页、read / write / edit / 目录操作、glob / grep / diff）→ 系列下一份 spec（037（layerfs-fs），本 spec 评审通过后起草）。
- Branch / Commit / Layer / LayerStack、checkpoint / rewind、三方合并、`.lww` 冲突规则、发布车道（头部检查 + 合并 + 发布的原子步）→ 系列第三份 spec（暂定 038（layerfs-branch-merge））。
- 物理编码增强（zstd 压缩、PREFIX delta、pack 分组与 lane、池化元数据 inode_value、相似度签名环）→ 编码 spec（暂定 039（layerfs-encoding））；036 的 pack 为单记录存储布局，schema 以 `user_version` 前向演进、旧版拒开不迁移（上游同口径）。
- FUSE / Workspace 挂载、overlay 数据库、Docker Sandbox 执行面 → Phase 2，未来 spec。
- 接入 core 引擎与 TS 侧（事件 / 契约 / 宿主 UI）→ 后续接线 spec；本 spec 无任何 TS 侧改动。
- 垃圾回收（孤儿对象回收与空间回收）→ 接入提交模型后另立 spec（上游同样未实现，需要独立契约）。
- 与上游 Store 文件互开（schema 版本与表组独立）→ 非目标；身份 / 封装 / CDC 层保持逐字节兼容。
- 初始采集端口（上游的 Acquisition 端口：Project Init 的可恢复工作表）→ 接线 spec 按本仓库的导入路径另行评估。
- Windows 的跨进程写车道（锁文件替代 flock）→ 不做；库本身在 Windows 可运行（进程内 FIFO 车道 + SQLite 自身 `Busy`），平台抽象缝见 FR-008（收敛留痕：原「Windows 原生运行不做」表述过宽）。

## 对需求基线的影响

无新增 US。本 spec 是库层地基，不产生任何用户可观察行为；待接线 spec（文件工具面、
历史 UI）落地时，再按既有口径登记 US 与 e2e 用例。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/layerfs-sqlite/src/open.rs`、`core-rs/layerfs-sqlite/src/profile.rs`、`core-rs/layerfs-sqlite/src/schema.rs`、`core-rs/layerfs-sqlite/src/seal.rs` | `core-rs/layerfs-sqlite/src/schema_tests.rs`、`core-rs/layerfs-sqlite/src/store_tests.rs` | 自动 |
| FR-002 | `core-rs/layerfs/src/object/id.rs`、`core-rs/layerfs/src/object/codec.rs`、`core-rs/layerfs/src/object/output.rs`、`core-rs/layerfs/src/object/payload.rs`、`core-rs/layerfs/src/object/predecessor.rs` | `core-rs/layerfs/src/object/object_tests.rs`（含上游 v1.1.0 测试向量） | 自动 |
| FR-003 | `core-rs/layerfs/src/cdc/gear.rs`、`core-rs/layerfs/src/cdc/zeros.rs`、`core-rs/layerfs/src/policy.rs` | `core-rs/layerfs/src/cdc/cdc_tests.rs`（分块边界向量 + 零游程）、`core-rs/layerfs/src/policy_tests.rs` | 自动 |
| FR-004 | `core-rs/layerfs/src/save.rs`、`core-rs/layerfs/src/port.rs`、`core-rs/layerfs-sqlite/src/provider.rs` | `core-rs/layerfs/src/save_tests.rs`（首次胜出 / 闭包）、`core-rs/layerfs-sqlite/src/provider_tests.rs` | 自动 |
| FR-005 | `core-rs/layerfs/src/storage.rs`、`core-rs/layerfs/src/save.rs` | `core-rs/layerfs/src/save_tests.rs`、`core-rs/layerfs-sqlite/src/store_tests.rs`（崩溃用例以子进程 kill 注入） | 自动 |
| FR-006 | `core-rs/layerfs/src/storage.rs`、`core-rs/layerfs/src/reader.rs` | `core-rs/layerfs/src/reader_tests.rs`、`core-rs/layerfs-sqlite/src/store_tests.rs` | 自动 |
| FR-007 | `core-rs/layerfs-sqlite/src/admission.rs`、`core-rs/layerfs-sqlite/src/writer_lock.rs`、`core-rs/layerfs-sqlite/src/connection.rs` | `core-rs/layerfs-sqlite/src/lane_tests.rs`、`core-rs/layerfs-sqlite/src/store_tests.rs`（多进程用例） | 自动 |
| FR-008 | `core-rs/layerfs-sqlite/src/platform.rs`、`core-rs/layerfs-sqlite/src/writer_lock.rs` | `core-rs/layerfs-sqlite/src/platform_tests.rs` | 自动 |

## 待澄清

（无——分块 profile 与身份算法逐字节沿用上游冻结值；schema 独立版本与物理编码后置
已写进「上游对齐口径」与「非目标」，均属已定事项。）

## 收敛记录

收敛于 2026-11-02（实施提交 `963ac98`）。闸门：`npm run check-types` / `npm run lint` /
`npm run test:unit -- docs-lint` / `npm run build:core:host` 后 `npm run test:core`
（layerfs 37 + layerfs-sqlite 26 + standalone-core 1048）全绿；musl 目标
`cargo check --tests` 验证 Linux `cfg` 分支可编译。

- 已满足：
  - AC-1 / AC-14（FR-001）→ `core-rs/layerfs-sqlite/src/store_tests.rs`：`seal_leaves_one_self_contained_file_and_reopens`（单文件、`bytes`、无 `-wal` / `-shm` / `-journal`、重开）、`seal_with_live_references_is_busy`；`schema_tests.rs`：`create_then_reopen_round_trips`（profile 读回值逐项断言）。
  - AC-2（FR-001）→ `schema_tests.rs`：`higher_schema_version_is_refused_without_touching_bytes`（`user_version` 99 与 0 都拒、文件字节前后一致）、`unexpected_table_is_refused`。
  - AC-3（FR-001）→ `schema_tests.rs`：`non_wal_journal_is_refused`。
  - AC-4（FR-002）→ `core-rs/layerfs/src/object/object_tests.rs`：`identity_and_envelope_match_upstream_bytes`、`whole_file_and_chunk_grammar_match_upstream`（身份 / 封装 / 两种角色值语法的对照常量由上游 v1.1.0 代码在独立进程里产出）、`envelope_rejects_in_upstream_order`、`thirteen_role_codes_match_upstream_table`。
  - AC-16（FR-003）→ `core-rs/layerfs/src/cdc/cdc_tests.rs`：`chunk_boundaries_match_upstream_bytes`（1 MiB 确定性输入 59 块逐长度一致，块长落在 8–32 KiB）、`zero_runs_match_upstream_repeat_blocks`、`zero_hole_path_matches_plain_scan_boundaries`、`constants_match_frozen_upstream_profile`（`profile_id` 对照）；`policy_tests.rs` 四例。
  - AC-5（FR-004）→ `store_tests.rs`：`same_content_twice_is_reused_and_stored_once`（`pack` 表计数 1）；`core-rs/layerfs/src/save_tests.rs`：`same_content_resave_counts_reused_without_new_pack`、`first_wins_loser_with_identical_bytes_counts_reused`。
  - AC-6 / AC-7（FR-006）→ `store_tests.rs`：`finish_acknowledges_and_reads_in_order_with_missing_classified`；`core-rs/layerfs/src/reader_tests.rs`：`reads_in_request_order_keeping_duplicates`、`absence_reports_object_missing`、`tampered_pack_reports_integrity_not_absence`、`lying_locator_identity_reports_identity_mismatch`、`lying_locator_length_reports_integrity`、`request_count_over_window_rejected`。
  - AC-8（FR-005）→ `store_tests.rs`：`published_batch_survives_process_kill_and_pending_does_not`（子进程发布 512 对象波次后被 `kill`，重开后已发布可读、批内未发布 `ObjectMissing`）。
  - AC-9（FR-005）→ `save_tests.rs`：`whole_file_save_acknowledged_by_finish`、`batch_bound_publishes_previous_wave`、`abandoned_save_keeps_published_batches`、`unproven_outcome_reports_unknown_outcome`、`sink_error_surfaces_through_finish`、`save_reads_pending_and_stored_objects_with_same_save_visibility`；`store_tests.rs` 同名往返用例。
  - AC-10（FR-004）→ `store_tests.rs`：`missing_dependency_leaves_no_effect_in_store`（`object_location` 行数 0）；`save_tests.rs`：`missing_reference_rejects_whole_batch_without_effect`。
  - AC-11 / AC-12（FR-007）→ `store_tests.rs`：`two_processes_write_concurrently`、`writer_in_another_process_queues_or_reports_busy`（Linux 断言双方完成 / 排队到释放，非 Linux 断言精确 `Busy`）。本机（Windows arm64）走 `Busy` 分支通过；Linux 排队分支的运行证据来自 CI `tests` job 的 `npm run test:core`（本机只做了 musl 目标的编译验证）。
  - AC-13（FR-007）→ `core-rs/layerfs-sqlite/src/lane_tests.rs`：`close_wakes_queued_caller_with_closed`、`in_process_concurrent_saves_serialize_without_busy`、`same_thread_reentry_is_refused_not_deadlocked`。
  - AC-15（FR-008）→ `core-rs/layerfs-sqlite/src/platform_tests.rs`：`equivalent_spellings_normalize_to_one_path`、`two_spellings_open_the_same_store`、`empty_or_directory_like_paths_are_refused`。
  - 反向对照补齐：`provider_tests.rs`（first-wins 败方名单、`store_totals` 只按胜方累加、`reserve` 连续分配、缺席省略）；`schema_tests.rs`：`read_only_session_refuses_writes_before_sql`、`create_over_existing_path_is_refused`、`policy_round_trips_through_store`；`save_tests.rs`：`role_without_decoder_rejected_and_save_terminates`、`second_begin_save_on_same_handle_is_ownership_unavailable`、`first_wins_loser_failing_authentication_reports_identity_mismatch`。
- 偏差（均已留痕）：
  - `PersistenceConfig` 由 `sqlite(path)` + `with_profile(..)` 改为 `sqlite(path, profile)`（铁律 2：无默认值）——改 spec 公开 API 表与用例 1。
  - `StorePath::as_os_path()` 落为 `as_path()` / `into_path_buf()` / `parent_dir()`——改 spec 公开 API 表。
  - spec 承诺的 `Save::read_objects` 初版只有 `AuthenticatedObjects` 端口形式——改代码补公开方法（端口实现委托它），补 `save_reads_pending_and_stored_objects_with_same_save_visibility`。
  - 边界「网络文件系统打开时拒绝」未实现探测——改 spec 为文档化放置契约（与上游同口径）。
  - 非 Linux 平台无跨进程写车道、并发写者得精确 `Busy`——补进 spec 边界与非目标（原「Windows 原生运行不做」过宽）。
  - `StorageError` 不含上游的 Unpublished / VisibilityCeiling / CleanupFailed 三个变体（036 无水位线与清理步）——改 spec 错误表；`Collision` 的可达条件（哈希碰撞）与 `IdentityMismatch` 先于裁决——补进边界。
  - 影响基线之外的构建接线：`test:core` 改为 `cd core-rs && cargo test --workspace`（cargo 按 cwd 发现 `.cargo/config.toml`），`core-rs/.cargo/config.toml` 为 aarch64-pc-windows-msvc 固化 `zig cc` 注入——已写进 [docs/core/standalone-core.md 3.3](../../docs/core/standalone-core.md#33-构建与目标平台)。
- 未做：无。
