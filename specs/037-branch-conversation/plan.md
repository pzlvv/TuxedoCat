# 实施方案：分支对话（git worktree 隔离）

本方案落实 [spec.md](spec.md)（FR-001 ~ FR-011）的技术路线：分支能力整体沉在 Core
（`core-rs/src/branch/`），工作根改向只在 `SessionState.project` 一处发生；宿主与 webview
只消费一个新增 CoreEvent、一条新增 UiEvent、两条新增 UiRequest；UI 增量收敛到四点——
新对话 split button 下拉、草稿页分支形态、会话标题后的分支标识、对话列表分支标记。
提交 / 历史 / 回退全部交给 git（提交历史不在 UI 展示），不自建快照体系；成果出口是用户
自己执行 `git merge`，我们不做发布。

**两个一句话取舍**：

1. 选 git worktree 而不是 overlayfs 做整个工作区、也不自建 CoW Store——它把「零复制隔离
   + 提交语义 + Windows 可用」三件事同时落在现成工具上；
2. **worktree 放 Core 数据目录（仓库外）**——这是「分支不可见」的全部机制，不靠权限、
   不靠过滤、不靠监视白名单（见第 2 节）。

## 技术方案

### 1. Core 内新模块：`core-rs/src/branch/`

新目录四个文件，单向被 `engine.rs` 调用，不与 `tools.rs` 形成循环依赖：

| 文件 | 职责 |
| --- | --- |
| `core-rs/src/branch/repo.rs` | 仓库探测（`git rev-parse --show-toplevel` / `--git-dir`）、脏工作区判定（`git status --porcelain`）、`branchPrecheckRequested` 应答组装 |
| `core-rs/src/branch/worktree.rs` | worktree 生命周期：`create`（`git worktree add <path> -b tuxedo/<name> HEAD`，一步建目录 + 真实分支）、`reuse`（已存在则复用，校验 HEAD 与 `meta.json` 一致）、`remove`（先卸载依赖挂载 → `git worktree remove --force` → `git branch -D tuxedo/<name>`）、`reconcile_on_start`（启动对账） |
| `core-rs/src/branch/state.rs` | 视图组装：`branchStateChanged` 载荷构造（view 只带 `branch` / `worktree` / `baseCommit` / `baseBranch` 四个事实——不带 commits / dirty / peers / deps，spec FR-008 的窄口径） |
| `core-rs/src/branch/deps.rs` | `DepStrategy` trait（`install` / `uninstall` / `describe`）+ 两档实现：`OverlayDeps`（Linux overlayfs 叠加已知依赖目录）、`SkipDeps`（不搬）；平台与能力探测、upper 目录放 worktree 外（`worktrees/deps/<branch>/`，Core 数据目录内） |

**git 调用方式**：`std::process::Command::new("git")`，固定 `-C <worktree>` 或
`--git-dir=<abs>` / `--work-tree=<abs>`，**不依赖 Core 进程 cwd**（宿主启动 Core 时 cwd
不可控）。所有调用带超时（10s）并捕获 stderr 原文进 `detail`，不做 stderr 解析式判定
（git 的错误文案随版本变）。

**为什么不解析 `.git/worktrees/` 内部格式**：那是 git 私有实现，跨版本会变。所有 worktree
事实都经 `git worktree list --porcelain` 读取。

### 2. 工作根改向：一处改，全工具跟随

```rust 示意
// 分支会话的 project 指向 worktree；普通会话原样（现状语义）
fn project_of(&self, session_id: &str) -> Result<String, String> {
    // 既有实现读 SessionState.project / history / config
}
```

`engine.rs:3303` 的 `ToolContext { cwd: project.to_string(), .. }` 是唯一工具根来源，因此：

- `Write` / `Edit` / `Read` / `Grep` / `Glob` 走 `expand_path(&ctx.cwd, ...)` → 自动在
  worktree 内；
- `Bash` 的默认 cwd 取 `ctx.cwd` → 自动在 worktree 内；`input.cwd` 原样交子进程
  （现状语义不变）；
- 后台任务、`detach`、MCP 工具全部继承同一 `ctx.cwd`。

**不需要**逐工具钩子、不需要 `Materializer` 抽象、不需要精度标注——工具根本不知道自己在
worktree 里，这正是选择这条路线省下的复杂度。

会话在**第一条消息发送时**才建立（既有机制：`startNewConversation` → `conversationStarted`，
`meta.json` 由首条消息的 `appendMessage` 创建）——点「分支对话」只打开「未发送的新对话」
草稿页（`openNewConversation` 的 `new-` 临时 key 视图），不建会话、不建 worktree、不发总线
事件（spec FR-006 创建时序）。首条消息的建立链上：webview 的 `startNewConversation` 载荷带
形态标记（wire 协议）→ 宿主翻译成 `branchModeChanged` → Core 预创建引擎时同步建 worktree
并把 `SessionState.project` 设为 worktree 绝对路径（`meta.json` 的 `branch` 字段存同一事实、
随首条消息落盘，见 FR-001），**改向发生在会话建立那一刻**，此后全生命周期不变。建立失败
（worktree 建不出）→ 会话建立失败，草稿页保留输入、报错可重试。

