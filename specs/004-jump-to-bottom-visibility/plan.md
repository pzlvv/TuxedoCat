# 实施方案：跳到底部按钮显示触发与交互调整

技术路线：纯 webview 渲染层改动，全部落在 `src/webview/MessagesView.tsx`——
手势累计与触发信号放进既有的 `useAutoScroll`（它已拥有 window 级 wheel 监听与容器
scroll 监听，无需新增监听器宿主）；按钮显隐从派生条件改为 MessagesView 本地的
`jumpVisible` 状态机，由四个入口（手势达标 / 回底 / 拖动按下 / 点击）单一写入；
按钮常驻挂载、以 opacity + pointer-events 过渡实现淡入淡出。无 wire / 事件 / 契约变化，
不触碰自动滚动抑制机制。方案对应同目录 [spec.md](spec.md)。

## 技术方案

### 常量与判定口径

- `WHEEL_GESTURE_GAP_MS = 150`：滚动手势分隔阈值。相邻向下滚轮输入间隔 ≤ 150ms 归入
  同一次手势（典型滚轮连滚 / 触摸板惯性事件间隔 20–80ms；停顿超过即视为新手势）。
- 显示阈值：`container.clientHeight / 3`（实时取值，窗口缩放自动跟随）。
- 「不在底部」沿用既有 2px 判定带（`distanceFromBottom > 2`）。
- 按钮间距：`bottom-3 right-3`（12px，与现 `bottom-3` 同量级）。
- 过渡：`opacity 150ms ease`（≤ 200ms 上界）。

### 1. useAutoScroll：手势累计信号（src/webview/MessagesView.tsx）

新增两个 ref 与第 7 个可选回调参数 `onWheelGestureThreshold?: () => void`
（沿用本 hook 既有 optional 回调风格，同 `onAtBottomChange`）：

- `lastWheelDownTimeRef`：最近一次向下滚轮输入时刻；`wheelGestureAccumRef`：手势内
  累计的实际滚动位移。
- **wheel 监听（既有 handleWheel，window 级）内追加手势跟踪**，不动既有
  `userScrolledAway` 置位逻辑：
  - 先做容器内判定：`event.target` 不在 `containerRef.current` 内直接返回（其他面板
    的滚轮不参与手势）；既有滚离置位逻辑保持全局口径不变。
  - `deltaY <= 0`（向上 / 横向）：清零累计——手势只由连续向下输入构成。
  - `deltaY > 0`：距上次向下输入超过 150ms 则清零累计（手势分隔），然后刷新时刻。
- **scroll 监听（既有 handleScroll）内追加累计与达标通知**，插在 `lastScrollTop` 更新
  之前（需要旧值算增量）：
  - 既有 `distanceFromBottom <= 2` 分支里同时清零累计（回底即新手势）。
  - 累计守卫三条同时成立才累计：`scrollTop > lastScrollTop`（向下）、
    `userScrolledAwayRef.current === true`（用户已滚离——此时自动滚动全被抑制，
    向下位移必为用户输入所致，天然排除流式跟随 / overflow-anchor 的程序化位移）、
    距上次向下滚轮输入 ≤ 150ms（手势窗口活跃）。
  - 累计后判定 `累计 > clientHeight / 3` 即调 `onWheelGestureThreshold?.()`；
    重复触发由消费方 React 同值 setState 去重（既有注释口径）。
  - **向上滚动即隐藏（spec 修订新增）**：`scrollTop < lastScrollTop`（任意幅度）且
    1s 内有真实用户滚动输入（复用既有 `lastUserScrollInputRef` 输入门，与滚离置位
    同口径——滚轮 / 拖动 / 键盘 / 触摸都会刷新）时，清零手势累计并调
    `onUserScrollUp?.()`（hook 第 8 个可选回调参数）；布局收缩造成的 scrollTop 回退
    没有用户输入，被输入门排除，不隐藏。

数据流：wheel（窗口/方向）→ scroll（实际位移累计）→ 达标回调 → MessagesView 置
`jumpVisible = true`。手势窗口外、未滚离、向上、键盘 / 拖动产生的 scroll 一律不累计
（后两者无 wheel 输入，窗口不活跃）。

### 2. MessagesView：显隐状态机与按钮形态

