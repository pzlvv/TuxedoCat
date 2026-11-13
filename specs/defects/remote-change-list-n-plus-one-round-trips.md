---
status: 已修
---

# 缺陷：远程变更清单按条目逐个往返（N+1 次 SSH），条目一多就慢到不可用

侧栏「文档 / 差异」两个变更视图的取数在远程（SSH）工作区上退化成 **N+1 次网络往返**：
git 只占 4 次 exec，其余每个变更条目各付一次 SFTP 请求——未跟踪文件按「整文件读回本地
再数行数」，已删除过滤按「逐条 stat」。条目数 50 时约 3 秒、200 时约 12 秒（单次 RTT
60ms 估算），期间侧栏只显示 loading。同一份取数在本地工作区毫秒级，因为本地读盘没有
往返成本，缺陷只在远程暴露。另外 4 条独立 git 命令各自付一次 RTT，且取数本身会重写
远端 `.git/index`，把变更视图自己的 git 哨兵再触发一轮全量重扫。

## 现状

取数入口是 `sidebar:files-doc-list`（`electron/main.ts`）。远程分支先跑
`probeGitWorkspace`，再跑 `collectGitEntries`，两者的每一次网络调用如下：

| # | 调用 | 次数 | 落点 |
| --- | --- | --- | --- |
| 1 | `git rev-parse --is-inside-work-tree` | 1 exec | `probeGitWorkspace`（`electron/main.ts` 的 `sidebar:files-doc-list`） |
| 2 | `git rev-parse --verify -q HEAD` | 1 exec | `electron/sidebarDocView.ts` 的 `collectGitEntries` |
| 3 | `git diff --numstat -M HEAD -- <pathspec>` | 1 exec | 同上 |
| 4 | `git ls-files --others --exclude-standard -- <pathspec>` | 1 exec | 同上 |
| 5 | 每个未跟踪文件：SFTP 读**整个文件**只为 `countLines` | N | `GitCommandRunner.readFile` |
| 6 | 每个条目：SFTP `stat` 过滤已删除 | M | `GitCommandRunner.exists` |

- 第 5、6 项串行执行（`for` + `await`），网络 RTT 逐次累加。`all` 范围（pathspec 置空）
  命中面最大，放大最明显。
- 第 5 项把整份文件内容经 SFTP 传回宿主只为数行数：远端大文件（日志、生成物）单条
  就可能几十 MB。
- 第 6 项的存在性过滤只为剔除「已删除」——git 自己就能用 `--diff-filter=d` 表达同一
  事实，Core 侧实现（`core-rs/src/work_view_changes.rs` 的 `entries_against_head`）已经
  用 `--diff-filter=d` 做了同一件事，宿主侧没有跟上，于是多出 M 次往返。
- 第 1、2、3、4 项是四条独立命令，各自一次 RTT；四条之间没有依赖，可以合并成一次。
- `remoteGitRunner`（`electron/main.ts` 的 `remoteGitRunner`）跑 git 时不带
  `--no-optional-locks` / `core.untrackedCache=false` / `core.fsmonitor=false`。
  实测（Windows，临时 git 仓）：默认 `git diff --numstat -M HEAD --` 会重写
  `.git/index`，`fs.watch` 在 `.git` 上观测到 6 个事件；而变更视图开着时哨兵（`electron/sidebarDocWatch.ts`）
  正在监听该目录，于是取数自己触发一次失效、再全量重扫一遍。
- 内容口径本身没有分叉：解析、重命名归一、行数、排序在本地与远程共用同一份
  （`parseNumstat` / `parseLsFiles` / `buildDocRows`），缺陷纯粹在取数形态。

复现路径：打开一个远程（SSH）工作区 → 侧栏底部展开文件资源管理器 → 分段 switch 切到
「差异」→ 在远端工作区里造成 100 个以上改动（含若干未跟踪文件）→ 列表转圈数秒到十几秒。
对照：同一批文件在本地工作区打开时毫秒级出结果。

## 期望

1. **git 取数一次往返**：`collectGitEntries` 里的三条 git 事实
   （`rev-parse --verify -q HEAD`、`diff --numstat`、`ls-files --others`）合并为**一次**
   远程 exec，各段结果按命令序号还原；本地实现仍逐条 spawn（本地无往返成本，不经 shell）。
   `probeGitWorkspace` 保持独立一条：它的结果决定走 git 口径还是记录口径，必须先于取数。
