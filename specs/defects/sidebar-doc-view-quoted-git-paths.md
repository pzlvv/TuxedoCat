---
status: 已修
---

# 缺陷：文档视图不解 git 的 C 风格引号路径，含引号 / 制表符的文件整条消失

`electron/sidebarDocView.ts` 的文档视图（US-63）用 `git diff --numstat` 与
`git ls-files` 两类输出取「本次改动的 Markdown 文件」。这两份输出是**行式**文本，
git 对含特殊字符的路径会加双引号并按 C 风格逐字符转义（`"a\"b.md"`、`"tab\tname.md"`）。

纯函数 `normalizeRenamedPath` 与 `parseLsFiles` 只剥掉两端的双引号、不做反转义，
于是路径里留着字面的 `\"` / `\t`，随后 `runner.exists(path)` 回查必然失败（磁盘上没有
这个名字的文件），条目被当成「已删除」过滤掉——文件名带引号 / 反斜杠 / 制表符的 Markdown
文档在文档视图里整条消失，用户无从发现它们有改动。

`-c core.quotepath=false` 只关掉**非 ASCII** 的八进制转义（`ünïcode.md` 因此正常），
含 `"`、`\`、制表符、换行的路径仍然被引号包裹——这是本次触发面。

## 现状

- `electron/sidebarDocView.ts` 的 `normalizeRenamedPath`：

  ```ts
  let cleaned = raw.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1);
  }
  ```

  只剥引号，`\"` / `\\` / `\t` / `\n` 等转义序列原样留下。

- 同文件的 `parseLsFiles`：

  ```ts
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  ```

  连引号都不剥。

- 复现（真实 git 仓，仓库里放 `a"b.md`、`tab<TAB>name.md`、`ünïcode.md` 三个未跟踪文件）：

  ```
  git -c core.quotepath=false ls-files --others --exclude-standard -- '*.md'
  "a\"b.md"
  "tab\tname.md"
  ünïcode.md

  collectGitEntries(...)  →
  {"ok":true,"mode":"git","entries":[{"path":"ünïcode.md","plus":1,"minus":0}]}
  ```

  只有不需要转义的 `ünïcode.md` 出现在结果里；另两条被回查过滤掉。

- 同一路径也会经 `git diff --numstat` 到达：改这两个文件后 numstat 给出
  `3\t0\t"a\"b.md"`，`normalizeRenamedPath` 解出 `a\"b.md`（字面反斜杠 + 引号），
  同样回查失败。

- 同一条「行式输出 → 路径」的链路上还有第二个漏点：`parseNumstat` 的
  `if (!line.trim()) continue` 与 `parseLsFiles` 的 `.map((line) => line.trim())`
  会**吃掉文件名首尾的空格**。git 对 ` lead.md` / `trail.md ` 这类名字既不引号包裹也
  不转义，按行读到的原文就是文件名：

  ```
  git -c core.quotepath=false diff --numstat -M HEAD -- '*.md'
  1       0        lead.md

  collectGitEntries(...)  →  {"ok":true,"mode":"git","entries":[]}
  ```

  两条改动都被 trim 成不存在的路径，同样被回查过滤掉。

## 期望

1. **按 git 的引号约定反转义**：被双引号包裹的路径按 C 风格还原
   （`\"`、`\\`、`\t`、`\n`、`\r`、`\b`、`\f`、`\v`、`\a`、三位八进制 `\nnn`），
   未引号包裹的路径原样返回。
2. **`parseLsFiles` 与 `normalizeRenamedPath` 共用同一份反转义**：两条取数路径（numstat /
   ls-files）对同一文件名给出同一结果，`runner.exists` 一次即可命中。
3. **路径不做 trim**：文件名允许首尾空格，两条解析都只跳空行（行尾 `\r` 单独剥）。
4. **连续八进制按 UTF-8 解码**：`\nnn` 是原始字节，`\303\274` 得到 `ü` 而不是两个
   latin-1 字符。
5. **`parseNumstat` 与 `parseLsFiles` 的其余语义不变**：`0/0` 与二进制行跳过、重命名归一到
   新名（`old => new`、`a/{o => n}b`）、空行过滤。
6. 文档视图列出这类文件，行数统计正确（`+N/-M`，未跟踪按全文计行）。

## 不变量

- 输出格式不变：`DocEntry.path` 仍是工作区根相对、`/` 分隔的路径；`git` 调用参数
  （含 `-c core.quotepath=false`）不变。
- 既有跳过规则不变：二进制行（`-`）、纯重命名（`0/0`）、已删除文件（回查失败）继续不出现。
- 真实仓的其它用例（修改 / 纯重命名 / 删除 / 忽略 / 无 HEAD 新仓）行为不变。
- 只改解析层，侧栏渲染层（`electron/sidebar/main.ts`）与 IPC 频道零改动。

## 回归测试

- **RT-1**：`normalizeRenamedPath` 对 `"a\"b.md"` / `"tab\tname.md"` / `"back\\slash.md"`
  反转义为真实文件名；未引号包裹的路径（含 `old => new`）行为不变。
  （落点：`src/test/sidebarDocView.test.ts`）
- **RT-2**：`parseLsFiles` 对引号包裹的行反转义，普通行原样。
- **RT-3**：真实 git 仓里新建 `quo"te.md`（2 行）与 `tab<TAB>name.md`（1 行）后，
  `collectGitEntries` 同时列出它们并给出正确行数（修复前两条都不出现）。
  （落点：`src/test/sidebarDocViewGit.test.ts`）
- **RT-4**：`parseLsFiles` / `parseNumstat` 不 trim 首尾空格的文件名
  （` lead.md` / `trail.md ` 原样保留）。
- **RT-5**：`unquoteGitPath` 把连续八进制按 UTF-8 解码（`"\\303\\274n.md"` → `ün.md`），
  控制字符与认不出的转义也按约定处理。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2（修复前） | `node scripts/run-tests.mjs sidebar-doc-view` | 红 | 两条新断言失败：`normalizeRenamedPath('"a\\"b.md"')` 得到 `a\"b.md` 而非 `a"b.md`；`parseLsFiles` 连引号都没剥 |
| RT-3（修复前） | `node scripts/run-tests.mjs sidebar-doc-view` | 红 | 真实仓用例失败：`collectGitEntries` 只列出无需转义的路径，`quo"te.md` / `tab\tname.md` 一条都不出现 |
| RT-4（修复前） | 真实仓 ` lead.md` / `trail.md ` + `collectGitEntries` | 红 | 两条改动都被 trim 成不存在的路径，`entries` 为空数组 |
| RT-1 ~ RT-5（修复后） | `node scripts/run-tests.mjs sidebar-doc-view` | 绿 | `sidebarDocView` 14 通过 / 0 失败；引号、制表符、反斜杠、首尾空格、八进制 UTF-8 五类都还原成真实文件名 |
| RT-3（修复后） | `node scripts/run-tests.mjs sidebar-doc-view` | 绿 | `sidebarDocViewGit` 5 通过 / 0 失败：真实 git 仓里 `quo"te.md`（+2/-0）与 `tab\tname.md`（+1/-0）都列出 |
| RT-4（修复后） | 同一真实仓 + `collectGitEntries` | 绿 | ` lead.md` 以原样名字出现在结果里（`{"path":" lead.md","plus":1,"minus":0}`） |
| 全量单测 | `npm run test:unit` | 绿 | 100 通过 / 0 失败 |
| 静态检查 | `npm run check-types && npm run lint` | 绿 | 含 webview / electron 三份配置 |