**「分支不可见」靠的就是这一步**：worktree 不在仓库目录树内，所以主工作区的 `git status`、
IDE 资源管理器、主对话的 `Grep` / `Glob` / `Bash ls`、宿主文件监视器全部看不到它——它们
的根都是主工作区路径，没有一条会走到 Core 数据目录。不需要 `gitignore`、不需要文件监视
白名单、不需要权限隔离。剩下两处是有意可见的：`git branch` 里的 `tuxedo/<name>`（成果
出口）与 `git worktree list`（git 自己的登记表，无法隐藏，也不值得隐藏）。

### 3. worktree 布局与 git 交互

```
<Core 数据目录>/<工作区目录>/worktrees/<branch>/      ← worktree 工作目录（仓库外）
<Core 数据目录>/<工作区目录>/worktrees/deps/<branch>/ ← 依赖 overlay 的 upper 与 workdir（FR-010）
<仓库根>/.git/worktrees/<branch>/                     ← git 自己管理，Core 不碰
refs/heads/tuxedo/<branch>                            ← 真实分支（成果出口）
```

创建序列（触发时机是首条消息的会话建立，不是点「分支对话」——那只打开草稿页；任一步失败
即回滚已做的步，会话建立失败、草稿页保留输入可重试）：

1. `git -C <repo> rev-parse --show-toplevel` 校验仓库（失败 → `not-git`）
2. `git -C <repo> status --porcelain` 探测未提交改动（非空即标注，不阻塞）
3. `git -C <repo> worktree add <path> -b tuxedo/<branch> HEAD`（一步建目录 + 分支；
   失败 → `git-failed` + stderr 原文）
4. 装配依赖策略（见第 4 节）
5. `branch` 字段随首条消息的 `appendMessage` 落盘（`meta.json` 本身此时才创建，现状机制）；
   此前任一步失败则 `umount` + `git worktree remove --force` + `git branch -D
   tuxedo/<branch>` 回滚

**为什么用真实分支而不是分离 HEAD + 隐藏 ref**：去掉发布后，`tuxedo/<name>` 分支指针就是
成果的唯一出口，它必须**随时准确**。真实分支让 `git commit` 自动推进指针（零钩子）；分离
HEAD 则要每轮结束执行 `git update-ref` 补一次，ref 最多落后一轮，用户 `git merge` 时可能
拿到旧提交——出口不可靠。代价是 `git branch` 列表里出现 `tuxedo/` 命名空间，这是有意可见的
（spec AC-5）。

**自毁命令拦截**：分支会话里拒绝作用于**自身**的 `git worktree remove`（含 `--force`）与
`git branch -D tuxedo/<自身分支>`，理由是执行后会话立刻变 `unavailable` 且未提交改动不可
恢复。拦截点放在 `run_bash` 的既有命令校验位置（与危险命令检测同一条路径，不做独立 AST
解析——按 `git` 子命令 + 参数的字符串匹配，误伤面极小）。

### 4. 依赖目录：overlay 只叠加依赖子目录

依赖目录被 `.gitignore` 排除，worktree 天然没有它们。三种可选机制里选 overlay，因为它是唯一
能保住「路径不变」的（pnpm 的 store 链接、venv 的绝对路径 shebang、Cargo 的绝对路径指纹在
复制/克隆后都会失效，overlay 里路径没变所以全部正常）。抽象成 trait，首版装配两档实现：

```rust 示意
// 只叠加已存在的已知依赖目录；其余平台的实现是空操作
trait DepStrategy {
    fn install(&self, repo: &Path, worktree: &Path, branch: &str) -> Result<Vec<MountedDep>, String>;
    fn uninstall(&self, mounted: &[MountedDep]) -> Result<(), String>;
    fn describe(&self) -> DepPolicy;   // 供系统提示组装（不进事件载荷，view 不带 deps）
}
```

| 实现 | 装配条件 | 行为 |
| --- | --- | --- |
| `OverlayDeps` | Linux 且探测成功（**Core 进程内**实际试挂 overlay 通过——实践上即进程持 `CAP_SYS_ADMIN`，如 root / 容器内 / 提权启动） | 对已有依赖目录挂 `overlay`：`lowerdir=<repo>/<dir>`、`upperdir=<Core 数据目录>/<工作区目录>/worktrees/deps/<branch>/<dir>`、`workdir=<Core 数据目录>/<工作区目录>/worktrees/deps/<branch>/.work/<dir>`，挂到 `<worktree>/<dir>` |
| `SkipDeps` | 其余（Windows / macOS / Linux 非特权进程探测失败） | 不挂载，`describe()` 返回「依赖需自行安装」 |

