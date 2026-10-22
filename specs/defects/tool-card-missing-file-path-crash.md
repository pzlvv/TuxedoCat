---
status: 已修
---

# 缺陷：模型漏传 file_path 时 Write / Edit 卡片把 webview 打崩

模型生成的 `Write` / `Edit` 入参里没有 `file_path`（漏传、拼错键、或流式补齐尚未到达）时，
工具卡片不是降级显示既有文案 `unknown file`，而是抛错把整个 webview 打崩：webview 没有
error boundary，任何一个组件在渲染或 effect 里抛错都会让整棵 React 树卸载，用户看到的是
空白界面（只能重开面板）。`Read` 卡片同一场景是正常的——它把判空放在所有 hooks 之前且
不在 effect 里使用路径，说明「缺路径就显示 unknown file」本就是既定行为。

## 现状

两条独立的抛错路径，都只在 `file_path` 缺失时触发：

1. **Write 卡片：`undefined.split` 抛 TypeError。** `src/webview/tools/WriteFile.tsx` 的
   `getLanguageFromPath` 形参是 `string`，函数体第一句是 `path.split('.').pop()`。它在
   语法高亮的 `useEffect` 里被调用，而该 effect 的前置条件只有
   `if (!highlightSource || !isExpanded) return`——没有 `filePath`。`highlightSource` 来自
   `args.contentPreview`，与路径无关：`core-rs/src/permission.rs` 的 displayArgs 只要
   `args.content` 为真就补 `contentPreview` / `totalLines`，不要求 `file_path` 存在
   （`src/webview/hooks/handlers/shared.ts` 的历史恢复分支同样如此）。于是
   「有 content、没 file_path」的 Write 调用必崩。
2. **Edit 卡片：hooks 数量随 `file_path` 变化。** `src/webview/tools/EditFile.tsx` 在
   `if (!filePath) { return <ToolHeader …/> }` 之后还有两处 hooks（按需加载语法高亮的
   `useEffect`、`diffRender` 的 `useMemo`）。React 按调用顺序匹配 hooks：同一个组件实例
   第一次渲染缺 `file_path`（少调 2 个 hooks），之后 args 补上 `file_path`
   （`updateToolArgs` 会就地合并 args 并重渲染同一张卡片，见
   `src/webview/hooks/handlers/toolHandlers.ts` 的 `handleToolUpdateToolArgs`）时就会抛
   `Rendered more hooks than during the previous render`。
3. 同一不变量的第二处违反（RT-1 全量扫描发现）：`src/webview/ConversationTreeItem.tsx`
   把环形 `parentSessionId` 的递归保护 `if (depth > MAX_DEPTH) return null;` 放在
   `useState` / `useRef` / `useEffect` 之前，`depth` 变化时同样会让 hooks 数量错位。
   当前会话树的 key 稳定、`depth` 不翻转，属潜在违反而非现网崩溃。

## 期望

- 缺 `file_path` 时两张卡片都降级成既有的 `unknown file` 头部（`tool.writeFile.unknownFile` /
  `tool.editFile.unknownFile`），不抛错、不影响同页其它卡片。
- 语言探测函数把「没有路径」当作合法入参：形参类型含 `undefined`，缺失时返回
  `plaintext`，由函数自己兜住，调用点不必各自判空。
- 组件的 hooks 调用序列与 args 内容无关：`file_path` 有无、何时补齐，都不改变同一实例
  两次渲染的 hooks 数量。
- `depth` 超限的递归保护保留，但不参与 hooks 顺序（保护在 hooks 之外判定）。

## 不变量

- 有 `file_path` 时两张卡片的既有行为不变：路径展示、点击打开文件、语法高亮语言映射
  （两处 map 各自保持现状，不合并、不改取值）、Edit 的 diff 渲染与回滚入口、
  Write 的预览折叠与回滚入口。
- `unknown file` 头部在有 `file_path` 时永不出现；缺失时头部右侧的回滚入口判定条件不变
  （`metaLoaded && (diffHunks.length > 0 || beforeContent) && effectiveToolCallId`）。
