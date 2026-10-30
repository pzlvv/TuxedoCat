# 任务分解：Bash 工具 detach 字段——后台化构造闸门与脱离管理授权

执行顺序：检测纯函数与 schema 字段先行（T001 / T002），闸门（T003）与豁免语义
（T004）依赖前者，权限分级（T005）只依赖 T001；文档与 ADR 收尾（T006 – T008）；
T009 全量闸门回归。需求口径见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-004）：在 `core-rs/src/tools.rs` 新增检测纯函数 `find_detach_construct`——段首词（`nohup` / `setsid` / `disown` / `Start-Process` 小写比对 / `start` + `/b` 二 token）与控制操作符 `&` 扫描（引号感知，排除 `&&` / `&>` / `&>>`）；依赖：—；完成判据：`core-rs/src/tools_tests.rs` 新增单测覆盖全部构造命中、`&&` 与引号内 `&` 与 `&>` 不命中（AC-2 / AC-3 / AC-4 / AC-5 的判定层），`npm run test:core` 绿
- [x] **T002**（FR-004）：Bash 工具 schema 新增 `detach` boolean 成员与 `BASH_DETACH_FIELD` 常量（一句防护性口径，不展开用法）；依赖：—；完成判据：`core-rs/src/tools_tests.rs` 新增 schema 断言用例（成员存在、description 无案例字样）
- [x] **T003**（FR-001）：`run_bash` 入口、`run_in_background` 分支之前落闸门与 LLM 面失败文案常量（构造名插值，逐字锁定）；依赖：T001、T002；完成判据：`core-rs/src/tools_tests.rs` 覆盖 AC-1 ～ AC-5 及「`run_in_background: true` 调用同样受闸门约束」用例 + 文案逐字对等测试，`npm run test:core` 绿
- [x] **T004**（FR-002）：豁免语义验证——`detach: true` 放行、无构造时字段惰性、未自我脱离命令超时回流自动转后台后按既有后台任务事实处理；依赖：T003；完成判据：`core-rs/src/tools_tests.rs` 覆盖 AC-6 / AC-7 / AC-8（回流用例用内部 `timeout` 覆盖驱动转后台，断言 `bash_task::task_status` 在册），`npm run test:core` 绿
- [x] **T005**（FR-003）：`core-rs/src/permission.rs` 的 `is_operation_risky` 扩展（detach + 命中 = 危险）、`ask_message` / `ask_choices` 换 `is_operation_risky` 单源判定并加 detach 专用确认文案与「允许执行 / 拒绝」选项；依赖：T001；完成判据：`core-rs/src/permission_tests.rs` 权限对照表覆盖 AC-9 ～ AC-12（risk 询问 / manual ⚠️ / auto 放行 / `detach: true` 无构造放行）+ 专用确认文案逐字测试，`npm run test:core` 绿
- [x] **T006**（FR-001 ～ FR-004）：新增 `docs/features/bash-detach.md`（七节骨架，行为与文案与代码一致）并登记 `docs/README.md` 地图；依赖：T003 ～ T005；完成判据：`npm run test:unit -- docs-lint` 绿（含地图覆盖断言）
- [x] **T007**（FR-003、FR-004）：新增 `docs/adr/0014-bash-detach-escape-hatch.md`——豁免开关 vs 执行模式、auto 模式零模态可见、业界对照（Claude Code 后台时长封顶 / dsh job 自始注册 / OpenCode 无模型侧字段）与被否方案；依赖：—；完成判据：docs-lint 的 ADR 编号连续断言绿
- [x] **T008**（FR-003）：基线文档四处修改——`docs/core/standalone-core.md` 第 4 契约（危险判据扩入 detach 逃生，点明与 `is_destructive_command` 首词口径差异）、[background-bash.md 第 4 节](../../docs/features/background-bash.md#4-边界与错误路径)交叉引用（detach 进程不属于后台任务事实，只留链接）、`docs/features/user-stories/tools.md` 新增 US-67、`docs/features/user-stories.md` 附录登记 e2e 豁免；依赖：T006；完成判据：`npm run test:unit -- docs-lint` 绿（章节引用与 FR 双向对照断言）
- [x] **T009**（FR-001 ～ FR-004）：全量闸门回归；依赖：T006 ～ T008；完成判据：`npm run check-types && npm run lint && npm run test:unit -- docs-lint && npm run test:core` 全绿
