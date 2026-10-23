---
status: 实施中
---

# 改动规格：工作区标签页快捷键切换与改键

Electron 宿主为工作区标签页提供键盘切换能力：「下一标签」「上一标签」两个动作按标签页
顺序把活动项移向相邻项，组合键可由用户在偏好设置窗口里录制改键，默认下一标签
Ctrl+Tab、上一标签 Ctrl+Shift+Tab。组合键与唤醒快捷键同属宿主本地偏好（core 不读不写），
录入、持久化与展示沿既有唤醒快捷键的形态；菜单条目与快捷键沿用同一份动作表。
VS Code 宿主不参与（无标签页概念）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md#5-标签页) | 5. 标签页 | 修改 | 新增键盘切换相邻标签页的行为条目（顺序、环绕、少于 2 项 no-op） |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md#7-菜单) | 7. 菜单 | 修改 | 菜单面板条目表新增「下一标签 / 上一标签」，登记其默认组合与改键入口 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md#11-持久化) | 11. 持久化 | 修改 | 状态文件新增两条标签快捷键字段（缺失 / 非法回默认） |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md#ep-9-多工作区桌面端) | EP-9 多工作区 | 修改 | 新增 US-53 标签页快捷键切换与改键 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 附录：US 与 e2e 场景用例映射 | 修改 | US-53 登记 e2e 用例落点 |

## 用户场景与验收标准

- 场景 1：键盘在标签页间移动活动项
  - **AC-1**（FR-001）：GIVEN 打开集合为 A、B、C 且活动项为 A WHEN 依次按三次「下一标签」组合 THEN 活动项依次为 B、C、A（末项向后环绕回首项）
  - **AC-2**（FR-001）：GIVEN 打开集合为 A、B、C 且活动项为 A WHEN 按「上一标签」组合 THEN 活动项为 C（首项向前环绕到末项）
  - **AC-3**（FR-001）：GIVEN 打开集合不足 2 项 WHEN 按任一标签组合 THEN 活动项不变（无相邻项，动作不执行）
  - **AC-4**（FR-001）：GIVEN 打开集合为 A、B、C 且活动项为 A WHEN 按下一标签组合切到 B THEN 侧栏对话列表与聊天区呈现 B、活动标签高亮 B、活动项持久化更新（与点击标签页同一套切换语义）
  - **AC-5**（FR-001）：GIVEN 主窗口内焦点在侧栏、标题栏或聊天区任意一处 WHEN 按标签组合 THEN 切换同样生效
- 场景 2：默认组合与持久化
  - **AC-6**（FR-002）：GIVEN 状态文件没有标签快捷键字段 WHEN 启动 THEN 下一 / 上一分别按 Ctrl+Tab、Ctrl+Shift+Tab 生效
  - **AC-7**（FR-002）：GIVEN 状态文件中标签快捷键字段缺失或非法 WHEN 读取 THEN 按默认值生效，不抛错、不把默认值写回文件
  - **AC-8**（FR-002）：GIVEN 已把下一标签录制为 Ctrl+J WHEN 重启应用 THEN 切换按 Ctrl+J 生效、Ctrl+Tab 不再触发
- 场景 3：偏好设置窗口录制改键
  - **AC-9**（FR-003）：GIVEN 偏好设置窗口 WHEN 点击「下一标签」字段并按下新组合 THEN 字段显示新组合、保存并立即生效（录制中 Esc 取消、原值保持）
  - **AC-10**（FR-003）：GIVEN 下一标签现值为 Ctrl+Tab WHEN 把上一标签录制为 Ctrl+Tab THEN 保存被拒绝、行内显示冲突原因、上一标签保持 Ctrl+Shift+Tab
  - **AC-11**（FR-003）：GIVEN 偏好窗口某行录制中 WHEN 按下的组合与菜单既有组合（Ctrl+O、Ctrl+Shift+O、Ctrl+Shift+I）或当前唤醒快捷键相同 THEN 保存被拒、行内显示冲突原因、原值保持
- 场景 4：菜单与快捷键同源
  - **AC-12**（FR-004）：GIVEN 任一时刻 WHEN 展开单一菜单 THEN 可见「下一标签」「上一标签」条目且展示当前生效组合，点击条目执行对应切换
  - **AC-13**（FR-004）：GIVEN 下一标签已改为 Ctrl+J WHEN 展开单一菜单 THEN 该条目展示 Ctrl+J（改键后展示与生效组合一致）

## 功能需求

### FR-001：键盘切换相邻标签页

