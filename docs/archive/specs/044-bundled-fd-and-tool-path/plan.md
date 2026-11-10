# 实施方案：内置 fd 与工具 shell 的 PATH 前置

技术路线见同目录 [spec.md](spec.md)：产物侧把 fd 接进既有的「随 Core 分发 → 共享位 / 安装器落位」
链路；运行侧在 `core-rs` 抽出一个内置工具登记表，同一份解析同时供 Grep 的 `rg` 与 PATH 前置使用。
核心取舍是**不新增第二套候选路径**：现在 `tools.rs` 的 `ripgrep_candidates` 是唯一的定位实现，
本次把它上移成两个工具共享的一份（spec FR-005），PATH 前置直接消费它的「已存在」结果。

## 技术方案

### 1. 内置工具登记表（新增 `core-rs/src/bundled_tools.rs`）

现有 `tools.rs` 的私有三件套（`platform_dir` / `exe_name` / `core_executable_dir` + `ripgrep_candidates`）
搬到新模块，改成按工具参数化：

```rust
/// 随 Core 分发的内置工具：目录名（产物与部署布局共用）与可执行名
pub struct BundledTool {
    pub dir: &'static str,
    pub stem: &'static str,
}
pub const BUNDLED_TOOLS: [BundledTool; 2] = [
    BundledTool { dir: "ripgrep", stem: "rg" },
    BundledTool { dir: "fd", stem: "fd" },
];
```

纯函数（各自的测试锁顺序，不碰进程环境）：

- `tool_candidates(tool, core_dir: Option<&Path>, extension_path: Option<&str>) -> Vec<PathBuf>`：
  沿用既有四条优先级——① `<Core exe 目录>/<dir>/<exe>`（本地打包布局）、② `<Core exe 目录>/../<dir>/<exe>`
  （部署布局的共享位）、③ `<extensionPath>/dist/resources/<dir>/<arch>-<platform>/<exe>`、
  ④ `<extensionPath>/resources/<dir>/<arch>-<platform>/<exe>`。
- `resolve_tool(tool, core_dir, extension_path) -> Option<PathBuf>`：第一条 `is_file()` 命中的。
- `search_path_entries(core_dir, extension_path) -> Vec<PathBuf>`：按 `BUNDLED_TOOLS` 顺序取
  `resolve_tool` 的**父目录**，同目录去重（`ripgrep` 与 `fd` 将来若合并成一个 `bin/` 也不会重复前置）。
  缺失的工具整条跳过（spec FR-004，唯一的运行期跳过点）。
- `shell_form(dir: &Path) -> Option<String>`：Windows 上转 POSIX 形式（`C:\a\b` → `/c/a/b`、
  `\\srv\share\x` → `//srv/share/x`、已是 POSIX 的原样返回），不可转换返回 `None`；
  非 Windows 直接 `to_string_lossy`。转换失败的那一条跳过（spec 边界第 2 条）。

`tools.rs` 的 `ripgrep_path()` 改为 `resolve_tool(Ripgrep, …)` 的薄封装，行为不变（找不到仍回退
字符串 `"rg"`，即交给 PATH——现在 PATH 首位就是内置目录，语义自然收口）。

**为什么单独成模块而不是放 `shell_env.rs` 或 `tools.rs`**：`tools.rs` 依赖 `shell_env`（`apply` /
`apply_native`），若 `shell_env` 反向依赖 `tools` 就形成环形概念依赖；新模块只依赖 `std` 与
`config::extension_path()`，两个消费者各自 `use` 它。

### 2. PATH 前置（修改 `core-rs/src/shell_env.rs`）

`ShellPath` 仍只承载「用户终端的 PATH」（探测与缓存语义不变）。前置在**写入点**合成，
`apply_value` 成为唯一的拼接处：

```
最终 PATH = [内置工具目录…] + (用户 PATH 去掉已出现在前置里的同条目)
```

- 两种形式各转一次：`apply`（shell 子进程）用 `shell_form`；`apply_native`（原生进程）用 Windows
  原生形式（不转换，直接 `to_string_lossy`）。
