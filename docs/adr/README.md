# ADR 索引

架构决策记录（ADR）：一个决策一个文件（`NNNN-<slug>.md`），只记决策、背景与被否决的
替代方案；**只增不删**，被新决策取代时把「状态」改为被取代并指向新编号，不删文件、不改写
已采纳的正文。写作模板见 `template.md`；「什么内容写到哪」的判据见 `docs/README.md`
分类法的「决策记录」行。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-two-core-implementations.md) | Core 的两套同契约实现（Embedded TS + Standalone Rust） | 被 [0007](0007-single-core-rust-only.md) 取代 |
| [0002](0002-daemon-process-model.md) | Core 进程的 daemon 模型（一个 endpoint 一个 daemon） | 已采纳 |
| [0003](0003-client-connection-split.md) | Client / Connection 拆分（连接模型按工作区收敛） | 已采纳 |
| [0004](0004-spec-driven-change-workflow.md) | SPEC 驱动开发的改动规格层（`specs/`） | 已采纳 |
| [0005](0005-docs-tree-and-feature-specs.md) | 文档体系重组（拆解 DEVELOPMENT.md、docs/ 分域目录与特性规格层） | 已采纳 |
| [0006](0006-tiered-change-workflow.md) | 改动分级流程（L0 直改 / L1 缺陷修复 / L2 需求变更 / L3 新特性） | 已采纳 |
| [0007](0007-single-core-rust-only.md) | 移除 Embedded Core，只保留 Rust 实现 | 已采纳 |
| [0008](0008-viewer-file-watch-core-push.md) | 查看器文件自动刷新用 Core 主动推送而非宿主轮询 | 已采纳 |
| [0009](0009-todo-state-owned-by-core.md) | Todo 状态由 Core 持有，宿主按需索取、变更推送 | 已采纳 |
| [0010](0010-ask-user-question-dsh-schema.md) | AskUserQuestion 入参对齐 dsh 的 questions 形状 | 已采纳 |
| [0011](0011-agents-shared-skills-discovery.md) | 技能发现面转向 `.agents` 共享目录（产品目录降为兼容层） | 已采纳 |
| [0012](0012-session-lock-kernel-lock.md) | 会话独占锁用 OS 建议性文件锁（锁生命周期归内核） | 已采纳 |

新决策取下一个递增编号；`src/test/docsLint.test.ts` 校验编号连续且唯一、状态取值合法、
被取代指向的文件存在。