Electron 宿主提供「下一标签」「上一标签」两个动作：按打开集合顺序（即标签页顺序，
含拖拽重排后的顺序）把活动工作目录移向相邻一项。从末项向后环绕到首项，从首项向前
环绕到末项。打开集合不足 2 项时动作不执行（无相邻项可去，不报错——设计允许的瞬时
状态）。切换复用既有「切换活动工作区」语义：活动项唯一、侧栏 / 聊天区 / 标题栏联动、
活动项持久化（[docs/hosts/electron-multi-workspace.md 第 3 节](../../docs/hosts/electron-multi-workspace.md#3-工作目录模型)）。
组合键在主窗口内生效，不限定焦点所在视图（侧栏 / 标题栏 / 聊天区）。

### FR-002：组合键可定义，默认值固定

两个动作各有一个用户可定义的组合键，以 Electron accelerator 形式持久化在宿主本地
状态文件（`workspace-state.json`），core 不读不写（与唤醒快捷键同类）。默认值：
下一标签 Ctrl+Tab、上一标签 Ctrl+Shift+Tab。字段缺失或非法时按默认值生效，读取路径
不把默认值写回文件。组合键的按键合法性口径与唤醒快捷键一致（必须带修饰键，单键仅
允许功能键）。

### FR-003：偏好设置窗口录制改键

偏好设置窗口的快捷键区列出唤醒、下一标签、上一标签三行，逐行点击进入录制：页面显示
录制提示，Esc 取消并保持原值，录到合法组合即保存、立即生效并持久化。录制的组合与
任一既有绑定冲突时拒绝保存：两条标签快捷键互撞、菜单既有组合（Ctrl+O、Ctrl+Shift+O、
Ctrl+Shift+I）、当前唤醒快捷键；拒绝时行内显示冲突原因，原值保持。唤醒快捷键自身的
录入路径不做冲突检测（既有行为不变）。

### FR-004：菜单条目与快捷键同源

单一菜单（Windows / Linux 自绘标题栏菜单、macOS 系统菜单栏）收录「下一标签」
「上一标签」条目，展示当前生效组合，点击执行与组合键相同的动作；菜单动作与快捷键
绑定沿用同一份动作表（[docs/hosts/electron-multi-workspace.md 第 7 节](../../docs/hosts/electron-multi-workspace.md#7-菜单)）。
改键保存后菜单展示与生效组合同步更新。

## 边界与错误路径

- **打开集合为空 / 仅一项**：两个动作均 no-op，不报错、不落日志噪音。
- **快捷键连按 / 切换执行中集合变化**：每次按键按当下的打开集合重新计算相邻项，不排队；
  目标项在执行前被关闭时该次动作落空（切换入口按标签 id 重新定位，定位不到即返回）。
- **环绕**：末项的下一项是首项、首项的上一项是末项（浏览器惯例），不做边界停驻。
- **持久化值非法**：读取按缺失处理回默认值，不写回、不抛错。
- **录制冲突**：拒绝保存并在行内报错（FR-003），不覆盖原值。
- **浮窗模式**：标签页区隐藏但打开集合仍在，组合键照常生效——浮窗呈现活动工作目录的
  对话，切换即更换呈现对象，与「浮窗呈现活动对话」的既有语义一致。
- **macOS**：组合键经系统菜单栏的原生 accelerator 生效，不依赖无边框兜底；
  默认值与 Windows / Linux 相同。

## 非目标

- VS Code 宿主不参与（无标签页概念，沿 EP-9 既有边界）。
- 不做「跳转到第 N 个标签」（Ctrl+1..9）、「新建 / 关闭标签」的组合键——需要时另开 spec。
- 标签组合键不做全局注册（`globalShortcut` 仍只用于唤醒快捷键）。
- 不改唤醒快捷键录入路径的冲突检测（其现状不查菜单冲突，保持不动）。
- 组合键不进 `settings.json` 与 webview 设置面板（宿主本地偏好，归属偏好设置窗口）。

## 对需求基线的影响

新增 US-53「标签页快捷键切换与改键」，落
[docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md#ep-9-多工作区桌面端)
EP-9；e2e 用例登记两处——标签切换驱动 `e2e/electron/workspace.spec.ts`（主进程
`sendInputEvent` 走真实输入管线，同 US-34 口径），改键录制驱动偏好设置窗口（同 US-34
的录制驱动形态）；`docs/features/user-stories.md` 附录映射表同步登记。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/tabSwitching.ts`（相邻项纯函数）+ `electron/main.ts` 动作接线 | `src/test/tabSwitching.test.ts` + `e2e/electron/workspace.spec.ts`（US-53 键盘切换） | 自动 |
| FR-002 | `electron/shortcut.ts`（默认值常量）+ `electron/workspaceStateStore.ts`（状态字段） | `src/test/tabSwitching.test.ts`（默认值 / 非法回退） | 自动 |
| FR-003 | `electron/preferenceDialogHtml.ts` + `electron/main.ts`（录制与冲突判定） | `src/test/preferenceDialog.test.ts` + `e2e/electron/desktopShell.spec.ts`（US-53 录制改键） | 自动 |
| FR-004 | `electron/main.ts` 的 `buildMenuSections` | `e2e/electron/desktopShell.spec.ts`（菜单条目展示与点击） | 自动 |

## 待澄清

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>
