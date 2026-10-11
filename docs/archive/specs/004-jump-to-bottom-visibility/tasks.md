# 任务分解：跳到底部按钮显示触发与交互调整

执行顺序：先落 `useAutoScroll` 手势信号（T001），再接 MessagesView 显隐状态机与按钮
形态（T002），e2e 改写（T003）与文档 delta（T004）在实现定稿后并行，最后全量验证
（T005）。需求口径见同目录 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：`src/webview/MessagesView.tsx` 的 `useAutoScroll` 增加滚动手势信号——`lastWheelDownTimeRef` / `wheelGestureAccumRef` 两个 ref、常量 `WHEEL_GESTURE_GAP_MS = 150`、可选回调参数 `onWheelGestureThreshold`；既有 wheel 监听内追加容器内判定 + `deltaY <= 0` 清零 + 手势分隔清零，既有 scroll 监听内在 `lastScrollTop` 更新前追加三守卫累计（向下位移 + 用户已滚离 + 手势窗口活跃）与达标通知，`distanceFromBottom <= 2` 分支同步清零累计；依赖：—；完成判据：`npm run check-types` 0 错（新回调参数与 ref 类型编译通过）
- [x] **T002**（FR-001、FR-002、FR-003、FR-004）：MessagesView 显隐状态机与按钮形态——`notAtBottom` 换 `jumpVisible`（`handleAtBottomChange` 仅 atBottom 时隐藏、不再读 `userScrolledAwayRefProp`，新增 `handleWheelGestureThreshold` 传 hook）；新增滚动条拖动隐藏 effect（`pointerdown`/`mousedown` 双监听 + `target === container && offsetX >= clientWidth` 守卫）；按钮 JSX 改 `bottom-3 right-3` 常驻挂载 + `opacity`/`pointerEvents`/`transition: opacity 150ms ease, filter 150ms ease` + `data-hidden` 标记 + 隐藏态 `aria-hidden`/`tabIndex={-1}`；依赖：T001；完成判据：`npm run check-types` 0 错且 `npm run lint` 干净（含 no-restricted-imports 分层检查）
- [x] **T003**（FR-001、FR-002、FR-003、FR-004）：改写 `e2e/webview/jumpToBottom.spec.ts`——显隐断言换 `data-hidden` 属性口径；用例重组为三组：①底部不显示 / 向上不触发 / 向下达标手势显示 + 贴右下定位（bounding box 12px ±2）与 opacity 过渡声明断言 / 点击回底钉底回归；②停顿 >150ms 后单次小幅 wheel(0, 80) 不显示、大幅上滚留余量后 PageDown 不显示；③达标显示后滚动条槽按下即隐藏、拖动与松开后不恢复；依赖：T002；完成判据：`npx playwright test e2e/webview/jumpToBottom.spec.ts` 全绿
- [x] **T004**（FR-001、FR-004）：文档 delta 并入——`docs/hosts/webview-ui.md`「跳到底部」行按新口径整行重写（触发条件 / 触发源白名单 / 右下角定位 / 淡入淡出 / 常驻挂载），`docs/features/user-stories.md` US-47 验收标准 1 重写（验收 2 不动），`MessagesView.tsx` 内指向 webview-ui 规格该节的行为注释随实现同步；依赖：T002；完成判据：`npm run test:all -- docs-lint` 全绿（43 组不回归）
- [x] **T005**（FR-001、FR-002、FR-003、FR-004）：全量回归验证——类型 / lint / 单测 / webview e2e 全量；依赖：T003、T004；完成判据：`npm run check-types` 0 错、`npm run lint` 干净、`npm run test:all` 全过（docs-lint 全组）、webview e2e 全量通过且其余用例无回归
- [x] **T006**（FR-004）：向上滚动即隐藏（spec 修订 AC-11）——`useAutoScroll` scroll 监听内新增向上滚动检测（`scrollTop < lastScrollTop` 任意幅度 + 1s 真实输入门复用 `lastUserScrollInputRef`，清零手势累计）并经新可选回调 `onUserScrollUp` 通知；MessagesView 新增 `handleUserScrollUp` 隐藏按钮；`e2e/webview/jumpToBottom.spec.ts` 新增第 4 条用例（达标显示 → wheel 上滚 60px 立即隐藏 → 小幅下滚不复现 → 新达标手势重新显示）；依赖：—；完成判据：`npm run check-types` 0 错、`npm run lint` 干净、`npx playwright test -c e2e/playwright.config.ts --project=webview-ui jumpToBottom` 4 条全绿
- [x] **T007**（FR-003）：按钮遮挡修复（spec 修订 AC-12）——按钮 z 序 `z-10` → `z-30`（高于 `user-msg-pin` 吸附容器的 zIndex 10 与置顶背景延伸条的 20，低于加载遮罩 40），`e2e/webview/jumpToBottom.spec.ts` 用例 1 增加回归锁（按钮 computed zIndex 高于吸附容器 + 按钮中心 elementFromPoint 命中按钮自身）；依赖：—；完成判据：`npm run check-types` 0 错、`npm run lint` 干净
- [x] **T008**（FR-001、FR-002、FR-003、FR-004）：修订后全量回归验证；依赖：T006、T007；完成判据：`npm run check-types` 0 错、`npm run lint` 干净、`npm run test:all` 全过（docs-lint 全组）、webview e2e 全量通过且其余用例无回归