2. **已删除过滤交给 git**：`diff` 带 `--diff-filter=d`，删除「取数后逐条 stat」这一轮。
   同一改动下 `exists` 不再参与 git 口径（记录口径仍用它）。
3. **未跟踪行数一次取回**：新增批量计行原语 `GitCommandRunner.lineCounts(rels)`。远程在
   远端机器上直接数行数（内容不出远端），一次 exec 取回全部路径的行数；本地按读盘计行。
   读不到的路径按 0 行（与现状 `content === null ? 0` 同口径）；无未跟踪文件时不发这次调用。
4. **工作区路径口径不因去掉存在性过滤而漂移**：`diff` 带 `--relative`。工作区是仓库
   子目录时 git 默认输出仓库根相对路径，去掉 `exists` 兜底后这类路径会变成打不开的行
   ——现状下它们被 `exists` 静默过滤掉，改动行整条消失。`--relative` 让 `diff` 与
   `ls-files --others` 输出同一套「工作区相对」路径（Core 侧 `entries_against_head`
   用的就是这一条）。
5. **取数不再自己触发哨兵**：每条 git 调用带 `--no-optional-locks` 与
   `core.untrackedCache=false` / `core.fsmonitor=false`。已知残留：索引 stat 信息陈旧时
   git 仍会重写一次 `.git/index`（实测，见验证记录）；本缺陷只消除可消除的那一类重写，
   不引入临时索引（那会让 `ls-files --others` 把已跟踪文件误报成未跟踪）。
6. **失败语义与结果形状不变**：`DocListResult` 仍是 `{ ok: true, mode, entries }` /
   `{ ok: false, error }`；「不在 git 仓库内」仍由 `probeGitWorkspace` 的 `'no'` 判定
   （调用方据此回落记录口径），git 失败如实带 stderr 原文，不静默空列表。

## 不变量

- 两个变更视图的行集、`+N/-M` 徽标、排序、层级铺平与本地口径逐字节一致：解析仍只有
  `parseNumstat` / `parseLsFiles` / `buildDocRows` 一份，pathspec 仍只有 `pathspecFor` 一份。
- `scope` 判别值仍只有 `'doc' | 'all'`，语义不变（`doc` = Markdown 两份 pathspec，
  `all` = `--` 之后为空）。
- 纯重命名、二进制、已删除三种行仍不进清单；未跟踪文件仍按全文行数计新增。
- 非 git 工作区的「全部变更」仍返回 `not-a-git-workspace` 提示而不是回落记录口径；
  文档视图仍回落记录口径。
- 记录口径（`collectRecordEntries` + `workspace.meta.json` 的 `modifiedDocs`）的取数与
  行数（不显示行数）不变。
- 取数仍只读：不写入工作区、不改 `.git/index`（现状里那一次重写是待消除的行为）。
  本地与远程仍共用同一份解析与组装，「远程走同一接口的 SSH exec 实现，行为一致」。
- 不新增总线事件 / 契约成员 / IPC 通道 / 落盘字段：改动全在宿主侧取数实现内部。

## 回归测试

修复的验收载体；每条一个可执行用例，先红后绿。

- **RT-1**：`collectGitEntries` 的 git 口径只发 **一次** `runBatch`（三条命令同序），
  且 `exists` / `readFile` 调用次数为 0（修复前：3 次 `run` + M 次 `exists` + N 次 `readFile`）。
  （落点：`src/test/sidebarDocView.test.ts` 的 `RT-1 git 口径：三条事实一次往返取回`）
- **RT-2**：`diff` 命令携带 `--diff-filter=d` 与 `--relative`（删除交给 git、路径保持
  工作区相对）；批处理的命令顺序固定（HEAD / diff / 未跟踪）。
  （落点：`src/test/sidebarDocView.test.ts` 的 `RT-2 diff 带 --diff-filter=d 与 --relative`）
- **RT-3**：未跟踪文件的行数由 **一次** `lineCounts` 批量给出（含读不到的路径按 0），
  不再逐文件 `readFile`；无未跟踪文件时不发这次调用。
  （落点：`src/test/sidebarDocView.test.ts` 的 `RT-3 未跟踪行数：一次批量计行`）
