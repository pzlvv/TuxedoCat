# ADR-0002：Core 进程的 daemon 模型（一个 endpoint 一个 daemon）

- 状态：已采纳
- 日期：2025（Core / UI 架构重构，M14）
- 规格：`docs/core-daemon.md`

## 背景

M14 之前的形态：一个 Host 实例一个 Core 进程，崩溃由 Host 侧重启（`CoreProcess.ts`）。
多工作区（一个工作区一个 Core 进程）与远程接入落地后，进程的启动 / 重启 / 终止责任
留在 Host 会带来：每个 Host 重复一套进程管理、远程机器上无人认领的孤儿进程、以及
「哪个 Host 拥有哪个 Core」的归属混乱。

## 决策

**进程生命周期归 daemon，Host 只做客户端**（当时的「方案 A」）：

- 一个 endpoint（本机或一台远程机器）一个 daemon；一个工作区一个 Core 进程，
  由 daemon 以自身路径加 `stdio` 启动；
- Core 崩溃由 daemon 在同一 channel 上重启并恢复接线；重启次数超限时 daemon 关闭
  channel 并向宿主报告——Host 侧只消费 `channelReset` 与 fatal 事件；
- 控制通道多路复用、thread-per-connection、按连接隔离心跳与计数；单条 channel 的
  拥塞不阻塞其它 channel（背压，[docs/core-daemon.md 第 7.4 节](../core-daemon.md#74-背压)）；
- 每连接的存活 Core 计数归零 + grace 期退出、`--idle-exit` 空闲自退（SSH 引导固定 30s，
  客户端崩溃后远端不留常驻进程）；
- 本地同机工作区不经过 daemon：Host 直接用 `stdio` 起单进程 Core（`CoreProcess.ts`
  保留为单进程形态的传输层）。

## 替代方案（被否决）

- **每个 Host 自己管理全部 Core 进程**（维持现状）：远程机器上 Host 崩溃即留下孤儿
  Core；多 Host 共存时进程归属与重启上限都无处安放。
- **Core 进程自我监督 / 崩溃后由 systemd 类外部设施接管**：分发场景要求零外部依赖，
  且 Windows 无对应设施。
