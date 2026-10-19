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

- **`docs/features/user-stories.md` 的拆分**（specs/010 收敛时登记，753 行已超文档 500 行上限
  的豁免项）：需求基线按主题拆成多份，但 `US-xx` 锚点被 e2e 用例与归档 spec 广泛引用，拆分要
  同时处理锚点迁移与引用重指。验收判据：拆分后全仓指向该文件的章节链接零失效（docsLint 链接
  组绿），e2e 的 US 编号映射不变。

- **`CoreRequest` 的 `waiting` 语义没有用例强制登记**（`specs/defects/tool-card-roundtrip-marks-waiting.md`
  修复时登记的缺口）：载荷类型已把「是否等用户」分开（`HostRenderRequest` / `UserBlockingRequest`，
  见 [docs/core/session-runtime.md 第 1 节](docs/core/session-runtime.md#1-来源与调用点)），发起点
  选错入口编译不过；但新增一种 `CoreRequest` 时没有任何用例要求声明它的 `waiting` 语义——该缺陷
  复发正是因为两条发点没有被任何用例覆盖。方向：表驱动用例，对每种 `CoreRequest` 类型跑一次，
  断言在途期间是否出现 `waiting=true` 快照与登记表一致。验收判据：新增 `CoreRequest` 类型而漏
  登记时用例红。
