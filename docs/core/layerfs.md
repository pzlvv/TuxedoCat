---
owner: pzlvv
last_reviewed: 2026-11-02
---

# 规格：LayerFS 内核库（对象库地基）

本仓库 Core 侧的 Rust 对象库：不可变内容对象的身份、封装、分块、保存与读取，以及它的
SQLite 持久化适配器。对照基线是上游 [Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs)
v1.1.0（commit `9f97a7ec95b662e9cb288704afa165feff132cfa`）；文件语义（映射树 / 文件系统）、
Branch / Commit / 物理编码（zstd / PREFIX / pack 分组）与宿主接线由系列后续 spec 承接。
本篇只描述已落地的 036 形态（改动规格见
[specs/036-layerfs-store](../../specs/036-layerfs-store/spec.md)，实施完成后归档）。

## 1. 范围、crate 布局与上游对齐

改动全在 Rust 侧，与 `src/shared/`、事件契约、帧协议、会话落盘格式无关。

| crate | 定位 | 关键约束 |
| --- | --- | --- |
| `core-rs/layerfs/` | 纯算法与端口面：身份、封装、分块、策略、`Storage` / `Save` / `Reader`、`ObjectPersistence` 端口 | 无任何 I/O；`#![forbid(unsafe_code)]`、`#![deny(missing_docs)]`；依赖只有 `blake3`（身份）与 `sha2`（pack 摘要） |
| `core-rs/layerfs-sqlite/` | SQLite 持久化适配器：profile PRAGMA、schema v1、并发车道、seal | 唯一触碰文件与数据库的层；`#![deny(unsafe_code)]`；依赖 `rusqlite =0.40.2`（`bundled` / `cache` / `limits`）与 `nix`（`fs`，仅 Linux 目标） |

两个 lib crate 与 `standalone-core` 同 workspace（`core-rs/Cargo.toml` 的 members）；
`standalone-core` 挂 `layerfs-sqlite` path 依赖但 036 不引用其符号，release 的 LTO 剔除。
`npm run test:core` 驱动 `cargo test --workspace` 覆盖三个 crate；覆盖率
（`node scripts/coverage-core.mjs`）度量 workspace 各 crate 的 `src/` 产品代码。

**上游对齐口径**：

- **逐字节兼容**（测试向量取自 v1.1.0 真实输出，固化为常量）：对象身份
  `ObjectId = BLAKE3("layerfs/object/v2\0" ‖ 规范字节)`、`LFSO` 封装帧、冻结 GEAR CDC
  profile（表、掩码、种子、零游程特例逐字复制，文件头带 MIT 版权注记）及其 `profile_id`。
- **有意分叉**：Store 文件不与上游互开——`user_version=1` 从本系列起算、
  `application_id` 是本系列自有常量（大端 `"TCLF"`，与上游的 `1279677264` 无关）；
  表组只含对象层四表；上游每个入口携带的遥测作用域参数不引入，以计数器代替。
- **后置**：zstd 压缩、PREFIX delta、pack 分组编码、池化元数据、映射树、history、
  Branch / Commit、FUSE / 挂载与 TS 宿主接线都不在 036；物理布局与端口形状为其预留。

## 2. 对象身份、封装与角色语法

对象身份是域分隔摘要：`ObjectId = BLAKE3("layerfs/object/v2\0" ‖ 完整规范字节)`，32 字节
（`DIGEST_BYTES`），小写 hex 的 `Display` / 大小写不敏感的 `FromStr`；分段输入用
`IdentityStream`（对同一 `Hasher`，身份等于其拼接结果的 `ObjectId::for_bytes`）。

规范封装帧为 `LFSO`：

```text
示意：byte 0..3  magic "LFSO"；4  kind（字节角色 = BYTES_KIND = 1）；
      5..8  payload_len（BE u32）；9..12  value_len（BE u32）；13..  value。
      HEADER_LEN = 9；canonical_len = 13 + value_len。
```

`decode_bytes_object` 按固定顺序逐项拒绝：超长对象（16 MiB）→ 短头 → magic → kind →
载荷超长（16 MiB − 9）→ 值超长（8 MiB）→ 值越过载荷 → 截断 → 尾随字节；
`encode_bytes_object_to` 一次写入最终分配，解码借用值不复制。

