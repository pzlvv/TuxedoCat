# 实施方案：LayerFS 内核库 · 对象库地基（上游对齐版）

技术路线：镜像上游 [Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs) 的
core/engine 分层，在本仓落为**两个 crate**——`layerfs`（对象身份 / `LFSO` 封装 / 冻结
GEAR CDC / 策略 / `Storage` / `Save` / `Reader` 与 `ObjectPersistence` 端口，
**无任何 I/O**，`forbid(unsafe_code)`）与 `layerfs-sqlite`（SQLite 持久化适配器：
profile PRAGMA、schema v1、FIFO 准入 + 父目录 flock、seal，唯一触碰文件 / 数据库的层）。
身份、封装、CDC 与上游逐字节兼容；schema 版本独立演进；zstd / PREFIX delta / pack
分组编码后置（见 spec「上游对齐口径」与「非目标」）。需求见同目录 [spec.md](spec.md)；
本文只写怎么做。

## 技术方案

### 1. crate 布局与边界

- `core-rs/layerfs/`（lib，`name = "layerfs"`）：`#![forbid(unsafe_code)]`、`#![deny(missing_docs)]`。
  无 `std::fs` / `std::path` 之外的平台依赖（路径规范化用 `std::path` 的词法操作），
  依赖只有 `blake3`（身份，域分隔 update）与 `sha2`（pack 摘要 `ObjectKey`）。
- `core-rs/layerfs-sqlite/`（lib）：依赖 `layerfs`（path）、`rusqlite =0.40`（features
  `bundled`（Linux）/ `cache` / `limits`、MSVC 下用系统工具链编译 bundled 的 C 源）、
  `nix`（feature `fs`，仅 Linux 目标挂，父目录 flock）。全 crate `deny(unsafe_code)`
  （无 zstd FFI，不需要上游的 audited-exception 结构）。
- `core-rs/Cargo.toml` 增 `[workspace] members = ["layerfs", "layerfs-sqlite"]`；
  `standalone-core` 增 `layerfs-sqlite` path 依赖（传递编译 `layerfs`）——四个发布目标
  的构建在本 spec 即验证 bundled SQLite 的 musl（zig cc）/ MSVC 可编译性；036 不引用
  其符号，release 的 LTO 会剔除。
- 文件划分：

  | 文件 | 职责 |
  | --- | --- |
  | `layerfs/src/lib.rs` | pub API 出口与模块声明（≤ 200 行声明式，上游同口径） |
  | `layerfs/src/object/{id,codec,output,payload,predecessor}.rs` | `ObjectId` / `IdentityStream`、`LFSO` 封装编解码、`ObjectRole` / `FinalizedObject` / consumer / provider 端口、WholeFile / Chunk 值语法（`payload.rs`）、有界建议前驱（类型与编码预留，036 恒空） |
  | `layerfs/src/cdc/{gear,zeros}.rs` | 冻结 GEAR 扫描器与零游程特例（表与掩码从上游逐字复制，MIT + 版权注记）、`profile_id` |
  | `layerfs/src/policy.rs` | `ConstructionPolicy` / `ConstructionCapacities` / `Representation` 常量与验证 |
  | `layerfs/src/storage.rs` | `Storage` 句柄：策略读回、`begin_save` / `reader` |
  | `layerfs/src/save.rs` | `Save` / `SaveSink` / 有界批次 / 封装注册 / `WriteOutcome` / 首次胜出与引用闭包 |
  | `layerfs/src/reader.rs` | `Reader` 认证批量读、窗口上界 |
  | `layerfs/src/port.rs` | `ObjectPersistence` / `PersistenceError` / `Publication` / `Published` / 位置与分配载体 |
  | `layerfs/src/error.rs` | `ContentError` / `StorageError` 判别联合与端口错误映射 |
  | `layerfs-sqlite/src/lib.rs` | `PersistenceConfig` / `SqlitePersistenceProfile` / `Handles` 出口 |
  | `layerfs-sqlite/src/{profile,connection}.rs` | PRAGMA 应用与打开期逐项实测校验（清单见第 3 节） |
  | `layerfs-sqlite/src/{schema,open}.rs` | schema v1 DDL（`include_str!`）与精确校验：`application_id` / `user_version` / 表名单 / `STRICT` / CHECK 文本 |
  | `layerfs-sqlite/src/{admission,writer_lock,connection}.rs` | 进程内 FIFO 准入、Linux 父目录 flock、单事务车道（`connection.rs` 持有会话与事务运行器）；`error.rs` 是后端错误到 `PersistenceError` 的唯一映射 |
  | `layerfs-sqlite/src/{provider,seal}.rs` | `ObjectPersistence` 的 SQLite 实现（locate / read_packs / reserve / publish）、`seal` / `SealedStore` |
  | `layerfs-sqlite/src/platform.rs` | `StorePath` 规范化、父目录确保、flock 的平台缝（Windows 未来换锁文件） |
  | `*/src/*_tests.rs` | 同名模块测试，挂载写法同 `core-rs/src/balance.rs` |