- 用户 PATH 里的同一条目**从前置之后移走**而不是放弃前置：保证「内置在前」与「不重复」同时成立
  （spec FR-004 最后一条）。
- 去重键：Windows 大小写不敏感 + 分隔符归一；POSIX 原样比较。
- 每次 `apply` 现算（两次 `Path::is_file` 级别开销），不进 `RESOLVED` 缓存——缓存里混进产物信息后，
  `force_path_for_test` 的语义与「extensionPath 可被用例改写」都会变浑。
- 新增测试覆盖槽 `force_bundled_dirs_for_test(Vec<PathBuf>)` / `clear_bundled_dirs_for_test()`，
  与既有 `TEST_FORCED` 同款（`Sandbox::new` 钉成空列表，`Drop` 清除），让新用例不依赖仓库产物布局。

### 3. TS 侧登记表（修改 `src/host/standalone/coreBinary.ts`）

新增 `BUNDLED_TOOLS: ReadonlyArray<{ dir: string; stem: string }>`（`ripgrep`/`rg`、`fd`/`fd`），
并把现有导出改为由它派生的薄封装——既有名字**全部保留**（`sshTransport.test.ts` /
`corePlatformMatrix.test.ts` 直接 import 它们）：

| 现有导出 | 改法 | 新增 |
| --- | --- | --- |
| `CORE_RIPGREP_DIR` | 保留，值来自登记表 | `CORE_FD_DIR` |
| `bundledRipgrepFileName` / `bundledRipgrepPath` | 保留（转调 `bundledToolFileName` / `bundledToolPath`） | `bundledFdFileName` / `bundledFdPath` |
| `coreDeployRipgrepPath` | 保留（转调 `coreDeployToolPath`） | `coreDeployFdPath` |

派生逻辑只有登记表一份，两个导出族都从它算出路径（铁律 4.5）。

### 4. SSH 引导（修改 `src/host/standalone/sshDaemonBootstrap.ts`）

`ensureRemoteRipgrep` → `ensureRemoteBundledTools`，按登记表循环：

```
for tool in BUNDLED_TOOLS:
  remote = ~/.local/share/<deployPrefix>/<tool.dir>/<exe>
  if stat(remote).exists: continue
  local = <本机 Core exe 目录>/<tool.dir>/<exe>      # 缺失 → 报错（附 build:core 命令）
  mkdir -p dirname(remote); uploadAtomically(local, remote)
```

- 保持「缺了才传」与两条独立原子换名（spec FR-002）；补齐 fd 不改 `running` 分支，daemon 复用路径
  与 `start` 判定一行不动。
- 错误文案点名缺的是哪个工具与它的本机路径。

### 5. 构建与打包链

| 位置 | 改动 |
| --- | --- |
| `scripts/build-core.mjs` | `copyBundledRipgrep` → `copyBundledTools`：按登记表把 `resources/<dir>/<target.dir>/<exe>` 复制到 `resources/core/<dir>/<dir>/<exe>`；任一缺失 `process.exit(1)`，文案点名工具 |
| `scripts/verify-core-artifacts.mjs` | 每个 `REQUIRED_CORES` 条目的 `ripgrep` 字段改为 `tools: Array<{ rel, label }>`；built 与 shipped 两侧逐工具 `existsSync` + 摘要比对 |
| `scripts/copy-assets.mjs` | 清理列表 `['ripgrep', 'fd']`（`dist/resources/<dir>/` 均无读取方） |
| `scripts/fix_vsix_permissions.py` | `TARGET_FILES` 补 `dist/resources/core/{x64,arm64}-linux/fd/fd` |
| `installer-rs/build.rs` | `entries` 增加 `(format!("{product_dir}/fd/fd{ext}"), pkg_dir_path.join("fd").join(format!("fd{ext}")), true)` |
| `scripts/build-tui-installer.mjs` | `coreArtifactsReady` 增加 `fd/fd<ext>` 判定 |
| `tui-rs/src/core_root.rs` | `shared_ripgrep_in` 旁增 `shared_fd_in`（同为 `#[cfg(test)]`，共用 `product_dir_in`） |

