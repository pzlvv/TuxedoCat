---
status: 已修
---

# 缺陷：偏好设置窗口语言无视 uiLanguage 设置，只看系统 locale

偏好设置窗口（菜单「偏好设置...」打开的宿主原生窗口）的界面语言直接取 Electron 的
系统 locale，没有走宿主 i18n 的语言收敛。系统语言是英文的用户即便在 settings.json
里显式选了中文（`uiLanguage: 'zh'`），窗口仍然渲染英文——菜单 / 托盘 / Spin 设计器
都跟随设置，只有这个窗口不一致；e2e electron 车道（Linux runner，en_US locale）的
US-34 / US-53 因此断言中文录制占位文案失败（CI run 109119767461，2026-10-26）。

## 现状

`electron/main.ts` 打开偏好设置窗口时：

```ts
const html = getPreferenceDialogHtml({
  locale: app.getLocale().startsWith('zh') ? 'zh' : 'en',
});
```

语言判定只看 `app.getLocale()`（系统 locale）。而按 as-built 规格
（[启动期状态：写入入口与读取器](../../docs/hosts/host-bootstrap.md#2-启动期状态写入入口与读取器)），
宿主原生 UI 的语言应来自收敛结果：`primeHostLocale` 先记录宿主 locale、再按
`settings.json` 的 `uiLanguage` 收敛（显式 `zh` / `en` 覆盖，`auto` 才回落系统语言），
菜单 / 托盘 / Spin 设计器都消费收敛后的 `tt()` / `getHostLocale()`——偏好设置窗口
是唯一绕过收敛的宿主原生窗口。

复现证据（CI run 109119767461，en_US runner，settings.json 预写 `uiLanguage: 'zh'`）：

- US-34：`expect(#shortcut-wake).toHaveText('请按下新的组合键…')` 收到
  `"Press the new key combination..."`（desktopShell.spec.ts:175）
- US-53：`expect(#shortcut-next).toHaveText('请按下新的组合键…')` 同样收到英文
  （desktopShell.spec.ts:211）

## 期望

偏好设置窗口的语言与其它宿主原生 UI 同源：取收敛后的宿主 locale
（`src/host/i18n.ts` 的 `getHostLocale()`，`electron/main.ts` 已有该 import 与同款
用法——远端终端窗口开窗即传 `locale: getHostLocale()`）。差异仅一处：
`electron/main.ts` 偏好窗口 HTML 构建处的 locale 来源由 `app.getLocale()` 判定改为
`getHostLocale()`。效果：`uiLanguage: 'zh'` / `'en'` 显式生效，`auto` 保持现状
（回落系统语言）。

## 不变量

- `getPreferenceDialogHtml(options)` 的签名与纯函数行为不变（`locale` 入参仍是
  `'zh' | 'en'`，同 locale 输出不变）。
- 菜单 / 托盘 / Spin 设计器 / 远端终端窗口的语言来源不变（已是收敛结果）。
- 偏好窗口的其余行为不变：状态推送（`onState`）、四行快捷键录制、主题 / 提示音保存。
- `app.getLocale()` 在启动事实里的角色不变（作为「宿主 locale」输入喂给
  `primeHostLocale`，见 `bootstrapCore` 的启动接线）。

## 回归测试

既有 e2e 用例即回归载体（断言中文录制占位文案），在系统 locale 非 zh 的环境必然
先红；本地 Windows（zh 系统 locale）无法复现红，红的证据取 CI electron 车道。

- **RT-1**：US-34 录制唤醒键进入捕获态后占位文案是中文（落点：
  `e2e/electron/desktopShell.spec.ts` US-34，`#shortcut-wake` toHaveText
  `'请按下新的组合键…'`）
- **RT-2**：US-53 录制「下一标签」进入捕获态后占位文案是中文（落点：
  `e2e/electron/desktopShell.spec.ts` US-53，`#shortcut-next` toHaveText
  `'请按下新的组合键…'`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | CI electron 车道 run 109119767461；本地 `npx playwright test --project=electron-app -g "临时：en 宿主 locale"`（临时 spec 以 `--lang=en-US` 强制宿主 locale） | 红 | RT-1 / RT-2 在 en_US runner 收到英文占位 `"Press the new key combination..."`；本地复现同路径 `document.documentElement.lang === "en"`（期望 zh） |
| 回归用例（修复后） | `npx playwright test --project=electron-app -g "US-34 全局唤醒快捷键"` 与 `-g "US-53 标签页快捷键：录制改键生效"`（本地 Windows，zh 系统 locale，分别执行） | 绿 | US-34 / US-53 全流程过；en 分支另用临时 spec 复跑 `--lang=en-US` 得 `lang === "zh"`（绿）后删除 |
| 既有回归 | 同上命令追加 `-g "US-31 标题栏最大化"` 与 `-g "US-33 偏好设置：提示音开关"`（四个用例一批） | 绿 | 4 用例全过；`npm run check-types`、`npm run check-types:e2e` 绿 |
| en_US 环境的完整车道绿 | CI electron 车道（Linux en_US runner） | not-run | 本机系统 locale 为 zh，en 分支的整车道验证由下一次 CI run 确认 |

备注：RT-1 的改键目标组合由 `Ctrl+Alt+Y` 改为 `Ctrl+Alt+9`——本机探测 `Ctrl+Alt+Y`
已被其它程序持有（`globalShortcut.register` 失败），换绑断言会环境性假红；选法与
初始预置的 `Ctrl+Alt+8` 同一口径（避开本机占用）。
