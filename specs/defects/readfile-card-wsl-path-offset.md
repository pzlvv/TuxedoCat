---
status: 已修
---

# 缺陷：Read 卡片的 WSL 路径转换与 offset 行号换算都算错，点击打开落到错文件 / 错行

`src/webview/tools/ReadFile.tsx` 是 Read 工具卡片（`docs/hosts/webview-ui.md` 的
工具卡片段）的唯一渲染方，两处派生都在这个组件里手写：

1. `wslToWindowsPath` 把 WSL 路径 `/mnt/<盘符>/...` 转成 Windows 路径时用了**错的
   固定下标**（`p[8]` / `p.slice(9)`），而 `/mnt/` 只有 5 个字符、盘符在下标 5；
2. `offset` / `limit` → `selectedLines`（1-based 行区间）的换算是按 **0-based**
   `offset` 写的（`offset + 1` / `offset + limit`），而 Read 工具的 `offset` 契约是
   **1-based** 起始行号。

两处都只影响用户点击卡片后的跳转结果，不改变工具执行与落盘内容。

## 现状

- `wslToWindowsPath`（`src/webview/tools/ReadFile.tsx`）：

  ```ts
  if (/^\/mnt\/([a-z])\//i.test(p)) {
    const drive = p[8].toUpperCase();
    return `${drive}:\\${p.slice(9).replace(/\//g, '\\')}`;
  }
  ```

  盘符位置应取 `p[5]`（`/mnt/` 占 0..4，盘符在 5），路径正文从 `p[7]` 起
  （盘符后紧跟 `/`）。当前实现把盘符取成路径正文的第 1 个字符、把路径正文从第 2 个
  字符起算，于是每个路径都被腰斩并接到错误盘符上。

  复现（Linux，仓库根，纯函数照抄组件实现）：

  ```
  node -e "const f=(p)=>{if(/^\/mnt\/([a-z])\//i.test(p)){const d=p[8].toUpperCase();return \`\${d}:\\\\\${p.slice(9).replace(/\//g,'\\\\')}\`;}if(/^\/mnt\/([a-z])\$/i.test(p)){return p[5].toUpperCase()+':\\\\';}return p;};
           for(const t of ['/mnt/d/git/proj','/mnt/c/Users/pz/x.ts','/mnt/d/'])console.log(t,'=>',f(t))"
  ```

  实测输出：

  ```
  /mnt/d/git/proj    => I:\t\proj
  /mnt/c/Users/pz/x.ts => S:\ers\pz\x.ts
  /mnt/d/            => TypeError: Cannot read properties of undefined (reading 'toUpperCase')
  ```

  期望 `D:\git\proj`、`C:\Users\pz\x.ts`、`D:\`。第三条是**抛错**：`/mnt/d/` 匹配
  第一个分支但只有 7 个字符，`p[8]` 是 `undefined`，`.toUpperCase()` 直接抛
  `TypeError`——点击卡片时组件抛错，跳转整个失效。

- `offset` / `limit` → `selectedLines`（同文件）：

  ```ts
  const endLine = limit !== undefined ? offset + limit - 1 : undefined;
  message.selectedLines = { start: offset + 1, end: endLine !== undefined ? endLine + 1 : offset + 1 };
  ```

  复现：

  ```
  offset=50 limit=3 => {"start":51,"end":53}   期望 {"start":50,"end":52}
  offset=1  limit=1 => {"start":2,"end":2}     期望 {"start":1,"end":1}
  offset=50 无limit => {"start":51,"end":51}   期望 {"start":50,"end":50}
  ```

  `offset` 是 1-based 起始行号（`core-rs/src/prompt.rs` 与 `core-rs/src/tools.rs`
  的 Read schema：`The 1-based line number to start reading from (default: 1)`，
  `core-rs/src/tools.rs` 的 `read_text` 用 `offset.saturating_sub(1)` 取起始下标），
  当前换算把每条 Read 卡片的跳转目标整体下移一行；带 `limit` 时区间长度多 1 行。

- 卡片上的行号文案（`displayText` 的 `:start-end`）用的是第二套换算
  （`offset + 1` / `offset + limit`），与上面的 `selectedLines` 是两份写法。它恰好
  算出 1-based 区间，但因为两处各写一遍，修复时必须一起收敛，避免「显示对、跳转错」
  或反之。

## 期望

1. **WSL 路径按正确下标转换**：盘符取 `/mnt/` 之后的第一个字符（大写），路径正文从
   盘符后的 `/` 起转成 `\`；`/mnt/d` 与 `/mnt/d/` 都得到 `D:\`。与 Core 侧
   `core-rs/src/tools.rs` 的 `wsl_mnt_path`（`bytes[5]` 取盘符、`path[6..]` 取正文）
   同口径。
2. **行号区间按 1-based `offset` 换算**：`offset=50, limit=3` → `{start: 50, end: 52}`；
   无 `limit` 时区间只覆盖起始行（`start === end === offset`）；`offset=0` 按 1 处理
   （schema 的「0 is accepted and treated as 1」）。
3. **一份换算**：`displayText` 的行号文案与 `selectedLines` 由同一个派生函数产出，
   不在组件里写两遍。
4. **不改变其他路径的语义**：非 `/mnt/` 开头的路径原样返回（Linux / macOS / 已是
   Windows 路径的会话）。

## 不变量

- 只改 webview 的展示与跳转派生：Read 工具的执行、`offset` / `limit` 的入参语义、
  落盘内容与 Core 行为全部不变。
- `openFile` 消息形状不变（`{ type: 'openFile', filePath, selectedLines? }`）。
- `selectedLines` 仍是 1-based 含端点的行区间（`UIHost.openFile` 的 `LineSelection`）。
- 无 `offset` 时不带 `selectedLines`（现有行为：整文件打开）。
- 本模块保持 webview 可 import（不得引入 Node 类型链）。

## 回归测试

- **RT-1**：`/mnt/d/git/proj` → `D:\git\proj`、`/mnt/c/Users/pz/x.ts` →
  `C:\Users\pz\x.ts`（修复前红：得到 `I:\t\proj` / `S:\ers\pz\x.ts`）。
- **RT-2**：`/mnt/d` 与 `/mnt/d/` → `D:\`（修复前红：后者抛 `TypeError`）。
- **RT-3**：`offset=50, limit=3` → `{start: 50, end: 52}`；`offset=1, limit=1` →
  `{start: 1, end: 1}`；`offset=50, limit=null` → `{start: 50, end: 50}`；
  `offset=0, limit=5` → `{start: 1, end: 5}`（修复前红：分别得到 51/53、2/2、51/51）。
- **RT-4**：非 WSL 路径原样返回（4a）；`limit` 为 0 / 负数 / `NaN` 时区间退化为起始行
  （4c）；无 `offset` 时组件不带 `selectedLines`（4b，判空在组件调用点）。

落点：`src/test/readFileCard.test.ts`（把两处派生抽成纯函数 `src/webview/readFileCard.ts`
后覆盖）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `node /tmp/redcheck.mjs`（照抄组件原实现跑同一组断言） | 红 | 7 条断言里 6 条失败：两条 WSL 路径得 `I:\t\proj` / `S:\ers\pz\x.ts`、`/mnt/d/` 抛 `TypeError: Cannot read properties of undefined (reading 'toUpperCase')`、`offset=50/limit=3` 得 51..53、`offset=1/limit=1` 得 2..2、`offset=50`（无 limit）得 51..51 |
| 回归用例（修复后） | `npm run test:unit -- readFileCard` | 绿 | 5 通过 / 0 失败 |
| 静态检查 | `npm run check-types`（含 webview / electron 三份配置） | 绿 | — |
| 静态检查 | `npm run lint` | 绿 | — |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测（含 webviewRenderInvariants / toolResultSideEffects 等工具卡片相关链路） |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节与验证记录取值合法、章节引用有效 |
