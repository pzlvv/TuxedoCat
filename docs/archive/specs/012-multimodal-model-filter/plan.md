# 实施方案：模型默认 radio、多模态开关与非多模态图片过滤

技术路线：多模态开关沿「设置页草稿 → `saveLLMConfig` → 宿主写 `settings.json` →
快照下发 Core」的既有通道走（与 `apiType` 完全同构，多一个布尔成员），Core 侧把开关
并入 `ProviderConfig`，在 `llm.rs::stream` 的协议分发入口做**单点**图片过滤（副本上
操作，三协议共用）；设置页的默认模型改 radio、删「默认」后缀是纯 webview 改动。
需求与验收见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 设置页（`src/webview/LLMConfigPanel.tsx`）

- `ModelDraft` 增加 `multimodal: boolean`；从 `initialProviders[].modelConfigs[name]`
  初始化（载荷里的 modelConfigs 来自**已解析**快照，见第 4 点，缺省即 `true`）。
- 模型行改造：
  - 「设为默认」按钮 → `<input type="radio">`，组名按 provider 区分
    （`default-model-${provider.id}`），`checked` = 该模型名与 `defaultModel` 一致，
    `onChange` = 原 `handleSetDefaultModel`，模型名为空时 `disabled`。radio 选中后
    不可反选（与原按钮语义一致：默认值一经设置保持）。
  - 删除模型名输入框内的「默认」后缀覆盖层（`defaultModelSuffix` span 与随之的
    `paddingRight` 分支），i18n 键 `llmConfig.defaultModelSuffix` 从 zh / en 删除。
  - 新增「多模态」checkbox（i18n 新键 `llmConfig.modelMultimodal`：zh `多模态` /
    en `Multimodal`），`onChange` 改草稿（沿用 `handleModelApiTypeChange` 的
    providerId 定位写法）。
- `buildProvidersPayload` 每个 provider 增加 `modelMultimodal: Record<模型名, boolean>`
  （键与 `modelApiTypes` 同口径：trim 后的模型名）。

### 2. 宿主保存（`src/host/`）

- `webviewMessages.ts`：`SaveLlmConfigProvider` 增加 `modelMultimodal?: Record<string, boolean>`；
  `showLLMConfig` 载荷的 `providers[].modelConfigs` 条目类型补 `multimodal?: boolean`。
- `llmConfigSave.ts`：`PanelProvider` 增加 `modelMultimodal`（逐字段校验：值必须是
  boolean）；作为新的 overrides 实参传给 `normalizeModelTokenLimits`（仅第 1 段
  provider 表保存时传；第 2 段全表补齐不传——未编辑的 provider 保留已有值，不被
  覆写）。

### 3. 模型配置合并（`src/shared/utils/modelConfig.ts`）

- `ModelTokenLimits` 增加 `multimodal?: boolean`（磁盘形状，可选与 `apiType` 同豁免）。
- 新增 `export const DEFAULT_MODEL_MULTIMODAL = true`——默认值单源，快照解析与
  保存链路共用（对齐 `DEFAULT_API_TYPE` 的先例）。
- `normalizeModelTokenLimits`：步骤 1 保留历史条目时带上合法的 `multimodal`（boolean
  才留）；步骤 2 对列表内模型按「面板传值 > 已有值 > `DEFAULT_MODEL_MULTIMODAL`」写入。

### 4. 快照（`src/shared/settingsSnapshot.ts`）

- `ModelLimits` 增加 `multimodal: boolean`（**必选**——快照字段全必选）。
- `resolveModelLimits`：显式 boolean 用之，否则 `DEFAULT_MODEL_MULTIMODAL`；
  `normalizeModelConfigs` 保留 boolean 的 `multimodal`；`FALLBACK_LIMITS.multimodal`
  取同一常量。未知模型走兜底即 `true`。

### 5. 面板载荷（`src/host/settingsRead.ts`）

`readLlmConfigPanelPayload` 的 `modelConfigs` 映射补 `multimodal: limits.multimodal`
（现有注释「只带面板需要的三项」同步改）。面板因此拿到的总是**已解析**值。

### 6. Core（`core-rs/`）

- `settings.rs`：`ModelLimits` 增加 `pub multimodal: bool`（无 serde 默认——缺字段
  反序列化报协议错误，AC-10）。
- `config.rs`：`ProviderConfig` 增加 `pub multimodal: bool`，构造处取
  `limits.multimodal`（兜底路径天然为 `true`）。
