# 实施方案：技能系统的调用语义、共享目录与优先级

技术路线一句话：把「发现根」从两处硬编码抽成一张按 rank 排序的根表，把「去重」从 realpath
单一步扩成「realpath 去重 → 同名仲裁」两步，两个调用开关各自落到自己的消费点——模型侧拒绝放在
`tools::validate_input`（模型调用的唯一入口），用户 `/name` 的注入路径不经过它，来源区分天然成立。

需求见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 两个开关的字段形态

`SkillCommand` 删掉派生字段 `is_hidden`，改为显式两个布尔：

| 字段 | 来源 | 语义 |
| --- | --- | --- |
| `user_invocable` | frontmatter `user-invocable`（默认 true） | 进不进斜杠菜单、`/name` 能不能匹配 |
| `model_invocable` | frontmatter `disable-model-invocation` 取反（默认 false → true） | 进不进模型名单、Skill 工具能否被模型调用 |

`ParsedSkillFrontmatter` 增加 `disable_model_invocation: bool`，解析写法对齐既有
`user-invocable`（`parse_boolean_frontmatter`，`skills.rs:502`），默认值 false 只在
`parse_skill_frontmatter_fields` 一处给：

```rust
let disable_model_invocation = match frontmatter.get("disable-model-invocation") {
    None => false,
    Some(value) => parse_boolean_frontmatter(Some(value)),
};
```

`BundledSkillDefinition` 增加 `disable_model_invocation: Option<bool>`；`CreateSkillCommandParams`
增加 `model_invocable: bool`（由调用方从 `disable_model_invocation` 取反后传入，构造点只有
`create_skill_command` 与 `register_bundled_skill` 两处）。

### 2. 根表与 rank

新增内部类型与函数（不进契约面）：

```rust
struct SkillRoot { rank: u8, path: PathBuf, source: SkillSource }
fn skill_roots(cwd: &str) -> Vec<SkillRoot>   // 已按 rank 升序，取不到的根直接跳过
```

| rank | 路径 | `SkillSource` |
| --- | --- | --- |
| 10 | `<cwd>/.agents/skills` | `Project` |
| 20 | `<cwd>/<configDir>/skills` | `Project` |
| 30 | `<home>/.agents/skills` | `User` |
| 40 | `<configHome>/skills` | `User` |
| 50 | bundled 注册表 | `Bundled` |

`<home>` 用 `config::home_dir()`、`<configDir>` 用 `config::host_environment().config_dir_name`
（与 `skills.rs` 现有口径一致，不新增家目录解析方式，见
[docs/architecture/principles.md 第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)）。

### 3. 去重与仲裁两步走

`get_skill_dir_commands` 改成三步：

1. 按 rank 升序把四个根全部扫出来，得到 `Vec<RankedSkill { rank, skill, file_path }>`；
2. **realpath 去重**：同一物理文件经多个根可见（junction / symlink）只保留 rank 最小的一份，
   这不算冲突、**不打 WARNING**（保留现有 debug 级日志）；
3. **同名仲裁**：`arbitrate()` 纯函数按 rank 顺序收敛，name 或 alias 命中的后者被丢弃，并产出一条
   `被忽略路径 ← 胜出路径` 的 WARNING 文案；调用方 `eprintln!` 逐条打印。

`arbitrate` 抽成纯函数（输入 `Vec<RankedSkill>`，输出 `(Vec<SkillCommand>, Vec<String>)`），
让「谁赢、几条 WARNING」可以单测，不必抓 stderr。

`get_all_skills` 把 bundled 当作 rank 50 的候选一起进 `arbitrate`，于是「项目 `commit` 遮蔽内置
`commit`」和「名单只一条」是同一个机制的结果，不需要第二套判断。

内置命令（`spin`）冲突仍留在 `register_bundled_skill` 的 `check_skill_conflict`，不参与 rank。

### 4. 四个消费点各自过滤