**探测与装配**：`probe_dep_policy()` 在首次创建分支对话时判定一次（`OnceLock` 缓存），
判定方式是**在 Core 进程内实际试挂一个临时 overlay 再卸载**（比读 `/proc/filesystems`
可靠——后者只看模块存在；也不能拿 `unshare -Urm` 子进程代替——子进程在独立命名空间里
挂载成功不代表多线程的 Core 进程自己能挂，且子进程的挂载对本进程不可见，会
「探测通过、真挂失败」）。失败即 `SkipDeps`（非特权桌面进程即此档），不重试、不降级为
link（link 会破坏写隔离）；非特权 Linux 的依赖复用方向（fuse-overlayfs 等用户态方案）
记入 open-questions。

**目录选择**：只挂主工作区里**已存在**的目录，名单固定
（`node_modules` / `target` / `.venv` / `venv` / `vendor` / `.gradle` / `build`）。名单是
常量表，不做可配置（spec 非目标：依赖策略不开放用户配置）。

**upper 放 worktree 外**（`<Core 数据目录>/<工作区目录>/worktrees/deps/<branch>/`——
仓库外、与 worktree 平级、同生命周期）的三个理由：

1. upper 的增量文件与 whiteout 字符设备若落进 worktree，会以未跟踪文件污染该分支自己的
   `git status`；
2. `git worktree remove` 删除 worktree 目录时不撞上层目录（挂载点仍在 worktree 内，
   先卸载即可）；
3. upper 与 workdir 须同一文件系统——都在 Core 数据目录内天然满足。

**卸载顺序**：先 `umount <worktree>/<dir>`（每个挂载点），再 `git worktree remove`。
依赖策略**不进 `branchStateChanged`**（UI 上不常驻展示）：`DepStrategy` 的产物只喂给系统
提示组装（决定提示里那句依赖事实怎么写），并且只在 Core 内部可见。判断是否需要展示时按
「它会不会改变用户行为」——依赖策略不改变，装了依赖就自然可用。

**崩溃残留**：Core 启动时对账（与 worktree 对账同一条链）：枚举 `/proc/self/mountinfo` 里
`upperdir` 指向本工作区 `worktrees/deps/` 的挂载点，仍挂着就卸载；对应分支会话已不存在则
报告孤儿 upper 目录（不自动删，可能是待复用的增量）。

**为什么不用 symlink / clone**：symlink 让分支的 `npm install` 直写主工作区（隔离失效）；
clone（reflink / 块克隆）保住了隔离但保不住路径——venv shebang 与 Cargo 指纹里的绝对路径
换路径即失效，实际仍会触发全量重装，收益不抵复杂度。两者都记入被否决方案。

### 5. 成果出口：只提供事实，不提供动作

本能力不提供发布 / 合并动作（spec 非目标）。Core 只做三件事：

1. 保证 `tuxedo/<name>` 指针随每一次 `git commit` 准确前移（真实分支的天然行为，零代码）；
2. 系统提示里写明出口方式：`git merge tuxedo/<name>`；
3. 删除会话时把提交数与差异计数（`git rev-list --count <base>..HEAD` 与
   `git diff --name-only <base>..HEAD | wc -l`）写进诊断日志——UI 删除确认是定性的
   （view 已收窄，不为确认框恢复计数字段）。

合并、冲突解决、`cherry-pick` 全部由用户（或用户让模型执行）走原生 git。我们**不解析**
合并冲突，也不提供冲突 UI。

### 6. 系统提示增补（分支会话专属）

分支会话的 system prompt 末尾追加一段（实现位置：`core-rs/src/prompt.rs` 的会话级段落组装）：

```
你正在一个独立的 git worktree 里工作，分支 tuxedo/<name>，从 <baseCommit> 分出。
- 你的文件修改只落在当前目录，不会影响用户的主工作区。
- 需要留检查点时用 git commit（仓库已就绪，无需 init / 配置）。
- 用户在主工作区的未提交改动你看不到（worktree 只从已提交内容起）。
- 成果由用户在主工作区执行 git merge tuxedo/<name> 取用，你不需要也不应该自己往主工作区写。
- 依赖目录 <deps 事实>：overlay 档写「已就绪（与主工作区共享，你的安装只影响本分支）」；
  skip 档写「未安装，需要时请自行安装（全局缓存在，通常很快）」。
```

这段是分支对话「模型自己管检查点」的全部实现——模型知道自己在哪、怎么记。

### 7. 契约与持久化