- `llm.rs::stream` 入口单点过滤，在重试循环**之前**做一次（重试复用同一份过滤结果）：

  ```rust
  pub fn stream(req: &LlmRequest, emit: &mut dyn FnMut(LlmEvent)) -> Result<(), String> {
      // 非多模态模型：请求出口过滤全部图片。历史里没有图片（预扫描为零克隆）
      // 直接透传；有图片才在副本上过滤，入参 req.messages 不改写（FR-006）；
      // 单点在协议分发之前，三个协议实现拿到的都已无图片块。
      let filtered;
      let req: &LlmRequest = if req.provider.multimodal || !has_images(req.messages) {
          req
      } else {
          filtered = strip_images(req.messages);
          &LlmRequest { messages: &filtered, ..*req }
      };
      // ……既有重试循环不动
  }
  ```

- `strip_images(messages: &[Value]) -> Vec<Value>`：克隆后逐条处理（入参不动，
  FR-006）。只动 content 为数组的消息：`type == "image"` 的块丢弃；`tool_result`
  块的 content 数组去掉 image 部分，清空后补一个 `{ "type": "text", "text": "[Image]" }`；
  消息级 content 数组被清空时整体替换为同一个 `[Image]` text 块。字符串 content 与
  其它角色不动。占位文本收敛为 `util::IMAGE_PLACEHOLDER`（`"[Image]"`），`compact.rs`
  既有两处字面量改引用同一常量（行为不变的纯收敛）。
- 性能与快路径：先做一次借引用预扫描（零克隆），无图片（从未贴图的会话，多数场景）
  直接透传原请求；有图片才整体克隆过滤。实测（release，1000 条消息 / 20 张
  ~300KB base64 截图 / 序列化 8.2 MB）：克隆 + 过滤中位数 ~6 ms；20 张 ~1MB 大图
  （21.5 MB）~10 ms；预扫描本身 ~0.2 ms。每轮请求只做一次（重试复用），相对
  LLM 网络往返（秒级）与请求体序列化（同为整树遍历）是噪声级开销；代价是流式期间
  多驻留一份过滤副本（≈历史树的等量内存），可接受。

### 7. 测试

- `src/test/settingsSnapshot.test.ts`：显式 `false` / 缺省 / 非 boolean / 兜底。
- `src/test/hostSettings.test.ts`：`modelMultimodal` 合并（面板值覆盖已有、未传保留、
  `context` / `output` 不动、历史条目保留）。
- `core-rs/src/settings_tests.rs`：缺 `multimodal` 的快照反序列化报错；带值解析。
- `core-rs/src/config_tests.rs`：`ProviderConfig.multimodal` 来自模型限值 / 兜底。
- `core-rs/src/llm_tests.rs`：`strip_images` 全分支（纯图消息→`[Image]`；图文→留文本；
  tool_result 纯图→`[Image]`；tool_result 图文→留文本；字符串 content 原样；入参
  slice 不被改写）；过滤后消息经 `to_chat_messages` / `sanitize_anthropic_messages`
  与 Responses 转换均无图片形态（对应 AC-5 三协议断言）。
- `core-rs/src/llm_tests.rs` / `responses_stream_tests.rs`：`ProviderConfig` 字面量补
  `multimodal`（编译性）；`test_support.rs` 的 `test_fallback_limits` 补
  `"multimodal": true`、`build_test_model_limits` 支持覆盖（boolean 才采用）。
- 守卫：`npm run test:all -- docs-lint`。

### 8. 文档同步（与代码同一提交）

- `docs/architecture/core-ui-separation.md` 4.3 条目文字：`modelLimits` 成员清单补
  `multimodal`（docsLint 只对 4.3 表做一层展开，成员级不受 lint，但文字必须与代码一致）。
