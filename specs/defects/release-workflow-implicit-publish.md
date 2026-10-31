---
status: 已修
---

# 缺陷：release 工作流里 electron-builder 隐式发布，缺 GH_TOKEN 时构建 job 直接失败

`.github/workflows/release.yml` 的 build job 在 GitHub Actions 里跑 `npm run package`，
electron-builder 因 CI 环境触发隐式发布，尝试把安装包直接上传到 GitHub Releases；
build job 没有 `GH_TOKEN`（发布职责在 publish job 的 `gh` CLI 上），于是抛
`GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"`
中断整条打包链。网页手动触发的 release 因此走不到 publish job。

## 现状

- `package.json` 的 `package:app:installer` / `package:app:installer:x64` 调 `electron-builder`
  时只给 `--config` 与 `--win`，不指定发布策略。
- `electron-builder.config.js` 没有 `publish` 段，provider 由 `package.json` 的
  `repository.url` 推断为 github。
- `electron-builder` 的发布管理器（app-builder-lib 的 publish 模块）：`publish` 未指定时，
  `isCI` 为真即把策略置为 `onTagOrDraft`；「当前提交不是 tag 就跳过上传」只对非 github /
  bitbucket provider 生效，github provider 仍会创建发布器，无 token 时抛配置错误。
- `.github/workflows/release.yml` 的 build job 不设置 `GH_TOKEN`；token 只出现在 publish job
  的 `gh release create/upload` 上。
- 复现：Actions → release → Run workflow（默认 draft=true），build job 在「打包」步骤失败，
  日志含 `⨯ GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"`。
- 影响面：release 工作流产不出任何发布物。本地非 CI 环境不触发隐式发布（策略保持
  undefined），所以问题只在 CI 上暴露。

## 期望

1. `npm run package`（含 `package:app` / `package:app:x64`）只把产物写进 `release/`，不做任何
   网络发布；CI 与本地行为一致。
2. 发布职责唯一落在 `.github/workflows/release.yml` 的 publish job（`gh release create/upload`）。
3. 不发布由命令行显式声明，不依赖 electron-builder 的隐式推断（该推断在 v27 移除）。

## 不变量

- 产物集合与命名不变：NSIS x64 + arm64、`.vsix`、TUI 安装器四平台；
  `artifactName: '${productName}-${version}-setup-${arch}.${ext}'` 与
  `buildUniversalInstaller: false` 不变。
- `package:app:installer` 仍显式 `--win`，`package:app:installer:x64` 仍是 `--win nsis:x64`。
- 链尾 `node scripts/verify-nsis-payload.mjs` 保留，找不到安装包仍判失败。
- `npm run package` 仍是 `package:ext && package:app:installer && package:tui` 三段串联。
- publish job 的 `permissions: contents: write` 与 `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 不变。

## 回归测试

- **RT-1**：`package:app:installer` 的 electron-builder 段带 `--publish never`
  （落点：`src/test/packagingChain.test.ts` 的 `package:app:installer 显式禁止 electron-builder 发布`）。
- **RT-2**：`package:app:installer:x64` 同样带 `--publish never`
  （落点：`src/test/packagingChain.test.ts` 的 `package:app:installer:x64 显式禁止 electron-builder 发布`）。
- **RT-3**：既有平台选择器与链尾校验断言保持绿，修复不许靠删校验转绿
  （落点：`src/test/packagingChain.test.ts` 的 `package:app:installer 显式指定 win 平台` 与
  `package:app:installer 链尾保留 NSIS 载荷校验`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1 / RT-2） | `npm run compile-tests && node scripts/run-tests.mjs packaging-chain` | 红 | 2 项失败：两条 installer 脚本的 electron-builder 参数只有 `--config ... --win [nsis:x64]`，没有 `--publish` |
| 回归用例（修复后，RT-1 / RT-2 / RT-3） | 同上 | 绿 | 5 通过 / 0 失败 |
| 端到端实跑（GitHub Actions 网页触发 release） | Actions → release → Run workflow | skipped | 需推送后人工触发；本次只有静态断言与本地测试证据 |
