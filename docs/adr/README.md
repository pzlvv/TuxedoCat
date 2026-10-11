# ADR 索引

架构决策记录（ADR）：一个决策一个文件（`NNNN-<slug>.md`），只记决策、背景与被否决的
替代方案；**只增不删**，被新决策取代时把「状态」改为被取代并指向新编号，不删文件、不改写
已采纳的正文。写作模板见 `template.md`；「什么内容写到哪」的判据见 `docs/README.md`
分类法的「决策记录」行。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-two-core-implementations.md) | Core 的两套同契约实现（Embedded TS + Standalone Rust） | 已采纳 |
| [0002](0002-daemon-process-model.md) | Core 进程的 daemon 模型（一个 endpoint 一个 daemon） | 已采纳 |
| [0003](0003-client-connection-split.md) | Client / Connection 拆分（连接模型按工作区收敛） | 已采纳 |

新决策取下一个递增编号；`src/test/docsLint.test.ts` 校验编号连续且唯一、状态取值合法、
被取代指向的文件存在。
