---
status: 已修
---

# 缺陷：任务进度浮层的固定态不接收指针事件，长清单无法滚动、条目文字无法选中复制

输入区任务进度浮层在「点击固定」后成为常驻面板，但整张浮层对指针事件透明：滚轮落在浮层
下方的消息区而不是清单上，内层滚动容器永远停在 `scrollTop = 0`；条目文字也无法进入选择
流程，拖选得不到选区、Ctrl+C 复制不到任何文本。影响面是清单超过一屏（浮层内部需要滚动）
以及任何想把某条任务文案复制出去的场景，都只能放弃浮层去消息流里翻 `TodoWrite` 卡片。

## 现状

- `src/webview/InputArea.tsx` 的浮层根节点带 Tailwind `pointer-events-none`（注释口径为
  「只读投影，点击不产生任何上行」），整个浮层连同内层列表都不参与命中测试。
- 内层列表容器本身有 `maxHeight: 240` + `overflowY: 'auto'`，滚动机制已就位但滚轮事件
  根本到不了它——`e2e` 实测固定 30 条清单后，在浮层中心滚轮 240px，该容器 `scrollTop`
  仍为 `0`，而浮层下方的消息区滚动了。
- 同样因为不参与命中测试，在条目文字上按下拖动不会建立选区：`window.getSelection()`
  返回空串，随后的复制拿到空内容。
- 复现路径：某对话有超过一屏的 Todo → 点击「任务进度: x/N」固定浮层 → 指针移到浮层上
  滚轮（列表不动）→ 在条目文案上拖选（无选区）。用例化复现见 RT-1 / RT-2，修复前
  两条均为红。
- 基线依据：内部滚动见 [docs/features/todo-list.md 第 4 节](../../docs/features/todo-list.md#4-边界与错误路径)
  的「清单很长」条目；浮层仍须满足 [US-59 验收 3 / 5](../../docs/features/user-stories/dialog-core.md#us-59-输入区任务进度按钮)
  的悬停与固定规则，以及 [todo-list.md FR-003](../../docs/features/todo-list.md#fr-003悬停显示与点击固定)
  的「浮层只读：点击不产生任何上行消息，也不改变固定状态」。

## 期望

- 固定态浮层接收指针事件：滚轮在浮层内滚动内部列表，滚到两端不外溢到消息区。
- 固定态浮层的条目文字可选中、可用 Ctrl / Cmd+C 复制，口径与消息区文本一致。
- 未固定（悬停）态保持现状的指针穿透：指针移出按钮仍按悬停规则立即隐藏，行为不变。
- 只读语义不变：点击浮层内任意位置不产生任何上行消息，也不改变固定状态。
- 滚动与选择都不改变按钮文案、不改变固定态。

## 不变量

- 悬停 100ms 显示、不足 100ms 移出不显示、未固定移出立即隐藏、点击按钮固定 / 再点取消、
  切换会话复位固定态（[todo-list.md FR-003](../../docs/features/todo-list.md#fr-003悬停显示与点击固定)）。
- 浮层定位（锚输入区底栏右边缘、紧贴输入区上沿）、宽度随内容自适应且不超过输入区宽度、
  配色取主题色、状态标记配色与消息流 `TodoWrite` 卡片共用同一份常量。
- 浮层仍是 `sessionTodos` 的只读投影：不新增契约成员 / 事件 / 落盘字段，不产生上行消息。
- 与 abort 悬停明细浮层的层叠关系不变（同层 z-50，abort 浮层在其之上）。

## 回归测试

- **RT-1**：某对话 30 条 Todo，点击按钮固定浮层并把指针移出按钮；指针移到浮层中心滚轮
  240px 后，内层滚动容器 `scrollTop > 0`，按钮文案与 `data-todo-progress-pinned` 不变。
  （落点：`e2e/webview/todoProgress.spec.ts`「US-59 固定后的长清单浮层可用滚轮滚动」）
- **RT-2**：固定浮层后在条目「改代码」上横向拖选，选区含该文本；Ctrl+C 后剪贴板含该文本；
  随后点击浮层内任意位置，上行消息条数不变、固定态仍为 `true`、浮层仍可见。
  （落点：`e2e/webview/todoProgress.spec.ts`「US-59 固定后的浮层文字可选中复制，点击不产生上行
  且不改变固定态」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui todoProgress -g "固定后的"` | 红 | RT-1：`expect.poll(tipScrollTop).toBeGreaterThan(0)` 收到 `0`（浮层 `pointer-events: none`，滚轮落到消息区）；RT-2：`expect(selected).toContain('改代码')` 收到 `''`（无选区） |
| 回归用例（修复后） | `npm run build:webview && npx playwright test -c e2e/playwright.config.ts --project=webview-ui todoProgress -g "固定后的"` | 绿 | RT-1 / RT-2 均过：固定态滚动位移 > 0、选区与剪贴板含条目文案、点击零上行且固定态不变 |
| 既有回归 | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui todoProgress` | 绿 | 连跑两轮均 12/12（含既有悬停 100ms、固定 / 取消固定、切换对话复位、宽度自适应、主题四条） |
| `check-types` | `npm run check-types` | 绿 | 三份 tsconfig 均 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 章节引用 0 处失效、`specs/defects/` 缺陷规格 0 处问题（首次跑报出注释里的裸章节引用，改成点名条目后转绿） |
| 全量 webview e2e | `npm run test:e2e:webview` | 部分验证 | 本机整轮长跑（124 例）出现多例与本改动无关的失败：失败用例都不注入 Todo（`setSessionTodos` 未被调用），浮层根本不渲染；同一用例单独复跑即过（`US-4 thinking 内容折叠`、`abort 按钮三态`、`US-3 引擎忙碌`、`US-47 单次小幅滚动`）——判为长跑环境下的时序 / 资源争用，非本缺陷回归。全量车道留给 CI |