`ObjectRole` 携带稳定的持久化 code（`code()` / `from_code()`，与上游同表）：

| code | 角色 | code | 角色 |
| ---: | --- | ---: | --- |
| 1 | `WholeFile` | 8 | `DirectoryBranch` |
| 2 | `Chunk` | 9 | `InodeBranch` |
| 3 | `ExtentLeaf` | 10 | `FilesystemRoot` |
| 4 | `ExtentBranch` | 11 | `AttributeLeaf` |
| 5 | `FileState` | 12 | `AttributeBranch` |
| 6 | `InodeLeaf` | 13 | `Symlink` |
| 7 | `DirectoryLeaf` | | |

本库只持有 `WholeFile` 与 `Chunk` 的解码器（`has_decoder()`），`Save` 只接受这两个角色，
其余 code 保留编码、引入对应解码器前拒绝接受。两者的值语法：

- WholeFile 值 = magic `LFS5SML\0` + 大端 u16 版本 1 + 文件字节（载荷非空且
  ≤ 阈值 − 1；`encode_whole_file` / `whole_file_payload`）；
- Chunk 值 = magic `LFS4CHK\0` + 块字节（≤ 32 KiB；`encode_chunk_object` /
  `chunk_payload` / `chunk_canonical_len`）。`chunk_id` 与 `ChunkIdentity` 不构建对象
  即给出身份。

`FinalizedObject` 携带五元组：id、role、canonical 字节、直接引用列表、建议前驱列表；
`into_parts()` 把五部分全部移交消费者——前驱是物理表示选择的输入，静默丢弃即丢失输入。
`FinalizedConsumer` 是有界 sink（`accept` 取所有权，报错即终止构造）；
`DiscardingConsumer` 只计数。建议前驱（`AdvisoryPredecessors`）上界
`MAXIMUM_ADVISORY_PREDECESSORS = 4`、按来源标注（`PredecessorProvenance`）、满员先撞
容量检查再去重；本库构造路径恒产出空列表，类型为编码 spec 预留。

## 3. 冻结 CDC 分块与策略

分块是冻结的双字节滚动 GEAR profile：下界 8 KiB、目标 16 KiB、上界 32 KiB
（`MINIMUM/TARGET/MAXIMUM_CHUNK_BYTES`）、归一化移位 2、种子 0、四个掩码
（`SMALL/LARGE/SHIFTED_SMALL/SHIFTED_LARGE_MASK`）与 256 项 `GEAR` 表全部冻结——改动
任何一项都会改变每个分区与每个块身份。profile 自带身份：`profile_id()` 是 BLAKE3 over
`b"layerfs/fastcdc-profile/v1\0"` + 全部参数 + GEAR 表，create 时写入 Store、open 时
校验一致，不一致拒开。

`FastCdc::scan` 流式扫描（一次回调一个块切片，回调错误即停）；`cut_candidates` 按两套
字节对齐上报候选边界（候选是待身份验证的提示）。连续零游程走重复块特例：
`ChunkScanner::zeros(length, …)` 处理稀疏洞——一个最大块清掉前导非零字节，其后只剩零的
扫描器状态每 32768 字节重复，满 interior 零块以重复计数一次交给回调，返回值是实际扫描
的零字节数（首尾两段，重复段只计数）。`ChunkScanner` 公开 `consume` / `zeros` / `finish`，
滚动哈希跨调用保持，洞与数据的衔接和一次喂入逐字节一致；`bytes_scanned` 计数只由
`FastCdc::scan` 包装层累计。

`ConstructionPolicy`（`policy.rs`）是唯一的构造策略定义点：整文件阈值
`small_file_threshold_bytes` 接受 128 KiB–1 MiB 的 2 的幂（`validated()` 拒绝其余），
两个角色深度接受 0–50；`representation(logical_len)` 选择 `Empty` / `WholeFile` /
`Chunked`——`Empty` 的对象形态属于映射树 spec，本库如实返回该判别但不产出对象。
`ConstructionCapacities` 由被接受的策略以检查算术派生（整文件载荷上限 = 阈值 − 1，
规范上限再加 `WHOLE_FILE_CANONICAL_OVERHEAD = 23`）。