- **RT-4**：git 调用携带 `--no-optional-locks` 与 `core.untrackedCache=false` /
  `core.fsmonitor=false`（取数不主动写远端 `.git/index`）。
  （落点：`src/test/sidebarDocView.test.ts` 的 `RT-4 git 口径：取数命令带只读锁参数`）
- **RT-5**：不在 git 仓库 / git 失败仍走既有两条判别值（探测 `'no'` 与
  `{ ok: false, error }`），不静默空列表。
  （落点：`src/test/sidebarDocView.test.ts` 的 `RT-5 git 失败：带 stderr 原文的错误态`）
- **RT-6**：批处理脚本与输出解析是可单测的纯函数：`buildGitBatchScript` 把 N 条命令拼成
  一段 POSIX sh（每条命令的 stdout / stderr / 退出码各占一个带标记段），
  `parseGitBatchOutput` 按标记还原每段的 `code` / `stdout` / `stderr`，stdout 末尾换行
  原样保留；命令数不匹配时报错而不是错位还原。
  （落点：`src/test/sidebarDocView.test.ts` 的 `RT-6 批处理：N 条命令一段脚本，输出按标记还原`）
- **RT-7**：真实仓端到端：删除的文件不出现、未跟踪文件行数正确；工作区是仓库**子目录**
  时，改动行的路径是工作区相对（修复前该行为仓库根相对，被 `exists` 过滤后整条消失）。
  （落点：`src/test/sidebarDocViewGit.test.ts` 的 `子目录工作区：改动行的路径是工作区相对`）

## 验证记录