- `notAtBottom` 状态删除，替换为 `const [jumpVisible, setJumpVisible] = useState(false)`：
  - `handleAtBottomChange`：仅 `atBottom === true` 时 `setJumpVisible(false)`
    （滚到底 / End / 点击回底 / 会话切换强制回底都落入 distance ≤ 2）；
    不再读 `userScrolledAwayRefProp`，依赖数组随之简化。
  - 新增 `handleWheelGestureThreshold = useCallback(() => setJumpVisible(true), [])`
    与 `handleUserScrollUp = useCallback(() => setJumpVisible(false), [])` 传入 hook；
    `jumpVisible` 的写入点为手势达标 / 回底 / 向上滚动 / 拖动隐藏 effect / 按钮 onClick
    五处，全部收敛到同一个 setState（一份事实一个写入点）。
- **滚动条拖动隐藏 effect**：在容器上挂 `pointerdown` / `mousedown`（双监听为
  Chromium 版本差异兜底），命中条件 `event.target === container && offsetX >= clientWidth`
  ——Chromium 把原生滚动条上的指针事件派发给滚动容器本身且 offsetX 落在滚动条槽
  （子元素上的按下 / 消息区背景点击不命中，不误伤文本选择与普通点击）→
  `setJumpVisible(false)`。拖动产生的 scroll 无 wheel 输入，不会重新触发显示。
- **按钮 JSX**：
  - 定位 `bottom-3 left-1/2 -translate-x-1/2` → `bottom-3 right-3`。
  - **z 序 `z-10` → `z-30`（遮挡缺陷修复）**：所有真实用户消息常驻 `user-msg-pin`
    样式（`position: sticky` + zIndex 10，未吸附时同样生效），且消息容器在 wrapper
    内后于按钮绘制——同 z 序下 DOM 靠后的用户消息会盖住按钮区域；30 高于吸附容器
    （10）与置顶背景延伸条（20），仍低于会话加载遮罩（40），loading 覆盖关系不变。
  - 由条件渲染（`notAtBottom && !isEmpty && <button>`）改为 `!isEmpty && <button>`
    常驻挂载 + `opacity: jumpVisible ? 1 : 0`、`pointerEvents: jumpVisible ? 'auto' : 'none'`、
    `transition: 'opacity 150ms ease, filter 150ms ease'`（保留 hover 亮度过渡）；
    隐藏态加 `aria-hidden` 与 `tabIndex={-1}`，不进 a11y 树、不可聚焦、不拦点击。
  - 增加状态标记 `data-hidden={!jumpVisible || undefined}`（同 `ThinkingAnimation`
    包裹层的既有标记习惯），供 e2e 做确定性断言（opacity:0 在 Playwright 中仍算
    visible，不能用 toBeVisible/toBeHidden 断言显隐）。
  - onClick 逻辑不变：清滚离抑制 + `scrollToBottom(true)` + `setJumpVisible(false)`。

### 3. e2e 改写（e2e/webview/jumpToBottom.spec.ts）

沿用既有 harness（压低视口 1280×500 + `setTurn` 撑高列表 + 真实 `mouse.wheel`），
显隐断言全部改为 `data-hidden` 属性判定，用例重组为：

1. 底部不显示；向上滚离不触发；向下达标手势（连续两次 `wheel(0, 400)`，间隔远小于
   150ms，累计远超 1/3≈133px）淡入显示；点击回底 + 隐藏 + 钉底断言（既有断言保留）；
   显示期间断言贴右下定位（bounding box 距右缘 / 底缘 12px ±2）与 opacity 过渡声明，
   并断言 z 序（按钮 computed zIndex 30 高于 `.user-msg-pin` 的 10，按钮中心
   `elementFromPoint` 命中按钮自身——遮挡缺陷回归锁）。
2. 小幅负例：滚离后停顿 >150ms，单次 `wheel(0, 80)` 不显示；`PageDown`（先大幅上滚
   留足余量，避免 PageDown 到底混淆「键盘不触发」与「到底隐藏」）仍不显示。
3. 拖动负例：达标手势显示后，在滚动条槽按下（x = 容器右缘内 2px）→ 立即隐藏；
   拖动 / 松开过程与结束后均不恢复（仍不在底部）。

高负载丢帧沿用既有 `toPass` 整体重试模式。

### 4. 文档 delta（实施任务内完成）