持久化的 `StoragePolicy` = `format_profile`（恒 1）+ `cdc_profile_id` + 构造策略 +
`metadata_delta_max_depth`（预留字段，校验范围 0–50、036 不使用）；`validated()` 逐项
核对，任何不符拒开。`StorageCapacities::from_policy` 派生固定窗口：
批次 512 对象 / 512 KiB（`BATCH_OBJECT_LIMIT` / `BATCH_CANONICAL_BYTES_LIMIT`）、
发布事务 8191 行 / 4 MiB − 1 规范字节（`TRANSACTION_ROW_LIMIT` /
`TRANSACTION_CANONICAL_BYTES_LIMIT`）、读取窗口 4096 id / 32 MiB
（`READ_OBJECT_LIMIT` / `READ_CANONICAL_BYTES_LIMIT`）、pack 上限
`PACK_LIMIT = 256 KiB`（元数据域）与 `SINGLETON_PACK_LIMIT = 16 MiB + 4 KiB`（载荷域）。

## 4. 存储与端口：Save、Reader、ObjectPersistence

`Storage::new(Arc<dyn ObjectPersistence>)` 打开句柄：读回并验证持久化策略、派生容量。
每个 `Storage` 句柄同时只允许一个活动 `Save`（第二个 `begin_save` 报
`OwnershipUnavailable`，`Save` 的 Drop 释放）；并发生产者各持句柄。

**Save 会话**（`save.rs`）：`accept(FinalizedObject)` 先做角色与值语法校验，再进有界
待发批次；批次到界（对象数或规范字节）即发布前一波次。一次波次：同波去重（重复身份计
`reused`）→ `locate` 命中者计 `reused`（内容寻址，同身份即同字节，不读回比对）→
引用闭包检查（直接引用必须已存储或同在本次发布集内，否则整批 `MissingDependency`、
无任何效果）→ Kahn 拓扑序（环拒绝）→ `reserve` 一次分配 pack id → 按事务上界拆分
发布。`SaveSink` 适配 `FinalizedConsumer`，原始错误保留给 `finish`。
`finish()` 封装并注册剩余输出，返回 `WriteOutcome`——**持有返回值即确认**，任何其他
结果都是类型化错误；持久化结果未证明时报 `UnknownOutcome`，绝不静默假定失败、不重试。
`Save` 被 Drop 而未 finish 即放弃：已发布的引用闭包批次存活，候选状态随结构丢弃。
`Storage` 与 `Save` 都实现 `AuthenticatedObjects`（后者还能读到本会话已接受未发布的
批次），构造方只依赖该端口。

**first-wins 与 Collision**：发布方插入定位行缺席者胜；败方名单里的身份读回胜方已提交
的字节比对——一致计 `reused`，不一致报 `Collision(id)`（同一身份下字节不一致只可能来自
真实哈希碰撞，此时读取可通过认证进入字节裁决；胜方若是无法通过身份认证的他者对象，
读取以 `IdentityMismatch` 拒绝，严格先于裁决）。败方的 pack 字节已写入，留下孤儿 pack，
按边界条款容忍。

**Reader**（`reader.rs`）：`Reader::read_objects(ids)` 按请求顺序批量返回规范字节（重复
id 保留重复输出），先 `locate` 再 `read_packs`。读取是认证的：pack 长度与 SHA-256 摘要
先验证（`PersistedPack::authenticate`，不符报 `Integrity`），记录长度与定位行一致，最后
`ObjectId::for_bytes(记录)` 必须等于请求 id（不符报 `IdentityMismatch`）。缺失只能是
`ObjectMissing(id)`；持有状态但无法服务的损坏一律报 provider 错误，两类严格分开、不冒充
缺席。单记录布局之外的组 / 记录寻址被拒绝。

