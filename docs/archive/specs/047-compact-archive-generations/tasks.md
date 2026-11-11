# 任务分解：多次压缩的归档逐代保留与逐层展开

执行顺序：Core 归档读写与合并口径先做通（T001–T004），再改契约与宿主（T005–T007），
然后接 webview 层级（T008–T010），最后补文档与全量验证（T011–T012）。
需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：归档记录信封加代次 —— `core-rs/src/history.rs` 的保存路径写
      `compactGeneration`（u64，1 起），读取返回 `(generation, message)`；缺字段按第 1 代。
      依赖：—；完成判据：`cargo test --manifest-path core-rs/Cargo.toml history` 中的旧格式
      读取用例绿。

- [x] **T002**（FR-001）：保存改为按代次追加 —— `save_compact_archive` 换成
      `append_compact_archive`：读既有最大代次、以追加方式写本代记录，不再整份覆盖；
      `core-rs/src/compact.rs` 的写入口随之改名。依赖：T001；完成判据：
      `cargo test --manifest-path core-rs/Cargo.toml compact_engine` 的既有归档用例改绿
      （一次压缩仍是 11 条记录）。

- [x] **T003**（FR-001、FR-004）：多次压缩后归档有两代 —— `core-rs/src/compact_engine_tests.rs`
      新增用例：连续压两次，归档记录代次为 1 / 2，第 1 代记录逐字节不变。依赖：T002；
      完成判据：该用例绿，且既有 `repeated_compact_keeps_the_global_user_input_head` 仍绿。

- [x] **T004**（FR-002、FR-004）：合并口径产出代次下标 —— `core-rs/src/main.rs` 的
      `compact_archive_display` 返回 `{ messages, generationStarts }`：按代次分组、按 uuid
      去重、起始下标单调、旧格式补偿与保留区追加沿用既有口径。依赖：T001；完成判据：
      `core-rs/src/main_tests.rs` 新增两代归档用例绿（摘要只出现一次、下标对齐代次）。

- [x] **T005**（FR-002）：契约扩展 —— `src/shared/AssistantEventBus.ts` 新增
      `CompactArchiveDisplay` 并改 `compactArchiveRequested` 结果；`src/host/webviewMessages.ts`
      的 `expandCompactDone` 增加必填 `messages` / `generationStarts`；`src/host/coreFacts.ts`
      的返回类型随之收窄。依赖：T004；完成判据：`npm run check-types` 通过。

- [x] **T006**（FR-002、FR-003）：宿主展开取数与分段转换 —— `webviewMessageHandler.ts` 的
      `handleExpandCompact` 按 `generationStarts` 切段逐段 `buildReplayMessageData`，累加出
      转换后的下标，只用一条 `expandCompactDone` 下发，不再投递 `messagesReplaced`。
      依赖：T005；完成判据：`npm run check-types && npm run lint` 通过。

- [x] **T007**（FR-002）：PyCharm 桥补空载荷 —— `HostUi.kt` 的 `expandCompact` 分支按新协议
      补 `messages` / `generationStarts` 空数组（v1 仍只发完成信号）。依赖：T005；
      完成判据：Kotlin 编译不在本地车道时登记 `skipped` 并写明原因。

- [x] **T008**（FR-002）：webview 纯函数 —— 新增 `src/webview/compactExpand.ts`：
      `compactGenerations` / `compactVisibleMessages` / `canExpandCompact`。依赖：T005；
      完成判据：`npm run test:unit -- compact-expand` 绿。

- [x] **T009**（FR-002、FR-003）：webview 层级状态与逐层铺消息 —— `App.tsx` 引入
      `compactArchiveView` / `compactExpandDepth`，点击时分「首次请求」与「用缓存加深一层」；
      `conversationLoaded` / 新建对话 / `compactEnd complete` 清缓存并归零；`MessagesView`
      的 `hasCompactArchive` + `isCompactExpanded` 合并为 `canExpandCompact`；
      `useAppHandlers` 删掉两个从未被读的 props。依赖：T008；完成判据：
      `npm run check-types && npm run lint` 通过。

- [x] **T010**（FR-002、FR-004）：e2e 逐层展开 —— `e2e/helpers/fakeHost.ts` 的 `expandCompact`
      改为按新协议回 `expandCompactDone`（带 `expandedMessages` / `expandedGenerationStarts`）；
      `e2e/webview/messagePresentation.spec.ts` 新增 US-17 用例：三次点击逐层展开、
      每层内容增量正确、末次点击后按钮消失。依赖：T009；完成判据：
      `npm run test:e2e:webview -- messagePresentation` 绿。

- [x] **T011**（FR-001 ～ FR-004）：文档 delta 并入 as-built ——
      `docs/features/compaction.md` 的 FR-005 / 数据流 / 边界 / 追溯矩阵，
      US-17 验收 2，`docs/architecture/core-ui-separation.md` 3.6，
      [docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为) 与 `onMessagesReplaced` 行，
      `docs/architecture/events.md` 的 `messagesReplaced` 行。依赖：T002–T010；
      完成判据：`npm run test:unit -- docs-lint` 绿。

- [x] **T012**（FR-001 ～ FR-004）：全量验证 —— `npm run check-types && npm run lint &&
      npm run test:core && npm run test:unit && npm run build:core:host`，
      再跑 `npm run test:e2e:webview`。依赖：T001–T011；完成判据：全绿，或对跑不了的
      车道在 spec 的「收敛记录」写明原因。
