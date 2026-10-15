---
status: 已修
---

# 缺陷：滚动进行中置顶背景延伸条以旧高度残留数帧，在滚动条上闪现长条（承 [pinned-gutter-cover-stale-height](pinned-gutter-cover-stale-height.md)）

上一缺陷把延伸条高度修为「随置顶消息可见段收缩」，静态对齐已成立；本条是同一延伸条在
**滚动进行中**的动态缺陷：置顶消息被下一条用户消息顶出的窗口内，延伸条高度逐帧变化，
而高度走 React state（置顶窗口内逐帧 setState），每个滚动帧都触发一次整棵 `MessagesView` 重渲染
（消息组件虽有 memo，但元素树逐帧重建）。长对话下单帧渲染可能超出帧预算，延伸条高度
更新被推迟数帧，期间以上一帧的旧高度显示——滚动条位置闪现一条与消息可见段不符的
长条，时隐时现、不连续。对齐基线与原缺陷相同：
[docs/features/user-stories.md 的 US-16](docs/features/user-stories.md#us-16-长消息折叠与用户消息置顶)
验收 2「吸附为整宽条」——延伸条与置顶消息可见段的对齐在滚动进行中的每一帧都得成立。

## 现状

- `src/webview/MessagesView.tsx` 的 `measurePinnedMessage` 把可见段
  高度写进 React state：顶出窗口内每个滚动帧的高度都不同 → 每帧一次全组件树重渲染。
- 高度更新天然晚一拍：scroll 事件先于同帧的 rAF 测量回调与 React 提交；在 scroll
  监听器内（滚动已生效、测量未跑）读到的延伸条高度必是上一帧的值，帧预算紧张时
  再叠加数帧残留。
- 复现：三轮对话 → 第二条用户消息吸附置顶 → 连续下滚穿过「第三条逼近、第二条被
  顶出」的窗口，滚动条位置可见延伸条长度跳变、闪现（用例化见 RT-2）。

## 期望

- 延伸条高度更新不触发 React 重渲染：滚动路径对高度走同步直写 DOM，不经过 setState。
- 滚动生效的同一帧内延伸条高度即对齐消息可见段：在 scroll 监听器内（同帧、rAF 测量
  之前）采样，延伸条底边 ≤ 置顶消息实际底边 + 1.5px 恒成立。
- 置顶身份的移交（二分查找、rAF 测量）不在本条范围、保持不动；高度为 0 的帧不显示
  （延续原缺陷契约）。
- 延伸条挂载与换主（置顶身份变化）后、绘制前高度同步就位，首帧不以旧高度或 0 高闪现。

## 不变量

- 原 [pinned-gutter-cover-stale-height](pinned-gutter-cover-stale-height.md) 的全部不变量：
  宽度、+1px 重叠缝、底边框、配色、z 序（跳到底部 30 > 延伸条 20 > 吸附容器 10）、
  `pointer-events: none`；可见段高度公式 `min(完整高度, max(0, 消息底边 − 容器顶))`；
  置顶判定与吸附条件、点击跳回、超高退出吸附。
- 置顶身份移交仍在 rAF 测量里按帧完成，二分查找口径（`rect.top <= containerTop + 0.5`）
  不变；scroll 驱动的 rAF 测量节流保留。
- React 状态（置顶身份、gutter 宽度）仍驱动延伸条的挂载与卸载；取消置顶即卸载。
- 高度直写只针对延伸条自身的 height/display，不旁落其它样式。

## 回归测试

- **RT-2**：三轮对话，第二条吸附置顶且延伸条已铺 gutter 后，页面内以 rAF 步进连续下滚
  穿过顶出窗口；在 scroll 监听器内（同帧、rAF 测量之前）逐帧采样「延伸条底边 vs 置顶
  消息实际底边」，断言全部中间态样本底边差 ≤ 1.5px，且采到的中间态样本足够多（扫描
  真实穿过窗口）。（落点：`e2e/webview/messagePresentation.spec.ts`「US-16 滚动进行中
  延伸条与置顶消息可见段同帧对齐」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "同帧对齐"` | 红 | rAF 时刻采样抓到残值帧：`coverBottom (85.125) toBeLessThanOrEqual pinnedBottom + 1.5 (75.75)`——高度更新晚一个滚动步长（≈9.4px），证实高度走 React state / rAF 测量存在帧间残留 |
| 回归用例（修复后） | `npm run build:webview && npm run copy-assets && npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "同帧对齐"` | 绿 | 高度改 scroll 监听器内同步直写后，全部中间态样本同帧对齐 |
| `check-types` | `npm run check-types` | 绿 | 三份 tsconfig 均 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| 既有回归 | `npm run test:e2e:webview` | 绿 | webview 全套 81/81（含 RT-1 与既有 US-16 置顶两条） |
| docs-lint | `npm run test:all -- docs-lint` | 绿 | 缺陷规格标识符存活与链接校验通过 |
