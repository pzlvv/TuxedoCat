# ADR-0011：技能发现面转向 `.agents` 共享目录

- 状态：已采纳
- 日期：2026-10
- 规格：docs/features/skills.md（技能系统的 as-built 规格，随本次改动落地新增）

## 背景

技能的发现根一直只有产品私有目录：用户级 `~/<configDir>/skills` 与项目级
`<cwd>/<configDir>/skills`。这带来两个问题：

- **生态无法复用**：`SKILL.md` 已经是跨工具的约定（Agent Skills 标准），业界同类工具的
  共享根是 `.agents/skills`（项目级与用户级各一个）——opencode 与 dsh 都读它。只有产品私有
  目录意味着同一个技能要在每个工具下各放一份，或者靠人手维护软链。
- **同一事实两份副本**：本仓库自身就在承受这个代价——`.zcode/skills` 是指向
  `.tuxedo-cat/skills` 的 junction，两条路径在 git 索引里各提交了 9 个内容相同的 blob，
  「谁是真相」要靠 AGENTS.md 的文字约定维持。

同时，技能的两个调用开关与业界语义不一致：`user-invocable: false` 被实现成「对模型也隐藏」，
而标准的含义是「只有模型能调用」；模型侧则完全没有「只能由用户触发」的开关，从 Claude Code
移植过来的有副作用技能（deploy / publish 之类）无法锁定为手动调用。

## 决策

技能的发现面按「共享目录优先、产品目录降为兼容层」的形态组织：

- 发现根四个，rank 越小越优先：`<cwd>/.agents/skills`（10）→ `<cwd>/<configDir>/skills`（20）
  → `~/.agents/skills`（30）→ `~/<configDir>/skills`（40）→ bundled（50）。
  同层级内 `.agents` 恒优先于 `.<configDir>`。
- 不读 `.claude/skills` 与 `.claude/commands/`：跨工具约定只认 `.agents` 一套，不并存两套。
- 同名冲突显式仲裁：rank 最小者胜出，其余不进任何名单并打一条同时点名胜出与被忽略路径的
  WARNING；同一物理文件经多个根可见（junction / symlink）按 realpath 去重，不算冲突。
- 两个调用开关各管一侧：`user-invocable`（默认 true）管用户侧（斜杠菜单与 `/name` 匹配），
  `disable-model-invocation`（默认 false）管模型侧（Available Skills 名单与 Skill 工具调用）。
  两者都关闭可达时技能不可达并打 WARNING。
- 本仓库的 9 个技能迁到 `.agents/skills`；`.zcode/skills` 降为本地 junction，不入库。
- `.<configDir>/skills` 的读取分支保留（既有用户与既有技能不受影响），但它是兼容层，方向是
  逐步弱化（停读时机另立决策，见 [open-questions.md 第 1 节](../architecture/open-questions.md#1-corerust)）。

实现落点：`core-rs/src/skills.rs`（根表与仲裁）、`core-rs/src/tools.rs`（模型侧拒绝）、
`core-rs/src/commands.rs`（`/name` 匹配）、`core-rs/src/prompt.rs`（模型名单）。

## 替代方案（被否决）与后果

1. **维持只读产品私有目录。** 否决：技能生态复用不了，本仓库的双份副本问题也解决不掉。
2. **加 `.claude/skills` 兼容根（对齐 opencode 的多根策略）。** 否决：两套跨工具约定并存会让
   「技能该放哪」长期含糊；`.agents` 已被 opencode 与 dsh 共同支持，是更窄的交集。
3. **`.agents` 与 `.<configDir>` 同级但产品目录优先。** 否决：迁移后项目自己的技能放在
   `.agents`，产品目录优先会让「后来者在产品目录补一份同名技能」静默盖掉共享技能，与弱化方向相反。
4. **迁移时把 `.tuxedo-cat/skills` 留成指向 `.agents/skills` 的反向 junction。** 否决：反向链接
   会让真相再次分叉；保留读取分支已经足够兼容。
5. **模型侧拒绝放在执行处（`run_skill`）。** 否决：用户 `/name` 的注入路径与模型调用共用同一个
   执行入口，在执行处拒绝会连带拦掉用户触发；要区分来源就得把内部状态写进 tool input。

后果：

- **收益**：同一份技能在多个工具间复用；仓库里技能只有一份副本；有副作用技能可以锁定为手动
  触发；调用语义与 Agent Skills 标准一致，移植技能不需要改写 frontmatter。
- **代价**：共享目录的写入方不受本项目控制——别的工具装进来的技能会直接出现在本产品的名单里，
  等于把第三方内容引入模型上下文。文档需要明确「第三方技能按依赖对待、装前审计」。
- **待办**：`.<configDir>/skills` 何时停读、是否给迁移提示，尚未定，登记在
  [open-questions.md](../architecture/open-questions.md)。
