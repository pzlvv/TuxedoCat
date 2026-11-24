---
status: 已修
---

# 缺陷：产物缓存跨文件系统 rename 失败，ssh 四条矩阵 job 全红在取产物

`all` 的 `e2e-ssh` 车道在自托管 runner 上用 `scripts/download-artifact-parallel.mjs`
取 `e2e-artifacts`。脚本把产物解压到系统临时目录（Linux 上的 `/tmp`），再
`renameSync` 到 `runner.workspace` 下的 `.e2e-artifacts-cache` 槽位。这两个路径在 CI 上
不是同一个挂载点，`rename` 被内核拒为 `EXDEV`，四个矩阵 job 全部倒在「并行取 e2e 产物」
这一步——**用例一条都没跑**。第一个 job 失败意味着缓存没落盘，后三个 job 又各自重下一份
再撞同一处，等于把同一个失败重复四次。

## 现状

- run `45292363880` 的四个 `e2e-ssh` job 都红在同一行（job ID 138105468834 /
  138105468908 / 138105468952 / 138105468981）：

  ```
  [download] 完成 28.8MB / 8.7s = 3384KB/s
  [download] 失败：EXDEV: cross-device link not permitted,
    rename '/tmp/artifact-44j1xO/run-45292363880-1-e2e-artifacts'
        -> '<runner.workspace>/.e2e-artifacts-cache/run-45292363880-1-e2e-artifacts'
  ##[error]Process completed with exit code 1.
  ```

  同 run 的 `e2e-ui` / `e2e-electron` / `e2e-tui` 与 `smoke` 全绿，失败面只有这条车道。
- 源码位置：`scripts/download-artifact-parallel.mjs` 的 `main()`——解压目录由
  `mkdtempSync(join(tmpdir(), 'artifact-'))` 创建，随后
  `renameSync(unpacked, slot)` 把它搬进 `ARTIFACT_CACHE_DIR`（`.github/workflows/all.yml`
  的 ssh job 设为 `${{ runner.workspace }}/.e2e-artifacts-cache`）。
- 触发条件与产物大小、并发数、网络都无关：只要 `os.tmpdir()` 与
  `ARTIFACT_CACHE_DIR` 不在同一个文件系统上就必现。自托管机器的 `/tmp` 是独立的
  tmpfs / overlay，工作区在另一层，因此是**必现**而不是偶发。
- 不设 `ARTIFACT_CACHE_DIR` 时脚本直接解压到 `ARTIFACT_DEST`，不经过 `rename`，
  所以本地复现与首版分片下载（run `45046252618`）都看不到这个问题；缺陷是随
  「同 run 后三个 job 复用本地产物缓存」引入的。
- 引入点：`main` 上的脚本用
  `spawnSync('unzip', [..., '-d', dest])` 直接解进工作目录，没有 `renameSync`，
  `all.yml` 里也没有 `ARTIFACT_CACHE_DIR`；两者都由 PR #80（「ssh 产物跨 job 复用」）
  加上（`git log -S'renameSync(unpacked, slot)'` 唯一命中该提交）。该提交落进 `main`
  之前的 `all` run（`45226713502` 的四个 ssh job）日志里 `EXDEV` 出现 0 次。
- 同源的旁证：`specs/defects/subagent-abort-reports-no-cancel-notice.md` 的验证记录里
  记过本机 `resources/core` 与暂存路径不同盘的 `EXDEV`——同一类「假设 rename 跨得过去」
  的写法。

## 期望

- 解压目录与缓存槽位在**同一个文件系统**上：要落缓存时，临时工作目录建在
  `ARTIFACT_CACHE_DIR` 之内，`rename` 才是同盘原子操作；不落缓存（无
  `ARTIFACT_CACHE_DIR`）时保持解压到 `ARTIFACT_DEST`，不引入多余的搬运。
- 与现状的差异逐条：
  1. 临时解压目录的位置由 `os.tmpdir()` 改为缓存目录内（仅在有缓存目录时）；
  2. 解压后的自检（三个必备目录）与「换 run 不命中」「槽位不完整不复用」的判据不变；
  3. 落盘布局不变：`dist` / `dist-electron` / `resources/core` 相对仓库根就位；
  4. 失败必须仍然立刻可见：脚本以非零退出并打印具体错误，不把错误顺延到 `chmod`。
- 缓存命中路径本来就不做 `rename`（`cpSync` 搬三个目录），跨盘可用，不参与本次修复。

## 不变量

