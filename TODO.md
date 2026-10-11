# TODO

只列**未排期**的想法与跨 spec 的缺口，每条带验收判据或指向某个 spec。进度不在本文件：
进入实施的改动在 `specs/<NNN>-<slug>/` 跟踪，`tasks.md` 的勾选状态即进度（工作流见
[specs/README.md](specs/README.md)）。完成的项当场删除；里程碑与已完成工作的历史记录见
`docs/archive/`。文档体系与「什么内容写到哪」见 `docs/README.md`。

- **e2e 测试名 ↔ spec FR 编号双向对照**（docsLint 组）：e2e 用例名里引用的 `FR-nnn` 必须能解析到
  活动 spec 或 `docs/features/` 的 FR 条目，spec 的每个 FR 至少被测试名或追溯矩阵行引用——防
  「spec 重排编号后既有测试名引用悬空」（specs/003 收敛评审时发现 FR-007 与 FR-002/003 两套编号
  分叉的实例）。验收判据：docsLint 新组上线，引用悬空即红。

- **SubAgentRegistry 只增不减**（specs/005 收敛反向对照发现的存量缺口）：TS
  `SubAgentRegistry.unregister` 与 Rust `subagent::unregister` 在生产代码中无调用方，
  注册表条目随子代理创建单调增长；注释声称的「完成一轮后注销」未接线，当前语义
  （递归中止可达性 / `subagent` 变更信号）依赖只增不减。接线需先定义「子代理何时
  算完」（一轮 vs 会话终结）并评估递归中止可达范围的变化。验收判据：注销接线后
  长对话场景注册表条目数有界（单测锁定），递归中止用例不回归。
