# ADR-0007：移除 Embedded Core，只保留 Rust 实现

- 状态：已采纳
- 日期：2026-10
- 取代：[ADR-0001](0001-two-core-implementations.md)
- 规格：`docs/core/standalone-core.md`、`docs/core/standalone-core-boundaries.md`

## 背景

[ADR-0001](0001-two-core-implementations.md) 决定同一份 core 侧契约保持两套实现：
Embedded Core（`src/core/`，TypeScript，与 UI 同进程）与 Standalone Core（`core-rs/`，Rust，
独立进程），以 parity 对照表 + 两侧测试锁定对等。运行三年后的事实：

- 双实现的同步成本是每笔 Core 行为改动的固定税：两侧实现、两侧测试、
  parity fixture 与生成器、core-parity 差异登记，缺一侧即视为未完成；
- 产品默认（也是唯一分发）形态始终是 `standalone`；`embedded` 只在开发期
  免构建 Rust Core 时使用，且长期落后于 Rust 侧的行为修补；
- 大量宿主代码要按 `CORE_KIND` 维护双分支（bootstrap 装配、coreFacts 分派、
  打包变体、e2e 注入），每一处都是理解与测试成本。

## 决策

**只保留 Rust 一套 Core**：

- 删除 Embedded Core 全部实现与装配（引擎 / 工具 / LLM 客户端 / MCP / 提示词 /
  压缩 / Spin 执行 / 智能命名等，即原 `src/core/` 的进程内实现）；
- 删除选择机制：`CORE_KIND`、`resolveCoreKind`、esbuild `__CORE_KIND__` define、
  `<envPrefix>_<core.envVarSuffix>` 覆盖入口、`release/embedded/` 打包变体；
- 原 `src/core/` 中被宿主与 webview 消费的共享部分迁入 `src/shared/`
  （叶子层，不 import host 与宿主 API）：总线契约 `AssistantEventBus`、类型、
  配置快照默认值、会话落盘格式读写库（`history/`，与 core-rs 共用同一格式）、
  纯工具、技能加载与 Spin 设计器纯逻辑；
- parity 基建退役：`src/test/fixtures/*Parity.json` 迁为 `core-rs/fixtures/*.json`
  （Rust 测试的行为对照表数据），TS 侧生成器与双跑对等测试删除；
- `docs/core/core-parity.md` 删除（差异登记随双实现一起失去对象）。

## 后果

- Core 行为只改一处；「两套 Core 必须同步改」的流程约束废止；
- 开发期调试 Core 需要 `npm run build:core`（或 `build:core:debug`）产物；
- `src/shared/history/` 与 core-rs 的落盘格式仍是一份格式两个读写方，
  格式变更需两侧同步（由 Rust 测试对照表锁定）。

## 被否决的替代方案

- **继续双实现**：见背景，同步成本无回收；
- **只留 TS 实现**：放弃独立进程形态与多宿主（TUI / 远端 daemon）能力，
  与既有 daemon / SSH 分发链路冲突。