### 2. 身份、封装与 CDC（逐字节兼容上游）

- `ObjectId::for_bytes` = `blake3::Hasher` 先 `update(b"layerfs/object/v2\0")` 再
  `update(canonical)`；`IdentityStream` 包同一个 Hasher。hex `Display` / 大小写不敏感
  `FromStr`。与上游共享测试向量（克隆仓库的 `object_tests` 断言值直接对照）。
- `LFSO` 封装：`"LFSO" + kind(1B) + payload_len(BE u32) + value_len(BE u32) + value`；
  `encode_bytes_object_to` 单次写入最终分配；`decode_bytes_object` 借用解码，按上游
  顺序逐项拒绝（超长 / 短头 / magic / kind / 载荷超长 / 值超长 / 越界 / 截断 / 尾随）。
- CDC：two-byte rolling GEAR 表、`SMALL/LARGE/SHIFTED_*` 掩码、`NORMALIZATION_SHIFT=2`、
  `PROFILE_SEED=0`、8/16/32 KiB 从上游 `core/crates/layerfs-content/src/file/cdc/gear.rs`
  逐字复制（MIT 许可，文件头注记来源：上游 v1.1.0，commit
  `9f97a7ec95b662e9cb288704afa165feff132cfa`）；零游程特例按 `zeros.rs` 语义实现（首个 32 KiB 清状态、其后每
  32 KiB 一个重复块 + 重复计数回调）。`profile_id()` = BLAKE3 over
  `b"layerfs/fastcdc-profile/v1\0" + 参数 + GEAR 表`，create 时写进 `store_policy`，
  open 校验不一致即拒。
- 分块用例（AC-4 / AC-6 分块边界）以克隆仓库为 fixture 源：同一输入在本库与上游
  `FastCdc` 的边界一致（测试用上游 `cut_candidates` 的输出做对照常量，不依赖运行时
  克隆仓库存在——把对照向量固化进测试文件）。

### 3. 适配器：profile、schema、并发、seal

- **profile**（每次连接应用 + 实测校验，任一不符拒开）：
  `journal_mode=wal`（已有库非 WAL 直接 `Integrity` 拒开）、`foreign_keys=1`、
  `wal_autocheckpoint=1000`、`journal_size_limit=4194304`、`cache_size=-2048`、
  `mmap_size=0`、`temp_store=2`、`busy_timeout=0`、`SQLITE_DBCONFIG_DEFENSIVE=on`、
  语句缓存 64；`synchronous=OFF(0)`（唯一 profile `Disposable`，spec FR-001）；
  创建时 `page_size=4096`。profile 身份串沿用上游 `sqlite-wal-off-v2`。
  `Durable` 不实现——上游 owner 政策已停用它，未经重新授权不得执行（身份串
  `sqlite-wal-full-v2` 仅在注释中提及以防止后人误造）。