### 6. 系统提示词（修改 `core-rs/src/prompt.rs` + 重生成对照表）

五处文本严格照 spec FR-006 的定稿逐字写入 `TOOL_DETAILS_BEFORE_TRANSFER`。对照表重生成走一次性脚本
（不提交）：

```
node -e "读 fixtures/systemPrompt.json → 对 toolUsage 做 5 处精确替换 → 写回"
```

替换串直接取自 spec FR-006 的代码块，避免手抄漂移；写完用
`cargo test --manifest-path core-rs/Cargo.toml prompt_tests` 验证逐字一致（不一致会打印首个差异下标）。

新增两条 `prompt_tests` 用例：

- `tool_details_do_not_ban_bash_rg`：`tool_usage_section(definitions(), None)` 不含
  `never use the Bash tool with`（AC-17）。
- `tool_details_describe_rules_not_mechanism`：Bash / Grep / Glob 三万段不含
  `ship with` / `bundled` / `PATH` / `first on this shell`（AC-18 的可判定形式）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `resources/fd/{x64-win32,arm64-win32,x64-linux,arm64-linux}/fd[.exe]` | 新增（已就位，LFS） | 无（构建源） |
| `core-rs/src/bundled_tools.rs` + `bundled_tools_tests.rs` | 新增：登记表、候选解析、POSIX 形式 | 无（内部模块，不进 wire） |
| `core-rs/src/tools.rs` | 修改：`ripgrep_path` 转调 `bundled_tools::resolve`；私有 helper 全部移走（无残留包装） | 无（`Grep` / `Glob` 入参与结果不变，`core-rs/fixtures/toolSchema.json` 不动） |
| `core-rs/src/tools_tests.rs` | 修改：删掉重复的候选顺序用例（由 `bundled_tools_tests` 单独锁），改为一条「Grep 与 PATH 前置消费同一份解析」的断言 | 无 |
| `core-rs/src/shell_env.rs` + `shell_env_tests.rs` | 修改：`apply_value` 合成前置；新增测试覆盖槽 | 无（`CoreEvent` / `UiEvent` 均不变） |
| `core-rs/src/test_support.rs` | 修改：`Sandbox::new` 钉空的前置列表，`Drop` 清除 | 无 |
| `core-rs/src/prompt.rs` | 修改：三处段落文本 | 无（提示词不属于 wire 契约） |
| `core-rs/fixtures/systemPrompt.json` | 修改：`toolUsage` 逐字同步 | 无 |
| `core-rs/src/prompt_tests.rs` | 修改：新增两条用例 | 无 |
| `src/host/standalone/coreBinary.ts` | 修改：登记表 + 派生封装 | 无（宿主内部定位，不进总线） |
| `src/host/standalone/sshDaemonBootstrap.ts` | 修改：`ensureRemoteBundledTools` | 无 |
| `src/test/sshDaemonBootstrap.test.ts` | 修改：全量部署 2→3 次上传、仅补 rg 场景 1→2；补 fd 用例 | 无 |
| `src/test/sshTransport.test.ts` | 修改：`warm` 场景把 fd 也标记为已部署 | 无 |
| `src/test/corePlatformMatrix.test.ts` | 修改：四目标的 `fd` 落位断言 + 候选路径断言 | 无 |
| `scripts/build-core.mjs` / `verify-core-artifacts.mjs` / `copy-assets.mjs` / `fix_vsix_permissions.py` / `build-tui-installer.mjs` | 修改：按登记表循环 / 补 fd 条目 | 无（构建期脚本） |
| `installer-rs/build.rs`、`tui-rs/src/core_root.rs(_tests)` | 修改：载荷与共享位加 fd | 无（安装布局成员变化，非总线契约） |
| `e2e/tui/installer.spec.ts` | 修改：布局断言加 `fd/fd<ext>` | 无 |
| `docs/core/standalone-core.md`、`docs/core/core-remote.md`、`docs/features/tui-installer.md`、`docs/hosts/tui.md`、`docs/architecture/repo-map.md`、`docs/features/user-stories/{tools.md,user-stories.md}` | 修改：spec 影响基线九处 | 无 |
| `docs/adr/README.md` | 修改：补齐 0012–0015 四行索引（既有缺口，见宪章检查） | 无 |