- [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md#11-消息区视图行为跳到底部与发送模式)「跳到底部」行整行重写（新触发条件、触发源
  白名单、右下角定位、淡入淡出、常驻挂载形态）。
- `docs/features/user-stories.md` US-47 验收标准 1 按新口径重写（验收 2 不动）。
- MessagesView 内指向 [webview-ui 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为跳到底部与发送模式)
  的行为注释随实现同步（章节号与锚点不变）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/webview/MessagesView.tsx` | 修改：useAutoScroll 增手势累计信号（2 ref + 1 可选回调参数 + wheel/scroll 监听内追加逻辑）；显隐状态 `notAtBottom` → `jumpVisible`；按钮定位 / 常驻挂载 / 过渡；新增滚动条拖动隐藏 effect | 无（wire / 事件 / UIHost / WebViewUiPort 均不动） |
| `e2e/webview/jumpToBottom.spec.ts` | 改写：断言口径换 `data-hidden`，用例按 spec AC 重组（达标 / 小幅 / 键盘 / 拖动 / 定位 / 点击回归） | 无 |
| `docs/hosts/webview-ui.md` | 「跳到底部」行重写 | 无 |
| `docs/features/user-stories.md` | US-47 验收标准 1 重写 | 无 |

不涉及：core（`src/core/`、`core-rs/`）、事件词汇表、契约接口、i18n（沿用
`messages.jumpToBottom`）、样式表文件（过渡走行内样式）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：不涉及——改动全部在 `src/webview/`，不新增
      任何跨层 import，不触碰 `host/` 与宿主实现；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：符合——`jumpVisible` 是 UI 派生状态而非事实，
      初值 `false`（隐藏）是显隐状态机的正常起点而非「猜事实」；写入点收敛为单一
      setState 的四个固定入口；无新增 fallback、无新增可选契约成员（hook 新参数沿用
      本文件既有 optional 回调风格，非 core 契约）；手势累计 / 显隐判定逻辑只有
      `useAutoScroll` 一份。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——零 Core 行为变化
      （TS 侧与 Rust 侧均不动），无对照表与双侧测试义务。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：履行——影响基线两处
      （[webview-ui 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为跳到底部与发送模式)、
      `docs/features/user-stories.md` US-47）
      在实施任务内同步，`npm run test:all -- docs-lint` 纳入验证；无新增 / 移动文档，
      `docs/README.md` 地图不变。

## 被否决的替代方案

1. **沿用 `userScrolledAway` 叠加位移条件**（在滚离标志之上再加「位移 > 1/3」）——
   否决：滚离标志由滚轮 / 键盘 / 拖动共同置位，无法满足 spec 的「仅滚轮」白名单，
   键盘 PageDown 会误触发；解耦出独立手势信号才能把触发源收窄到滚轮。
2. **按 wheel `deltaY` 累计**（输入位移而非实际滚动位移）——否决：近底部会被滚动
   边界 clamp、与「实际发生的滚动位移」语义不符，且无法把程序化位移与输入位移区分开；
   scrollTop 增量是用户可见的真值，配合滚离守卫天然排除自动滚动污染。
3. **framer-motion 等动画库 / 条件渲染 + 入场动画类**——否决：为一个按钮引入依赖
   不成比例；条件渲染只能做淡入做不了淡出（卸载即消失）。常驻挂载 + opacity /
   pointer-events 行内过渡零成本满足双向淡入淡出。
4. **纯速度阈值判定**（scroll 事件位移速率超阈值即显示，不挂 wheel 窗口）——否决：
   无法满足触发源白名单（快速拖动滚动条的位移速率同样高），手势边界也无法定义。
5. **按钮放右侧垂直居中**——否决：用户指定「显示在右边，留一点 padding」，右下角
   （`bottom-3 right-3`）与回底语义一致且是最小 diff；垂直居中需要额外垂直定位逻辑。
6. **仅滚轮上滚触发隐藏**——否决：向上滚动即隐藏不限于滚轮，拖动 / 键盘 / 触摸上滚
   同样移动视口，按实际 scrollTop 回退判定一个分支覆盖全部输入源，无需逐源枚举。
7. **向上滚动隐藏不加输入门**（scrollTop 回退即隐藏）——否决：内容收缩（折叠
   thinking / 收起 diff）造成的 scrollTop 回退会被误判为用户上滚，按钮无故消失；
   复用既有滚离置位的 1s 输入门（`lastUserScrollInputRef`）零新状态。
8. **降 `user-msg-pin` 的 zIndex 换按钮不被遮挡**——否决：zIndex 10 是吸附消息压过
   普通消息内容的既有契约（置顶吸附表现依赖它），且所有真实用户消息常驻该样式；
   按钮让到 30 是纯增量改动，不影响任何既有层级关系。