- **schema v1**（本系列自己的 `user_version=1`；`application_id` 取自派常量并在
  `format.rs` 注明与上游 1279677264 无关）：

  ```sql
  CREATE TABLE store_policy (
    id INTEGER PRIMARY KEY CHECK(id=1),
    format_profile INTEGER NOT NULL CHECK(format_profile=1),
    cdc_profile_id BLOB NOT NULL CHECK(length(cdc_profile_id)=32),
    small_file_threshold_bytes INTEGER NOT NULL CHECK(small_file_threshold_bytes BETWEEN 131072 AND 1048576),
    whole_file_delta_max_depth INTEGER NOT NULL CHECK(whole_file_delta_max_depth BETWEEN 0 AND 50),
    chunk_delta_max_depth INTEGER NOT NULL CHECK(chunk_delta_max_depth BETWEEN 0 AND 50),
    metadata_delta_max_depth INTEGER NOT NULL CHECK(metadata_delta_max_depth BETWEEN 0 AND 50),
    next_pack_id INTEGER NOT NULL DEFAULT 1 CHECK(next_pack_id>0)
  ) STRICT;
  CREATE TABLE pack (
    pack_id INTEGER PRIMARY KEY CHECK(pack_id>0),
    domain INTEGER NOT NULL CHECK(domain IN(0,1)),
    digest BLOB NOT NULL CHECK(length(digest)=32),
    length INTEGER NOT NULL CHECK(length BETWEEN 13 AND 16781312),
    body BLOB NOT NULL CHECK(length(body)=length),
    CHECK(domain=1 OR length<=262144)
  ) STRICT;
  CREATE TRIGGER pack_immutable_update BEFORE UPDATE ON pack BEGIN
    SELECT RAISE(ABORT,'published pack immutable'); END;
  CREATE TRIGGER pack_immutable_delete BEFORE DELETE ON pack BEGIN
    SELECT RAISE(ABORT,'published pack immutable'); END;
  CREATE TABLE object_location (
    object_id BLOB PRIMARY KEY CHECK(length(object_id)=32),
    role INTEGER NOT NULL CHECK(role BETWEEN 1 AND 13),
    canonical_length INTEGER NOT NULL CHECK(canonical_length BETWEEN 1 AND 16777216),
    pack_id INTEGER NOT NULL REFERENCES pack(pack_id),
    group_number INTEGER NOT NULL CHECK(group_number BETWEEN 0 AND 255),
    record_number INTEGER NOT NULL CHECK(record_number BETWEEN 0 AND 8190)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE store_totals (
    id INTEGER PRIMARY KEY CHECK(id=1),
    canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical>=0),
    stored INTEGER NOT NULL DEFAULT 0 CHECK(stored>=0),
    metadata INTEGER NOT NULL DEFAULT 0 CHECK(metadata>=0)
  ) STRICT;
  ```

  036 的 pack 是**单记录存储布局**：每对象一个 pack，`body` = 原始规范字节（无帧、
  无压缩），`group_number=0` / `record_number=0`；编码 spec（`specs/039-layerfs-encoding/`
  暂定）以 `user_version` 前向演进到分组 / zstd / PREFIX 布局，旧版拒开不迁移
  （上游 Monolithic → GroupRows 的同款演进路径）。`metadata_delta_max_depth` 036
  未使用，按上游校验范围持久化预留。
- **并发**：进程内每会话 FIFO 准入（`Mutex` + `Condvar`，无时限，`close()` 后等待者
  与后续调用得 `Closed`，持锁者 Drop 释放）；Linux 上写事务前对 **Store 父目录**
  取 `nix::fcntl::Flock` 独占锁（独立打开的目录 fd，绝不另开主 / WAL / SHM 描述符；
  `EINTR → Cancelled`；同目录多个 Store 共享粗粒度车道）；随后单次 `BEGIN IMMEDIATE`，
  `SQLITE_BUSY / LOCKED / PROTOCOL` → 类型化 `Busy`，绝不重试。锁持有范围 = 单个
  原子事务。
- **seal**：`Arc` 唯一引用（否则 `Busy`）→ 一次 TRUNCATE checkpoint → 关连接 →
  校验无 `-wal` / `-shm` 残留 → `SealedStore { path, profile, sqlite_version, bytes }`；
  失败不猜测删除。
- **provider**：`publish(&Publication)` 单事务完成 pack 行插入 + `object_location`
  first-wins 插入（`INSERT OR IGNORE` + 回答 `lost` 列表）+ `store_totals` 累加；
  `locate` 批量查询定位行；`read_packs` 整包读出。`store_totals` 由发布事务内累加，
  不用触发器（036 无 history 行）。

### 4. 测试方案（逐 AC）

