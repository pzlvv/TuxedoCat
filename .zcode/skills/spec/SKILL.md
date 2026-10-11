---
name: spec
description: 起草改动规格（specs/<NNN>-<slug>/spec.md 或 defect.md），产出即停等人评审
when_to_use: 开始一项新改动、需要先把「要做出什么样」落成版本化规格时
user-invocable: true
---

产物：`specs/<NNN>-<slug>/spec.md`（缺陷改动用 `defect.md`）。只做这一件事，产出即停，
等人评审；评审通过前不得进入 /plan。

步骤：

1. 定编号与 slug：编号取 `specs/` 与 `docs/archive/specs/` 已用最大值 +1（三位、不复用）；
   slug 小写连字符，与实施分支同名。
2. 复制 `specs/_templates/spec.md`（缺陷改动复制 `defect.md`）到 `specs/<NNN>-<slug>/`，
   frontmatter 的 status 保持「起草」。
3. 影响基线：逐条声明改动落在哪些 as-built 规格的哪些章节（只链接**已存在**的文档与
   锚点），标注新增 / 修改 / 删除；新增文档在落地前写行内代码、落地后改链接。
4. 用户场景与验收标准：每条验收标准一行式 GIVEN / WHEN / THEN，写作
   `- **AC-n**（FR-nnn）：GIVEN … WHEN … THEN …`，回指功能需求条目；不写
   「支持 / 优化 / 合理 / 尽量」这类不可判定的词。
5. 功能需求：`### FR-nnn：<标题>`（nnn 三位、不重复），只写「应该是什么样」，
   不写实现方案（那是 /plan 的事）。
6. 补齐边界与错误路径、非目标、对 docs/features/user-stories.md 的影响（新增 US 必须登记 e2e
   用例或按既有口径登记豁免；流程类改动写「无新增 US」+ 理由）。
7. 未决问题写入「待澄清」节：`[待澄清]` 必须同行带去向链接（转 ADR / 转
   [docs/architecture/open-questions.md](../../../docs/architecture/open-questions.md) / 写成非目标）；实施前必须清零。
8. 停：把 spec.md 交给用户评审，等明确反馈。

规则出处：`specs/README.md`（工作流与守卫口径）、`AGENTS.md` 第 0 节（specs/ 例外与
写作规则）。
