# ADR-0016：LayerFS 内核库以上游 v1.1.0 为锚点——身份逐字节兼容、Store 格式独立、物理编码后置

- 状态：已采纳
- 日期：2026-11
- 规格：[docs/core/layerfs.md](../core/layerfs.md)，随 specs/043 落地

## 背景（Context）

本仓库引入 LayerFS 语义的 Rust 内核库（不可变内容对象库，后续承载映射树、文件系统、
Branch / Commit 与挂载）。上游 [Ephemeral-AI-Lab/layerfs](https://github.com/Ephemeral-AI-Lab/layerfs)
已有成熟实现（MIT），但它是 FUSE 守护进程 + SDK 的完整产品，带遥测框架、zstd FFI、
多 Store 历史格式与 macOS 专项路径；本仓库只需嵌入式的内核库，且要能跨 Windows /
Linux 构建。三个无法回头的决策必须在第一份 spec 落定：对象身份算法（一旦存入 Store 就不
能改）、Store 文件格式归属（与上游互开还是独立）、物理编码（压缩 / delta）何时引入。
上游代码演进活跃（HEAD 比最近 tag 多一个 engine/ 目录重排），对照基线必须钉死。

## 决策（Decision）

1. **版本锚点**：以上游 **v1.1.0**（commit `9f97a7ec95b662e9cb288704afa165feff132cfa`）
   为唯一对照基线；本地参考克隆固定在该 tag，逐字节兼容项的测试向量一律取自该锚点的
   真实输出并固化为常量（`core-rs/layerfs/src/object/object_tests.rs`、
   `core-rs/layerfs/src/cdc/cdc_tests.rs`），不随上游前进。
2. **身份、封装与分块逐字节兼容**：`ObjectId`（BLAKE3 域分隔摘要）、`LFSO` 封装帧、
   WholeFile / Chunk 值语法（`LFS5SML\0` / `LFS4CHK\0` magic）、冻结 GEAR CDC profile
   （表、掩码、种子、零游程特例、`profile_id`）与上游一致——同一字节内容在两边得到同一
   个对象身份与同样的分块边界。GEAR 表与扫描器算法逐字复制（MIT，文件头版权注记）。
3. **Store 文件格式独立**：schema 版本从本系列的 `user_version=1` 起算，`application_id`
   是自有常量；表组只含对象层四表（策略 / pack / 定位行 / 计数）；不与上游 Store 文件互开，
   不承诺迁移上游文件。
4. **物理编码后置**：043 的 pack 是单记录布局（body = 原始规范字节），zstd / PREFIX
   delta / pack 分组 / 池化元数据由编码 spec 以 `user_version` 前向演进引入，旧版拒开不
   迁移；端口形状（`Publication` / `PublishedPack` / `PackInfo`）从第一天就是编码就绪形态。
5. **持久化 profile 只实现 Disposable**（WAL / `synchronous=OFF`）：与上游所有者决策一致
   （`Durable` 已停用，未经重新授权不得执行）；不预留半成品代码。
6. **并发模型沿用上游**：单全局库、单写者、短持有——进程内 FIFO 准入 + Linux 父目录
   flock + 单次 `BEGIN IMMEDIATE`、`busy_timeout=0`、绝不重试；非 Linux 平台以 SQLite
   自身文件锁的精确 `Busy` 为准（上游 macOS 同款）。
7. **双 crate 分层**：`layerfs`（纯算法、禁 I/O、禁 unsafe）与 `layerfs-sqlite`（唯一
   触碰文件 / 数据库的适配器），镜像上游 core / engine 分层，边界由编译器保证。

## 替代方案（被否决）与后果（Consequences）

- **直接依赖上游 crate**（git 依赖或 vendoring 全部 crate）：上游带遥测框架、zstd FFI、
  历史格式与 macOS 专项路径，Windows 目标不受支持，API 面随产品演进；嵌入成本与跟随成本
  都高于按锚点移植核心算法。
- **自研分块 / 身份（如 `fastcdc` crate + 自定义摘要）**：与上游永久脱钩，日后任何互操作
  （导入上游 Store、共享对象）都要重写身份体系；逐字节兼容的代价只是复制一张表。
- **与上游 Store 文件互开**：上游 schema 带 history / lineage / merge / acquisition 等
  二十余表、三种 pack 布局与 macOS seal 专项，且版本号持续变动；互开意味着跟随全部格式
  演进。独立格式让本系列按自己的 spec 节奏演进。
- **043 即引入 zstd / delta**：需要 C FFI 与 unsafe 例外结构（上游的 audited-exception
  模块），且压缩选择策略依赖尚未落地的映射树；先以单记录布局立住端口与并发模型，编码
  作为独立 spec 可被单独验收。
- **两档 profile 都实现**：`Durable` 在上游被所有者停用，实现它只是多一条未被验证的路径；
  若未来需要抗掉电，作为独立改动补 profile。
- **busy_timeout 等待制 / 连接池**：与上游「无 busy handler、一次尝试」相悖，会把排队
  语义压给每个调用方重试；车道排队让等待发生在 SQL 之前、失败精确。

后果：上游锚点升级是显式决策（重新生成测试向量、复核常量），不是日常依赖升级；Store
文件与上游不互通；Windows 上没有跨进程写车道（文档化的 `Busy` 语义），换锁文件的扩展只
动平台缝模块；Windows ARM64 本机构建依赖 zig 充当 clang（`core-rs/.cargo/config.toml`）。
