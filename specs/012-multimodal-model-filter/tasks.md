# 任务分解：模型默认 radio、多模态开关与非多模态图片过滤

执行顺序：先 shared 类型与默认值（T001–T002），再宿主保存链路（T003）与 core-rs
（T004–T005，两线可并行，T005 依赖 T004 的 `ProviderConfig.multimodal`），然后面板 UI
（T006），最后文档同步（T007）与全量闸门（T008）。需求见 [spec.md](spec.md)，技术方案
见 [plan.md](plan.md)；每条任务完成即勾选，全勾后进 /converge。

## 任务清单

- [x] **T001**（FR-002、FR-003）：`src/shared/utils/modelConfig.ts` 增加
  `ModelTokenLimits.multimodal` 与 `DEFAULT_MODEL_MULTIMODAL`，`normalizeModelTokenLimits`
  增加 overrides 实参并按「面板传值 > 已有值 > 默认」合并（历史条目保留合法布尔值）；
  依赖：—；完成判据：`src/test/hostSettings.test.ts` 新增合并用例（面板值覆盖已有、
  未传保留、`context` / `output` 不动）且 `npm run check-types` 绿。
- [x] **T002**（FR-003）：`src/shared/settingsSnapshot.ts` 的 `ModelLimits` 增加必选
  `multimodal`，`resolveModelLimits` / `normalizeModelConfigs` / `FALLBACK_LIMITS` 按
  `DEFAULT_MODEL_MULTIMODAL` 解析；依赖：T001；完成判据：
  `src/test/settingsSnapshot.test.ts` 新增用例（显式 `false`、缺省 `true`、非 boolean
  回落 `true`、兜底 `true`）全绿。
- [x] **T003**（FR-002）：宿主链路——`webviewMessages.ts` 的
  `SaveLlmConfigProvider.modelMultimodal` 与 `showLLMConfig.providers[].modelConfigs`
  条目类型，`llmConfigSave.ts` 校验并透传 overrides（第 2 段全表补齐不传），
  `settingsRead.ts` 载荷映射补 `multimodal`；依赖：T001；完成判据：
  `src/test/hostSettings.test.ts` 的 `applyLlmConfigSave` 用例绿 + `npm run check-types` 绿。
- [ ] **T004**（FR-003）：core-rs 快照契约——`settings.rs` 的 `ModelLimits.multimodal`
  （必选）、`config.rs` 的 `ProviderConfig.multimodal`，`test_support.rs` 夹具与
  `llm_tests.rs` / `responses_stream_tests.rs` 的 `ProviderConfig` 字面量补字段；依赖：—；
  完成判据：`core-rs/src/settings_tests.rs` 缺字段反序列化报错用例与
  `core-rs/src/config_tests.rs` 兜底取值用例绿（`cargo test`）。
  ※ 代码与测试已写完；本机（win-arm64）无 clang，ring 0.17 在 win-arm64 硬性要求
  clang 编译 C 代码，`cargo test` 无法在本地执行——待 CI / 常规开发环境验证。
- [ ] **T005**（FR-004、FR-005、FR-006）：`llm.rs` 增加 `has_images` 预扫描快路径与
  `strip_images`（克隆过滤、空内容补 `[Image]`），`stream()` 分发前单点接入；
  `util::IMAGE_PLACEHOLDER` 收敛 `compact.rs` 两处字面量；依赖：T004；完成判据：
  `core-rs/src/llm_tests.rs` 新增用例绿（纯图消息 / 图文混合 / tool_result 纯图与图文 /
  字符串 content 原样 / 入参不被改写 / 过滤后经 `to_chat_messages` 与
  `sanitize_anthropic_messages` 均无图片形态）。
  ※ 代码与测试已写完；同 T004，`cargo test` 本机无法执行，待 CI / 常规开发环境验证。
- [x] **T006**（FR-001、FR-002）：`LLMConfigPanel.tsx` 模型行改造——radio 取代「设为
  默认」按钮（组按 provider、空名 disabled）、删 `defaultModelSuffix` 覆盖层、新增
  「多模态」checkbox、`buildProvidersPayload` 带 `modelMultimodal`；i18n zh / en 增
  `llmConfig.modelMultimodal`、删 `llmConfig.defaultModelSuffix`；依赖：T003；完成判据：
  `npm run check-types && npm run lint` 绿，i18n 两文件无残留旧键。
- [x] **T007**（FR-001、FR-002、FR-003）：文档同步（与代码同一提交）——
  `docs/architecture/core-ui-separation.md` 4.3 条目文字补 `multimodal`，
  `docs/features/user-stories.md` US-23 验收标准改 radio 表述并新增多模态勾选与
  请求过滤条目；依赖：T002–T006；完成判据：`npm run test:all -- docs-lint` 绿。
- [ ] **T008**（FR-003、FR-004）：全量闸门——`npm run build:core:host` 后
  `npm run check-types && npm run lint && npm run test:all`（standalone 系列驱动真实
  Core 二进制）；依赖：T007；完成判据：全部命令绿，提交信息带 `Flow: L3` +
  `Spec: 012`。
