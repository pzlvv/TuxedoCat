# 任务分解：自动获取模型时尝试取回上下文窗口

执行顺序：先落纯函数与单测（可独立验证），再改宿主提取与 wire 载荷，然后合并链与面板对话框，
最后 e2e、文档同步与收敛归档。需求见 [spec.md](spec.md)，方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-002）：`src/shared/utils/modelConfig.ts` 新增 `readModelContextFromEntry`——按 `meta.n_ctx` → `context_length` → `max_model_len` → `max_context_length` 取第一个大于 0 的安全整数，取不到返回 `null`，`meta.n_ctx_train` 不参与；依赖：—；完成判据：`src/test/modelContextProbe.test.ts` 中字段优先级、`n_ctx_train` 排除、`0` / 负数 / 非数字 / 缺失四类非法值全部通过
- [x] **T002**（FR-001）：`WebviewMessageHandler.fetchModelsFromProvider` 返回 `{ models, modelContexts }`，提取发生在既有 `rawList.map` 内、不新增 HTTP 请求；依赖：T001；完成判据：`src/test/modelContextProbe.test.ts`「单次模型列表请求内提取候选」用例通过（请求计数为 1）
- [x] **T003**（FR-006）：`src/host/webviewMessages.ts` 的 `providerModelsFetched` / `providerModelsResult` / `detectProviderModelApiTypes` 三处载荷各加 `modelContexts`；`handleFetchProviderModels` 与 `handleDetectProviderModelApiTypes` 回包携带候选（阶段二由请求回传）；依赖：T002；完成判据：`npm run check-types` 通过且两处回包在 handler 里实际赋值
- [x] **T004**（FR-004）：`normalizeModelTokenLimits` 增 `probeContexts` 参数，`resolveLimit` 的判定顺序改为「探测值 > 弹层清空 > 弹层显式值 > 已有值 > 注册表」；`applyLlmConfigSave` 透传面板载荷；依赖：T001；完成判据：`src/test/hostSettings.test.ts` 新增用例覆盖 AC-10 / AC-11 / AC-12 / AC-13 / AC-15 / AC-16 并通过
- [x] **T005**（FR-003、FR-004）：面板 `ModelDraft` 增 `contextProbe`，`mergeFetchedModels` 对全部模型（含既有）写入候选，确定时按勾选状态保留或清除；依赖：T003、T004；完成判据：`npm run check-types` 通过，且未勾选 context 时保存载荷不含该模型的覆盖值
- [x] **T006**（FR-005）：`LLMConfigPanel.tsx` 的确认对话框改成两个并列勾选项（协议项按 `needDetect.length` 置灰、context 项按候选数量置灰），确定按组合执行、跳过与点遮罩等同都不勾；依赖：T005；完成判据：`e2e/webview/settings.spec.ts` 两个勾选项与两种置灰用例通过
- [x] **T007**（FR-005）：`src/webview/i18n/zh.ts` 与 `en.ts` 补齐对话框文案与置灰说明；依赖：T006；完成判据：`npm run lint` 通过，且面板代码无用户可见文本字面量
- [x] **T008**（FR-005、FR-006）：`e2e/helpers/fakeHost.ts` 的 `fetchProviderModels` 回包带 `modelContexts` 并在回执里记录 `saveLLMConfig` 的 provider 条目；依赖：T003；完成判据：`e2e/webview/settings.spec.ts` 新用例能读到回带候选
- [x] **T009**（FR-001…FR-006）：`docs/` 四处 delta 同步（`host-ui-modules.md` 的 WebviewMessageHandler 节、`core-ui-separation.md` 的「快照字段」节、`sessions-and-llm.md` 的 US-23、`contracts.md` 的「宿主侧入口：动作翻译为 UiEvent」节）；依赖：T002—T006；完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T010**（FR-001…FR-007）：收敛记录三分类写进 spec，`npm run check-types` / `npm run lint` / `npm run test:unit -- docs-lint` 全绿后归档到 `docs/archive/specs/`；依赖：T001—T009；完成判据：`specs/060-auto-fetch-model-context/` 目录不再存在于 `specs/`，且归档后 docs-lint 仍绿