四列表；必须含修复前的红与修复后的绿两行。跑不了的检查写 `skipped` 或 `not-run` 并写原因，
不许编造结果；评估里列的复现路径没真跑过时只能记「部分验证」，不许记「已修」。

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 基线（修复前） | `npm run test:unit -- sidebar-doc-view` | 绿 | 21 通过 / 0 失败；`sidebarDocViewGit` 4 通过 / 1 段跳过（Windows 文件名分支） |
| 回归用例（修复前） | `npm run test:unit -- sidebar-doc-view` | 红 | `sidebarDocView` 23 通过 / 8 失败；`sidebarDocViewGit` 4 通过 / 1 失败。失败项：RT-1（`runBatch` 未被调用，实际 4 次 `run` + 2 次 `exists` + 2 次 `readFile`）、RT-2 两条（`diff` 缺 `--diff-filter=d` / `--relative`；无批处理）、RT-3（`lineCounts` 未被调用）、RT-4（缺只读锁参数）、RT-6 三条（`buildGitBatchScript` / `parseGitBatchOutput` 不存在）、RT-7（子目录工作区只列出 `new.md`，`x.md` 被存在性过滤丢掉） |
| 实测：`git diff` 是否写索引 | 临时仓 + `fs.watch(.git)` | not-run | 诊断记录：默认 `git diff --numstat -M HEAD --` 触发 6 个事件、`.git/index` 内容改变；加 `--no-optional-locks` 后 stat 新鲜时 0 事件，stat 陈旧时仍写一次。真机复测（Ubuntu 24.04 / git 2.43）见「e2e 车道（RT-4）」行 |
| 实测：远端工具可用性 | `grep -a -c ''` / `xargs -0` / `mktemp` | not-run | 诊断记录：`grep -c` 与 `countLines` 对「末行无换行 / 空文件 / CRLF」逐项同值；`-Z` 输出 `path\0count\n` |
| 实测：子目录工作区现状 | `collectGitEntries(localGitRunner(<repo>/sub))` | not-run | 诊断记录：修复前返回 `[{ path: 'new.md', plus: 1 }]`——`sub/x.md` 的改动整条消失（对应 RT-7） |
| 实测：远端单次往返 | ssh2 同一连接上串行 exec 20 次 | 绿 | **≈195ms／次**（ICMP 平均 29ms；SSH 建 exec 会话的额外开销远大于 ICMP）。旧形态 121 条未跟踪文件 × 195ms ≈ 23.6 秒，是缺陷「条目一多就慢到不可用」的量级来源 |
| 实测：远端批量计行吞吐 | 单个 12MB / 40 万行文件 | 绿 | 远端 `grep -a -c ''` 单独一条 exec 约 0.26 秒；同文件经 SFTP 拉回宿主 ≈1.4MB/s（≈8.6 秒）——这是「内容不出远端」省下的量级 |
| 回归用例（修复后） | `npm run test:unit -- sidebar-doc-view` | 绿 | `sidebarDocView` 34 通过 / 0 失败（含新增的远端拼装 3 项）；`sidebarDocViewGit` 5 通过 / 0 失败 / 1 段跳过（Windows 文件名分支，既有） |
| 批处理端到端（修复后） | `sh -c buildGitBatchScript(...)` + `parseGitBatchOutput` | 绿 | 有 HEAD 仓四段全 0 退出，stdout / stderr 各自还原且行尾换行保留；无 HEAD 仓第 0 段 `code=1`、第 1 段 `code=128` + `fatal: bad revision 'HEAD'`，第 2 段给出索引内容——单条命令失败不影响其它段 |
| 远端计行脚本（修复后） | `sh -c` 跑 `lineCounts` 那段脚本 | 绿 | 末行无换行 `2`、空文件 `0`、前导空格文件名 ` lead.md` 命中 `1`、缺失文件 `0`，与 `countLines` 同口径 |
| 变更视图取数 | `npm run test:unit -- git-file-content` | 绿 | 13 通过 / 0 失败（`GIT_COMMON_ARGS` 统一到 `sidebarDocView.ts` 唯一一份后，参数逐字断言改为按 `gitTail` 比对子命令部分） |
| 全量单测 | `npm run test:unit` | 绿 | 退出码 0 |
| 类型与风格 | `npm run check-types` / `npm run lint` | 绿 | 三份 tsconfig（含 webview / electron）与 eslint 均无输出 |
| 文档同步 | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败；`docsLintLocalOnlyPaths` 6 通过 |
| e2e 车道（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList` | 红 | 6 失败 / 1 通过（9.8 分钟）：RT-1 / RT-2 / RT-3 ×2 / RT-7 / RT-4 全红；只有「非 git 工作区」一条通过（它不取 git 口径）。失败形态是侧栏「读取失败，点击重试」——该真机同时暴露了本 spec 之外的两个缺陷（`remote-git-batch-drops-worktree-cwd` / `remote-line-counts-shifts-cwd-into-first-path`） |
| e2e 车道（修复后） | 同上 | 绿 | 7 通过 / 0 失败（1.8 分钟）。关键读数：**121 条改动的取数 = 远端 3 次调用**（`run` 1 次工作区探测 + `runBatch` 1 次 + `lineCounts` 1 次），无逐条 `readFile` / `exists`；1 条改动的取数 = 2 次调用（无未跟踪文件时不发批量计行）；121 条 1193ms vs 1 条 379ms |
| e2e 车道（RT-4 哨兵） | 同上 | 绿 | 取数前后远端 `.git/index` 的内容哈希与 mtime 完全一致（`3e61899…` / `1794572610.'.git/index'`）；`[sidebar-files] doc-list failed` 行数为 0（没有「取数 → 哨兵失效 → 全量重扫」的连环） |
| e2e 车道（RT-7 子目录） | 同上 | 绿 | 工作区 `<repo>/sub` 时 `x.md` / `new.md` 都在清单里且 `data-path` 是工作区相对；`sub/x.md` 与仓库根的 `other.md` 都不出现 |
| e2e 车道（已删除剔除） | 同上 | 绿 | 未暂存删除的 `doomed.md` 在文档与差异两个视图都不出现，同批的 `keep.md` / `new.md` / `notes.txt` 照常列出（剔除 ≠ 整批失败） |
| 实测：ElapsedTime 收益 | e2e 车道的远端调用计数（`<envPrefix>_E2E_REMOTE_GIT_OPS`） | 绿 | 修复前 121 条改动约 185 次远端往返（4 次 `run` + 60 次 `readFile` + 121 次 `exists`）；修复后恒为 3 次。计时侧：121 条 1193ms vs 1 条 379ms（差 0.8 秒，与条目数无关） |