- 缓存键仍是 `run-<runId>-<attempt>-<artifactName>`：换 run / 重跑不拿到旧产物。
- 复用判据仍是「三个必备目录齐全」，被打断的半份目录不被当成可用产物。
- 任一步失败都以非零退出并指名原因。
- 产物内容与形状不变（同一份 `e2e-artifacts`，解压后三个目录原位）。
- `e2e-ci-lane` 的 RT-15（ssh job 用分片脚本、不用 `actions/download-artifact`）继续成立。
- 不设 `ARTIFACT_CACHE_DIR` 的车道（本机手工跑、`ARTIFACT_DEST` 直解）行为不变。

## 回归测试

编号与 `src/test/artifactCache.test.ts` 里的 `RT-n` 注释一致（该文件既有的 RT-1～RT-3
钉缓存键与复用判据，本条缺陷的用例从 RT-4 起）。

- **RT-4**：跨文件系统拓扑下取产物仍成功——`ARTIFACT_CACHE_DIR` 与解压临时目录不在
  同一文件系统时，脚本必须成功退出、三个目录落到 `ARTIFACT_DEST` 且内容是本次下载的
  产物（落点：`src/test/artifactCache.test.ts` 的「缓存目录与临时目录不同文件系统时脚本
  仍成功退出」与「跨文件系统时三个必备目录都落到 ARTIFACT_DEST」）。
- **RT-5**：同一拓扑下后一个 job 复用缓存——第二次运行打印「复用本地缓存」并把三个
  目录搬进新的 `ARTIFACT_DEST`（落点：同文件的「跨文件系统写入的槽位可被后续 job 复用」
  与「复用时日志点名复用本地缓存」）。修复不许靠「干脆不落缓存」绕过跨盘问题。
- **RT-6**：暂存目录不留残渣——下载成功与自检失败两条路径都不在
  `<cache>/.staging` 留目录（落点：同文件的「下载成功后暂存目录不留残渣」「自检失败后
  暂存目录同样不留残渣」）。暂存目录搬进了持久路径，漏清就会把 runner 的盘吃满。
- **RT-7**：过期暂存目录被清掉、正在用的不被误删（落点：同文件的「过期暂存目录被清掉」
  「正在区间内的暂存目录不被误删」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| CI 实证（修复前） | run `45292363880` 的四个 `e2e-ssh` job | 红 | 四个 job 都停在「并行取 e2e 产物」：`EXDEV: cross-device link not permitted, rename '/tmp/artifact-*/<slot>' -> '<runner.workspace>/.e2e-artifacts-cache/<slot>'` |
| 回归用例（修复前） | `npm run test:unit -- artifactCache` | 红 | 5 项失败，首条 `FAIL 缓存目录与临时目录不同文件系统时脚本仍成功退出`；stderr 为 `[download] 失败：EXDEV: cross-device link not permitted, rename '<tmp>/artifact-FjrKyH/run-990003-1-e2e-artifacts' -> '<cache>/run-990003-1-e2e-artifacts'`——与 CI 现场同一行 |
| 回归用例（修复后） | `npm run test:unit -- artifactCache` | 绿 | 17 通过 / 0 失败（含既有 RT-1～RT-3） |
| 变异验证（RT-6 / RT-7 有效性） | 删掉 `pruneStale(stagingRoot)` 调用后重跑 | 红 | `FAIL 过期暂存目录被清掉`——清理逻辑被移除时用例确实变红 |
| 变异验证（RT-4 / RT-5 有效性） | 把暂存目录改回 `os.tmpdir()` 后重跑 | 红 | `FAIL 缓存目录与临时目录不同文件系统时脚本仍成功退出`，stderr 为 CI 现场的同一行 `EXDEV` |
| 无缓存车道回归 | `ARTIFACT_DEST` 直解（不带 `ARTIFACT_CACHE_DIR`）跑脚本 | 绿 | 仍解压到 `ARTIFACT_DEST`、不经 `rename`，日志照旧打印「解压完成」；`<cache>/.staging` 为空 |
| 失败路径回归 | 夹具造缺 `resources/core` 的产物 | 绿 | 以非零退出并打印「解压后缺少 dist / dist-electron / resources/core」，暂存目录已清空 |
| 类型与静态检查 | `npm run check-types` / `npm run lint` | 绿 | tsc（含 webview / electron）与 eslint 无输出 |
| 文档守卫 | `node scripts/run-tests.mjs docsLint docsLintLocalOnlyPaths brandLiteral` | 绿 | 49 / 7 / 12 全通过 |
| 全量单测 | `npm run test:unit` | 部分验证 | 与本次改动相关的文件全绿；`e2eProcessTeardown` / `pdbPackaging` / `traySoundAssets` 在本机干净基线上同样红（`npm -v` 不可用、进程回收时序），与本次改动无关 |
| CI 实证（修复后） | 待下一次 `all` run | not-run | 本地无法驱动自托管 runner 的真实挂载拓扑；以脚本级复现（RT-4）替代 |
