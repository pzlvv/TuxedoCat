# MessagesView 渲染 / 内存 / 性能测试 harness

这是一套基于 Playwright + esbuild 的本地测试工具，用来在真实浏览器里挂载 webview 的
`MessagesView`，测量大对话的 DOM 节点数、JS 堆占用、渲染耗时与滚动性能，并验证
代码预览（Edit / Write）的截断与展开行为。

它**不属于** `npm test`（VS Code 扩展的 mocha 测试），也不会参与正式构建；只在需要
排查渲染性能或做回归验证时手动运行。

## 目录结构

```
src/test/memtest/
├── harness.entry.tsx      # 测试页面入口：把样本会话挂到 MessagesView 上
├── template.html          # 页面模板（build.mjs 用它生成 index.html）
├── build.mjs              # 用 esbuild 把 harness 打成单文件 web.js，并复制真实 CSS
├── preprocess.js          # 把 <configDir>/conversations 的 JSONL 转成样本集
├── make-synthetic.mjs     # 生成"多语言"合成会话（验证 Shiki 按需加载）
├── make-length-sweep.mjs  # 从同一会话切出不同长度的样本（隔离"长度"变量）
├── run.mjs                # 内存 / DOM 测试驱动
├── perf.mjs               # 运行时性能剖析（滚动、交互、长任务）
├── perf-render.mjs        # 真实渲染耗时 + CPU profile 热点
├── real-startup.mjs       # 用真实构建产物（dist/webview）测启动性能
├── verify-preview-limit.mjs  # 验证代码预览默认截断、点击后展开全部行
├── preview-toggles.mjs    # 验证预览的两个独立开关（箭头收起 / 点击展开）
├── preview-fit.mjs        # 计算预览框不出现滚动条所需的渲染行数
└── stubs/                 # shiki / rehype-katex 桩，用于 --variant 对照实验
```

## 前置条件

1. 安装依赖（Playwright 只装在本目录，不污染扩展的依赖）：

   ```bash
   cd src/test/memtest
   npm install
   npx playwright install msedge
   ```

   驱动脚本默认使用系统已安装的 Edge（`channel: 'msedge'`）。

2. 生成真实构建产物的 CSS（harness 用它保证布局与线上一致）：

   ```bash
   npm run build:webview   # 在仓库根目录执行
   ```

## 使用流程

```bash
cd src/test/memtest

# 1) 准备样本数据（二选一）
node preprocess.js sessions.json     # 从真实会话导出（需要 <configDir>/conversations）
node make-synthetic.mjs              # 或生成多语言合成会话 sessions-synthetic.json

# 2) 构建 harness 页面
node build.mjs                       # 生成 web.js + index.html（+ real-*.css）

# 3) 运行
node run.mjs --sessions=sessions.json            # 内存 / DOM 测试
node perf.mjs current --sessions=sessions.json   # 运行时性能
node perf-render.mjs --sessions=sessions.json --profile
node verify-preview-limit.mjs --sessions=sessions.json
node preview-toggles.mjs --data=sessions.json --session=last
```

`build.mjs` 支持 `--variant=full|no-shiki|no-katex|neither`，用 `stubs/` 里的桩替换
shiki / rehype-katex，从而测量各自的资源占用：

```bash
node build.mjs --variant=no-shiki && node run.mjs --variant=no-shiki
```

## 说明

- 生成物（`web*.js`、`index*.html`、`real-*.css`、样本 / 结果 `*.json`、截图 `*.png`、
  `node_modules/`）已在 `.gitignore` 中忽略，不要提交。
- 各驱动脚本默认读取本目录下的 `sessions.json`，可用 `--sessions=` / `--data=`
  指向其它样本文件；`--session=` 支持 `last`、`0` 或名字片段。