- `getLanguageFromPath` 的扩展名 → 语言映射结果逐项不变（本次只加缺失路径的兜底，
  不动映射表）。
- webview 仍不引入 error boundary、不加运行时兜底渲染；缺陷在源头修掉。

## 回归测试

- **RT-1**：`src/webview/**` 每个函数体内，hooks 调用不得出现在「带 return 的 `if` 语句」
  之后（AST 判定，跳过嵌套函数体）。（落点：
  `src/test/webviewRenderInvariants.test.ts`「hooks 不在条件返回之后」）
- **RT-2**：每个 `getLanguageFromPath` 定义的形参类型必须显式含 `undefined`，且函数体
  第一条语句是对该形参的判空返回（缺失路径不抛错；函数体内的 `.split` 等解引用由
  `npm run check-types:webview` 的类型收窄兜住）。（落点：
  `src/test/webviewRenderInvariants.test.ts`「形参类型含 undefined」/「首条语句对形参判空返回」）
- **RT-3**：Write 高亮 effect（回调体里调用 `getLanguageFromPath` 的那个 `useEffect`）的
  前置条件必须含 `filePath`（缺路径不跑高亮），且依赖数组含 `filePath`（路径后补时重跑）。
  （落点：`src/test/webviewRenderInvariants.test.ts`「缺 filePath 时不跑高亮」/「依赖数组含 filePath」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:all -- webview-render-invariants` | 红 | 6 项断言失败 / 4 通过：RT-1 命中 `src/webview/ConversationTreeItem.tsx`（guard@88 → hook@93）与 `src/webview/tools/EditFile.tsx`（guard@236 → hook@412）；RT-2 两处 `getLanguageFromPath`（`EditFile.tsx:287` / `WriteFile.tsx:172`）形参均为 `string`、首条语句不是判空返回；RT-3 的 `WriteFile.tsx:119` 前置条件不含 `filePath`（依赖数组已含，故该条已绿） |
| 回归用例（修复后） | `npm run test:all -- webview-render-invariants` | 绿 | 10 通过 / 0 失败：`hooks 不在条件返回之后` 无命中（`ConversationTreeItem` 拆成「无 hooks 的 depth 外壳 + Body」、`EditFile` 的 unknown file 分支下移到全部 hooks 之后）；两处 `getLanguageFromPath` 形参改为 `string \| undefined` 且首条语句判空；`WriteFile.tsx` 高亮 effect 前置条件含 `filePath` |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsconfig（含 `check-types:webview`）0 错；eslint 对 `src` 无告警 |
| 既有回归（单测全量） | `npm run test:all` | 红 | 62 个用例文件 60 绿 / 2 红，两项都与本改动无关：`docsLint` 当次红在本表还缺「修复后的绿」行（属本流程中间态，补齐后单独复跑为绿，见下），`corePlatformMatrix` 见下一行；本改动涉及的 `webviewRenderInvariants` / `webviewFacts` 均在绿列 |
| 既有回归：`corePlatformMatrix` | `npm run test:all -- core-platform-matrix` | 红 | 唯一失败项「`arm64-win32` 已产出调试符号（pdb）」：本机 `resources/core/arm64-win32/` 只有 exe / ripgrep / fingerprint，缺 `.pdb`——本地 Core 产物未按 `npm run build:core:host` 重建，属 `specs/defects/core-pdb-not-deployed.md` 的 RT-1 环境前置，本次改动只碰 `src/webview` 与 `src/test`，未触及该目录 |
| docsLint | `npm run test:all -- docs-lint` | 绿 | 46 通过 / 0 失败（本规格的五节 / RT 编号 / 验证记录四列与结果取值、行内代码路径存活均通过） |
| webview 打包 | `npm run build:webview` | 绿 | vite 六个入口全部 built（含 `dist/` 主 webview），改动的三个 `.tsx` 无打包期告警 |