- `src/shared/AssistantEventBus.ts`：`CoreEvent` 联合补 `branchStateChanged`，`UiEvent`
  联合补 `branchModeChanged`（形态到达 Core 的唯一一跳，见 spec FR-006 创建时序），
  `UiRequest` 联合补 `branchTreeRequested` / `branchPrecheckRequested`（会话建立前的入口
  数据）；`WebViewUI` 的映射表同步（漏写会编译报错）。
- `src/shared/history/`：`meta.json` 的 `branch` 字段类型（Rust 侧 `history.rs` 写入，
  TS 侧同名字段读取；旧会话缺失该键时读取侧归一为 `null`，成员必选、不新增可选成员）。
- 快照：**无新增字段**（分支能力不需要配置项——worktree 路径固定、命名固定、无预算）。
  这一点与前一版方案相比是净减法。
- 新增事件按 [events.md 第 7 节](../../docs/architecture/events.md#7-新增事件时的检查清单)：
  定方向 → 定名 → 定载荷 → 四组联合类型 + 映射表 → Core 侧订阅 / `WebviewMessageHandler`
  翻译 → 文档表（docsLint 校验数量、名单、载荷列）。

### 8. 宿主侧改动

| 落点 | 改动 |
| --- | --- |
| `src/webview/App.tsx` | 新对话 split button（主「+」+ 小三角下拉两项）；草稿页分支形态（图标 + 「分支对话」，无分支名）；会话标题后的分支标识（图标 + 「分支对话」+ 分支名，不含状态 / 并行计数）；对话列表分支标记 |
| `src/webview/i18n/{zh,en}.ts` | 新增文案（下拉两项、草稿页与标题标识、置灰原因、脏工作区说明） |
| `src/host/webviewMessages.ts` | `startNewConversation` wire 载荷补形态标记（spec FR-006 创建时序），宿主翻译成 `branchModeChanged` |
| `src/host/ui/` | `branchTreeRequested` / `branchPrecheckRequested` 的 `UiRequest` 翻译与 `branch` 失效原因 |
| `src/host/` 侧栏文件树 | 读 `branchTreeRequested` 应答，回落主工作区读盘 |
| 各宿主 `*ConversationManager` | 对话列表元数据带分支信息（现有 `conversationListChanged` 通道） |
| VS Code 宿主 | `branchStateChanged` 落到既有文件刷新路径；无侧栏文件树，其余 no-op |

不写用户仓库的任何文件：worktree、依赖 upper 都在 Core 数据目录（spec FR-005 / AC-36），
`.gitignore` 一字不动。

### 9. 已知边界

本轮重写后 spec 与 plan 已对齐，无待回写项。实施中若发现 `git worktree add -b` 在
「目标分支已存在」时的行为与预期不符（它只在 `-b` 指定全新名字时成功，撞名会在第 3 步
报错），按 FR-009 的撞名重试处理——重试范围限于名字生成，不回滚 worktree（此时 worktree
尚未建出）。

## 测试方案

正式开发调测在 Linux 上做，但**测试必须能跑在两个平台上**：CI 的 tests job 是
`ubuntu-latest`（smoke.yml / all.yml 全部 `runs-on: ubuntu-latest`），开发机是 Windows。
因此测试分四层，每层都写明「Linux 真跑 / Windows 只跑装配」的边界。

### 1. 测试夹具：真实 git 仓库，不用桩

分支能力的全部行为都落在 git 命令的**真实输出**上（`worktree add` 的错误文案、
`status --porcelain` 的转义、`rev-list --count` 的语义）。用桩替代 git 只能测出我们自己
的假设，测不出真实行为。夹具统一放 `core-rs/src/test_support.rs` 新增的
`GitSandbox`（沿用既有 `Sandbox` 的临时目录 + 退出清理约定）：

```rust 示意
// 一个装了两次提交的最小仓库，测试各自决定要不要加未提交改动
struct GitSandbox { root: PathBuf }   // root/repo 是仓库，root/home 是伪造的 HOME
impl GitSandbox {
    fn init() -> Self;                 // git init + user.email/user.name 本地配置（不碰全局）
    fn commit(&self, files: &[(&str, &str)], msg: &str);
    fn dirty(&self, path: &str, content: &str);   // 造未提交改动
    fn branches(&self) -> Vec<String>;            // git for-each-ref 读回来做断言
}
```

**必须做的事**（否则测试在 CI 上会互相污染）：

- `git init` 后立刻 `git config user.email` / `user.name`（写在仓库本地），**不依赖全局
 配置**——CI runner 上没有 `~/.gitconfig`，`git commit` 会直接失败；
- `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向夹具内的空文件，隔离开发机上的
  `includeIf` / `commit.gpgsign` / 钩子（这是最容易在开发机上过、在 CI 上挂的一类）；
- `core.hooksPath` 指向空目录（我们仓库自己的 `scripts/githooks` 会被继承，提交会被拦）；
- 临时目录走既有 `makeTempDir` 等价物，**不要**在仓库内建夹具（会触发 docsLint 与本仓库
  自己的 docs 校验）。

### 2. Rust 单测（`core-rs/src/branch/*_tests.rs`）：覆盖全部核心逻辑

这一层是证据主体，全部与平台无关或按 `cfg` 分流：

| 测试文件 | 覆盖 | 平台 |
| --- | --- | --- |
| `repo_tests.rs` | 仓库探测（在仓库内 / 子目录 / 非仓库 / 裸仓库）、脏工作区判定（未跟踪/已修改/已暂存三种）、`.git` 缺失 | 全平台 |
| `worktree_tests.rs` | 创建（目录 + 分支一步到位）、撞名重试、复用已存在、创建失败回滚（磁盘只读 / 分支已存在）、删除顺序（卸载 → remove → 删分支）、孤儿对账、用户手删 worktree 后的 `unavailable` | 全平台（Linux 为主证据） |
| `state_tests.rs` | `branchStateChanged` 载荷组装：`ready`（`branch` / `worktree` / `baseCommit` / `baseBranch`）/ `plain` / `unavailable` 三态；断言视图**不含** `commits` / `dirty` / `peers` / `deps` 字段；`branchPrecheckRequested` 的 ok / not-git 两态与 `head` / `dirty` 应答 | 全平台 |
| `deps_tests.rs` | `SkipDeps` 装配与 `describe()`；`OverlayDeps` 的**挂载与卸载**（`#[cfg(target_os = "linux")]`）、只叠加已存在目录、upper 隔离（分支写不影响 lower）、卸载先于 remove | 有挂载权限的 Linux（Core 进程持 `CAP_SYS_ADMIN`）真挂载；非特权 Linux 与 Windows 只跑 `SkipDeps` |
| `naming_tests.rs` | 格式正则、常量表非空与唯一、撞名重试收敛 | 全平台 |

**overlay 用例的跳过口径**（沿用仓库既有的 `skip:` 前缀约定，见
`test_support.rs` 的 ripgrep 产物处理）：

- Linux 但探测（Core 进程内试挂）失败（无 `CAP_SYS_ADMIN`）→ 打印
  `skip: overlay 挂载不可用（Core 进程无 CAP_SYS_ADMIN）`，用例记为跳过而非通过；
- 非 Linux → 只跑 `SkipDeps` 装配用例，`OverlayDeps` 相关用例整体 `cfg` 排除（不是跳过，
  是不参与编译，避免出现「看起来有覆盖其实没跑」的假绿）。

**开发机（Windows）与 CI（Linux）的差异必须显式验证**：`naming_tests` / `repo_tests` /
`worktree_tests` 全部 `#[cfg(not(target_os = "linux"))]` 不排除——Windows 上真跑，证明
「worktree 与路径处理在 Windows 也对」。这是「Linux 调测」之外必须保住的对称性：
Windows 破了没人发现，等于发布即坏。

### 3. TS 侧单测（`src/test/*.test.ts`）：契约与翻译

| 测试文件 | 覆盖 |
| --- | --- |
| `branchContract.test.ts`（新） | `CoreEvent` / `UiEvent` / `UiRequest` 联合类型的判别字段与必选性；`meta.json` 的 `branch` 字段两侧同步（Rust 写 → TS 读的字段名与形态对照表） |
| `branchModeEntry.test.ts`（新） | split button 的两项、置灰条件（非 git / `unavailable`）、等待态（`branchStateChanged` 未到达时不按猜测值渲染）；草稿页形态（不建会话、无分支名、首条消息才建立）；`branchModeChanged` 的翻译用例（`startNewConversation` 形态标记 → 宿主 → UiEvent） |
| `branchTreeRequested.test.ts`（新） | `UiRequest` 应答形态、`not-branch` 回落主工作区读盘、侧栏 `branch` 失效原因触发重读、`branchPrecheckRequested` 的 ok / not-git 两态应答 |
| `standaloneBranch.test.ts`（新） | 真实 Core 二进制驱动：建分支会话 → 收 `branchStateChanged` → 工具写入落 worktree → `git commit` 推进分支 → 删除会话清理。前置 `npm run build:core:host`，产物缺失走 `markSkipped`（与既有 `standalone*` 同口径） |

**`standaloneBranch` 是 Linux 真跑、Windows 跳过的重点**：它驱动真实二进制，CI 上
（ubuntu-latest）是真证据；Windows 开发机上如果没有 `build:core:host` 产物会 `markSkipped`
并打印原因，不算通过。

### 4. e2e（Playwright）：只覆盖 UI 渲染与无 Core 路径

`e2e/webview` 与 `e2e/electron` 没有 git 仓库夹具，也不该为此引入（会拖慢整车道）。
按既有豁免口径，e2e 只覆盖不依赖 Core 的 UI 渲染：

| 用例 | 车道 | 断言 |
| --- | --- | --- |
| 新对话 split button 下拉两项 + 主「+」行为不变 | `webview` | 点击小三角出现两项、无选中态、主「+」走普通创建 |
| 非 git 工作区下分支对话项置灰与提示文案 | `webview` | 置灰 + 原因文案（i18n 双语都验） |
| 草稿页与标题标识渲染（用桩事件注入 `branchStateChanged`） | `webview` | 草稿页只有图标 + 「分支对话」（无分支名）；标题标识只含图标 + 「分支对话」+ 分支名；消息区无横幅、无依赖策略、无并行计数 |
| 标识在 `unavailable` 时的警告色 | `webview` | 警告色 + 悬停原因，不出现常驻状态区 |

**明确不做**：e2e 里不建真实 git 仓库、不跑 `git worktree`、不验证 overlay。三条新 US
的 e2e 豁免理由因此写成「分层验证依赖真实 Core 二进制与真实 git 仓库，e2e 车道无 git
夹具；证据在 `core-rs` 单测 + `standaloneBranch`」，与 spec「对需求基线的影响」一致。

### 5. Linux 调测的具体环境要求

Linux 上跑全量测试的机器需要：

| 项 | 要求 | 缺失时 |
| --- | --- | --- |
| `git` | ≥ 2.17（`worktree add -b` 与 `--porcelain`） | 分支能力整体不可用，`not-git` |
| 文件系统 | overlay 的 upper 与 workdir 同一文件系统（都在 Core 数据目录内，天然满足） | `OverlayDeps` 试挂失败 → `SkipDeps` |
| `CAP_SYS_ADMIN`（Core 进程持有） | 探测（进程内试挂）成功的前提；root / 容器内 / 提权启动即有 | overlay 用例跳过，功能退 `SkipDeps`（非特权桌面 Linux 即此档） |
| 内核 | overlayfs 可用（≥ 3.18） | `SkipDeps` |

**开发机（Linux）首次准备**：

```bash
npm run build:core:host          # 真实 Core 二进制（standalone* 前置）
npm run test:core                # Rust 单测，含 overlay 真挂载
npm run test:all                 # TS 单测 + standalone
npm run test:e2e:local           # e2e 三车道（不含 ssh / pycharm）
```

**验证 overlay 是否真的在本机可用**（与 Core 的探测同口径：本进程直接试挂；非特权用户
预期失败 → `SkipDeps`）：

```bash
d=$(mktemp -d) && mkdir "$d"/{l,u,w,m}
mount -t overlay overlay -olowerdir="$d/l",upperdir="$d/u",workdir="$d/w" "$d/m" \
  && echo "overlay OK" && umount "$d/m"
```

### 6. 门禁

- 本地提交前：`npm run check-types && npm run lint`；涉及 core 加 `npm run test:core`。
- CI 必过：`smoke.yml` 的 `docs-lint` 与 `tests` 两个 job（tests job 先构建 Linux Core，
  所以 Rust 单测与 `standalone*` 都是真跑）。例外：overlay 真挂载用例——ubuntu-latest 的
  runner 是非特权用户，按跳过口径走；真挂载证据在有 `CAP_SYS_ADMIN` 的环境补（本机提权或
  容器内跑 `cargo test deps_tests`，runner 免密 `sudo` 也可选为实施时的加档方案）。
- 本能力的 e2e 只用 `webview` 车道，三车道全跑留给既有能力（分支能力不新增 electron /
  tui 专属用例）。

## 受影响模块与契约

| 模块 | 变更 | 校验 |
| --- | --- | --- |
| `core-rs/src/branch/{repo,worktree,state,deps}.rs` | 新增 | 单测（真实 git 仓库夹具；overlay 用例 Linux 限定） |
| `core-rs/src/engine.rs` | `project_of` 会话级改向 + 系统提示段落 | 既有 `engine_tests` 全绿 |
| `core-rs/src/history.rs` | `meta.json` 的 `branch` 字段读写 | 落盘格式双侧一致测试 |
| `core-rs/src/prompt.rs` | 分支会话提示段 | 单测：普通会话提示不变 |
| `src/shared/AssistantEventBus.ts` | 1 CoreEvent + 1 UiEvent + 2 UiRequest | `standalone*` 帧往返 |
| `src/shared/history/` | `meta.json` 的 `branch` 字段类型（读取侧缺失归一 `null`，成员必选） | 两侧同步测试 |
| `src/webview/App.tsx` + i18n | 入口 / 草稿页 / 标题标识 / 列表标记 | e2e + 单测 |
| `src/host/` | `branchTreeRequested` / `branchPrecheckRequested` 翻译、`branch` 失效原因 | 单测 |
| `docs/architecture/events.md` / `docs/core/standalone-core.md` / `docs/core/standalone-core-boundaries.md` / `docs/architecture/principles.md` / 特性规格（新增 `docs/features/branch-conversation.md`） | 修改 / 新增 | docsLint 全量对照 |

## 宪章检查

- [x] **分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）**：`core-rs/src/branch/` 在 Core 内，不 import TS；契约成员只在
      `src/shared/AssistantEventBus.ts` 定义；`src/host/` 不 import `vscode` / `electron`
      （宿主差异收在既有 `UIHost`）；无 `host.kind ===` 嗅探。
- [x] **架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）**：不过度 fallback——非 git 仓库拒建（不降级为「无隔离的分支对话」）；worktree
      消失转 `unavailable`（不静默重建）；git 失败原样透出 stderr（不猜原因）；overlay 探测失败
      退 `SkipDeps` 是 FR-010 设计的两档装配之一（不是静默降级），一次判定不重试。
- [x] **不让接口 / 参数可选**：`branchStateChanged.view` 是判别联合（`plain` / `ready` /
      `unavailable`），无 `?`；载荷字段全必选，`ConversationMetadata.branch` 用 `| null`
      不用 `?`。
- [x] **一份事实只有一个写入点**：worktree 路径与分支名只有 `meta.json` 的 `branch` 一处；
      主工作区不被本能力写入（成果出口是用户自己的 `git merge`）；`SessionState.project`
      的派生只有 `project_of` 一处。
- [x] **默认值只有一处**：本能力无新增配置项（无预算、无模式默认值、无路径配置），因此
      不涉及；新对话默认仍是普通对话，由 split button 的主按钮承担，无 settings 项。
- [x] **webview 不持有事实默认值**：`branchStateChanged` 未到达时用等待态（转圈），不猜
      「就绪」；分支名不从对话标题猜，只从事件来。
- [x] **Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）**：worktree 生命周期与依赖策略的落点在
      `core-rs/src/branch/` 并同步 `core-rs/src/branch/*_tests.rs`；`meta.json` 的 `branch`
      字段是 core-rs 写、`src/shared/history/` 读的共用格式，两侧同步并有对照测试。
- [x] **依赖策略不引入配置项**：`DepStrategy` 由平台与能力探测自动装配，无 settings 项、
      无仓库级配置文件；默认值「有哪些目录可挂」是常量表（一行代码），不涉单源约束。
- [x] **文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）**：新增 1 CoreEvent / 1 UiEvent / 2 UiRequest / 1 个 `meta.json` 字段（`branch`）→ 同步
      `events.md` 事件表与载荷列、`standalone-core.md` 事实归属、`standalone-core-boundaries.md`
      的 `UiRequest` 表、`principles.md` 事实表、新增 `docs/features/branch-conversation.md`、
      `docs/README.md` 地图；`npm run test:unit -- docs-lint` 必须绿。
- [x] **e2e 口径**：三条新 US 无 e2e，按豁免登记（依赖真实 Core 二进制与真实 git 仓库，
      e2e 车道无夹具），core 侧单测 + `standalone*` 为证据。

## 被否决的替代方案

1. **Linux overlayfs（lower = 活的主工作区，upper = 分支私有）**：语义最贴「分支看到主
   工作区一切改动（含未提交）」，且依赖目录（`node_modules` / `target`）不用重装。否决
   理由：需要 `CAP_SYS_ADMIN` 或非特权 user namespace（内核 ≥ 5.11，发行版策略分裂——
   Debian 默认关），挂载 / 卸载生命周期与崩溃残留清理负担大，Windows 无对应物（导致能力
   平台分裂）。**这不是永久否决**：若将来用户明确需要「分支看到未提交改动」，可在 Linux 上
   以 overlay 替代 worktree 实现，上层契约不变——记入 open-questions。
2. **自建 CoW 存储（reflink / 块克隆 + 内容寻址对象库 + 自建 Commit）**：上一版方案。
   否决理由：把 git 已经做好的事重做一遍——对象去重、Commit 模型、预算淘汰、物化抽象、
   精度档位全部要自己写自己测，而 Windows 上还缺底层能力（ReFS 块克隆要求 Dev Drive
   与 1 MB 对齐，普通用户难以满足）导致整个能力置灰。worktree 让这套体系整体消失。
3. **硬链接副本**：写时原地改会同时改掉源目录（`echo >> f` 即出事），且无法拦截第三方
   进程的写入。只有「写临时文件 + rename」的编辑器才自然断开链接，不可依赖。直接否决。
4. **全量复制目录**：`node_modules` / `target` 量级下每次创建几十秒到分钟级，且与「并行
   多开」的使用方式冲突（开三个分支就占三份空间）。否决。
5. **依赖目录用符号链接（Windows 为 junction）共享主工作区那份**：省时且实现只有一行，但
   分支里的 `npm install` / `pip install` 会直接改主工作区（隔离失效），pnpm 的 store 链接
   与 venv 的绝对路径也会因链接跳转而错乱。否决（形态见「被否决」第 6 条与 spec FR-011）。
6. **依赖目录用 CoW 克隆（reflink / APFS clonefile / ReFS 块克隆）**：保住了隔离，但保不住
   路径——venv 的 shebang、`pyvenv.cfg`、Cargo 指纹里的绝对路径换路径即失效，实际仍触发全量
   重装，收益不抵复杂度；ReFS 路径还要求 Dev Drive 与 1 MB 对齐，普通用户难以满足。否决。
7. **依赖目录挂在 worktree 内（upper 也放 worktree 里）**：upper 的增量与 whiteout 字符
   设备落进 git 工作树，以未跟踪文件污染该分支自己的 `git status` 与 `dirty` 判定
   （挂载点本身在 worktree 内是需求——依赖要出现在原路径，先卸载再 remove 即可）。
   否决，upper 放 `<Core 数据目录>/<工作区目录>/worktrees/deps/<branch>/`（仓库外、
   worktree 平级）。
8. **分离 HEAD + 隐藏 ref（`refs/tuxedo/<name>`）**：上一版方案。ref 只能靠每轮
   `git update-ref` 补写，最多落后一轮，用户 `git merge` 时可能拿到旧提交——成果出口不可靠
   （spec FR-004 的定案理由）。否决，改真实分支 `refs/heads/tuxedo/<name>`：`git commit`
   天然推进指针、零同步代码；代价是 `git branch` 列表出现 `tuxedo/` 命名空间，与用户自己的
   分支混列——**有意可见**（spec AC-5，成果出口）。
9. **提供发布按钮（内部跑 `git merge` 或逐路径应用）**：评审定的是「不需要发布回主工作区」
   ——成果出口交给用户的原生 git。少了发布就少了三方对账、冲突 UI、`branchPublished` 事件
   一整组复杂度。若将来要做，形态是「按钮 → 在用户仓库跑 `git merge` →
   把 git 输出原样展示」，不做自建对账（记入 open-questions）。
10. **分支历史面板（含「回退到此」按钮）**：spec 定稿整块砍掉——提交历史不在 UI 展示
   （模型用 `git log`、用户在终端看），UI 只保留「这是哪个分支」的标识；「回退到此」按钮
   随面板一并消失，回退交给模型的 `git reset`（spec 非目标已登记）。
11. **孤儿 worktree 的 UI 清理入口**：上一版方案的 `branchOrphansRequested` /
   `branchPruneRequested` 一组。spec 定稿砍掉——孤儿只写诊断日志（可能是用户手工创建的
   工作树，不自动删也不推送 UI），少一条 UiEvent、一条 UiRequest 与一个面板区块。
12. **`branchModeChanged` 走新建「模式」概念**：评审已定形态是**一次性创建动作**而非持久
   模式选择；事件名保留 `branchModeChanged` 是因为它承载 `meta.json` 的持久事实（会话是
   plain 还是 branch），但 UI 上不暴露「切换模式」入口。

> 第 1 条、第 2 条与第 5 / 6 条够分量，建议收敛时落两篇 ADR：
> `docs/adr/0016-branch-conversation-worktree.md`（worktree vs 整体 overlay vs 自建 CoW）
> 与 `docs/adr/0017-branch-deps-overlay.md`（依赖目录：overlay vs symlink vs clone）。

## 实施顺序与验证

1. `core-rs/src/branch/`：repo 探测 + worktree 创建 / 复用 / 清理 + 单测（真实 git 夹具）
2. `deps.rs`：`DepStrategy` + `SkipDeps`（先落地，保证全平台可用）→ `OverlayDeps`（Linux
   真实挂载用例）+ 卸载顺序 + 启动对账的挂载残留清理
3. `engine.rs` 的工作根改向 + 系统提示段 + 现有 `engine_tests` 全绿
4. `meta.json` 的 `branch` 字段（Rust 写 → TS 读，两侧同步测试）
5. 契约面（1 CoreEvent + 1 UiEvent + 2 UiRequest）+ `standalone*` 帧往返
6. 成果出口：系统提示写明 merge 出口；删除会话的计数诊断日志
7. 启动对账 + 删除清理
8. webview（split button / 草稿页 / 标题标识 / 列表标记）+ e2e
9. 侧栏文件树读 `branchTreeRequested`
10. 文档同步 + docsLint 绿

每步的验证命令：`npm run check-types && npm run lint`；Core 侧 `npm run test:core`；
契约与文档 `npm run test:unit -- docs-lint`；端到端 `npm run build:core:host && npm run test:all`。
