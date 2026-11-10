---
status: 已收敛
---

# 改动规格：内置 fd 随产品分发与工具 shell 的 PATH 前置

`rg` 早已随 Core 分发，但它只被 Grep / Glob 以绝对路径 spawn，模型在 `Bash` 里跑
`rg` 仍要靠目标机器自己装过。本次把预编译 `fd` 纳入同一条分发链（构建产物、SSH
引导部署、TUI 安装器），并让 `Bash` 工具 shell 的 PATH 前置内置 `rg` / `fd` 两份产物
所在目录，使模型可以直接使用；系统提示词相应声明「优先 `rg` 代替 `grep`、`fd` 代替
`find`」。范围只到工具的可用性与提示词口径，不新增工具、不改用户自己的终端。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 3.1 节 平台矩阵](../../docs/core/standalone-core.md#31-平台矩阵) | 修改 | 部署单元与共享位从「自带 `ripgrep/`」扩为「自带 `ripgrep/` + `fd/`」；仓库产物目录补 `resources/fd/<dir>/` |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 3.2.1 节 工具命令的 PATH](../../docs/core/standalone-core.md#321-工具命令的-path) | 修改 | PATH 注入改为「内置目录前置 + 探测到的用户 PATH」，两种形式同源；补「缺失目录不注入、缺工具由命令自身报错」的口径 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 3.3 节 构建与目标平台](../../docs/core/standalone-core.md#33-构建与目标平台) | 修改 | 预编译产物来源补 fd（版本、musl 变体、入库校验口径）；`build-core.mjs` / `verify-core-artifacts.mjs` 的必检项 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 7 节 事实归属](../../docs/core/standalone-core.md#7-事实归属) | 修改 | 事实行「ripgrep」改为「随 Core 分发的 rg / fd 两份内置工具」 |
| [docs/core/core-remote.md](../../docs/core/core-remote.md) | [第 2.8 节 SSH 接入](../../docs/core/core-remote.md#28-ssh-接入ssh-scheme) | 修改 | 引导期部署产物清单加 fd（缺了才传、原子上传、不因补传重启在跑的 daemon） |
| [docs/features/tui-installer.md](../../docs/features/tui-installer.md) | [第 2 节 功能需求](../../docs/features/tui-installer.md#2-功能需求) | 修改 | FR-002 的部署布局与[第 3 节 行为规格](../../docs/features/tui-installer.md#3-行为规格)的载荷嵌入都带上 `fd/fd[.exe]` |
| [docs/hosts/tui.md](../../docs/hosts/tui.md) | [第 2.4 节 Core 产物定位](../../docs/hosts/tui.md#24-core-产物定位tui-rssrccore_rootrs) | 修改 | 共享位清单加 `fd/`（与 ripgrep 同级同口径） |
| [docs/architecture/repo-map.md](../../docs/architecture/repo-map.md) | [目录布局](../../docs/architecture/repo-map.md#目录布局) | 修改 | 登记 `resources/fd/`（构建源）与 `resources/core/<dir>/fd/`（随 Core 落位） |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | [EP-7 工具与技能](../../docs/features/user-stories/tools.md#ep-7-工具与技能) | 修改 | 新增 US-77（工具 shell 自带 rg / fd 并优先使用） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [附录：US 与 e2e 场景用例映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 修改 | 登记 US-77 的 e2e 豁免理由（不新增 e2e 用例） |

`docs/core/standalone-core.md` 当前 493 行，逼近单篇 500 行上限：本次四处 delta 必须在既有段落内就地改写（不新增小节），否则按 [docs/README.md](../../docs/README.md) 的拆分口径另立主题分册。

系统提示词正文**没有 as-built 文档**：事实只在 `core-rs/src/prompt.rs` 与 `core-rs/fixtures/systemPrompt.json`。本次五处提示词修订的文本基线就写在本 spec 的 FR-006（逐字给全文），落地后以代码与对照表为准，冻结在 `docs/archive/specs/044-bundled-fd-and-tool-path/`。

## 用户场景与验收标准

- 场景 1：本地工具 shell 直接能用内置 rg / fd
  - **AC-1**（FR-004）：GIVEN 本机 Core 产物同时带 `rg` 与 `fd` WHEN 模型执行 `command -v rg; command -v fd` THEN 两条都命中，且解析到的路径位于 Core 产物目录内。
  - **AC-2**（FR-004）：GIVEN 用户 PATH 里已装过另一个 `rg` WHEN 在工具 shell 里执行 `rg --version` THEN 命中的是内置那份（前置生效，同名命令被遮蔽）。
  - **AC-3**（FR-004）：GIVEN Git Bash 作为工具 shell（Windows） WHEN 执行 `printf '%s\n' "$PATH"` THEN 前置条目是 POSIX 形式（`/c/...`），且 `command -v fd` 命中。
  - **AC-4**（FR-004）：GIVEN 内置 `fd` 目录不存在（旧产物） WHEN 依次执行 `echo hi` 与 `fd --version` THEN 前者正常成功（PATH 不含该目录），后者由 shell 报 `command not found`——问题由命令本身暴露，不注入额外错误。
  - **AC-5**（FR-004）：GIVEN 同一条命令转入后台 WHEN 读该后台任务的 PATH THEN 前置的内置目录及其顺序与前台一致。
  - **AC-6**（FR-004）：GIVEN 原生子进程（MCP stdio server、`rg` 兜底） WHEN 启动 THEN PATH 前置同一组目录的 Windows 形式。
- 场景 2：内置目录解析只有一份
  - **AC-7**（FR-005）：GIVEN 同一份产物布局 WHEN 比较 Grep / Glob 解析出的 `rg` 与 PATH 注入的内置目录 THEN 两者由同一纯函数给出，位置判定一致。
- 场景 3：远端部署
  - **AC-8**（FR-002）：GIVEN 远端产品共享位只有 `rg` WHEN 完成 SSH 引导 THEN `fd` 上传到产品共享位、置可执行位，已存在的 `rg` 不重复上传。
  - **AC-9**（FR-002）：GIVEN 远端已有本指纹的 daemon 在跑 WHEN 引导时补齐缺失的 `fd` THEN 补齐后复用同一个 daemon（端口取自状态文件），不重启。
  - **AC-10**（FR-002）：GIVEN 本机 Core 产物里缺 `fd` WHEN 触发引导部署 THEN 直接报错并给出重建产物的命令，不静默跳过。
  - **AC-11**（FR-002）：GIVEN 远端工具 shell WHEN 执行 `command -v rg; command -v fd` THEN 两者都命中且位于 `~/.local/share/<core.deployPrefix>/` 内。
- 场景 4：构建与打包
  - **AC-12**（FR-001）：GIVEN `npm run build:core` WHEN 构建平台矩阵里的四个目标 THEN 每个 `resources/core/<dir>/` 同时出现 `rg` 与 `fd` 两份可执行产物。
  - **AC-13**（FR-001）：GIVEN 打包校验 WHEN 某个目标的 `fd` 缺失 THEN 校验失败并给出该目标的重建命令。
  - **AC-14**（FR-001）：GIVEN `npm run copy-assets` WHEN 完成 THEN `dist/resources/fd/`（构建源）被清理，`dist/resources/core/<dir>/fd/`（随 Core 落位）保留。
- 场景 5：TUI 安装器
  - **AC-15**（FR-003）：GIVEN 构建完成的 TUI 安装器 WHEN 安装 THEN `<前缀>/share/<core.deployPrefix>/fd/fd[.exe]` 落位且可执行；再次安装时因内容未变而跳过。
- 场景 6：系统提示词
  - **AC-16**（FR-006）：GIVEN normal 预设的系统提示词 WHEN 读 `### Bash` 段 THEN 含 FR-006 定稿的 `**Prefer ripgrep and fd**` 块（`rg` 代替 `grep`、`fd` 代替 `find`），且 `Syntax Guidelines` 与 `Common Usage` 的示例已换成 `rg` / `fd`。
  - **AC-17**（FR-006）：GIVEN normal 预设的系统提示词 WHEN 读 `### Grep` / `### Glob` 段 THEN 含 FR-006 定稿的「单个搜索优先用工具、需要组合时用 Bash `rg` / `fd`」两条规则，且全文不再出现 `never use the Bash tool with` 式禁令。
  - **AC-18**（FR-006）：GIVEN normal 预设的系统提示词 WHEN 检索全文 THEN 不出现产物来源、PATH 位置、版本号、缺失处置等实现事实（提示词只陈述使用规则），静态部分与 `core-rs/fixtures/systemPrompt.json` 逐字一致。
  - **AC-19**（FR-006）：GIVEN minimal / mixed 预设 WHEN 组装的提示词 THEN 仍是单行核心身份、不含工具说明段（不引入第三个分支）。

## 功能需求

### FR-001：fd 随 Core 产物分发

- 构建源目录 `resources/fd/<arch>-<platform>/fd[.exe]` 与平台矩阵一一对应，四个平台取自 fd 官方 release 的**同一版本**；Linux 两份用 musl 静态链接目标（与 `resources/ripgrep/` 同口径）。许可文件随产物入库（fd 为 MIT / Apache-2.0 双许可）。
- `npm run build:core` 把 `fd` 与 `rg` 一起落到 `resources/core/<dir>/`（与 Core 可执行文件同级），任一缺失即构建失败。
- 打包校验（`verify-core-artifacts.mjs`）把 `fd` 列为必检项：构建产物缺失、`dist/resources/` 里没同步，都直接报错。
- `copy-assets` 只把随 Core 落位的那份带进 `dist/`，构建源目录 `dist/resources/fd/` 清理掉（无读取方）。
- vsix 打包在 Windows 上产出的 Linux 可执行位修复覆盖新增的 `fd`。

### FR-002：SSH 引导部署 fd

- 远端落位口径与 `rg` 相同：产品共享位（`~/.local/share/<core.deployPrefix>/` 下与指纹槽位同级）放一份，全部指纹槽位共享——fd 的行为不随 Core 版本变。
- **缺了才传**：远端已有该文件就跳过上传；本机产物里缺 `fd` 属于构建不完整，直接报错并给出重建命令。
- 上传沿用原子上传（客户端唯一暂存名 + `rename`）：目标可能正被执行，直接覆盖写会是 `ETXTBSY`。
- 补齐内置工具不重启已在跑的 daemon：引导仍按状态文件复用，`start` 只在该指纹没有可用 daemon 时执行。
- 平台 / 架构由远端 `uname -sm` 决定，取本机对应平台的产物；不在矩阵内仍报错，不猜目录。

### FR-003：TUI 安装器载荷带 fd

- 安装器内嵌载荷含 `fd`，布局为 `<前缀>/share/<core.deployPrefix>/fd/fd[.exe]`（与 `ripgrep/` 同级）。
- 构建期缺 `fd` 产物即构建失败并给出补救命令；安装保持既有的幂等与原子口径（内容未变跳过）。
- 产品目录名、Core 二进制名等身份字段仍只来自 `src/config/project.json`，源码不出现产品字面量。

### FR-004：工具 shell 的 PATH 前置内置 rg / fd 目录

- `shell_env.rs` 仍是 PATH 的唯一写入点：注入内容 = 内置 `rg` / `fd` 所在目录（前置，顺序固定）+ 探测到的用户 PATH。
- 两种形式同一份来源：shell 形式给 `$SHELL -c` 拉起的命令（前台 `Bash`、后台任务），原生形式给原生子进程；Windows 上 shell 形式按 POSIX 形式表达（`C:\a\b` → `/c/a/b`，UNC `\\server\share` → `//server/share`），不得把含 `:` 的 Windows 路径塞进 POSIX 列表。
- 内置目录前置意味着同名命令被遮蔽：模型在工具 shell 里跑 `rg` / `fd` 恒用内置那一份，行为不随目标机器是否装过而漂移。
- 目录不存在时**跳过该目录**，命令照常执行；缺工具由命令本身暴露（`command not found`），不额外注入错误。构建 / 打包 / 部署三个环节仍是严格报错，跳过只发生在运行期注入这一处。
- 同一目录已在用户 PATH 里时不重复前置（去重后顺序仍是「内置在前」）。

### FR-005：内置产物目录解析只有一份

- 内置工具所在目录的候选顺序只有一处实现：Core 可执行文件同目录下的内置目录 → 该槽位上一级的产品共享位 → 宿主 `extensionPath` 下的开发期产物；都没有则视为缺失。
- Grep / Glob 解析 `rg` 与 PATH 注入复用同一份结果，不再各写一套候选列表；`ripgrep_path` 既有的「找不到就回退 PATH 上的 `rg`」保留。
- 文件名按平台加 `.exe`，目录名按 `<arch>-<platform>` 解析；矩阵外的组合直接报错，不猜目录。

### FR-006：系统提示词的搜索工具口径（逐字定稿）

提示词正文没有 as-built 文档，五处修订的最终文本以本节为准，实施时逐字照抄进
`core-rs/src/prompt.rs`，并重生成 `core-rs/fixtures/systemPrompt.json`。

**只写使用规则**：文本里不出现工具从哪来、加了什么 PATH、哪个版本、缺了怎么办——这些是
实现事实，写进提示词只会让模型把「规则」读成「环境说明」，也随实现变动而腐烂。

**（1）`### Bash`：`**IMPORTANT**` 段之后插入一个块**

```text
**Prefer ripgrep and fd**: use `rg` instead of `grep`, and `fd` instead of `find`:
- Content search: `rg -n 'pattern' src` instead of `grep -rn 'pattern' src`
- File search: `fd -e ts util` instead of `find . -name '*util*.ts'`
- Use `grep` / `find` only when the command must run outside this environment.
- The first argument is the pattern, not a path: write `fd -e ts . src`, not `fd -e ts src`.
- No `/` inside the pattern: use `-p` with a glob, e.g. `fd -p -g '**/i18n/*.ts' src`.
- Empty output is not absence: `.gitignore` and hidden entries are skipped (`-I` / `-H`), and no match exits 0.
```

这三条规则对应三种会被误读为正常结果的行为：把搜索根当 pattern、pattern 中写路径、空输出被
当成文件不存在。它们都只是使用规则，不涉及产物来源或版本。

**（2）`### Bash`：`Syntax Guidelines` 的 unix 命令清单**

`- Use unix-style commands: … sort, grep, find, head, …` 里把 `grep, find` 换成 `rg, fd`
（其余条目与顺序不变）。

**（3）`### Bash`：`Pipes & Command Chains` 与 `Common Usage` 的示例**

- 管道示例：把 `` `|` pipes the output of one command into the next: `grep pattern file.txt | sort | uniq` ``
  改成 `` `|` pipes the output of one command into the next: `rg -l 'pattern' src | sort` ``。
- 引号示例保持不变（`grep "a|b" file.txt` 讲的是引号语义，不是推荐工具）。
- `Common Usage` 的 `- Search: grep 'pattern' file.txt` 拆成两行：
  `- Search file contents: rg 'pattern' file.txt`、
  `- Search file names: fd -e ts pattern`。

**（4）`### Grep`：`When to use` 三条替换为下面两条**

```text
- Use this tool when you need to find files containing specific text or patterns
- Prefer this tool for a single search; use Bash `rg` when the result feeds another command
  (e.g. `rg -l 'TODO' src | xargs wc -l`) or you need a ripgrep flag this tool does not expose
```

**（5）`### Glob`：`When to use` 三条替换为下面两条**

```text
- Use this tool when you need to find files matching a specific pattern
- Prefer this tool for a single search; use Bash `fd` when the file list feeds another command
  (e.g. `fd -e ts . src | xargs rg 'TODO'`) or you need an fd flag this tool does not expose
```

三条硬约束：

- 全文不再出现 `never use the Bash tool with` 式禁令：代码里没有任何拦截，写成禁令只会让
  模型在需要管道组合时无所适从。
- 「工具优先」与「Bash 里用 `rg` / `fd`」是分工而非对立：单个搜索走工具，需要组合时走
  Bash，两处措辞都给出对方的适用场景。
- 同一段文字不重复另一段的参数说明（避免同一事实两处腐烂）。

**（6）对照表**：`core-rs/fixtures/systemPrompt.json` 的 `toolUsage` 按上述五处逐字更新；
`prompt_tests.rs` 的逐字断言（含 `## Tool Usage` 清单与 `## Tool Details` 段）同步。

## 边界与错误路径

- **运行期缺目录（不是 fallback，是让流程继续）**：内置 `rg` 或 `fd` 目录不存在时跳过该目录继续注入其余条目，命令照常执行；缺工具由命令本身报 `command not found`，问题照样暴露给使用者。这是**故障暴露路径**而不是掩盖路径：注入侧若是抛错，整条 Bash 命令都会失败，连带上百条与搜索无关的命令也用不了，真正的问题反而被埋在后面。范围同样被夹在 PATH 注入这一处，构建 / 打包 / 部署仍然严格报错。
- **Windows POSIX 形式转换失败**（既不是盘符路径也不是 UNC）：跳过该目录，不把坏条目注入 PATH；原生形式不受影响。
- **远端共享位残缺**：只有 `rg` 缺 `fd`（或反之）时只补缺的那一份；两份都缺时各上传一次，仍是两条独立原子换名。
- **本机产物缺 fd**：`build:core` / `verify-core-artifacts` / SSH 引导 / TUI 安装器构建四处都直接失败，错误文案给出重建命令（不允许出现「部署成功但工具不可用」）。
- **提示词与实际可用性不一致**：提示词要求优先用 `rg` / `fd`，可用性由 PATH 前置保证；两者由同一次构建产出，`core-rs` 的提示词对照表与产物矩阵测试分别锁住两侧，出现漂移即测试红。
- **旧远端部署**：共享位已有的 `rg` 原样复用，新客户端只补 `fd`；旧客户端不受影响（它不读 `fd`）。

## 非目标

- 不新增 `Fd` / `Find` 工具：`Grep` / `Glob` 的工具集合、入参与行为都不变（`Glob` 仍走 `rg --files`），`core-rs/fixtures/toolSchema.json` 不动。本次只改它们**系统提示词里的用法说明**（FR-006），不改工具定义。新增工具是另一条改动（未来的 spec）。
- 不改用户自己的终端：远端终端（US-54）、宿主内终端面板的 PATH 不受影响，本改动只覆盖 Core 拉起的工具 shell 与原生子进程。
- 不写 shell 启动文件 / 不改 `~/.bashrc`、不向系统目录安装任何东西——前置只发生在子进程的环境变量上。
- 不动 `resources/ripgrep/` 与 `ripgrep/` 部署目录的既有命名（fd 用同级的 `fd/`，不合并成 `bin/`）；合并布局若有价值另立 spec。
- 不扩平台矩阵：macOS 仍无产物；fd 的版本升级不做独立机制，跟着 Core 构建走。
- 不接管系统已装的 `rg` / `fd` 的版本管理，也不在 `PATH` 里替换它们（只前置）。
- 不在代码里拦 Bash 的 `grep` / `find` / `rg` / `fd`：本改动只调提示词措辞（分工说明），不加运行时禁令、不加权限判定。

## 对需求基线的影响

新增 [US-77](../../docs/features/user-stories/tools.md#ep-7-工具与技能)（工具 shell 自带 rg / fd 并优先使用），写入工具与技能分册，包含三条验收：工具 shell 里 `rg` / `fd` 可直接用、同名系统命令被内置遮蔽、远端部署后同样可用。

e2e 登记为豁免：端到端验证需要真实 LLM 轮次与四平台产物，依赖外网账户；由 `core-rs` 的 `shell_env_tests`（PATH 前置 / POSIX 转换 / 缺目录跳过）、`prompt_tests`（提示词文案与对照表）、`sshDaemonBootstrap.test.ts`（部署补齐）与 `e2e/tui/installer.spec.ts`（安装布局）分侧锁定，豁免理由写进 [user-stories.md 附录](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射)后的豁免段。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `resources/fd/`、`scripts/build-core.mjs`（内置工具落位）、`scripts/verify-core-artifacts.mjs`、`scripts/copy-assets.mjs`、`scripts/fix_vsix_permissions.py` | `src/test/corePlatformMatrix.test.ts`（内置工具落位、登记表两端同源、`copy-assets` 清理清单与 verify 缺失分支的静态断言） | 自动 |
| FR-002 | `src/host/standalone/sshDaemonBootstrap.ts`、`src/host/standalone/coreBinary.ts` | `src/test/sshDaemonBootstrap.test.ts` | 自动 |
| FR-003 | `installer-rs/build.rs`、`scripts/build-tui-installer.mjs`、`tui-rs/src/core_root.rs` | `e2e/tui/installer.spec.ts`、`tui-rs/src/core_root_tests.rs` | 自动 |
| FR-004 | `core-rs/src/shell_env.rs` | `core-rs/src/shell_env_tests.rs` | 自动 |
| FR-005 | `core-rs/src/tools.rs`（内置产物目录解析） | `core-rs/src/tools_tests.rs` | 自动 |
| FR-006 | `core-rs/src/prompt.rs`（`TOOL_DETAILS_BEFORE_TRANSFER` 的 Bash / Grep / Glob 三段）、`core-rs/fixtures/systemPrompt.json` | `core-rs/src/prompt_tests.rs`（`system_prompt_carries_tool_details_for_every_builtin_tool` 的逐字断言 + 新增「提示词里不再有 `never use the Bash tool with` 禁令」用例） | 自动 |

## 待澄清

无。fd 的入库来源与校验口径已在 FR-001 定死（官方 release 同版本、四平台、许可随产物入库）；跳过口径与前置顺序已定。

## 收敛记录

核对基准：工作树里本 spec 的全部改动（`git status` 中 core-rs / docs / scripts / e2e 的
相关文件）。分三类。

### 已满足

逐条 AC 的实现落点与测试证据：

| 验收 | 实现落点 | 证据 |
| --- | --- | --- |
| AC-1 / AC-6 | `bundled_tools.rs::search_path_dirs_now`、`shell_env.rs::apply` / `apply_native`（`bash_task.rs`、`mcp.rs`、`tools.rs`、`prompt.rs` 六处调用点） | `bundled_tools_tests`（登记表顺序、去重、缺失跳过）、`shell_env_tests::bundled_dirs_are_prepended{,_for_native_children}`；实测 `resources/core/arm64-win32/{ripgrep/rg.exe,fd/fd.exe}` 与可执行文件同级且可执行（`fd 10.5.2` / `ripgrep 15.2.0`） |
| AC-2 | `prepend_bundled_dirs` 把内置目录放在用户 PATH 之前，同条目只保留前置那份 | `shell_env_tests::bundled_dirs_deduplicate_against_user_path`、`bundled_dirs_are_prepended`（断言 `starts_with` 内置目录） |
| AC-3 | `bundled_tools::shell_form` 的盘符 / UNC / POSIX 三分支 | `bundled_tools_tests::shell_form_converts_drive_paths` / `_unc_paths` / `_keeps_posix_paths`；`shell_env_tests::parse_shell_form_accepts_posix_list_on_windows` |
| AC-4 | `search_path_dirs` 对缺失工具整条跳过；`prepend_bundled_dirs` 空表原样返回 | `bundled_tools_tests::search_path_dirs_skip_missing_tools`、`shell_env_tests::empty_bundled_dirs_leave_user_path_untouched` |
| AC-5 | `bash_task.rs::spawn_background` 与前台同走 `shell_env::apply` | 同一份 `apply` 实现（前台 `tools.rs::run_bash` 与后台 `spawn_background` 都调用它），无第二条 PATH 构造路径 |
| AC-7 | `tools.rs::ripgrep_path` 改调 `bundled_tools::resolve(BUNDLED_TOOLS[0])` | `tools_tests::ripgrep_path_shares_the_bundled_tools_resolution`、`bundled_tools_tests::candidates_prefer_the_core_bundle` |
| AC-8 / AC-9 | `sshDaemonBootstrap.ts` 的 `BUNDLED_TOOLS` 循环：`stat` 命中即 `continue`，否则 `uploadAtomically`（暂存名 + `mv`，`0o755`）；daemon 复用走状态文件 | `sshDaemonBootstrap.test.ts`：「只在跑时补传 fd 到共享位」「只缺 fd 时只补 fd（rg 不重复上传）」「只补 fd 后仍复用同一个 daemon」 |
| AC-10 | 同循环内 `existsSync(local)` 缺失即抛 `bundled tool "fd" is missing ... run "npm run build:core" first.` | `sshDaemonBootstrap.test.ts`：「本机缺 fd 产物时引导报错并点名工具」「缺 fd 时不把 fd 的半截产物传上去」 |
| AC-11 | `core_root.rs::shared_fd_in`；路径由 TS 侧 `coreDeployToolPath('fd')` 同源派生 | `core_root_tests::shared_fd_lives_beside_slots`、`corePlatformMatrix.test.ts::共享位 fd 路径由登记表派生` |
| AC-12 | `build-core.mjs::copyBundledTools` 按 `BUNDLED_TOOLS` 复制 | `corePlatformMatrix.test.ts`：`<dir> 已产出内置工具 <name>`（host 目标逐一枚举两件工具）、`登记表登记了 ripgrep 与 fd`、与 `bundled_tools.rs` 逐项对照 |
| AC-15 | `installer-rs/build.rs` 载荷清单、`scripts/build-tui-installer.mjs` 产物四件套校验 | `e2e/tui/installer.spec.ts::部署布局完整` 含 `share/<产品名>/fd/fd[.exe]`；`core_root_tests::shared_fd_lives_beside_slots` |
| AC-16 / AC-17 | `prompt.rs` 的 Bash / Grep / Glob 三段 | `prompt_tests::tool_details_do_not_ban_bash_rg`、`tool_details_describe_rules_not_mechanism`、`tool_details_warn_about_fd_silent_pitfalls` |
| AC-18 | 提示词只写使用规则；静态部分与对照表逐字一致 | `prompt_tests::system_prompt_static_text_matches_the_shared_table`（逐字对照 `fixtures/systemPrompt.json`）、`tool_details_describe_rules_not_mechanism`（四条实现事实关键词不在） |
| AC-19 | `preset_core_prompt` 仍是两分支 | `prompt_tests::preset_tool_whitelist_and_minimal_prompt`（minimal / mixed 的 prompt 恰为核心身份一行） |

### 偏差

三条都是「追溯矩阵或 AC 声称的验证落点不存在」，行为本身已实现；按 /converge 口径修矩阵或补
测试。本次裁决：**改矩阵**（把虚指落到真实用例），并为 AC-13 / AC-14 补测试。

1. **追溯矩阵 FR-001 行虚指 `packagingChain.test.ts`**：该文件只断言 `electron-builder` 的
   平台参数与发布开关，全文没有 `fd`。已从 FR-001 行移除该落点，改为指向
   `corePlatformMatrix.test.ts` 的相关断言。
2. **AC-14（`copy-assets` 清理 `dist/resources/fd/`）无任何测试，且实现手抄了清单**：
   `scripts/copy-assets.mjs` 原本写 `staleToolDirs = ['ripgrep', 'fd']`，注释声称「与
   `build-core.mjs` 的 `BUNDLED_TOOLS` 同源」但代码并未引用登记表——加第三件工具时会漏。
   已改为 `BUNDLED_TOOLS.map(...)` 真正派生（实测跑通），并在
   `corePlatformMatrix.test.ts` 补静态断言：清理清单由 `BUNDLED_TOOLS` 派生。
3. **AC-13（`verify-core-artifacts` 缺 `fd` 时失败并给出重建命令）无测试驱动**：脚本的
   `missingBuiltTool` 分支没有用例，`corePlatformMatrix.test.ts` 只覆盖矩阵与落位、
   注释明说「产物齐不齐由 verify 把关」但不验证 verify 自身。已在同一测试文件补静态断言：
   每目标工具清单由 `BUNDLED_TOOLS` 派生、缺失分支同时含 `missingBuiltTool` 与 `core.rebuild`。

三条均已修复，`npm run test:unit -- core-platform-matrix` 84 通过 / 0 失败（新增三条断言
在输出中可见）。

### 未做

无。`tasks.md` 十项全部勾选且实现到位。

### 前置闸门

| 门 | 结果 |
| --- | --- |
| `npm run check-types` | 通过（退出码 0） |
| `npm run lint` | 通过（退出码 0） |
| `npm run test:unit -- docs-lint` | 通过（docsLint 49 + docsLintLocalOnlyPaths 6） |
| `npm run build:core:host` | 通过（产出 `arm64-win32` 的 Core + 内置 rg / fd + 指纹） |
| `cargo test --target x86_64-pc-windows-msvc` | 1147 通过 / 1 失败：唯一失败是 `mcp_http::tests::http_streamable_handshake_headers_and_sse_response`，与本改动无关（`mcp_http.rs` / `_tests.rs` 不在本 spec 的改动面内）；单独连跑三次均通过，判定为全量并发下的偶发 |
| `npm run test:core`（host 三元组） | 本机 host 为 `aarch64-pc-windows-msvc`，`ring` 的 build.rs 对 Windows ARM64 强制要求 clang（本机 VS 未装该组件），链接报错 LNK1143，属环境缺失而非代码问题；等价用例由上一条 x64 目标覆盖 |