| AC | 落点 | 手段 |
| --- | --- | --- |
| AC-1 / AC-14 | `store_tests.rs` | create → 写入 → seal → 断言 `SealedStore.bytes`、无 `-wal` / `-shm`、`open_writable` 重开 |
| AC-2 | `schema_tests.rs` | 用 rusqlite 直接造 `user_version = 99` 的文件，断言 `Malformed` 且文件字节前后一致 |
| AC-3 | `schema_tests.rs` | 直连 rusqlite 把 journal_mode 改为 `delete`，断言拒开 `Malformed` |
| AC-4 / AC-16 | `object_tests.rs` / `cdc_tests.rs` | 上游测试向量（身份、封装、分块边界、`profile_id`）固化为常量对照 |
| AC-5 | `save_tests.rs` | 同内容两次 Save：`inserted=1` → `reused=1`、`packs=0` |
| AC-6 / AC-7 | `reader_tests.rs` | 按序读回、逐块身份校验、缺失 id 断言 `ObjectMissing` |
| AC-8 | `store_tests.rs`（子进程） | 子进程发布一个引用闭包批次后挂起，父进程 `kill` 它；父进程重开断言已发布可读、未发布 `ObjectMissing` |
| AC-9 | `save_tests.rs` | `finish()` 返回后立即 `read_objects` 全可读 |
| AC-10 | `save_tests.rs` | 提交带未存储直接引用的对象，断言 `MissingDependency` 且定位行为空 |
| AC-11 / AC-12 | `store_tests.rs`（多进程） | 两子进程并发 `begin_save` 写不同对象，双 `finish` 后交叉可读；子进程持事务、父进程排队至其释放后完成 |
| AC-13 | `lane_tests.rs`（进程内） | 持有者线程占住会话轮次、排队线程等待中 `Handles::close()`，断言等待返回 `Closed`、后续调用 `Closed`（准入是每会话 / 进程内的语义） |
| AC-15 | `platform_tests.rs` | 冗余分隔符 / `.` 段两种写法 create + open 指向同一文件，`StorePath` 相等 |

多进程用例统一用**测试自派生**：`std::env::current_exe()` 以 `--exact <helper> --nocapture`
启动子进程，环境变量 `LAYERFS_TEST_ROLE` 选角色，stdout 行握手；全部跑在
`cargo test --workspace` 内，不新增二进制。

### 5. 文档与 ADR

- 新增 `docs/core/layerfs.md`（owner / last_reviewed frontmatter）：上游对齐口径 /
  对象身份与封装 / 冻结 CDC / 存储与端口 / 适配器与并发 / 限制 六节，schema 用
  ```` ```sql ```` 块照录 v1 DDL；登记进 `docs/README.md` 地图的主题规格（docs/core）表。
- [docs/core/standalone-core.md](../../docs/core/standalone-core.md)：
  [1.1 Core 侧业务范围](../../docs/core/standalone-core.md#11-core-侧业务范围) 加 layerfs 一行；
  [3.3 构建与目标平台](../../docs/core/standalone-core.md#33-构建与目标平台) 加一句 bundled
  SQLite 由 cc-rs 编译、交叉编译沿用 zig；[7 事实归属](../../docs/core/standalone-core.md#7-事实归属)
  加「LayerFS Store 文件」一行（owner Core / 库内；宿主侧不读写）。
- 立 ADR-0016「LayerFS 内核库的上游对齐策略」：身份 / 封装 / CDC 逐字节兼容、Store
  schema 独立版本、物理编码（zstd / PREFIX / pack 分组）后置——三项都是日后难回头的决策。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/Cargo.toml` | 修改：增 `[workspace] members`；`standalone-core` 增 `layerfs-sqlite` path 依赖 | 无 |
| `core-rs/layerfs/Cargo.toml` | 新增：`blake3`、`sha2` | 无 |
| `core-rs/layerfs-sqlite/Cargo.toml` | 新增：`rusqlite =0.40`（`bundled` / `cache` / `limits`）、`nix`（`fs`，仅 Linux）、`layerfs` path | 无 |
| `core-rs/layerfs/src/**`（第 1 节清单） | 新增 | 无 |
| `core-rs/layerfs-sqlite/src/**`（第 1 节清单） | 新增 | 无 |
| `package.json` → `test:core` | 修改：`cargo test --manifest-path core-rs/Cargo.toml --workspace` | 无 |
| `scripts/coverage-core.mjs` | 修改：`cargo test --no-run` 加 `--workspace` | 无 |
| `scripts/build-core.mjs` | 无改动：已哈希 `core-rs/` 全树（含子目录），`CC` / `CFLAGS` 注入对 cc-rs 全局生效 | 无 |
| `docs/core/layerfs.md` | 新增 | — |
| `docs/core/standalone-core.md` | 修改：1.1 / 3.3 / 7 各加一行 | — |
| `docs/README.md` | 修改：地图登记新规格 | — |
| `docs/adr/0016-layerfs-upstream-alignment.md` | 新增 | — |

