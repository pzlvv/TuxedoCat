---
status: 实施中
---

# 改动规格：技能系统的调用语义、共享目录与优先级

把技能系统对齐到 Agent Skills 标准的调用语义，同时把技能的发现面从产品私有目录扩到跨工具共享的
`.agents/skills`，并把解析优先级定成 `project > user > bundled`、同名冲突显式仲裁。

三块范围：**调用语义**（`user-invocable` 与新增的 `disable-model-invocation` 各自管一侧，修掉当前
`user-invocable: false` 反而对模型隐藏的反向实现）；**发现根**（项目级与用户级各加 `.agents/skills`，
`.agents` 优先于 `.<configDir>`，不读 `.claude`）；**优先级**（四个文件系统根 + bundled 按 rank 排序，
同名只保留 rank 最小者并打一条 WARNING，名单按 name 去重）。

顺带把本仓库自身的 9 个技能迁到 `.agents/skills`，并删掉 `src/shared/skills/` 那份零消费方的
遗留实现，让「技能怎么加载」只有一处事实。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `docs/features/skills.md` | — | 新增 | 技能系统的 as-built 规格：发现根与 rank、frontmatter 字段、两个调用开关、模型名单、注入路径、同名仲裁与日志 |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | [US-27 斜杠命令与技能触发](../../docs/features/user-stories/tools.md#us-27-斜杠命令与技能触发) | 修改 | 验收标准 1 的来源链改为四个根 + rank；新增两个调用开关的验收标准 |
| [docs/architecture/repo-map.md](../../docs/architecture/repo-map.md) | [目录布局](../../docs/architecture/repo-map.md#目录布局) | 修改 | `src/shared/` 一行去掉 `skills/`（实现只剩 `core-rs/src/skills.rs`） |
| [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md) | [第 1 节 Core（Rust）](../../docs/architecture/open-questions.md#1-corerust) | 修改 | 新增一行：弱化 `.<configDir>/skills` 的路线待定（现状 + 待定） |
| [AGENTS.md](../../AGENTS.md) | [第 5 节 工作流](../../AGENTS.md#5-工作流) | 修改 | 技能落库路径改为 `.agents/skills`；`.zcode/skills` 降为本地 junction，不再入库 |
| [docs/adr/0011-agents-shared-skills-discovery.md](../../docs/adr/0011-agents-shared-skills-discovery.md) | — | 新增 | 决策记录：发现面转向 `.agents` 共享目录、产品目录降为兼容层，含被否决的替代方案与「共享目录的写入方不受本项目控制」这一代价 |
| [docs/adr/README.md](../../docs/adr/README.md) | [ADR 索引](../../docs/adr/README.md) | 修改 | 索引表登记 ADR-0011 |

## 用户场景与验收标准

- 场景 1：用户主动触发（`/name`）
  - **AC-1**（FR-001）：GIVEN 技能 `a` 未设 `user-invocable`（默认 true）WHEN 在输入框输入 `/` THEN 斜杠菜单列出 `a`；发送 `/a` 后经 Skill 工具注入正文并在会话里留下 Skill 卡片。
  - **AC-2**（FR-001）：GIVEN 技能 `b` 设 `user-invocable: false` WHEN 输入 `/` THEN 菜单不列 `b`；手工发送 `/b` 不匹配任何技能，消息按普通消息进入对话（与未知 `/xxx` 同一条 passthrough 路径）。
  - **AC-3**（FR-001）：GIVEN 技能 `c` 设 `disable-model-invocation: true` WHEN 用户发送 `/c` THEN 正文照常注入并执行，参数替换与默认技能一致。
- 场景 2：模型主动加载
  - **AC-4**（FR-001）：GIVEN 技能 `b` 设 `user-invocable: false` WHEN 构建系统提示 THEN `b` 出现在 Available Skills 名单里，模型可调用并拿到正文。
  - **AC-5**（FR-001）：GIVEN 技能 `c` 设 `disable-model-invocation: true` WHEN 模型调用 Skill 工具 `skill: "c"` THEN 调用被拒绝，tool_result 是错误且文案点名该技能只能由用户触发，正文不进入上下文。
  - **AC-6**（FR-001）：GIVEN 技能 `d` 同时设 `user-invocable: false` 与 `disable-model-invocation: true` WHEN 加载 THEN 模型名单与斜杠菜单都不出现 `d`，模型调用被拒绝，core 日志打一条点名 `d` 的 WARNING。
- 场景 3：发现根
  - **AC-7**（FR-002）：GIVEN `<cwd>/.agents/skills/x/SKILL.md` 存在 WHEN 请求技能列表 THEN 列表含 `x`。
  - **AC-8**（FR-002）：GIVEN `~/.agents/skills/y/SKILL.md` 存在、当前工作目录与之无关 WHEN 请求技能列表 THEN 列表含 `y`。
  - **AC-9**（FR-002）：GIVEN 仓库里同时存在 `.claude/skills/z/SKILL.md` WHEN 请求技能列表 THEN 列表不含 `z`（不读 `.claude`）。
- 场景 4：优先级与同名仲裁
  - **AC-10**（FR-003）：GIVEN 项目 `<cwd>/.agents/skills/p/SKILL.md` 与用户 `~/.agents/skills/p/SKILL.md` 同名且描述不同 WHEN 调用 `/p` THEN 用项目那份；名单里 `p` 只出现一次，描述取项目那份。
  - **AC-11**（FR-003）：GIVEN 同一层级下 `<cwd>/.agents/skills/p/` 与 `<cwd>/<configDir>/skills/p/` 同时存在 WHEN 调用 `/p` THEN 用 `.agents` 那份；名单只一条。
  - **AC-12**（FR-003）：GIVEN 项目技能名为 `commit`（与 bundled 同名）WHEN 调用 `/commit` THEN 用项目那份，bundled 被遮蔽；名单只一条。
  - **AC-13**（FR-003）：GIVEN 任一同名冲突被仲裁 WHEN 读取 core 日志 THEN 有一条 WARNING 同时点名胜出路径与被忽略路径。
  - **AC-14**（FR-003）：GIVEN 同一物理目录经两个根可见（junction / symlink）WHEN 加载 THEN 只算一次，且不产生同名 WARNING。
- 场景 5：本仓库迁移
  - **AC-15**（FR-004）：GIVEN 本仓库 WHEN 查看 git 索引 THEN 9 个技能位于 `.agents/skills/<name>/SKILL.md`，`<configDir>/skills/` 与 `.zcode/skills/` 都不再入库。
  - **AC-16**（FR-004）：GIVEN 本机工作区 WHEN 打开 ZCode 会话 THEN `.zcode/skills` 是指向 `.agents/skills` 的 junction，可用技能清单与迁移前一致。
- 场景 6：实现单一化
  - **AC-17**（FR-005）：GIVEN 仓库 WHEN 查找技能加载实现 THEN 只有 `core-rs/src/skills.rs` 一份；`src/shared/skills/` 不存在，repo-map 的 `src/shared/` 一行不再列 `skills/`。

## 功能需求

### FR-001：两个调用开关各管一侧，语义对齐 Agent Skills 标准

`user-invocable`（默认 true）管**用户侧**：false 时该技能不出现在斜杠菜单、`/name` 不匹配
（落到与未知 `/xxx` 相同的 passthrough 路径），但仍出现在模型名单里且模型可调用。

`disable-model-invocation`（默认 false）管**模型侧**：true 时该技能不出现在模型名单（Available
Skills），Skill 工具调用被拒绝且正文不进入上下文，但 `/name` 仍可正常触发。

两个开关正交，四象限都有确定语义；两者都关闭可达（`user-invocable: false` 且
`disable-model-invocation: true`）时技能不可达，加载期打一条 WARNING 点名它。

`SkillCommand` 不再有 `isHidden` 这个派生字段，改为显式的 `userInvocable` / `modelInvocable`
两个布尔；「是否进模型名单」只由 `modelInvocable` 决定，「是否进斜杠菜单」只由 `userInvocable`
决定，两者互不推导。

用户 `/name` 的注入路径与模型调用走同一个 Skill 工具，但**来源必须区分**：模型侧开关只拦模型
发起的调用，不得拦住用户在斜杠菜单里选中的同一个技能。

### FR-002：新增 `.agents/skills` 发现根，不读 `.claude`

技能发现面从「产品私有目录」扩到跨工具共享目录，项目级与用户级各加一个根：

| 层级 | 根 |
| --- | --- |
| project | `<cwd>/.agents/skills/<name>/SKILL.md` |
| project | `<cwd>/<configDir>/skills/<name>/SKILL.md` |
| user | `~/.agents/skills/<name>/SKILL.md` |
| user | `~/<configDir>/skills/<name>/SKILL.md` |
| bundled | 编译内置 |

根目录不存在是正常状态，按空列表处理，不报错也不提示。明确**不读** `.claude/skills/`、
`~/.claude/skills/` 与 `.claude/commands/*.md`：本工程只认 `.agents` 这一套跨工具约定。

### FR-003：优先级 `project > user > bundled`，同名显式仲裁

rank 越小越优先，同层级内 `.agents` 优先于 `.<configDir>`：

| rank | 根 | 层级 |
| --- | --- | --- |
| 10 | `<cwd>/.agents/skills` | project |
| 20 | `<cwd>/<configDir>/skills` | project |
| 30 | `~/.agents/skills` | user |
| 40 | `~/<configDir>/skills` | user |
| 50 | bundled | 内置 |

同名（name 或 alias 命中）跨根冲突时 rank 最小者胜出，其余**不进任何名单**（模型名单与斜杠
菜单一致），并打一条同时点名胜出路径与被忽略路径的 WARNING。名单按 name 去重后每个 name 只
出现一次。

同一物理文件经多个根可见（junction / symlink）时按 realpath 去重，只算一次且不算冲突、不打
WARNING——这与「同名不同文件」是两类情况，必须分开。

内置命令（如 `spin`）恒优先于任何技能：同名技能被忽略并打 WARNING，内置命令不参与 rank。

### FR-004：本仓库的技能迁到 `.agents/skills`

仓库自带的 9 个技能从 `<configDir>/skills/` 迁到 `.agents/skills/`，`<configDir>/skills/` 与
`.zcode/skills/` 都不再入库——目前这两条路径各提交了 9 个同样的 blob，是同一份事实的两份副本。

`.zcode/skills` 保留为**本地** junction，指向 `.agents/skills`，供 ZCode 会话读取；它在
`.gitignore` 里被忽略。[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)写明这条约定与克隆后建 junction 的方式。

### FR-005：技能实现只有一份

删除 `src/shared/skills/`（1294 行、零消费方，ADR-0007 移除 Embedded Core 后的遗留），技能
加载、frontmatter 解析、变量替换只有 `core-rs/src/skills.rs` 一份实现。

`core-rs/fixtures/skills.json` 保留为 Rust 测试的行为对照数据，并在 `skills_tests.rs` 注明它
是手工维护的期望值（原 TS 侧生成器已随 Embedded Core 退役）。

## 边界与错误路径

- `SKILL.md` 不存在、读不出、frontmatter 解析失败：跳过该技能目录，不影响同根下其他技能（现状不变）。
- 四个文件系统根全不存在：名单只含 bundled 技能与内置命令，不报错。
- 同一根内目录名唯一，不会出现同名；alias 撞名按「rank 相同时先到先得 + WARNING」处理。
- 两个开关都关闭可达：WARNING + 不可达，不做加载失败处理（不影响其他技能）。
- 模型调用 `disable-model-invocation` 的技能：返回错误 tool_result，文案点名该技能只能由用户触发，正文不注入。
- `/name` 匹配保持区分大小写、按名称精确匹配，不做归一化（与现状一致）。
- 迁移后 `~/<configDir>/skills` 与 `<cwd>/<configDir>/skills` 仍被读取：弱化是后续方向，本次不删读取分支。
- 项目根上的技能在子目录里打开会话时仍不可见（不向上查找，见非目标）。

## 非目标

- 不读 `.claude/skills`、`~/.claude/skills`、`.claude/commands/*.md`。
- 不向上父目录查找（monorepo 根技能从子包打开仍不可见）→ 去向 [TODO.md](../../TODO.md)。
- 不换真正的 YAML 解析器：`>-` / `>` 折叠标量、流式数组、嵌套 map 仍不支持 → 去向 [TODO.md](../../TODO.md)。
- 不改 `SkillListItem` 契约（不加来源 / 开关字段），宿主仍只拿到 `name` / `description` / `isBuiltin`。
- 不迁移用户家目录里既有的技能，不删 `~/<configDir>/skills` 读取分支。
- 不加模型名单的字符预算、压缩后重挂技能正文、重复调用去重。
- 不做技能管理面板或 `/skills` 列表。
- 弱化 `.<configDir>/skills` 的具体路线（何时停读、是否给迁移提示）→ 去向 [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)。

## 对需求基线的影响

无新增 US。本次是既有能力（US-27 斜杠命令与技能触发）的行为修订：发现根从两个扩到四个、
优先级与同名仲裁定死、新增一个模型侧调用开关，因此改 US-27 的验收标准而不新开故事；
AC-1～AC-17 由 core 侧单测覆盖，不新增 e2e 用例（斜杠菜单的端到端路径已由 US-5 / US-27
既有用例覆盖，本次不改变其交互形态）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/skills.rs`（frontmatter 字段与两个布尔）、`core-rs/src/commands.rs`（dispatch 只匹配 `userInvocable`）、`core-rs/src/prompt.rs`（名单按 `modelInvocable` 过滤）、`core-rs/src/main.rs`（`skills_payload` 只出 `userInvocable`）、`core-rs/src/tools.rs`（模型调用校验与注入路径区分来源） | `core-rs/src/skills_tests.rs`、`core-rs/src/commands_tests.rs`、`core-rs/src/prompt_tests.rs`、`core-rs/src/main_tests.rs`、`core-rs/src/tools_tests.rs` | 自动 |
| FR-002 | `core-rs/src/skills.rs`（`get_skill_dir_commands` 的四个根） | `core-rs/src/skills_tests.rs` | 自动 |
| FR-003 | `core-rs/src/skills.rs`（rank 常量、同名仲裁、realpath 去重、WARNING） | `core-rs/src/skills_tests.rs` | 自动 |
| FR-004 | `.agents/skills/**`、`.gitignore`、[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流) | 无自动覆盖 + 仓库内容迁移，由 `git ls-files` 与一次手工核对（AC-15 / AC-16）验证 | 无自动覆盖 + 属于仓库内容与本地环境约定 |
| FR-005 | 删除 `src/shared/skills/**`、`docs/architecture/repo-map.md` | `npm run check-types` / `npm run lint` 绿 + `src/test/docsLint.test.ts` | 自动 |

## 待澄清

```text
```

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
- 偏差：
- 未做：
