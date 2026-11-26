---
status: 已修
---

# 缺陷：Bash 流式结束后输出框不折叠，卡片按自然高度铺满（大输出落盘后「撑满界面」）

Bash 卡片执行期间的流式容器与完成态的折叠容器是**两个不同的 DOM 节点**：流式走
`outputRef`，完成态走 `usePreviewLimit` 的 `contentRef`。执行期间 `contentRef` 一直是
`null`，测量逻辑在这一段被跳过；执行结束后新节点挂上，但 `usePreviewLimit` 的测量
effect 依赖只有「行数 / 修订值 / 限高 / 测法」，而持久化信封的预览文本与流式期间的
`full_output` 逐字相同、行数也相同——依赖没变，effect 不再执行，完成态拿不到测量结果。

表现：输出超过一屏（例如 `cat` 一个 12K 的 JSON，超过 4K 上限落盘）时，流式期间框高
正常（115px 框内滚动），执行一结束整张卡片突然按自然高度展开（实测 4346px），把
消息区顶到底部；折叠提示条也不出现，用户必须先滚过整段输出才能看到后面的内容。

## 现状

- `src/webview/tools/previewLimit.tsx` 的测量 effect：

  ```tsx
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // ...measure()
  }, [totalLines, expanded, revision, contentHeight, measurement]);
  ```

  依赖里没有「被测量节点本身」。流式期间节点不存在（Bash 的流式分支渲染的是另一个
  容器），effect 每轮都 `return`；节点在完成态第一次挂上时不触发重新测量。

- `fit` 初值在**挂载时**按当时行数算出（首次渲染 `output` 为空，`totalLines = 0`）：

  ```tsx
  const [fit, setFit] = useState(() => ({
    lines: Math.min(totalLines, PREVIEW_LINES),
    height: contentHeight,
    overflow: totalLines > PREVIEW_LINES,
  }));
  ```

  即 `{ lines: 0, height: 115, overflow: false }`，于是 `hasMore = fit.overflow || ... = false`。

- `src/webview/tools/Bash.tsx` 完成态据此计算：`collapsed = hasMore && !expanded`（false）、
  `boxHeight = hasMore ? ... : undefined`（undefined）——输出框既无 `height` 也无
  `maxHeight`，`overflow` 退化成 `hidden`，整段内容按自然高度撑开。

- 复现（webview e2e，假宿主注入，`e2e/webview/bashOutputCollapse.spec.ts`）：

  1. 用户消息 + Bash 卡片（`status: 'running'`）；
  2. `toolProgress` 发送 12K 输出的「前 2K + 后 2K」预览（与 Core 的 `clamp_output` 同口径）；
  3. `updateToolStatus` 发送 `<persisted-output>` 信封，其 `Preview (first 2K + last 2K):`
     正文与第 2 步的预览逐字相同。

  实测：流式期间 `div[title="点击查看完整输出"]` 高 115px（`overflow-y: auto`）；
  收到结果后同一节点高 4346px（`max-height: none`、`overflow-y: hidden`），
  「仅显示末尾 N 行」提示条不出现。

- 反证（同一注入只改一处）：在上述信封的预览末尾多加一行 → `totalLines` 变化 → effect
  重跑并读到节点 → 框高立刻回到 115px、提示条出现。这说明缺陷的触发条件是
  「节点挂上时依赖值恰好与上一次相同」，而不是测量公式本身有问题。

- 影响面：所有「流式文本与最终预览一致」的 Bash 大输出（Core 对同一份输出做同口径
  前 2K + 后 2K 裁剪，逐字相同是常态而非巧合）。历史会话加载（卡片直接挂载、无流式
  阶段）不触发：那时首次渲染就带着输出，`contentRef` 在 effect 前已挂好。Edit / Write
  预览同样走这个 hook，但它们没有「流式时容器不存在」的阶段，因此不受影响。

## 期望

1. **被测量节点参与测量判据**：`contentRef` 指向的节点（重新）挂上时必定触发一次测量，
   不依赖行数 / 修订值是否恰好变化。