**端口**（`port.rs`）：适配器实现 `ObjectPersistence`（`Send + Sync`）——
`policy` / `locate` / `read_packs` / `reserve` / `publish`；每次调用一次尝试，没有恢复
循环。`publish(&Publication)` 是单个原子事务：pack 行插入 + 定位行 first-wins 插入并
回答败方名单（`Published.lost`）+ 计数行累加。`PersistenceError` 变体：`Busy`（锁被
持有，无写效果）/ `BackendUnavailable` / `Missing` / `Refused` / `Malformed` /
`Uncertain`（确认未知）/ `Closed` / `Cancelled`。`StorageError` 判别联合的全部变体：
`Busy`、`Content(ContentError)`、`Io`、`ObjectMissing(id)`、`Collision(id)`、
`MissingDependency`、`OwnershipUnavailable`、`UnsupportedPolicy`、`Integrity`、
`CapacityExceeded`、`UnknownOutcome`、`Aborted`、`Closed`、`Cancelled`。`WriteOutcome`
字段：`inserted`（新写入对象数）/ `reused` / `packs` / `canonical_bytes` / `stored_bytes`。

## 5. 适配器：profile、schema、并发车道与 seal

**配置与句柄**（`open.rs`）：`PersistenceConfig::sqlite(StorePath, SqlitePersistenceProfile)`
无默认值；`SqlitePersistenceProfile` 只有 `Disposable`（WAL / `synchronous=OFF`，身份串
`sqlite-wal-off-v2`）——进程崩溃可存活、内核崩溃无保证；上游已停用 `Durable`
（`sqlite-wal-full-v2`），未经所有者重新授权不得执行，本适配器不实现它。
`Handles::create` 拒绝已存在路径（`create_new`，不覆盖）、一次事务写入 schema 与策略行；
`open_writable` / `open_read_only` 打开前逐项校验；`close()` 以 `Closed` 拒绝排队与
后续调用，正持有的调用跑到完成。

**profile PRAGMA**（`profile.rs`）：连接期应用并实测校验，任一不符拒开——
`journal_mode=wal`（打开已有库时非 WAL 直接拒开，绝不转换）、`synchronous=0`（在 WAL
选择之前先定，因为选 WAL 本身可能写文件）、`page_size=4096`（仅创建时）、
`foreign_keys=1`、`wal_autocheckpoint=1000`、`journal_size_limit=4194304`、
`cache_size=-2048`、`mmap_size=0`、`temp_store=2`、`busy_timeout=0`、
`SQLITE_DBCONFIG_DEFENSIVE=on`、语句缓存 64；并核对引擎限额（行长 ≥
`SINGLETON_PACK_LIMIT + 1024` 等）。`ConnectionProfile` 携带读回值与链接的 SQLite 版本。

**schema**（`schema.rs` + `sql/schema_v1.sql`）：四表——`store_policy`（单行策略与
`next_pack_id` 计数）、`pack`（`pack_id` / `domain` 0 或 1 / 32 字节 SHA-256 `digest` /
`length` / `body`，禁 UPDATE / DELETE 触发器）、`object_location`（32 字节主键
WITHOUT ROWID，role 1–13、规范长度 1–16 MiB、组 / 记录序号边界）、`store_totals`
（单行已确认计数）。全部 `STRICT`。036 的 pack 是单记录布局：每对象一个 pack，
`body` = 原始规范字节（无帧、无压缩），定位行恒 `group_number=0` / `record_number=0`。
打开期校验是精确的：`application_id` / `user_version` 必须与实现完全一致，表名单不多
不少（`sqlite_%` 内部表除外），全部定义文本必须与用同一 DDL 在内存库建出的定义逐字一致
（因此 `STRICT`、role 边界等 CHECK 文本都被核对）。更高或更低的 schema 版本一律拒绝，
不迁移、不修改文件。

**并发车道**（`admission.rs` + `writer_lock.rs` + `connection.rs`）：顺序是——

1. 进程内每会话 FIFO 准入（`Mutex` + `Condvar`）：排队无时限、无计数上限（每票一个
   阻塞线程）；出口只有 `Closed`（会话已 `close`）、`Unknown`（队列互斥量中毒）、
   `Integrity`（本线程重入自锁，拒绝而非挂死）。持有者 unwind 仍释放轮次。
