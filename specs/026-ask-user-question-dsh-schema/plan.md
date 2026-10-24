# 实施方案：AskUserQuestion 入参对齐 dsh 的 questions 形状

本方案把 `AskUserQuestion` 的入参、答案回传、`userChoice` 请求/结果、webview 选择框
统一改成 dsh 的 `questions` / `options` / `multi_select` / `answers` 形状。需求与验收见
同目录 [`spec.md`](spec.md)。技术路线是「先定契约判别联合，再改 core 与宿主两侧，
最后改 webview 逐页 UI」，避免同一份载荷在链路上出现两种形状。

## 技术方案

### 1. 契约层：`userChoice` 改为按场景判别的联合

权限确认与 AskUserQuestion 共用 `CoreRequest.userChoice` 通道，但载荷与结果不同。用
`kind` 判别，禁止用可选字段混装：

```ts 示意
// src/shared/UserChoiceQueue.ts
export type UserChoiceOptions =
  | {
      kind: 'permission';
      toolName: string;
      message: string;
      choices: Array<{ label: string; description?: string }>;
      // 既有 diff 预览字段保持原样（存量，不在本次重构）
      showPreview?: boolean;
      previewContent?: string;
      previewTitle?: string;
      beforeContent?: string | null;
      afterContent?: string;
      contextBefore?: string[];
      contextAfter?: string[];
    }
  | {
      kind: 'question';
      toolName: 'AskUserQuestion';
      questions: UserQuestion[];
    };

export interface UserQuestion {
  id: string;
  question: string;
  /** 内部规范化后必选；无 header 用 null */
  header: string | null;
  /** 无选项用空数组 */
  options: Array<{ label: string; description: string | null }>;
  multi_select: boolean;
}

export interface UserAnswer {
  id: string;
  selected: string[];
  custom: string | null;
}

export type UserChoiceResult =
  | { kind: 'permission'; index: number; reply: string | null }
  | { kind: 'question'; answers: UserAnswer[] };
```

`CoreRequestResultMap.userChoice`（`src/shared/AssistantEventBus.ts`）同步为
`UserChoiceResult`。`request('userChoice')` 的调用方按自己发出的 `kind` 收窄结果；
core 侧 `request_user_choice` 只发 `kind: 'permission'`，`run_ask_user_question` 只发
`kind: 'question'`。

### 2. Core（Rust）

- `core-rs/src/tools.rs`
  - `definitions()` 的 AskUserQuestion `input_schema` 展开 `questions` 的 `items`：
    `id` / `question` / `header` / `options`（`items: { label, description }`）/
    `multi_select`，并写 `minItems` / `maxItems`。
  - `run_ask_user_question`：解析并规范化 `questions`（`header` 缺省 → `null`，
    `options` 缺省 → `[]`，`multi_select` 缺省 → `false`），发
    `{ kind: 'question', toolName: 'AskUserQuestion', questions }`；收到
    `{ kind: 'question', answers }` 后产出 `{"answers":[...]}` JSON 文本。
  - `validate_input` 保留 `question` 非空口径，改为逐题校验。
- `core-rs/src/tool_input.rs`
  - `ask_user_fields` 改为 `questions` 数组；新增 question item 的嵌套校验
    （`id` / `question` / `header` / `options` / `multi_select`），沿用 `validate_object`
    的 strict 模式。
  - `check_choices` 改名为 `check_questions`，校验 1–9 项、`id` 唯一、option `label`
    非空且同题唯一。
- `core-rs/src/engine.rs`
  - `request_user_choice`（权限确认）的 options 增加 `kind: 'permission'`，结果解析保持
    `index` / `reply`。
  - `run_tools` 注入的 `user_choice` 回调不变，由工具自己组装 `kind: 'question'` 载荷。
- `core-rs/src/prompt.rs`：AskUserQuestion 段改成 dsh 参数说明与示例。
- `core-rs/fixtures/`：`toolSchema.json`、`toolInputValidation.json`、
  `systemPrompt.json` 同步。
- 测试：`tools_tests.rs`、`engine_tests.rs`、`prompt_tests.rs`、
  `tool_input_validation_parity_tests` 更新用例。

### 3. Host（TS）

