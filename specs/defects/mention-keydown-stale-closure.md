---
status: 已修
---

# 缺陷：`@` 工作区补全的键盘选中停留在第 0 项（stale closure）

`@` 候选弹层的键盘导航失效：`ArrowDown` / `ArrowUp` 移动高亮后按 `Enter`，插入的仍是
**第一项**（alpha）而不是选中的那一项（gamma），期望的引号形态 `@"DEV-PC:C:\Program Files\gamma" `
永远插不出来。specs/023 FR-007 的验收标准「键盘选中第二项（身份含空格）→ 插入引号形态」
在实现中从未成立。

## 现状

- `src/webview/InputArea.tsx` 的 `handleKeyDown`（mention 分支在 handlers 前部，分支顺序
  正确）是 `useCallback`，其依赖数组只列了 slash 四件套与发送相关依赖，**漏了
  `showMention` / `filteredWorkspaces` / `mentionIndex` / `commitMention`**。
- `ArrowDown` 触发 `setMentionIndex(1)`，但 `mentionIndex` 不在依赖里，回调不随其重建；
  紧随其后的 `Enter` 走的仍是旧闭包里的 `mentionIndex = 0`，于是
  `commitMention(filteredWorkspaces[0])` 恒插第一项。
- 唯一锁定该行为的用例 `e2e/webview/workspaceMention.spec.ts` 自随 specs/023 落地起就是
  **死胎**，两处独立问题叠加，键盘导航缺陷因此漏网：
  1. `e2e/helpers/fakeHost.ts` 在 specs/023 提交里把带裸反引号的注释写进了外层**模板
     字符串**（`// \`@\` 工作区补全…`）——186 行的反引号把模板提前闭合，整个文件不可
     解析，**webview e2e 车道全线无法加载**（Playwright 报 `No tests found`，e2e 不在
     CI 里所以无人发现）；
  2. 同一夹具里 `requestWorkspaces` 的路径写 `'C:\\Program Files\\gamma'`：外层模板求值
     先把 `\\` 折成 `\`，生成脚本的字符串转义再把它当未知转义（`\P` → `P`）吃掉，
     运行期身份变成 `DEV-PC:C:Program Filesgamma`，用例的身份断言也匹配不上。
- 复现（修复前）：`npm run build:webview && npx playwright test -c e2e/playwright.config.ts
  --project=webview-ui workspaceMention` → `toHaveValue` 收到 `@DEV-PC:C:\work\alpha `（第 0 项、
  无引号形态）。

## 期望

- `ArrowDown` / `ArrowUp`（及 `Ctrl+N` / `Ctrl+P`）移动候选选中项；`Enter` / `Tab` 插入
  **当前选中项**，身份含空白时为引号形态（`mentionToken`），插入后带尾随空格、光标落
  输入末尾。
- 候选列表渲染的身份文本与宿主下发的 `id` 完全一致（含反斜杠与空格）。

## 不变量

- `/` 斜杠补全与输入历史（`ArrowUp` / `ArrowDown`）的键盘行为不变。
- 点击候选项插入（`WorkspacePopup.onSelect`）与 `Escape` 关闭行为不变。
- `mentionState.ts` 纯函数（区间判定 / 过滤 / 插入）不变——缺陷在组件接线层，
  纯函数侧 `src/test/mentionState.test.ts` 一直绿。

## 回归测试

- **RT-1**：`@` 触发候选 → `ArrowDown` + `Enter` → 输入框值为
  `@"DEV-PC:C:\Program Files\gamma" `（第二项、引号形态）（落点：
  `e2e/webview/workspaceMention.spec.ts`
  「US-57 @ 工作区补全：候选列表与插入引号形态」）。
- **RT-2**：候选身份文本含反斜杠原样可见（`DEV-PC:C:\Program Files\gamma`，落点：同一
  用例的 `getByText` 断言；依赖 fakeHost 夹具的四反斜杠写法）。
- **RT-3**：正文中的 `@` 不弹候选（落点：同文件
  「US-57 @ 只认首字符：正文中的 @ 不弹候选」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui workspaceMention` | 红 | 1 failed：`toBeVisible`（身份文本缺反斜杠——夹具转义问题）修复夹具后仍红：`toHaveValue` 期望 `@"DEV-PC:C:\Program Files\gamma" ` 收到 `@DEV-PC:C:\work\alpha `（stale index 恒插第 0 项） |
| fakeHost 语法修复（修复前） | `npx tsc -p e2e/tsconfig.json --noEmit` | 红 | `fakeHost.ts(186,13): error TS1005`（模板字符串内的裸反引号）并级联报错，webview e2e 车道无法加载 |
| fakeHost 语法修复（修复后） | `npx tsc -p e2e/tsconfig.json --noEmit` | 绿 | 0 错误，webview e2e 车道恢复可加载 |
| 回归用例（修复后） | `npm run build:webview && npx playwright test -c e2e/playwright.config.ts --project=webview-ui workspaceMention` | 绿 | 2 passed（RT-1 含引号形态插入、RT-3）；同一车道全量 110 passed |
| 既有回归（webview 车道全量） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui` | 绿 | InputArea 改动只增依赖项（回调更勤重建），slash 补全 / 输入历史 / 发送链路用例全过 |