2. 写事务取 Store 父目录的独占 flock（仅 Linux；独立打开的目录 fd，绝不对主 / WAL /
   SHM 文件另开描述符——关闭主文件描述符会取消本进程在该 inode 的全部 POSIX 锁；
   同目录多个 Store 共享这条粗粒度车道；`EINTR` → `Cancelled`）。非 Linux 目标没有这层：
   跨进程写者冲突由 SQLite 自身文件锁以精确 `Busy` 上报（与上游 macOS 同款）。
3. 单次 `BEGIN IMMEDIATE`：`SQLITE_BUSY` / `LOCKED` / `PROTOCOL` 映射为类型化 `Busy`，
   绝不重试、不重放。锁持有范围 = 单个原子事务（到已知 COMMIT 或明确 ROLLBACK）。

只读不可变行（定位行、pack 行、计数行）的 `locate` / `read_packs` 不开显式事务：每条
语句各自取隐式快照——只对一旦可见就不再变化的行安全。任何让结果无法证明的失败
（I/O 错误、COMMIT 未知、ROLLBACK 失败）使会话进入隔离（quarantined），此后一切调用报
`Uncertain`（存储侧 `UnknownOutcome`）；连接拆除先于锁释放。

**发布与分配**（`provider.rs`）：`reserve` 一条 `UPDATE … RETURNING` 顺序分配 pack id；
`publish` 单事务内插 pack 行、`INSERT … ON CONFLICT DO NOTHING RETURNING` first-wins
插入定位行（返回行即胜者，缺席即败方）、按胜者累加 `store_totals`。pack 分页插入时一页
的绑定字节不超过一个普通 pack 上限。

**seal**（`seal.rs`）：`Handles::seal(self)` 消费句柄——仍被引用的 provider 以 `Busy`
拒绝；取唯一会话后走写者车道，`PRAGMA wal_checkpoint(TRUNCATE)` 一次（checkpoint 被碍
即 `Busy`）、检查关闭连接、校验 `-wal` / `-shm` / `-journal` 无残留，返回
`SealedStore { path, profile, sqlite_version, bytes }`。任何失败不猜测删除、不重试。

**平台缝**（`platform.rs`）：`StorePath` 只做词法规范化（折叠冗余分隔符、去 `.` 段；
不解析符号链接、不折叠 `..`），两种等价写法落为同一个 `StorePath`，库对外返回的路径即
规范化形式；裸文件名的父目录是 `.`。Windows 未来换锁文件的扩展只动 `writer_lock.rs`。

**构建注记**：bundled SQLite 的 C 源由 cc-rs 编译——Linux musl 走构建脚本注入的
zig cc，Windows arm64 由 `core-rs/.cargo/config.toml` 的 `[env]` 注入同一份
`CC_aarch64_pc_windows_msvc = "zig cc"`（ring 的 build.rs 对该目标硬性要求 clang，
本机无 clang 时经 zig 充当；构建脚本注入的同名变量优先）。

## 6. 限制

- `Empty` 表示、映射树、文件系统语义、Branch / Commit / merge、zstd / PREFIX delta、
  pack 分组与池化元数据都不在 036（见第 1 节的后置清单）；`metadata_delta_max_depth`
  只是持久化预留。
- 非 Linux 平台没有跨进程写车道：并发写者的第二个 `BEGIN IMMEDIATE` 得到精确 `Busy`
  而不是排队（上游 macOS 同款语义）；排队语义（等待到持有者释放）只在 Linux。
- 同目录的多个 Store 共享父目录 flock 车道：一个 Store 的写事务会延后同目录另一 Store
  的写事务（协调键是目录 inode，粗粒度是设计选择）。
- Store 放置要求本地内核锁定 / 共享内存语义的文件系统；网络挂载与宿主共享不受支持。
- 放弃的 `Save` 可能留下孤儿 pack（字节已写入但无定位行指向）：按边界条款容忍，
  不回收（回收属于后续 spec 的维护面）。
- `seal` 期间必须由供给流程排除新的打开者；另一进程阻碍 checkpoint 或留下侧文件时
  seal 以 `Busy` / `Refused` 失败，不重试、不删除。
