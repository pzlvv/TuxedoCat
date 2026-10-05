# e2e 场景级测试（Playwright）

以真实用户操作（输入、点击、悬停、快捷键）驱动的场景级端到端测试，需求基线是
`docs/user-stories.md`（每条用例标题标注覆盖的 `US-xx`）。两个 project 对应两层：

| project | 层级 | 驱动对象 | 宿主侧 |
| --- | --- | --- | --- |
| `webview-ui` | webview UI | Chromium 加载构建产物 `dist/webview/index.html` | 假宿主（`helpers/fakeHost.ts`）按 `src/host/webviewMessages.ts` 协议应答 |
| `electron-app` | 整应用 | 真实 Electron 应用（`dist-electron/main.cjs`） | **standalone core**（Rust，`dist/resources/core/`，先 `npm run build:core`）+ 本地 mock LLM SSE 服务器（`helpers/mockLlmServer.ts`） |

## 运行

前置：构建产物必须存在（配置文件加载时校验并给出提示）。

```bash
# 首次：构建被测产物 + 安装浏览器
npm run build:webview && npm run copy-assets && npm run build:electron
npx playwright install chromium            # 网络受限时：PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/

npm run test:e2e            # 全部（webview-ui + electron-app，串行）
npm run test:e2e:webview    # 仅 webview UI 级
npm run test:e2e:electron   # 仅 Electron 整应用
```

Electron 用例不需要 Playwright 的 Chromium，用项目自带的 `node_modules/electron`。

排查：`E2E_DEBUG=1 npm run test:e2e:electron` 会把应用主进程日志透传到测试输出；
失败时 Playwright 输出 trace（`npx playwright show-trace <zip>`）。

## 结构

```
e2e/
├── playwright.config.ts        # 两个 project，串行执行（workers=1）
├── helpers/
│   ├── fakeHost.ts             # webview 级假宿主：注入 window.vscode / __hostInfo 等全局，
│   │                           # 自动应答启动序列，sendMessage 播放脚本化流式轮次
│   ├── webviewHarness.ts       # 静态伺服 dist/webview + 页面装配（clipboard 权限等）
│   ├── mockLlmServer.ts        # OpenAI Chat Completions 兼容 SSE 服务器：
│   │                           #   写入文件 <名> → Write 工具轮；执行命令 <cmd> → Bash 工具轮；
│   │                           #   慢速回答 → 慢速流（中止场景）；其余 → 文本终轮
│   └── electronApp.ts          # Electron 启动器：沙箱隔离 + CDP 直连 + 活动视图解析
├── webview/                    # US-1/2/3/4/5/6/7/8/9/10/11/12/13/16/17/18/19/20/21/22/23/24/25/26/29/40/41
│                               # （titlebar.spec 为标题栏快照时序，US-36 渲染层）
└── electron/                   # US-1/2/14/15/18/19/20/21/22/27/28/30/31/32/34/35/36/37/38/39/42/43
```

## 隔离策略（electron-app）

- `USERPROFILE` / `HOME` / `APPDATA` 指向临时目录：`~/.tuxedo-cat/`（settings.json、
  会话落盘）与 Electron userData（workspace-state.json）全部进沙箱，用例结束删除。
  注意 `APPDATA` 必须一并指向沙箱并预建目录，否则 Electron 解析不出 `appData` 路径。
- settings.json 预写 mock provider（manual 询问模式让写操作弹权限确认），
  LLM 指向本地 mock SSE 服务器，全程无外网请求。
- `TUXEDO_CAT_CORE=standalone`（默认）：Rust Core 独立进程，多 Connection / daemon / SSH 链路与
  产品一致；前置 `npm run build:core`。远程工作区场景只有 standalone 才真实（embedded 单
  Connection 无 lost 信号、session 路由有「唯一连接」退路，覆盖不了失败链路）。
- `--multi-instance=<id>` 跳过单实例锁；实例后缀会被 main.ts 截断到 32 字符，
  预置 workspace-state.json 时必须用同样的短 id 规则。

## 已知坑（实证结论）

1. **Playwright 连接 Electron 的两个前提**（`_electron.launch` 与裸 CDP 均适用）：
   - 应用主窗口从不 `loadURL`（视图全挂 contentView），其 webContents 没有渲染进程，
     对该 target 的 CDP 命令永不响应，会让 Playwright 页面初始化无限挂起。启动器经
     Node inspector（`--inspect=0`）在主进程执行 `loadURL('about:blank')` 拉起渲染器。
   - `--inspect=0` / `--remote-debugging-port=0` / `--remote-allow-origins=*` 必须放在
     入口文件之前。
2. **多视图宿主的活动视图解析**：标题栏 / 侧栏 / 每会话聊天视图都是 WebContentsView，
   在 CDP 目标列表里同为 page target；且 Electron 对未挂载视图仍报告
   `visibilityState=visible`、`hasFocus()=true`，两者都不能判别活动视图。启动器用
   「视图绑定工作区（`electronAPI.getWorkspacePath()`）+ 视图自身会话
   （`window.__currentSessionId`）+ 侧栏列表」组合解析。
3. **antd 菜单项整项 disabled**：功能菜单 / 模型子菜单的条目刻意 `disabled: true`
   （交互交给内部控件），Playwright 的可点击性检查会拒绝，需要 `click({ force: true })`。
4. **会话条目操作按钮 hover 才显示**（纯 CSS `group-hover`）：悬停要用条目根
   （`.group`），且同名按钮在每条根会话上都存在，定位必须按行作用域化。
5. **全局快捷键会被泄漏实例占用**：用例中断（Ctrl+C / 超时强杀）跳过 afterEach 时，
   上一轮的 Electron 实例可能残留并持有全局热键，新实例启动注册静默失败（现会落
   日志）。US-34 预置独占组合键（`Ctrl+Alt+8`）断言，不依赖默认 `Ctrl+Alt+X` 是否
   空闲；跑套件前可用 `tasklist | findstr "Tuxedo"` 检查残留实例。
