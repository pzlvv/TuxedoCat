---
status: 已修
---

# 缺陷：自托管 ssh 车道用单连接下载 artifact，30MB 要 20 分钟并撞穿 job 上限

`all.yml` 的 `e2e-ssh` 车道跑在自托管 Ubuntu 测试机上，用
`actions/download-artifact@v4` 取 `e2e-artifacts`。该 action 用**单条连接**拉 blob，
而本机到 `*.blob.core.windows.net` 的单连接吞吐只有 25–31KB/s——30MB 产物要 20 分钟，
四个矩阵 job 全部撞穿 18 分钟上限，失败点落在后续步骤
（`chmod: cannot access 'dist/resources/core'`），看着像「产物没构建」。

## 现状

- 下载步骤：`.github/workflows/all.yml` 的 ssh job 里 `uses: actions/download-artifact@v4`
  （`name: e2e-artifacts`）。
- 实测吞吐（`ubuntu-e2e`，2026-11-22）：
  - 直连 `productionresultssa8.blob.core.windows.net` 的 30MB artifact：25.8KB/s
    （60s 只拉到 1.56MB）；
  - 经 banana 代理（mihomo `127.0.0.1:7890`，`mode: rule`，`DOMAIN-SUFFIX,windows.net,Domestic`
    使该域直连）：23.7KB/s；
  - 强制 `mode: global`（全走 Proxy 组）后**更慢**：13.6KB/s；
  - 代理组内逐节点实测（各 12s）：4KB/s–35KB/s，最优为新加坡 B2S 35KB/s——**加代理无效**。
- 失败表现（run `45027408803`、`45030636920`）：ssh job 在
  `Run actions/download-artifact@v4` 停 17–18 分钟，被 `timeout-minutes: 18` 杀掉；
  同 run 里 `chmod` 步骤报 `cannot access 'dist/resources/core': No such file or directory`，
  工作目录里只有 `dist/`（缺 `dist-electron` 与 `resources/core`）。
- 对照：**同一份 artifact 在 GitHub 托管 runner 上 2 秒下完**（同 run 的 `e2e-electron` job
  日志：`Total of 1 artifact(s) downloaded` → `Download artifact has finished successfully`
  共约 2s），证明慢的是这条机器到 Azure blob 的链路，不是产物本身。
- 瓶颈是**单连接**而非带宽：同一份 blob 切 N 段并发，聚合吞吐随并发线性上升
  （实测 1/4/8/16/32 路 = 25/102/204/181/363KB/s）。

## 期望

- ssh 车道改用并发分片下载：把 zip 按 Range 切成 N 段并发拉取、按序拼接、`unzip` 到工作目录，
  落盘布局与官方 action 一致（`dist` / `dist-electron` / `resources/core` 原位）。
- 并发数取 32：实测 30MB 用 165s 取完，zip 完整性校验通过，三个目录都落出来。
- 下载失败必须**立刻可见**：脚本在解压后自检三个目录，缺一个就以非零退出并指名缺哪个，
  不让失败顺延到 `chmod` 或用例收集期（那里报的是「路径不存在」，与「构建漏产物」混淆）。
- 官方 action 的其它车道（`ui` / `electron` / `tui`）不动：它们跑在 GitHub 托管 runner 上，
  下载是秒级，引入分片没有必要。

## 不变量

- 产物的**内容与形状**不变：仍是 `prepare` job 上传的同一份 `e2e-artifacts`，
  解压后 `dist` / `dist-electron` / `resources/core` 相对仓库根就位。
- `chmod -R u+x dist/resources/core resources/core` 这一步保留（已知坑 6：artifact 上传
  不保留可执行位）。
- 凭证闸门不变：`e2e-ssh` 仍关 trace、不上传 `test-results`、上传前扫明文。
- 其余车道的 job 上限与关键路径预算不变（`prepare` 8 + 车道 18 = 26 ≤ 30）。
- 矩阵仍声明为四路并行（并行度受 runner 数量约束，不由 workflow 表达）。

## 回归测试

- **RT-1**：ssh 车道用分片脚本取产物——`npm run test:unit -- e2e-ci-lane`，断言
  `all.yml` 的 ssh job 含 `node scripts/download-artifact-parallel.mjs`，且**不再有**
  `uses: actions/download-artifact@` 步骤（落点：`src/test/e2eCiLane.test.ts` 的
  「all.yml 的 ssh job 用并行分片脚本取产物」与「不再用单连接的 actions/download-artifact」）。
- **RT-2**：分片下载端到端可用——在 runner 上跑脚本取真实 artifact，ping 通 165s 内完成、
  拼接后字节数与 `size_in_bytes` 相等、`unzip -t` 通过、三个目录齐全
  （本次已在 `ubuntu-e2e` 上手工验证，见验证记录）。
- **RT-3**：CI 实证——`all` 的 `e2e-ssh` 四个 job 不再红在下载步骤，产物目录就位后
  `chmod` 与用例步骤正常进入。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run test:unit -- e2e-ci-lane` | 红 | 加断言后首跑报 `FAIL all.yml 的 ssh job 不再用单连接的 actions/download-artifact`——ssh job 里仍是官方 action |
| 吞吐实测（直连） | runner 上 `curl -r` 分片取同一 blob | 红 | 单路 12s 只拿到 25.8KB/s；30MB 推算 ≈20 分钟 > 18 分钟上限 |
| 吞吐实测（banana 代理） | 同上，`-x http://127.0.0.1:7890` | 红 | 23.7KB/s；`mode: global` 更慢（13.6KB/s）；组内逐节点 4–35KB/s |
| 吞吐实测（并发） | 1/4/8/16/32 路 Range 并发 | 绿 | 25/102/204/181/363KB/s——瓶颈是单连接 |
| 回归用例（修复后，RT-1） | `npm run test:unit -- e2e-ci-lane` | 绿 | 39 通过 / 0 失败 |
| 分片下载实跑（RT-2） | runner 上 32 路取真实 artifact + `unzip -t` + 目录自检 | 绿 | 手工等价脚本：30164384B 用 165s；拼接后字节数一致；`dist` / `dist-electron` / `resources/core` 齐全，解压后 76M |
| 分片下载实跑（RT-2，真实脚本） | runner 上在 `scripts/` 原位跑 `node scripts/download-artifact-parallel.mjs`，`ARTIFACT_DEST=/tmp/env-verify` | 绿 | `28.8MB / 86.2s = 342KB/s`；解压后三个目录自检全 OK（76M）；产物落地路径与官方 action 一致 |
| 类型与静态检查 | `npm run check-types:e2e` / `npm run lint` | 绿 | e2e 的 tsc 与 eslint 无输出 |
| CI 实证（修复前） | run `45027408803` / `45030636920` 的 ssh job | 红 | 四个 job 都停在 `download-artifact` 撞 18 分钟上限，`chmod` 报缺 `dist/resources/core` |
| CI 实证（修复后，RT-3） | 下一次 `all` run 的 `e2e-ssh` | not-run | 待推送后由 CI 复核 |
