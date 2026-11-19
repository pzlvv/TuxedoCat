# ADR-0017：Overlay 挂载改由 root 属主 + setuid 位的代理完成特权前置

- 状态：被取代（[ADR-0018](0018-resident-mount-proxy.md)）
- 日期：2026-11-14
- 规格：[docs/core/mount-proxy.md](../core/mount-proxy.md)、
  [docs/core/conversation-work-view.md](../core/conversation-work-view.md)

## 背景（Context）

Overlay 对话需要一个私有挂载命名空间来把「真实工作区 + 本对话改动」叠起来。Core 原本自己
做这件事：`run_core()` 最早期 `unshare(CLONE_NEWUSER)` + 写 id 映射，拿到命名空间内的
`CAP_SYS_ADMIN` 后再 `unshare(CLONE_NEWNS)`。

在限制非特权用户命名空间的主机上，这条路的 `uid_map` 写入回 `EPERM`，于是
`storageCapabilitiesRequested` 恒回不可用、Overlay 入口永不渲染——功能整体不可用。实测同时
确认：setuid 二进制**自己**写 `/proc/self/uid_map` 也被拒，必须由**仍是 root 的父进程**替
unshare 过的子进程写。

约束：

- 用户明确否决「执行期写 sudoers 免密规则」；
- 代理随 Core 打包、暂不按指纹分槽，落到 `/usr/libexec` 下；
- 用户拒绝部署时必须**阻止创建、消息不发**，不能出现「勾了 Overlay 却写真实磁盘」。

## 决策（Decision）

用一个随 Core 分发的独立可执行文件（`<core.mountProxyName>`）做**特权前置**：

- 安装为 `root:root` `04755`，装在 `<core.mountProxyDir>/<core.mountProxyName>`；
- 它只做四件事：建用户命名空间、由仍是 root 的父进程写一组单 uid 映射、建私有挂载命名空间、
  降权后监督目标进程；
- 挂载仍由 Core 在自己的命名空间里发起；文件 IO 不经代理；代理不常驻；
- 入口裁剪 capability bounding set、校验调用者在 root 侧写入的允许列表内、只接受产品 Core
  可执行文件、做完映射立刻降权；
- 安装内容**经标准输入**进 root 侧（不经路径），`chown` / `chmod` 在 `rename` 之前完成。

代理与 Core 之间有一次协议版本握手；不匹配则不引导、能力回 `absent`。

## 替代方案（被否决）与后果（Consequences）

**被否决的方案：**

| 方案 | 否决理由 |
| --- | --- |
| file capabilities（`cap_setuid,cap_setgid=ep`） | 过不了限制非特权 userns 的那道闸——判据是本命名空间内的 `CAP_SYS_ADMIN`，`cap_setuid` 不属于它。加上 `cap_sys_admin` 后并不比 root 窄，却换来 xattr 依赖、`nosuid` 同样失效、硬化扫描漏检。 |
| 执行期写 `/etc/sudoers.d/` 免密规则 | 用户已明确否决：改系统授权配置属于越权改用户状态。 |
| 代理常驻并独占 mount（每条 Bash 由代理 fork + bind） | 工具路径全部改写，代理要常驻 + IPC；而隔离的收益并不因此增加（命名空间内能力对调用者本人不是边界）。 |
| 全部文件 IO 经代理 IPC | Read / Write / Edit / Grep 全部重写，收益与代价不匹配。 |
| 让管理员关掉内核开关 | 用户机器不可控，且方向相反：本决策就是为「开关已关」的机器提供能力。 |
| 只做远端、不做本地 | 本地是主场景；远端与本地共用同一套安装与自检。 |
| 代理按 Core 指纹分槽 | 代理与指纹无关（与 `ripgrep` / `fd` 同口径）；分槽只会让多版本并存时反复要求提权，语义漂移由协议版本握手兜住。 |
| 卸载做 GUI 按钮 | 一次性动作，文档化幂等命令足够；GUI 要处理权限、失败态与多用户。 |

**代价（后续维护者需要知道的）：**

1. **这套设计不是沙箱。** 代理把发行版显式关掉的那项内核攻击面重新提供给本地用户。规格
   把这一点写在最前面，并用两条收窄（允许列表 + bounding set 裁剪）限制影响范围，但没有
   ——也不能——把它变成安全边界。
2. **目标路径校验只是卫生措施。** 产品 Core 自带 Bash，能启动它就能在同一命名空间里执行
   任意代码；`O_NOFOLLOW` + 单 fd 执行解决的是 TOCTOU，不是越权。
3. **宿主观察到的 pid 是代理，实际执行 Core 的是它的子进程。** 孤儿兜底依赖链式
   `PDEATHSIG` 与代理的信号转发，两处缺一就会退化成轮询。
4. **密码无法真正清零**（JSON 串在 V8 堆里各留一份），只能保证不主动留存。
5. **代理必须静态链接**：动态链接会让 setuid 下的 `LD_*` / `GCONV_PATH` 一族重新成为问题。
6. **一行容易写错的内核约束**：bounding set 里必须保留 `CAP_SYS_ADMIN` 等三项，全丢时
   `unshare(CLONE_NEWUSER)` 会 `EPERM`——即便 `CapEff` 仍是满的。
