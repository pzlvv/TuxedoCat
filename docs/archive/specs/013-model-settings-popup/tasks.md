# 任务分解：模型行「设置」弹层（多模态 / context / output）

执行顺序：先 shared 合并纯函数（T001），再宿主链路（T002），然后面板 UI（T003–T005，
T004 依赖 T003 的弹层骨架），最后 e2e（T006）、文档同步（T007）与全量闸门（T008）。
需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)；每条任务完成即勾选，
全勾后进 /converge。

## 任务清单

- [x] **T001**（FR-003）：`src/shared/utils/modelConfig.ts` 的
  `normalizeModelTokenLimits` 增加第 5 参 `limitOverrides`（数值 > 0 胜已有值与注册表；
  `null` 跳过已有值取注册表 fallback；无 override 走现状）；依赖：—；完成判据：
  `src/test/hostSettings.test.ts` 新增合并优先级用例（显式值胜已有、清空回落注册表、
  未碰保留、非法 override 丢弃）全绿，`npm run check-types` 绿。
- [x] **T002**（FR-003）：宿主链路——`webviewMessages.ts` 的
  `SaveLlmConfigProvider.modelLimits` 与 `llmConfigSave.ts` 的 `PanelProvider.modelLimits`
  逐字段校验（正数或 `null`，其余丢弃）并传入 T001 的 overrides；依赖：T001；完成判据：
  `src/test/hostSettings.test.ts` 的 `applyLlmConfigSave` 载荷校验用例绿。
- [x] **T003**（FR-001、FR-002）：`LLMConfigPanel.tsx`——`ModelDraft` 增加
  `contextText/outputText`，行内「多模态」checkbox 换成「设置」图标按钮，新增模态
  弹层组件（本地快照 + 应用写回 / 取消丢弃，预填 = 草稿值 > 载荷解析值），i18n 新增
  7 键（zh / en）；依赖：—；完成判据：`npm run check-types` 绿；webview 构建产物
  `npm run build:webview`（或 compile）无错。
- [x] **T004**（FR-003、FR-005）：`LLMConfigPanel.tsx` 的脏检测（`contextText/outputText`
  与初始解析值比较）与 `buildProvidersPayload` 的 `modelLimits` 组装（untouched /
  value / invalid 三态解析）；依赖：T003；完成判据：`npm run check-types` 绿，payload
  形态与 T002 校验对齐（手工构造载荷走 `applyLlmConfigSave` 用例覆盖）。
- [x] **T005**（FR-004）：`handleSave` 校验链追加 invalid 限值拦截（`setModelError`
  带模型名提示、切 tab、不写盘）；依赖：T004；完成判据：e2e 非法输入用例绿
  （见 T006）。
- [x] **T006**（FR-001–FR-005）：`e2e/webview/settings.spec.ts` 新增弹层用例：行内
  无 checkbox 有设置按钮、打开预填解析值、改值保存重开仍显示、清空保存后回落、
  非法输入保存拦下、取消不改值；依赖：T003–T005；完成判据：
  `npm run test:e2e:webview -- settings` 相关用例绿。
- [x] **T007**（文档同步）：修订 `docs/features/user-stories.md` US-23、
  `docs/architecture/core-ui-separation.md` 4.3、
  [host-ui-modules 第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler)
  （同 spec 影响基线表）；依赖：T002、T003；完成判据：
  `npm run test:all -- docs-lint` 绿。
- [x] **T008**（全量闸门）：`npm run check-types && npm run lint && npm run test:all`；
  依赖：T001–T007；完成判据：三条命令全绿，结果回写本文件与 spec 收敛记录候选。
  实测：check-types / lint 干净；test:all 57 项全绿（含 docs-lint 45 组）；
  e2e webview settings 18 项全绿（含 3 条新增弹层用例）。
