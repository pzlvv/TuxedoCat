---
status: 已修
---

# 缺陷：挂载代理在 user namespace 里建不了视图目录（EOVERFLOW）

Overlay 挂载代理能装机、能通过入口自检，但 `--self-check` 与常驻形态的挂载请求都失败在
「建视图目录」这一步，`mkdir` 返回 `EOVERFLOW`（errno 75）。影响面是 049 阶段一的
overlay 挂载能力：代理就位（`mountProxy: 'ready'` 的必要条件之一成立），但能力应答只能
回 `absent`，Overlay 对话用不了。

## 现状

根因是**代理建了 user namespace**，与 tmpfs 无关。

`unprivileged` 进程建 userns 时只允许映射**一个** uid（调用者自己那个），于是：

- ns 内的那一个 id 对应宿主真实 uid，**其它所有 id 都是 `65534`（overflow）**；
- 凡需要把 kuid 反向映射回 mount 所属 userns 的操作都返回 `EOVERFLOW`
  （`mkdir` 算属主、overlay 建 whiteout …）；
- 这个错误与具体文件系统无关：tmpfs、继承的 `/tmp`、真实磁盘目录**都会**撞上。

### 决定性的实测（真实远端 `8.136.22.171`，内核 6.8.0-63）

| 形态 | `mkdir` 结果 | 结论 |
| --- | --- | --- |
| 建 userns + tmpfs | `EOVERFLOW` | 与 tmpfs 无关 |
| 建 userns + 继承 `/tmp` 目录 | `EOVERFLOW` | 与 tmpfs 无关 |
| **只建 mount ns（不建 userns）** | **成功** | 根因是 userns |

只建 mount ns 的那次实测，overlay 一次挂上、以用户身份写入正常、`upper` 落在真实磁盘：

```
start: uid=1001 euid=0
  overlay rc=0 ok
  merged: uid=1001 gid=1001 mode=755
  dropped: uid=1001 euid=1001 gid=1001
  write merged/user.txt: ok
  upper/user.txt: uid=1001 gid=1001 mode=664
  readback: 'persisted'
```

### 架构结论

代理是 setuid root 启动的，**在初始 userns 里本来就持有 `CAP_SYS_ADMIN`**；再建
`CLONE_NEWUSER` 是主动把自己降进一个残缺的映射。因此：

- 只 `unshare(CLONE_NEWNS)`：挂载隔离照样成立，这是 049 真正需要的隔离边界；
- 全程留在初始 userns，没有 id 映射问题；
- 视图目录落在**真实磁盘**上，重启后 `upper` 仍在，用户修改可恢复。

常驻期要按需挂载，而 `mount(2)` 需要 `CAP_SYS_ADMIN`，降权后的服务本体没有。因此拆成
两个进程：A（euid 0）只做 `mount` / `umount`，B（降权到真实 uid）跑业务并经 socketpair
把挂载请求转给 A。挂载命名空间在 `fork` **之前**建立，A / B 共享同一份挂载表。

### 一并修掉的四个缺陷

| 缺陷 | 症状 | 修法 |
| --- | --- | --- |
| 重复 `waitpid` | EOF 退出码错成 6（`No child process`） | 收尸只在挂载器循环里做一次，退出码由 `Forked::child_exit_code` 带回 |
| `merged` 由 root 创建 | 挂载点 `root:root 0700`，降权后的 B 读不了 | `upper` / `work` / `merged` 全部由 B（用户身份）建，A 只检查存在 |
| 挂载后未验证视图 | `mount()` 返回 0 但视图可能是空的 | `read_through_view`：应答前由代理自己读一次，读不到就卸载并报错 |
| 读 `TMPDIR` | 违反「常驻形态不读环境变量」，且可被指向攻击者目录 | 固定用 `/tmp`，不调 `std::env::temp_dir()` |

另外：`scripts/verify-mount-proxy-remote.mjs` 原判据是「宿主路径下能读到 `lower` 的标记
文件」，这**与设计冲突**——Core 在宿主命名空间里看不见代理命名空间内的挂载
（见 [051 的「不采用 setns」](../051-overlay-root-mount-proxy/spec.md)）。
判据改为双向：宿主侧应为**空目录**（反证挂载没泄漏），代理侧必须读通叠加视图。

## 期望