2. **完成态恒为折叠形态**：流式结束后输出框高与流式期间一致（115px ± 1，`overflow: hidden`），
   折叠提示条按实测行数出现，可见窗口钉在末尾。
3. **测量结果按节点实测**：`fittedLines` 由 `lineHeight` 与限高算出（`line-box` 口径），
   未测量完成前 `hasMore` 不得为 `false` 而放开框高——即「没测过」必须表现为折叠，
   不能表现为自然高度。
4. **展开行为不变**：点提示条后提示条让位、框高 = 折叠高 + 提示条高、出现框内滚动条、
   初始视点仍在底部。

## 不变量

- 流式 / 缩略 / 展开三态仍渲染同一段 `<pre>`（`white-space: pre`、逐行补 `\u00A0`），
  行高与行数口径不变。
- `OUTPUT_BOX_HEIGHT`（115）与 `TAIL_HINT_HEIGHT`（22）的取值与「卡片总高不变」的高度账不变。
- Edit / Write 预览（`measurement: 'children'`）的折叠行为、`PREVIEW_LINES` /
  `PREVIEW_CONTENT_HEIGHT` / `PREVIEW_BOX_HEIGHT` 常量与实测口径不变。
- `usePreviewLimit` 返回的形状与调用方（`Bash.tsx` / `EditFile.tsx` / `WriteFile.tsx`）
  的用法不变。
- 持久化信封格式与生成侧（Core 的 `build_large_tool_result_message`）不变；
  `parsePersistedOutput` 的解析结果不变。

## 回归测试

- **RT-1**：流式期间发送「前 2K + 后 2K」预览，完成时发送预览正文与之**逐字相同**的
  `<persisted-output>` 信封 → 完成态输出框高 ≤ 116px、`overflow-y` 为 `hidden`、
  折叠提示条可见（修复前红：框高 4346px、无提示条）。
  （落点：`e2e/webview/bashOutputCollapse.spec.ts` 的
  「US-14 流式结束后的持久化输出与流式预览逐字相同：框高仍为折叠态」）
- **RT-2**：同一场景下点提示条展开 → 提示条消失、框高增加约 `TAIL_HINT_HEIGHT`、
  `overflow-y: auto` 且初始视点钉在底部（守护「节点挂上 → 测量 → 展开」整条链路，
  修复前因 `hasMore` 为 false 根本没有提示条可点）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui bashOutputCollapse -g "流式结束后的持久化"` | 红 | 两条全红：RT-1 提示条 `element(s) not found`（`hasMore` 为 false，不渲染提示条）；RT-2 无提示条可点，同样卡在 `toBeVisible` |
| 回归用例（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui bashOutputCollapse` | 绿 | 7 通过 / 0 失败，含 RT-1、RT-2 与既有的缩略 / 展开 / CRLF / ANSI / 持久化按钮 5 条 |
| 既有回归（webview e2e 全量，修复后） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui` | 部分验证 | 142 通过 / 15 失败；失败集合全部落在发送 / thinking / 图片 / 滚动等与本改动无关的用例上（同批失败在未改动的基线上同样红） |
| 既有回归（失败子集，未改动基线） | `git stash` 后跑 `conversation inputExtras jumpToBottom sendModes` | 红 | 基线 14 失败 / 20 通过；同一子集在修复后 11 失败 / 23 通过，基线失败集合是本改动的超集——没有任何用例因本改动由绿转红 |
| 静态检查 | `npm run check-types:webview` | 绿 | — |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 部分验证 | `specs/defects/` 组通过；`docsLintLocalOnlyPaths` 在本机红（`缺少本机专属文件时 docsLint 仍绿`），该子测试由本机缺失的 gitignore 专属文件驱动，与本改动无关（改动前同样红） |
| 流式态与短输出回归 | 两条临时探针用例（短输出仍为自然高度 18px、无提示条；运行中卡片不渲染输出框） | 绿 | 探针用例已删除，仅作边界确认 |