- `docs/features/user-stories.md` US-23：验收标准 2 的「模型行可设默认」改 radio
  表述；新增「多模态」勾选与非多模态请求过滤的验收条目。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/webview/LLMConfigPanel.tsx` | 修改：radio 取代默认按钮、删「默认」后缀、新增多模态 checkbox、载荷带 `modelMultimodal` | 无 |
| `src/webview/i18n/zh.ts` / `en.ts` | 修改：增 `llmConfig.modelMultimodal`，删 `llmConfig.defaultModelSuffix` | 无 |
| `src/host/webviewMessages.ts` | 修改：`SaveLlmConfigProvider.modelMultimodal`、`showLLMConfig.providers[].modelConfigs.*.multimodal` | webview 消息类型点名成员（无新增消息） |
| `src/host/llmConfigSave.ts` | 修改：透传并校验 `modelMultimodal` | 无 |
| `src/host/settingsRead.ts` | 修改：载荷 `modelConfigs` 补 `multimodal` | 无 |
| `src/shared/utils/modelConfig.ts` | 修改：`ModelTokenLimits.multimodal`、`DEFAULT_MODEL_MULTIMODAL`、normalize 合并 | settings.json 磁盘形状新增 `modelConfigs[].multimodal`（可缺省） |
| `src/shared/settingsSnapshot.ts` | 修改：`ModelLimits.multimodal`（必选）、解析与兜底 | 快照契约新增 `llm.providers[].modelLimits.*.multimodal` 与 `llm.modelLimitsFallback.multimodal`（4.3 表一层 lint 不受影响，条目文字同步） |
| `core-rs/src/settings.rs` | 修改：`ModelLimits.multimodal`（必选） | 同上，Rust 侧 |
| `core-rs/src/config.rs` | 修改：`ProviderConfig.multimodal` | Core 内部类型 |
| `core-rs/src/llm.rs` | 修改：`stream` 入口过滤、`strip_images`、占位常量 | 无新事件、无 wire 变化 |
| `core-rs/src/util.rs` + `compact.rs` | 修改：`IMAGE_PLACEHOLDER` 常量收敛 | 无 |
| `core-rs/src/test_support.rs` 等 Rust 测试 | 修改：夹具与字面量补字段 | 无 |

不新增事件；`events.md` 无需改动（`hostEnvironmentProvided` 载荷列不变）。会话落盘
格式不动（FR-006）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：webview 只改面板组件（不 import 宿主 API）；
      host 改动在 `llmConfigSave` / `settingsRead` / `webviewMessages`（不 import
      vscode / electron）；shared 改动是叶子层类型与纯函数；core-rs 只读快照、不触
      文件路径。无新增跨层边，无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：快照成员必选、缺字段报协议错误（不过度
      fallback）；`settings.json` 非法值按默认解析是该文件既有的规范化豁免面
      （`resolveSettingsSnapshot` 的既定口径）；`ModelTokenLimits.multimodal` 可选属
      磁盘形状（与 `apiType` 同一豁免，快照侧必选）；`modelConfigs` 写入点仍唯一
      （`applyLlmConfigSave`）；默认值单源（`DEFAULT_MODEL_MULTIMODAL` 一处定义）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动落 `core-rs/`
      并带两侧测试（TS 快照测试 + Rust 反序列化 / 过滤测试）；会话落盘格式不动，
      `src/shared/history/` 无涉及；ADR-0007 后 Core 只有 core-rs 一套实现，无双实现
      parity 义务。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`core-ui-separation.md` 4.3 条目文字与
      `user-stories.md` US-23 随代码同一提交更新；`docs/README.md` 地图不变（无新增
      / 移动文档）；`npm run test:all -- docs-lint` 绿。

## 被否决的替代方案

1. **三协议各自过滤**（在 `to_chat_messages` / `responses.rs` / Anthropic 分支各改
   转换函数）——否：三份拷贝必然漂移（`llm.rs::to_image_part` 与
   `responses.rs::to_image_part` 的形状差异注释已是这类分叉的先例）；分发前单点过滤
   一处覆盖三协议，且重试循环复用同一份结果。
2. **过滤写回引擎消息或落盘前改写**——否：FR-006。改写会让「换回多模态模型」失去
   可恢复性，并破坏 US-6 的落盘承诺；副本过滤代价是每轮一次浅克隆，可忽略。
3. **多模态放独立的「模型能力表」**（`modelCapabilities` + 独立兜底）——否：解析路径
   与 `modelLimits` 完全同构（模型级覆盖 + 全局兜底；协议成员 `apiType` 也非「限值」
   却已在其中），拆两张表徒增两侧同步面。
4. **`settings.json` 只在 `false` 时写 `multimodal`**——否：与
   `normalizeModelTokenLimits` 为每个模型写全 `context` / `output` 的既有形态不一致，
   文件不自描述；显式布尔让手编辑者看得见状态，缺省语义只留给「没跑过新保存」的
   老文件。
5. **保留「设为默认」按钮、radio 只作指示**——否：用户明确要求 radio 承担选择；
   保留按钮会出现双控件双真相，违背一份事实一个写入点。