`AssistantEventBus` 四组事件、帧协议、wire 消息、会话落盘格式：**均不变**。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在
      Rust 侧；`layerfs` 与 `layerfs-sqlite` 是 lib crate，编译器保证它们不能 import
      `standalone-core` 内部，依赖方向只有 `standalone-core → layerfs-sqlite → layerfs`；
      I/O 只存在于适配器 crate（`layerfs` 的禁 I/O 由守护测试强制，见下）；不涉及
      `src/shared` / `src/host` / 宿主 API，无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      版本不符 / 非 Store 文件 / 损坏 / 已存在路径创建 / 策略越界一律报错，无自动迁移与
      修复（铁律 1）；配置与端口入参全必填、错误是判别联合、无 `Option` 参数（铁律 2）；
      Store 文件是对象数据唯一写入点，句柄只是视图（铁律 4）；冻结 profile / PRAGMA /
      schema 常量只定义在各自一个模块（铁律 6）；跨进程写安全由「目录 flock + SQLite
      事务」承担，不叠加 `fileLock` 口径——后者只针对 settings.json 类「读改写整文件」
      场景（铁律 9）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——
      Store 是全新的 Rust 侧格式，`src/shared/history/` 没有、也不应有对应读写库（宿主侧
      本期不读写 Store）；Core 对外可观察行为、帧协议均不变。接线 spec 若让宿主直读
      Store，届时再评估两侧同步与对照表。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：新增
      `docs/core/layerfs.md` + 地图登记、修订 `standalone-core.md` 三处，与实现同一提交；
      `npm run test:unit -- docs-lint` 绿是收敛前置；schema 代码块为 ```` ```sql ````，
      不含 `export` / 顶层声明，不触发 `src=` 比对。

## 被否决的替代方案

- **bin crate 内的 `mod layerfs`**：零构建脚本改动，但接线前全部 pub 项触发 dead_code
  需整模块压制；无编译器边界；`tui-rs` / 未来挂载进程无法复用。独立 crate 三项全解。
- **单 crate 承载算法 + SQLite**（上一版 plan 的方案）：少一个 crate，但「核心无 I/O」
  只能靠守护测试约束、不能靠编译器；与上游 core/engine 分层相悖，编码 spec 加入 zstd
  FFI 后还要引入上游式 audited-exception 结构。双 crate 从第一天就把边界立住。
- **`fastcdc` crate 做分块**：算法与掩码与上游冻结 profile 不逐字节一致，分块边界不同
  则身份体系与上游脱钩；自复制上游 GEAR 实现保持兼容（MIT 许可 + 来源注记）。
- **SQLite 表直接存对象体（无 pack 表）**：最简，但编码 spec 引入分组 / zstd 时需要
  重建格式；单记录 pack 布局让端口（`Publication` / `PublishedPack`）与 schema 从
  第一天就是编码就绪形态，演进只动 `user_version`。
- **上游式水位线（publication watermark）**：旧 C2 MEMORY-journal 时代的机制，现行
  全局库（WAL）靠 insert-only 定位行 + 引用闭包批次保证可见性；036 不复刻已退役结构。
- **SQLite rollback-journal 模式 / MEMORY journal**：前者写者阻塞读者，后者无进程间
  共享；WAL 是上游现行唯一允许的 journal 模式。
- **`Durable` profile（WAL + `synchronous=FULL` + `fullfsync`）**：上游 owner 政策已
  停用 Durable（身份串 `sqlite-wal-full-v2`），未经所有者重新授权不得执行；本仓库
  遵循同一决策，036 只实现 `Disposable`——若未来需要抗掉电，作为独立改动补 profile，
  不预留半成品代码。
- **busy_timeout 等待制（上一版 plan 的 `write_wait` + `Busy`）**：与上游「无 busy
  handler、一次尝试」相悖，且把排队语义压给每个调用方重试；车道排队（FIFO + flock，
  无时限）让等待发生在 SQL 之前，失败精确。
- **进程内共享连接 / 连接池**：036 无并发写者场景，池只增加 `Sync` 包装与生命周期
  复杂度；fs 层 spec 若出现多线程读热点再引入。
- **遥测 `TimingScope` 参数**：上游每个入口都带，本仓库无该遥测框架；以
  `WriteOutcome` / `Diagnostics` 计数器替代，不为对齐而引入空转参数。
- **独立测试辅助二进制**：多一个 `[[bin]]` 与构建脚本例外；测试自派生（`current_exe` +
  角色环境变量）零额外产物且与 `cargo test` 过滤天然兼容。