代理就位后，`--self-check` 的 overlay 实测断言成立、常驻形态的 `probeOverlay` /
`mountOverlay` / `unmountOverlay` 成功，能力应答能给出 `isolatedWorkView: true` +
`mountProxy: 'ready'`（049 的 FR-001 / AC-19 / AC-28j）。

**在修复之前，能力应答必须如实反映当前状态**：代理已装机时 `mountProxy: 'ready'` 成立
（装机、协议握手、拉起都是好的），但 `isolatedWorkView: false` 且 `reason` 点名 overlay
实测失败的具体原因——不能把「代理在、但挂不上」报成「代理不在」，也不能把 `reason` 留成
空串。

## 不变量

- 入口自检（`euid == 0` / 真实 uid `!= 0` / 真实 uid 在允许列表内）与请求收紧（bounding
  set 三项、`umask(077)`、`chdir("/")`、不读环境变量）不变；
- **特权只留在 A**：B 降权后 `getresuid` 三个 id 全为真实值，且 `CapEff` 不含
  `CAP_SYS_ADMIN`（`mount(2)` 对 B 必然 `EPERM`）；
- 回收主路径仍是 socketpair EOF，不依赖 `PDEATHSIG`；
- 代理的 fd 1 / fd 2 只归它自己，工具不继承通信 fd；
- 挂载随命名空间销毁，宿主 `mountinfo` 里无残留；
- 视图目录在真实磁盘上，进程重启后 `upper` 内容保留。

## 回归测试

- **RT-1**：`--self-check` 在真实远端返回 0 并打印 `self-check ok`；断言（B 降权后不含
  `CAP_SYS_ADMIN`、三个 uid 全为真实值、mountinfo 可读、经 A 挂载 overlay 成功）
  全过（落点：`scripts/verify-mount-proxy-remote.mjs` 的「自检」段）。
- **RT-2**：常驻形态的 `probeOverlay` 回 `ok`（落点：同上「常驻形态」段的 `PROBE_OK`）。
- **RT-3**：常驻形态的 `mountOverlay` 回 `ok`；宿主侧看 `merged` 是**空目录**（挂载没有
  泄漏到宿主），且代理侧读通叠加视图（`read_through_view`）；随后 `unmountOverlay` 回
  `ok`（落点：同上 `MOUNT_OK` / `UMOUNT_OK`）。
- **RT-4**：会话关闭后代理进程全部消失且宿主 `mountinfo` 无该视图条目
  （落点：`e2e/electron/overlayMountProxyRemote.spec.ts` 的挂载无泄漏用例）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（代理自检，修复前） | `node scripts/verify-mount-proxy-remote.mjs` | 红 | `自检断言不成立：overlay 实测失败：私有 tmpfs 挂上后仍无法在其下建目录（mkdir(...) 失败（rc=-1 errno=75 ...））` |
| 复现（常驻形态，修复前） | 同上「常驻形态」段 | 红 | `PROBE_FAIL` / `MOUNT_FAIL`，同一 errno |
| 最小 C 对照（建 userns + tmpfs） | 远端 `gcc` 编译后 `sudo` 执行 | 红 | `mkdir errno=75` |
| 最小 C 对照（建 userns + 继承 `/tmp`） | 同上 | 红 | `mkdir errno=75`——tmpfs 不是变量 |
| 最小 C 对照（**只建 mount ns**） | 同上 | 绿 | `overlay rc=0`、以用户身份写入、`upper` 落真实磁盘 |
| 共享挂载表（A 挂 / B 读） | 同上，A 保持 euid 0、B 降权 | 绿 | B 看见 merged、写入、读回；B 自己 `mount` → `EPERM` |
| 自检（修复后） | `node scripts/verify-mount-proxy-remote.mjs` | 绿 | `self-check ok` |
| 常驻形态（修复后） | 同上「常驻形态」段 | 绿 | `PING_OK` / `VERSION_OK` / `PROBE_OK` / `MOUNT_OK` / `UMOUNT_OK` / `STAGE2_REFUSED_OK` / `EOF_EXIT_OK` |
| 端到端 | 同上收尾 | 绿 | `全部步骤通过` |

复原：远端 `8.136.22.171`，用户 `pz`（uid 1001），Linux x86_64 / 内核 6.8.0-63，
`/usr/libexec` 为 `root root 0755`、无 `nosuid`。
