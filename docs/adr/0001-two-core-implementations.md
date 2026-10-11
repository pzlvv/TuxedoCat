# ADR-0001：Core 的两套同契约实现（Embedded TS + Standalone Rust）

- 状态：已采纳
- 日期：2025（Standalone Core 落地，M0–M8）
- 规格：`docs/standalone-core.md`、`docs/core-parity.md`

## 背景

Core（引擎 / 工具 / 历史 / MCP / 技能）最初与 UI 同进程，用 TypeScript 写在 `src/core/`。
后续需要：独立进程的运行形态（资源隔离、崩溃不影响 UI）、同一份 Core 服务多个宿主
（VS Code 扩展、Electron、TUI）、以及在无 Node 运行时的环境分发 Core。

## 决策

**同一份契约、两套实现**：

- Embedded Core（`src/core/`，TypeScript）与 UI 同进程，保留为唯一真值；
- Standalone Core（`core-rs/`，Rust）是独立进程，经 stdin/stdout 帧通道对 UI 呈现**同一份**
  `CoreEvent` / `CoreRequest` / `UiEvent` / `UiRequest` 词汇表，落盘格式一致；
- 装配由单一选择变量 `CORE_KIND`（`embedded` / `standalone`）决定，默认 `standalone`；
- 行为对等由 parity 测试 + `src/test/fixtures/*Parity.json` 对照表锁死；
- 有意保留的差异逐项登记在 `docs/core-parity.md`（原 TS 有 bug 的不复刻、Rust 更健壮的保留）。

## 替代方案（被否决）

- **只留 Rust 一套**：一次性重写风险大，且 Embedded 形态仍是测试与调试的最快路径
  （进程内直调、无产物依赖），两套并存的对价由对照表控制。
- **Rust 侧做 TS 的转译层 / FFI 复用 TS 代码**：无法摆脱 Node 运行时，违背独立分发的目标。
- **渐进抽接口再逐模块替换**：契约（事件词汇表）本来就已经把 Core 与 UI 隔开，
  没有必要再加一层「Core 内部接口」的间接层。