| 消费点 | 位置 | 过滤条件 |
| --- | --- | --- |
| 模型名单（Available Skills） | `skills::format_skill_listing`（`skills.rs:1127`） | `model_invocable` |
| 斜杠菜单（`skillsRequested`） | `main::skills_payload`（`main.rs:430`） | `user_invocable` |
| `/name` 派发 | `commands::dispatch`（`commands.rs:213`） | `user_invocable` |
| 模型调用 Skill 工具 | `tools::validate_input` 的 `"Skill"` 分支（`tools.rs:764`） | `model_invocable`，否则返回校验错误 |
| Spin 设计器技能清单 | `main::spin_design_skills`（`main.rs:455`） | `user_invocable` |

`skills_payload` 同时改成「内置命令（`isBuiltin: true`）+ `get_all_skills(cwd)` 过滤 `user_invocable`」，
替掉现在分两次 push bundled 与文件技能、可能重名出现两次的写法；`SkillListItem` 字段不变。

模型侧拒绝文案固定为
`Skill '<name>' cannot be invoked by the model (disable-model-invocation: true)`，
经既有 `InputValidationError` 通道回到模型，不新增事件。

**来源区分靠调用路径而不是入参**：`engine::inject_skill_tool_use`（`engine.rs:3220`）走
`execute_tool` 而不经过 `validate_input`（模型路径在 `engine.rs:4708` 才调），因此用户注入不会被
模型侧开关拦住。这里**不加**校验，只加一条注释说明这是有意的（否则后人顺手补校验就会破坏
FR-001），并在 `tools_tests.rs` 加一条用例锁定「`validate_input` 拒绝 + `execute` 仍可执行」。

### 5. 仓库迁移（`.agents/skills`）

1. `git mv .tuxedo-cat/skills .agents/skills`（9 个技能目录），删空的 `.tuxedo-cat/`；
2. `git rm -r --cached .zcode/skills`，`.gitignore` 去掉 `!.zcode/skills/` 一行（`.zcode/*`
   已忽略，`.zcode/skills` 从此是本地 junction）；
3. 本机重建 junction：`.zcode/skills` → `.agents/skills`（Windows `cmd //c mklink /J`，
   POSIX `ln -s`），使 ZCode 会话读到的仍是同一份文件；
4. [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)改写：技能落库路径为 `.agents/skills`，`.zcode/skills` 是本机 junction，
   克隆后需自行建立。

### 6. 删掉 TS 侧遗留实现

