# 任务分解：变更视图用状态字母标记文件

执行顺序：先在取数层把状态事实做出来并锁住（T001–T006），再在渲染层换行内形态
（T007–T009），随后补文档 delta 与验证（T010–T014）。spec 与 plan 见同目录
[spec.md](spec.md) / [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-002）：宿主取数层加 `ChangeStatus` 类型、`parseNameStatus` 纯函数与
      `DocEntry.status` / `oldPath` 成员，`buildChangeCommands` 增一条 `--name-status -z`
      事实（仍是一次 `runBatch`）；依赖：—；完成判据：`npm run test:unit -- sidebarDocView`
      绿，含 `parseNameStatus` 的分段解析用例与「批处理命令数 = 5」断言
- [x] **T002**（FR-002、FR-003）：`collectGitEntries` 按新路径合并 numstat 与 name-status；
      `parseNumstat` 的 0/0 规则改为「name-status 非 R 才丢」，纯重命名保留为 `R` 行；
      依赖：T001；完成判据：`npm run test:unit -- sidebarDocView` 绿，含「未跟踪 → A」
      「已暂存新文件 → A」「修改 → M」「重命名 → R 且 oldPath 是旧路径」「纯重命名保留」
      五条用例
- [x] **T003**（FR-006）：`buildDocRows` / `DocRow` 透传 `status` / `oldPath`；
      `DocListResult` 组装点（`electron/main.ts` 的两条 `sidebar:files-doc-list*`）不改判别值；
      依赖：T002；完成判据：`npm run test:unit -- sidebarDocView` 绿，含 `buildDocRows`
      透传用例；`npm run check-types` 绿
- [x] **T004**（FR-006）：`src/shared/AssistantEventBus.ts` 的 `WorkViewChangeEntry` 加必选
      `status` / `oldPath`；依赖：—；完成判据：`npm run check-types` 绿（不改 `?`，不破
      docsLint 的可选成员冻结）
- [x] **T005**（FR-002、FR-006）：Core 侧 `core-rs/src/work_view_changes.rs` 加
      `ChangeStatus` / `ChangeEntry.status` / `old_path` / `parse_name_status_z`，
      `entries_against_head` 增一次 `--name-status` 并与 numstat 合并，未跟踪与无 HEAD 分支
      一律 `A`；`core-rs/src/main.rs` 的 `workViewChangesRequested` 序列化补两字段；
      依赖：—；完成判据：`npm run test:core -- work_view_changes` 绿
- [x] **T006**（FR-002、FR-006）：Core 侧测试：`work_view_changes_tests.rs` 加
      `parse_name_status_z` 分段 / 中文路径 / 畸形条目用例与「纯重命名保留为 R」，
      `main_tests.rs` 断言条目 JSON 含 `status` / `oldPath`；依赖：T005；完成判据：
      `npm run fmt:rust:check` 绿且 `npm run test:core -- work_view_changes` 绿
- [x] **T007**（FR-001、FR-003）：`electron/sidebar/main.ts` 的 `DocViewRow` 加
      `status` / `oldPath`，`docRowHtml` 渲染状态字母（复用 `.file-icon` 槽位）、
      `R` 行显示 `旧名 → 新名` 与完整前后路径的 `title`、`R` 行不渲染 `.doc-count`；
      依赖：T003；完成判据：`npm run check-types` 绿、`npm run lint` 绿
- [x] **T008**（FR-001）：`electron/sidebar/styles.css` 加 `.doc-status` 与三个配色 class
      （深色 + 浅色主题两档），槽位宽 14px 与 `.file-icon` 一致；依赖：T007；完成判据：
      `npm run compile` 绿
- [x] **T009**（FR-001、FR-003、FR-004、FR-005）：`e2e/electron/fileExplorer.spec.ts` 补 AC-1 /
      AC-3 / AC-4 / AC-5 / AC-6 / AC-8 / AC-9 七个用例；依赖：T007、T008；完成判据：
      `npm run test:e2e:local -- fileExplorer` 绿
- [x] **T010**（FR-006）：`e2e/electron/remoteChangeList.spec.ts` 补 AC-7（Overlay 变更
      清单的 `M` / `A` / `R` 字母与磁盘口径一致）、`e2e/electron/overlayMountProxyRemote.spec.ts`
      断言 Overlay 条目带 `status`；依赖：T005、T007；完成判据：
      `npm run test:e2e:local -- remoteChangeList` 绿
- [x] **T011**（FR-001）：`docs/features/user-stories/desktop.md` 的 US-63 验收标准按 spec
      修订（行首状态字母、配色、`R` 行、纯重命名改为显示、徽标只对 `A` / `M`）；
      依赖：T009；完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T012**（FR-001、FR-006）：[docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)、
      [docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)、
      [docs/core/conversation-work-view.md 第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)、
      [docs/core/standalone-core-boundaries.md 第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) 按 spec 修订；依赖：T005、T011；
      完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T013**（FR-001～FR-006）：全量验证：`npm run check-types`、`npm run lint`、
      `npm run test:unit`、`npm run test:core`、`npm run docs:freshness`（只看报告）；
      依赖：T009、T010、T012；完成判据：前四项全绿，freshness 报告已过目
- [x] **T014**（FR-001～FR-006）：收敛：核对 9 条 AC 与实现 / 测试证据写入 spec 的「收敛
      记录」，status 改「已收敛」，归档到 `docs/archive/specs/055-sidebar-change-status-letters`；
      依赖：T013；完成判据：`npm run test:unit -- docs-lint` 绿且 `git status` 里没有残留
      `specs/055-*`