**不做**：`docs/features/user-stories.md` 的 US 映射新增 e2e 用例（豁免理由见 spec）；`docsLint`
之外不新增校验脚本。

### 文档体积风险（`docs/core/standalone-core.md`）

现 493 行，上限 500。四处 delta 按「就地改写、不新增小节」执行，预算：

- [第 3.1 节 平台矩阵](../../docs/core/standalone-core.md#31-平台矩阵)的部署布局代码块各加 1 行
  （`fd/fd[.exe]`），并把「Core 自带 ripgrep」一句合并叙述为「自带工具（`ripgrep/rg`、`fd/fd`）」——净 +2；
- [第 3.2.1 节 工具命令的 PATH](../../docs/core/standalone-core.md#321-工具命令的-path)表格加一行
  「内置工具前置」+ 正文里把 PATH 来源描述合并——净 +1；
- [第 3.3 节 构建与目标平台](../../docs/core/standalone-core.md#33-构建与目标平台)把 ripgrep 预编译段
  扩成两工具——净 +1；
- [第 7 节 事实归属](../../docs/core/standalone-core.md#7-事实归属)事实行改写——净 0。

预计 497 行。若实施时越界，先单独提交一个文档拆分（把[第 3.3 节 构建与目标平台](../../docs/core/standalone-core.md#33-构建与目标平台)
与[第 3.4 节 构建指纹](../../docs/core/standalone-core.md#34-构建指纹)移入 `docs/core/core-build.md` 并更新地图与
引用），再落功能提交——拆分属 L0，不与本 spec 混提。

## 宪章检查

- [x] **分层与依赖**（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新模块
      `core-rs/src/bundled_tools.rs` 只依赖 `std` 与 `config::extension_path()`，不碰宿主 API；
      TS 改动全在 `src/host/standalone/`（已在该层），`src/shared/` 不动。无 `host.kind === '...'` 嗅探
      ——平台差异仍走 `cfg!(windows)` / `process.platform`。唯一新增的跨层调用是
      `shell_env → bundled_tools`（同 crate 内、无宿主动词），方向为「环境装配 → 产物解析」，
      不构成反向依赖。
- [x] **架构铁律**（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      ①不过度 fallback——缺失的内置目录不注入 PATH，也不掩盖：失败信号由命令本身发出
      （`command not found` 进工具结果，模型与用户立刻可见），属**故障暴露路径**而非回退路径；
      与之对照，构建 / 打包 / 部署三处缺产物一律报错；②契约成员全必选——无新契约成员，
      `CoreEvent` / `UiEvent` / `WireMessage` 零改动；③一份事实一个写入点——PATH 仍只有
      `apply_value` 一处合成、内置目录仍只有 `tool_candidates` 一处解析（TS 侧同理）；
      ④默认值单源——工具目录名 / 可执行名只来自两张登记表（`bundled_tools.rs` 与
      `coreBinary.ts`），不散落目录名字符串；⑤派生逻辑一份纯函数——`search_path_entries` /
      `coreDeployToolPath` 各一份，测试直接锁它们。
- [x] **Core 行为与落盘格式同步义务**（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：只有一套 Core
      （ADR-0007），无双实现 parity；但目录名 / 文件名口径同时存在于 `bundled_tools.rs` 与
      `coreBinary.ts`，两侧各由 `bundled_tools_tests` 与 `corePlatformMatrix.test.ts` 锁死平台矩阵
      （四个 `<arch>-<platform>` 目录），漂移即红。**不涉及落盘格式**：`meta.json` / JSONL /
      压缩归档 / 项目清单均未改，`src/shared/history/` 与 `core-rs/src/history_tests.rs` 不动。
      Core 侧行为变更（PATH 前置）由 `shell_env_tests` + `tools_tests`
      （`bash_runs_with_the_resolved_path`）覆盖。
- [x] **文档同步义务**（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：九处 as-built 增量与本提交同时
      落地（清单见上表），`npm run test:unit -- docs-lint` 必须绿。本次**不新增 ADR**（见「被否决的
      替代方案」末段：跳过不属于铁律 1 的例外，无需豁免记录）。另记一处**既有缺口**：
      `docs/adr/README.md` 的索引只有 0001–0011，0012–0015 四篇未登记（docsLint 只校验编号连续，
      不校验索引完整性）。建议在同一提交顺手补齐四行（纯文档），若评审认为属跨范围则改记 `TODO.md`。

## 被否决的替代方案

1. **新增 `Fd` / `Find` 工具，而不是让模型在 Bash 里用 fd**
   否决：工具集扩张要连带 schema 对照表、权限表、四宿主 parity 与提示词工具表，成本远高于收益；
   且「按文件名找文件」已经有 `Glob`（`rg --files`），新增工具只是换个后端。spec 已把这条写成非目标。

2. **把内置目录软链 / 硬链进 `~/.local/bin`（或 `~/.local/share/<prefix>/bin` 并让用户自己加 PATH）**
   否决：①会改动用户机器上产品目录之外的路径，与「只影响子进程环境」冲突；②Windows 上软链要
   开发者模式或管理员权限，安装器还得处理失败分支；③用户的交互式终端本来不该被产品改写 PATH。
   前置到子进程环境变量是唯一副作用为零的做法。

3. **在提示词里写「内置版本随产品分发、恒在 PATH 首位」**
   否决：提示词是给模型的**使用规则**，写清来源与注入方式会把实现细节固化进一段需要保持稳定的
   文本，且实现一改（比如将来改成 wrapper 脚本或 git-submodule 构建）就要改提示词。AC-18 用
   「不含 ship with / bundled / PATH」把这条钉成负向断言。

4. **保留 `ripgrep_candidates` 不动，在 `shell_env` 里另写一份内置目录候选**
   否决：两份候选列表必然漂移——一处加 `<extensionPath>/dist/resources` 兜底而另一处忘了，
   就会出现「Grep 找得到 rg、PATH 里却没有」的幽灵状态。spec FR-005 明确要求收敛成一份。

5. **在 Bash 工具代码里拦截 `grep` / `find`（改写成 `rg` / `fd` 或直接拒绝）**
   否决：静默改写命令会破坏脚本语义（`grep -c`、`find -exec` 参数完全不同），拒绝则是把提示词
   建议升级成能力限制，且用户明确要求「只调提示词」。已写进 spec 非目标。

6. **把 fd 与 rg 合并进一个 `bin/` 目录（`share/<prefix>/bin/{rg,fd}`）**
   否决（本轮）：迁移既有部署位需要处理「老槽位只有 `ripgrep/`」的兼容分支与已部署机器的重传，
   与本次「补齐一个工具」的目标不成比例。合并布局的价值（PATH 只前置一个目录）留待需要第三个
   工具时再评估，已写进 spec 非目标。

**不需要 ADR**：「内置工具目录缺失时跳过而不是报错」**不属于 fallback**——铁律 1 的靶子是「用不易察觉的
回退路径掩盖问题」，而这里跳过的是**不可用工具的 PATH 条目**，失败信号由命令本身发出（`command not found`
直接进工具结果，模型立刻可见）；注入侧若是抛错，整条 Bash 命令都会失败、把上百条无关命令一起挡掉，
反而埋掉真正的问题。既然不是例外，就不需要 ADR 豁免；决策落在 spec FR-004 与边界节，plan 宪章检查里
按「故障暴露路径」表述。