- `src/host/webviewMessages.ts`
  - `requestUserChoice`：加 `kind`，`question` 场景带 `questions`，`permission` 场景带
    `message` / `choices`。
  - `respondUserChoice`：加 `kind`，`question` 场景带 `answers`，`permission` 场景带
    `index` / `reply`。
- `src/host/ui/userChoice.ts`：`showUserChoice` 按 `kind` 透传；`pendingUserChoices`
  的 resolve 类型改为 `UserChoiceResult`。
- `src/host/ui/webviewMessageHandler.ts`：`handleRespondUserChoice` 按 `kind` 构造结果。
- `src/host/ui/toolHandler.ts`：权限确认路径按 `kind: 'permission'` 读取 `index`。
- `src/host/WebViewUI.ts`：`requestUserChoice` 返回 `Promise<UserChoiceResult>`。

### 4. Webview

- `src/webview/types.ts`：`UserChoiceRequest` 改为判别联合，`question` 场景带
  `questions`。
- `src/webview/UserChoiceOverlay.tsx`：
  - `permission` 分支保持现有「消息 + 选项 + 自由文本 + 点击即提交」。
  - `question` 分支实现逐页 UI：一次一题、进度 `n/N`、上一页 / 下一页 / 提交、切页保留
    草稿、最后一页提交；`multi_select` 用 checkbox，其余 radio；每题末尾追加「其他」
    项，输入框始终显示；普通 radio 点击后自动下一页（最后一页不自动提交）；输入框
    Enter 下一页 / 提交、Shift+Enter 换行、IME 合成期间不触发；输入内容自动选中
    「其他」，单选清空普通选项。
  - 进度条分段可点击跳页：已答蓝、当前未答灰、已跳过黄；被跳过的判定是「离开该页时
    未作答」。
- `src/webview/hooks/useAppHandlers.ts`：`respondUserChoice` 按 `kind` 提交
  `answers` 或 `index` / `reply`。
- `src/webview/hooks/handlers/toolHandlers.ts`：解析 `requestUserChoice` 的
  `kind` / `questions`。
- `src/webview/App.tsx`：数字键 1-9 仅在 `permission` 场景直接提交；`question` 场景
  用于选择当前页选项。
- `src/webview/tools/AskUserQuestion.tsx`：工具卡片优先读 `questions[].question`，
  兼容旧 `question` / `choices` 只读展示。
- `src/webview/i18n/{zh,en}.ts`：新增上一页 / 下一页 / 提交 / 其他 / 输入提示等文案。

### 5. 数据流

