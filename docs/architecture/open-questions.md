---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：待定事项

本文只列当前仍未定的方向（现状 + 待定）。已经落地的（不论落在哪篇规格）不保留；
定了方向但还没动手的，写清「现状」与「待定」。改动规格中的未决问题（`[待澄清]`）
以本文为去向之一。

## 1. Core（Rust）

规格见 [docs/core/standalone-core.md](../core/standalone-core.md)（形态与契约）、
[docs/core/core-daemon.md](../core/core-daemon.md)（daemon 与远程服务）；连接模型见
[docs/core/client-connection.md](../core/client-connection.md)。

| 项 | 现状 | 待定 |
| --- | --- | --- |
| 断线重连 | 控制连接断开即结束该连接的全部 Core，宿主收到 fatal 事件后把受影响会话标记失败；重新打开工作区恢复（[docs/core/core-remote.md 第 2.5 节](../core/core-remote.md#25-连接与生命周期)） | daemon 控制通道与 SSH 转发的自动重连 |
| SSH 凭证 | 口令明文落 `userData/workspace-state.json`，重启后据此恢复连接（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主固有差异有意保留)） | 凭证的加密存储与钥匙串集成 |
| SSH 认证 | 仅口令认证；主机密钥按 TOFU 记在 `~/<configDir>/known-hosts.json`，指纹不一致即失败（[docs/core/core-remote.md 第 2.8 节](../core/core-remote.md#28-ssh-接入ssh-scheme)） | SSH 密钥 / agent 认证 |
| 内置 `web_search` 工具 | Core 的 Responses API 不下发内置 `web_search` 工具（[docs/core/standalone-core-boundaries.md 第 4 节](../core/standalone-core-boundaries.md#4-不覆盖范围)） | 迁入 |
| 宿主侧直接读取的例外 | 例外表见 [docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 远程工作区落地时把例外迁到 `UiRequest` |
| 工具命令的 tty 模式 | 工具命令一律非交互执行：stdin 接空设备、stdout / stderr 是管道，PATH 由一次登录 + 交互 shell 探测得到（[docs/core/standalone-core.md 第 3.2.1 节](../core/standalone-core.md#321-工具命令的-path)） | 需要 tty 的命令（密码提示、全屏编辑器、靠终端判断决定颜色的工具）：长驻会话的形态、完成检测、stdin 与超时语义 |

## 2. 跨机器部署的传输形态

现状：远程接入已落地且只有 SSH 一条路径（[docs/core/core-remote.md 第 2 节](../core/core-remote.md#2-远程服务start--kill)）——daemon 只绑回环、端口交内核分配，Host 经 SSH 转发接入；帧协议与磁盘格式不依赖「Core 与宿主同机」，宿主侧不直接读 core 的磁盘数据（[layering.md 第 2.1 节](layering.md#21-规则-9-的审计结论)、[docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)的例外表）。

待定：传输形态本身——帧通道目前假定本机 stdin/stdout，没有认证、重连与多宿主复用；换成网络直连通道属于产品决策（[docs/core/standalone-core-boundaries.md 第 4 节](../core/standalone-core-boundaries.md#4-不覆盖范围)）。