`git rm -r src/shared/skills`（1294 行、零消费方）；`docs/architecture/repo-map.md` 与
`docs/architecture/overview.md` 里 `src/shared/` 的描述去掉 `skills/`；
`core-rs/src/skills_tests.rs` 顶部注明 `fixtures/skills.json` 是手工维护的期望值
（TS 生成器已随 ADR-0007 退役）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/skills.rs` | 修改：`SkillCommand` 删 `is_hidden` 加 `model_invocable`；`ParsedSkillFrontmatter` 加 `disable_model_invocation`；新增 `SkillRoot` / `skill_roots` / `arbitrate`；重写 `get_skill_dir_commands` / `get_all_skills`；`format_skill_listing` 改过滤条件 | 无（core 内部类型，不过总线） |
| `core-rs/src/commands.rs` | 修改：`dispatch` 匹配技能时要求 `user_invocable` | 无 |
| `core-rs/src/prompt.rs` | 修改：名单过滤与注释（`prompt.rs:681`） | 无（system prompt 文本不变，条目集合随开关变） |
| `core-rs/src/tools.rs` | 修改：`validate_input` 的 `"Skill"` 分支加模型侧拒绝；`run_skill` 不变 | 无（Skill 工具 `input_schema` 不变） |
| `core-rs/src/main.rs` | 修改：`skills_payload` 改用 `get_all_skills` + `user_invocable`；`spin_design_skills` 过滤条件 | **无契约变化**：`SkillListItem` 仍为 `{name, description, isBuiltin}`，`skillsRequested` 载荷不变 |
| `core-rs/src/engine.rs` | 修改：`inject_skill_tool_use` 加来源区分注释（不加校验） | 无 |
| `core-rs/fixtures/skills.json` | 修改：`skillListing` 用例 `isHidden` → `modelInvocable`、期望串按新语义重算；`fields` 增 `disable-model-invocation` 用例 | 无（测试数据） |
| `core-rs/src/skills_tests.rs` / `commands_tests.rs` / `tools_tests.rs` / `prompt_tests.rs` / `main_tests.rs` | 修改 + 新增用例 | — |
| `src/shared/skills/**` | 删除 | 无（零消费方） |
| `.agents/skills/**` | 新增（9 个技能迁入） | 无 |
| `.tuxedo-cat/skills/**`、`.zcode/skills/**` | 从索引删除 | 无 |
| `.gitignore`、`AGENTS.md` | 修改 | 无 |
| `docs/features/skills.md` | 新增 | 需求基线（as-built） |
| `docs/features/user-stories/tools.md` | 修改 US-27 验收标准 | 需求基线 |
| `docs/architecture/repo-map.md`、`docs/architecture/overview.md`、`docs/architecture/open-questions.md`、`docs/README.md` | 修改 | — |

`docs/README.md` 的地图要加 `docs/features/skills.md` 一行（docsLint 强制覆盖）——spec 的
影响基线漏列了这条，收敛时按偏差记录补记。

## 宪章检查

- [x] **分层与依赖**（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：不涉及 + 理由——改动全在 `core-rs/`，没有新增 TS 侧
      依赖；`src/shared/skills/` 是删除，方向上是减少叶子层内容。core 仍只经帧通道与 TS 通信。
- [x] **架构铁律**（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      - 不过度 fallback：根不存在 → 空列表（既有空态约定，非降级）；同名冲突 → WARNING 点名两条
        路径，不静默；两开关都关 → WARNING + 不可达，不悄悄放行。
      - 契约成员全必选：`SkillCommand` / `ParsedSkillFrontmatter` 新字段均为必选 `bool`，无 `Option`。
      - 一份事实一个写入点：开关语义只由 `user_invocable` / `model_invocable` 表达，删掉派生
        `is_hidden`，避免同一事实两个字段；rank 只在 `skill_roots` 一张表里。
      - 默认值单源：`user-invocable` 默认 true、`disable-model-invocation` 默认 false 只在
        `parse_skill_frontmatter_fields` 一处。
- [x] **Core 行为与落盘格式**（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动落点在 `core-rs/` 并同步测试；
      **不涉及落盘格式**（`meta.json` / 对话 JSONL 无变化），`src/shared/history/` 不需同步。
      两套 Core 的 parity 义务已随 ADR-0007 退役，`fixtures/skills.json` 是手工维护的期望值，
      本次只改 Rust 一侧并在文件头注明。
- [x] **文档同步义务**（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：新增 `docs/features/skills.md` 并登记
      `docs/README.md` 地图；US-27、repo-map、overview、open-questions、AGENTS.md 与代码同提交；
      `npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

1. **保留 `is_hidden`，让它表示「两个开关都关」**：否决——同一事实仍由两个字段推导，且「不可达」
   与「不展示」是两回事，混在一个布尔里下次还得再拆。
2. **模型侧拒绝放在 `run_skill`（执行处）**：否决——用户 `/name` 注入也走同一个执行入口，会连带
   拦掉用户触发；要区分就得把「来源」写进 tool input，等于把内部状态塞进 transcript。
3. **给 `SkillListItem` 加 `source` / 开关字段，让 UI 区分来源**：否决——本次不改契约面
   （spec 非目标），来源只在 core 日志与文档里体现。
4. **加 `.claude/skills` 兼容根**：否决——spec 明确不兼容，两套跨工具约定并存会让「谁是真相」
   再次含糊。
5. **迁移时把 `.tuxedo-cat/skills` 留成反向 junction**：否决——弱化产品目录的方向下，反向链接
   只会让真相再次分叉；读取分支保留即可。
6. **顺手做「向上父目录查找」**：否决——独立能力，属 spec 非目标，另开 spec。

## 需要评审拍板的一处

`.<configDir>/skills` 的弱化方向（spec 非目标，已归位到
[docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）是一个有分量的
产品决策——建议单独落一份 ADR（`docs/adr/0011-...`）记录「发现面转向 `.agents` 共享目录、产品
目录降为兼容层」的决策与被否决的替代方案。是否本次一并写，请评审时明确。
