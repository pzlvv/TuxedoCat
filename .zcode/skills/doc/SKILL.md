---
name: doc
description: 写规格与文档（as-built 的 docs/ 与改动规格的 specs/ 两层分工）
when_to_use: 写或改任何 .md 规格文档时
user-invocable: true
---

两层分工，先判断落在哪层：

- **`docs/`（architecture / core / hosts / features 四域）**：as-built 规格，只写现状——描述代码当前的实现，
  不出现「变成」「现在是」「不再是」等描述修改过程的用语。
- **`specs/`**：改动规格，描述尚未落地的意图与验收（AGENTS.md 第 0 节的显式例外）；
  目录约定、生命周期与闸门见 `specs/README.md`，模板在 `specs/_templates/`，
  入口是 /spec /plan /tasks /implement /converge，每个产出即停等人评审。
- 一次改动收敛后 delta 并入 `docs/`、spec 归档——`docs/` 里不出现「正在做的改动」。

写作规则（全文见 AGENTS.md 第 0 节，要点）：

- 只写应有形态；跨文档章节引用一律相对链接 + 锚点；禁行号引用；术语与代码一致。
- 聚合数字与名单不手抄：事件数量、契约成员、清单表都由 docsLint 对照代码校验；
  新清单表必须挂对应的 lint 组，先问一句「它漂了什么会红」。
- 含 `export` / 顶层声明的代码块必须标 `src=<路径>`，纯示意块在 info 里写「示意」。
- 同一事实只写一处：第二份文档只放链接，不复述。
- 主题规格（`docs/*.md` 顶层）带 owner / last_reviewed frontmatter（docsLint 校验）。
- 改完跑 `npm run test:all -- docs-lint`，红在哪同步哪。
