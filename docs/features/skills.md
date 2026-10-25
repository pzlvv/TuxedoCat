---
owner: pzlvv
last_reviewed: 2026-10-26
---

# 规格：技能系统

本规格界定技能的发现面、`SKILL.md` 的 frontmatter 契约、两个调用开关、模型名单与注入路径。
技能是 `SKILL.md` 形式的指令集：模型只看到名称与描述（名单），正文在调用时才进上下文。
范围不含宿主侧技能管理界面（开关、来源标注、启用 / 停用），也不含 `.claude` 兼容目录。

交叉引用：`UiRequest.skillsRequested` 的载荷见 [docs/architecture/events.md 第 2 节](../architecture/events.md#2-事件词汇表)；
用户 `/name` 的注入顺序见 [docs/features/user-message-pipeline.md 第 2 节](../features/user-message-pipeline.md#2-功能需求)；
`core` 与 `UI` 的分工见 [principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)；
决策背景见 [ADR-0011](../adr/0011-agents-shared-skills-discovery.md)。

## 1. 用户场景与验收标准

- 场景 1：用户主动触发（`/name`）
  - **AC-1**（FR-001）：GIVEN 技能 `a` 未设 `user-invocable`（默认 true）WHEN 输入 `/` THEN 斜杠菜单列出 `a`；发送 `/a` 后经 Skill 工具注入正文，会话里留下 Skill 卡片。
  - **AC-2**（FR-001）：GIVEN 技能 `b` 设 `user-invocable: false` WHEN 输入 `/` THEN 菜单不列 `b`；手工发送 `/b` 不匹配任何技能，消息按普通消息进入对话。
  - **AC-3**（FR-001）：GIVEN 技能 `c` 设 `disable-model-invocation: true` WHEN 用户发送 `/c` THEN 正文照常注入并执行，参数替换与默认技能一致。
- 场景 2：模型主动加载
  - **AC-4**（FR-001）：GIVEN 技能 `b` 设 `user-invocable: false` WHEN 构建系统提示 THEN `b` 出现在 Available Skills 名单里，模型可调用并拿到正文。
  - **AC-5**（FR-001）：GIVEN 技能 `c` 设 `disable-model-invocation: true` WHEN 模型调用 Skill 工具 `skill: "c"` THEN 调用被拒绝，tool_result 是错误且正文不进入上下文。
  - **AC-6**（FR-001）：GIVEN 技能 `d` 同时设 `user-invocable: false` 与 `disable-model-invocation: true` WHEN 加载 THEN 名单与菜单都不出现 `d`，core 日志打一条点名 `d` 的 WARNING。
- 场景 3：发现根
  - **AC-7**（FR-002）：GIVEN `<cwd>/.agents/skills/x/SKILL.md` 存在 WHEN 请求技能列表 THEN 列表含 `x`。
  - **AC-8**（FR-002）：GIVEN `~/.agents/skills/y/SKILL.md` 存在、当前工作目录与之无关 WHEN 请求技能列表 THEN 列表含 `y`。
  - **AC-9**（FR-002）：GIVEN 仓库里同时存在 `.claude/skills/z/SKILL.md` WHEN 请求技能列表 THEN 列表不含 `z`。
- 场景 4：优先级与同名仲裁
  - **AC-10**（FR-003）：GIVEN 项目 `<cwd>/.agents/skills/p/SKILL.md` 与用户 `~/.agents/skills/p/SKILL.md` 同名且描述不同 WHEN 调用 `/p` THEN 用项目那份；名单里 `p` 只出现一次。
  - **AC-11**（FR-003）：GIVEN 同一层级下 `<cwd>/.agents/skills/p/` 与 `<cwd>/<configDir>/skills/p/` 同时存在 WHEN 调用 `/p` THEN 用 `.agents` 那份；名单只一条。
  - **AC-12**（FR-003）：GIVEN 项目技能名为 `commit`（与 bundled 同名）WHEN 调用 `/commit` THEN 用项目那份，bundled 被遮蔽；名单只一条。
  - **AC-13**（FR-003）：GIVEN 任一同名冲突被仲裁 WHEN 读取 core 日志 THEN 有一条 WARNING 同时点名胜出路径与被忽略路径。
  - **AC-14**（FR-003）：GIVEN 同一物理目录经两个根可见（junction / symlink）WHEN 加载 THEN 只算一次，且不产生同名 WARNING。
- 场景 5：仓库与实现
  - **AC-15**（FR-004）：GIVEN 本仓库 WHEN 查看 git 索引 THEN 9 个技能位于 `.agents/skills/<name>/SKILL.md`，`<configDir>/skills/` 与 `.zcode/skills/` 都不在索引里。
  - **AC-16**（FR-004）：GIVEN 本机工作区 WHEN 打开 ZCode 会话 THEN `.zcode/skills` 是指向 `.agents/skills` 的 junction，可用技能清单与迁移前一致。
  - **AC-17**（FR-005）：GIVEN 仓库 WHEN 查找技能加载实现 THEN 只有 `core-rs/src/skills.rs` 一份；`src/shared/` 下没有技能加载模块。

## 2. 功能需求

### FR-001：两个调用开关各管一侧

`user-invocable`（默认 true）管用户侧：false 时该技能不进斜杠菜单、`/name` 不匹配（落到与
未知 `/xxx` 相同的 passthrough），但仍在模型名单里且模型可调用。

`disable-model-invocation`（默认 false）管模型侧：true 时该技能不进模型名单、Skill 工具调用
被拒绝，但 `/name` 仍可触发。

两者正交、互不推导：`SkillCommand` 用 `user_invocable` / `model_invocable` 两个布尔表达，
不存派生字段。两者都关闭可达时技能不可达，加载期打一条 WARNING。

用户 `/name` 的注入路径与模型调用走同一个 Skill 工具，来源区分靠调用路径：模型侧开关只在
`tools::validate_input`（模型调用的唯一入口）生效，注入路径不经过它。

### FR-002：四个发现根，不读 `.claude`

技能发现面是四个文件系统根加 bundled：

| 层级 | 根 |
| --- | --- |
| project | `<cwd>/.agents/skills/<name>/SKILL.md` |
| project | `<cwd>/<configDir>/skills/<name>/SKILL.md` |
| user | `~/.agents/skills/<name>/SKILL.md` |
| user | `~/<configDir>/skills/<name>/SKILL.md` |
| bundled | 编译内置 |

根目录不存在是正常状态，按空列表处理，不报错也不提示。`.claude/skills/` 与
`.claude/commands/` 不参与发现。`cwd` 为空（无会话上下文）时跳过项目级两个根。

### FR-003：优先级 `project > user > bundled`，同名显式仲裁

rank 越小越优先，同层级内 `.agents` 优先于 `.<configDir>`：

| rank | 根 | 层级 |
| --- | --- | --- |
| 10 | `<cwd>/.agents/skills` | project |
| 20 | `<cwd>/<configDir>/skills` | project |
| 30 | `~/.agents/skills` | user |
| 40 | `~/<configDir>/skills` | user |
| 50 | bundled | 内置 |

同名（name 或 alias 命中）跨根冲突时 rank 最小者胜出，其余不进任何名单（模型名单与斜杠菜单
一致），并打一条同时点名胜出路径与被忽略路径的 WARNING。名单按 name 去重后每个 name 只出现
一次。同一物理文件经多个根可见（junction / symlink）时按 realpath 去重，只算一次且不算冲突。

内置命令（如 `spin`）恒优先于任何技能：同名技能在注册期被忽略并打 WARNING，内置命令不参与 rank。

### FR-004：技能文件的唯一副本

仓库自带的技能在 `.agents/skills/`，这是唯一入库位置。`.zcode/skills` 是本机指向
`.agents/skills` 的 junction，不入库（见 [AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）。
`<configDir>/skills` 两个根仍被读取，作为既有用户与既有技能的兼容层。

### FR-005：实现只有一份

技能加载、frontmatter 解析、变量替换只有 `core-rs/src/skills.rs` 一份实现；
`core-rs/fixtures/skills.json` 是手工维护的期望值表，不存在第二份实现对跑。

## 3. 行为规格

### 3.1 发现与去重

`skill_roots(cwd)` 给出按 rank 升序的根表，`get_all_skills(cwd)` 依次做三件事：扫根收集候选
→ realpath 去重（同一物理文件只留 rank 最小的一份，日志走独立的 `deduped` 通道）→ 同名仲裁
（`arbitrate` 纯函数，bundled 以 rank 50 参与同一个仲裁）。宿主侧的斜杠菜单与模型名单都取
`get_all_skills` 的结果，不各自拼列表。

### 3.2 frontmatter 字段

只解析下表字段；未列出的键被忽略（不报错）。解析器是 YAML 子集实现：支持标量、`- ` 数组与
`|` 字面量块，不支持折叠标量、流式数组与嵌套 map。

| 字段 | 解析结果 | 消费点 |
| --- | --- | --- |
| `name` | `display_name` | 未消费（命令名取目录名） |
| `description` | `description` | 模型名单、斜杠菜单；缺省时取正文首段 |
| `when_to_use` | `when_to_use` | 模型名单（拼在描述后） |
| `arguments` | `argument_names` | 变量替换（`$name` / `${name}`） |
| `user-invocable` | `user_invocable` | 斜杠菜单、`/name` 派发 |
| `disable-model-invocation` | `disable_model_invocation` | 模型名单、Skill 工具的模型调用校验 |
| `model` | `model` | 未消费（模型解析只看会话配置） |
| `version` | `version` | 未消费（仅随技能对象携带） |
| `paths` | `paths` | 未消费（不做按文件路径的条件激活） |

### 3.3 名单与消费点

| 消费点 | 过滤条件 | 输出 |
| --- | --- | --- |
| 模型名单（system prompt 的 Environment 段） | `model_invocable` | `- <name>: <description>[ - <when_to_use>]` 逐行 |
| 斜杠菜单（`UiRequest.skillsRequested`） | `user_invocable` | `{name, description, isBuiltin}`；内置命令 `isBuiltin: true`，技能 `false` |
| `/name` 派发 | `user_invocable` | 命中后交给 Skill 工具注入 |
| Skill 工具的模型调用校验 | `model_invocable` | 不满足即返回校验错误 |
| Spin 设计器的技能选择 | `user_invocable` | `{name, description}` |

名单文本每轮随系统提示重建，技能目录变化不需要重启 Core。

### 3.4 注入路径

模型调用：`Skill` 工具取正文 → 替换 `${SKILL_DIR}` / `${SESSION_ID}` → 包成 `isMeta: true` 的
user 消息随 `newMessages` 进对话，tool_result 文本是
`Skill "<name>" has been loaded. Follow the instructions in the skill content above.`。

用户 `/name`：命令在轮次边界解析 → 合成一条 assistant `tool_use` 消息 → 执行同一个 Skill 工具
→ 落 tool_result 与注入消息。整个过程落三条消息，UI 看到一张 Skill 卡片。

### 3.5 仲裁与日志

冲突 WARNING 形如
`Skill '<name>' at <被忽略路径> ignored (rank <n>); using <胜出路径> (rank <m>)`；
realpath 去重日志形如 `deduped '<name>' (<路径> from <来源> is the same file already loaded at rank <n>)`。
两者都写 core 的 stderr，都不进总线事件。

## 4. 边界与错误路径

- `SKILL.md` 不存在、读不出、frontmatter 解析失败：跳过该技能目录，不影响同根下其他技能。
- 四个根全不存在：名单只含 bundled 技能与内置命令，不报错。
- 同一根内目录名唯一；alias 撞名按「先到先得 + WARNING」处理。
- 两个开关都关闭可达：WARNING + 不可达，不影响其他技能。
- 模型调用 `disable-model-invocation` 的技能：返回校验错误
  `Skill '<name>' cannot be invoked by the model (disable-model-invocation: true)`，正文不注入。
- `/name` 区分大小写、按名称精确匹配，不做归一化；未知命令落到普通消息路径。
- 技能名含空白时无法用 `/name` 触发（命令名以空白切分），菜单仍会列出它。

## 5. 非目标

- 不读 `.claude/skills`、`~/.claude/skills`、`.claude/commands/*.md`。
- 不向上父目录查找：monorepo 根上的技能在子目录里打开会话时不可见。
- 不支持扁平 `skills/*.md`（只认 `<name>/SKILL.md`）。
- 不换真正的 YAML 解析器：折叠标量、流式数组、嵌套 map 仍不支持。
- 模型名单没有字符预算或截断；压缩后不重新挂载已加载的技能正文；重复调用不去重。
- 不改 `SkillListItem` 契约（不带来源与开关字段）。
- 不做技能管理面板与 `/skills` 列表。
- 弱化 `<configDir>/skills` 的路线未定，登记在
  [open-questions.md 第 1 节](../architecture/open-questions.md#1-corerust)。

## 6. 对需求基线的影响

对应 [US-27 斜杠命令与技能触发](user-stories/tools.md#us-27-斜杠命令与技能触发)：验收标准 1
列出四个发现根与 rank 顺序，验收标准 3 保留「技能与内置命令同名时技能被忽略」，
验收标准 4 给出两个调用开关的语义。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/skills.rs`（两个布尔与名单过滤）、`core-rs/src/tools.rs`（`validate_input`）、`core-rs/src/commands.rs`（`dispatch`）、`core-rs/src/main.rs`（`skills_payload`） | `skills_tests.rs`、`tools_tests.rs`、`commands_tests.rs`、`main_tests.rs` | 自动 |
| FR-002 | `core-rs/src/skills.rs` 的 `skill_roots` | `skills_tests.rs`（`agents_project_root_is_discovered` / `agents_user_root_is_discovered` / `claude_skills_root_is_ignored`） | 自动 |
| FR-003 | `core-rs/src/skills.rs` 的 `arbitrate` / `dedupe_by_file_identity` / rank 常量 | `skills_tests.rs`（`arbitrate_reports_both_paths` / `same_file_via_multiple_roots_dedupes_without_warning` / `project_skill_shadows_bundled` 等） | 自动 |
| FR-004 | `.agents/skills/**`、`.gitignore`、`AGENTS.md` 第 5 节 | 无自动覆盖 + 仓库内容与本地环境约定，靠 `git ls-files` 与手工核对 | 无自动覆盖 + 属于仓库布局 |
| FR-005 | `core-rs/src/skills.rs`（唯一实现）、`core-rs/fixtures/skills.json` | `npm run check-types` / `npm run lint` 绿 | 自动 |