```text
LLM tool_use { questions }
  → core tool_input::parse_input 规范化
  → tools::run_ask_user_question 组装 { kind:'question', questions }
  → CoreRequest.userChoice → host UserChoiceQueue → webview requestUserChoice
  → 用户逐页作答 → webview respondUserChoice { kind:'question', answers }
  → host resolve → core run_ask_user_question
  → tool_result {"answers":[...]}
```

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | 修改 | AskUserQuestion `input_schema`、`run_ask_user_question`、`validate_input` |
| `core-rs/src/tool_input.rs` | 修改 | `ask_user_fields` / `check_questions` / question item 校验 |
| `core-rs/src/engine.rs` | 修改 | `CoreRequest.userChoice` 权限确认载荷加 `kind` |
| `core-rs/src/prompt.rs` | 修改 | AskUserQuestion 提示词段 |
| `core-rs/fixtures/toolSchema.json` | 修改 | 工具 schema 对照表 |
| `core-rs/fixtures/toolInputValidation.json` | 修改 | 入参校验对照表 |
| `core-rs/fixtures/systemPrompt.json` | 修改 | 系统提示词对照表 |
| `core-rs/src/{tools,engine,prompt}_tests.rs` | 修改 | 用例更新 |
| `src/shared/UserChoiceQueue.ts` | 修改 | `UserChoiceOptions` / `UserChoiceResult` 判别联合、`UserQuestion` / `UserAnswer` |
| `src/shared/AssistantEventBus.ts` | 修改 | `CoreRequestResultMap.userChoice` |
| `src/host/webviewMessages.ts` | 修改 | `requestUserChoice` / `respondUserChoice` wire 载荷 |
| `src/host/ui/userChoice.ts` | 修改 | 按 `kind` 透传与 resolve |
| `src/host/ui/webviewMessageHandler.ts` | 修改 | `handleRespondUserChoice` |
| `src/host/ui/toolHandler.ts` | 修改 | 权限确认结果读取 |
| `src/host/WebViewUI.ts` | 修改 | `requestUserChoice` 返回类型 |
| `src/webview/types.ts` | 修改 | `UserChoiceRequest` 判别联合 |
| `src/webview/UserChoiceOverlay.tsx` | 修改 | 逐页 UI + 权限分支 |
| `src/webview/hooks/useAppHandlers.ts` | 修改 | 提交载荷 |
| `src/webview/hooks/handlers/toolHandlers.ts` | 修改 | 解析请求载荷 |
| `src/webview/App.tsx` | 修改 | 数字键行为按 `kind` 分支 |
| `src/webview/tools/AskUserQuestion.tsx` | 修改 | 新字段渲染 + 旧字段兼容 |
| `src/webview/i18n/{zh,en}.ts` | 修改 | 新增文案 |
| `src/test/userChoice*.test.ts` | 修改 | 载荷更新 |
| `docs/features/ask-user-question.md` | 新增 | 特性规格 |
| `docs/adr/0010-ask-user-question-dsh-schema.md` | 新增 | 决策记录 |
| `docs/architecture/events.md` 等 6 篇基线 | 修改 | 见 spec 影响基线 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../../AGENTS.md#1-分层与依赖评审必查)）：core 只经 `AssistantEventBus` 帧通道通信；
      host 侧改动在 `src/host/`，不 import 宿主 API；webview 不持有事实默认值，逐页
      草稿只是 UI 本地状态，提交后由 host / core 消费。无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：未知字段严格拒绝，不静默降级；`UserChoiceOptions`
      / `UserChoiceResult` 用判别联合，`kind` 必选；内部 `UserQuestion` 的
      `header` / `description` / `custom` 用 `null` 表达缺失；`multi_select` 默认值只在
      core 规范化一处落地。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../../AGENTS.md#5-工作流)）：改动在 `core-rs/` 并同步
      `tools_tests.rs` / `engine_tests.rs` / `prompt_tests.rs`；tool_use input 原样落盘，
      落盘格式不变，`src/shared/history/` 无需改动；工具 schema / 入参校验 / 系统提示词
      三份 fixture 与 Rust 侧对照测试同步。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../../AGENTS.md#0-文档要求)）：随实施同步 `docs/architecture/events.md`、
      `docs/architecture/host-ui-modules.md`、`docs/hosts/webview-ui.md`、
      `docs/core/standalone-core.md`、`docs/features/user-stories/messages.md`；
      新增 `docs/features/ask-user-question.md`、`docs/adr/0009-...`，并登记
      `docs/README.md` 地图；`npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

1. **保持 `question` + `choices`，只补 `items`。** 否决理由：命名与业界先验冲突
   （业界统一 `questions` / `options` / `header` / 多选字段），只补 schema 不能消除模型
   按先验生成错误字段的根因。
2. **照搬 Claude 的 `multiSelect` + `questions[].options[].description` 必填。** 否决
   理由：用户指定按 dsh；dsh 的 `id` 更适合多问题答案按 id 对应，`multi_select` 与
   dsh 保持一致。
3. **引入 dsh 的 `timeout` 与 pending 语义。** 否决理由：需要「稍后回复」的用户消息
   回填通道与 pending 结果状态，超出本次范围；列入非目标并指向
   `docs/architecture/open-questions.md`。
4. **权限确认单独建通道，不与 AskUserQuestion 共用 `userChoice`。** 否决理由：现有
   通道已共用队列、pending 补偿与 waiting 语义；拆开会让 `UserChoiceManager` 与
   `UserChoiceQueue` 出现两套状态机，收益不足。
5. **保留 `{ index, reply? }` 结果，把 answers 编码进 `reply`。** 否决理由：类型不安全，
   调用方需要解析字符串，违反契约清晰原则。

上述第 1 / 4 条涉及跨 surface 的契约取舍，实施时补
`docs/adr/0010-ask-user-question-dsh-schema.md` 记录决策、背景与否决方案。
