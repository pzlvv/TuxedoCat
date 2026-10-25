---
status: 已修
---

# 缺陷：`package:app:installer` 不指定平台，非 Windows 宿主上产出 Linux 桌面包并卡死打包链

`npm run package:app:installer` 调 `electron-builder` 时不带平台选择器，`electron-builder.config.js`
又只定义了 `win` 段，于是产物由**宿主平台**决定：Linux 打包机上出的是 `snap` + `AppImage`，
链尾 `verify-nsis-payload` 找不到 `setup-*.exe` 直接失败，`npm run package` 在第二段中断、
`package:tui` 不执行。发布物该出什么，与打包机是什么系统无关。

## 现状

- `package.json` 的 `package:app:installer`：

  ```text 示意
  npm run build:electron:prod && electron-builder --config electron-builder.config.js && node scripts/verify-nsis-payload.mjs
  ```

  `electron-builder` 调用**没有平台选择器**；对照同文件的 `package:app:installer:x64`
  （`electron-builder --config electron-builder.config.js --win nsis:x64`）可见显式选择器是既有写法。

- `electron-builder.config.js` 只定义 `win` 段（`target: nsis`、`arch: ['x64', 'arm64']`），
  没有 `linux` / `mac` 段；没有平台选择器时 electron-builder 按宿主平台取默认目标，Linux 上的
  默认目标是 `snap` + `AppImage`。

- `scripts/verify-nsis-payload.mjs` 无条件在 `release/` 下找 `<productName>-<version>-setup-*.exe`，
  找不到即 `exit 1`（`readdirSync` 过滤后为空的分支），没有「非 Windows 宿主就跳过」的分支。

- 复现（Linux 打包机，HEAD d0a654b，`release/` 里已清掉上次的 exe）：

  ```text 示意
  $ npm run package:app:installer
  • building        target=snap     file=release/tuxedo-cat_0.0.1_amd64.snap
  • building        target=AppImage file=release/Tuxedo Cat-0.0.1.AppImage
  [verify-nsis-payload] 在 /home/pz/git/TuxedoCat/release 下找不到 Tuxedo Cat-0.0.1-setup-*.exe
  # exit 1
  ```

  由此 `npm run package`（`package:ext && package:app:installer && package:tui`）在第二段中断。

- 同一台机器、同一份 `dist/` 上跑 `npm run package:app:installer:x64`（带 `--win nsis:x64`）
  exit 0，产出 `Tuxedo Cat-0.0.1-setup-x64.exe` 且链尾校验通过 —— 缺的只是显式平台选择器，
  不是 wine / 环境依赖（`/usr/bin/wine` 存在）。

- 影响面：README「打包」一节承诺 `npm run package` 产出「Electron 桌面安装包」并写明「只追加
  主进程打包与 NSIS 产出」；在 Linux 打包机上这条链必然中断，且失败前已经把 `snap` / `AppImage`
  写进 `release/`（分发目录里混进非发布物）。

## 期望

1. `package:app:installer` 对 `electron-builder` 显式指定 win 平台（`--win`），产物与目标集合不随
   宿主平台变化：任意宿主上都产出 `nsis` 的 x64 与 arm64 安装包，目标集合仍由
   `electron-builder.config.js` 的 `win.target` 唯一定义。
2. `npm run package` 三段在任何宿主上都能走完：`package:ext` → `package:app:installer`
   （含链尾 `verify-nsis-payload` 校验本次产出的安装包）→ `package:tui`。
3. 不产出 Linux 桌面包（`AppImage` / `snap`）：`electron-builder.config.js` 没有 linux 目标，
   宿主默认值不能凭空引入分发物。

## 不变量

- `electron-builder.config.js` 的 `win.target` 仍是 `nsis`、`arch: ['x64', 'arm64']`；
  `artifactName: '${productName}-${version}-setup-${arch}.${ext}'` 与
  `buildUniversalInstaller: false` 不变（改任一项都会改发布物命名或体积）。
- `package:app:installer:x64` 仍只出 x64（`--win nsis:x64`）。
- 链尾 `scripts/verify-nsis-payload.mjs` 保留，且「找不到安装包」仍判失败 —— 不许为让链变绿
  删掉校验或给它加「找不到就跳过」。
- `package:ext` / `package:tui` 的脚本与产物不变；`npm run package` 仍是三段 `&&` 串联。
- `release/` 之外的构建链（`build:core` / `build:webview` / `copy-assets` / `verify-core-artifacts`）
  不受影响。

## 回归测试

- **RT-1**：`package.json` 的 `package:app:installer` 里 `electron-builder` 那段调用带显式平台
  选择器 `--win`（落点：`src/test/packagingChain.test.ts` 的
  `package:app:installer 显式指定 win 平台`）。
- **RT-2**：同一脚本的链尾仍执行 `node scripts/verify-nsis-payload.mjs`，即修复不能靠删校验转绿
  （落点：`src/test/packagingChain.test.ts` 的
  `package:app:installer 链尾保留 NSIS 载荷校验`）。
- **RT-3**：`electron-builder.config.js` 把 `node_modules` 整个排除在包外时，`npmRebuild` 必须是
  `false` —— 否则非 Windows 宿主上跨架构打包会撞 `@electron/rebuild` 的 node-gyp 平台守卫
  （落点：`src/test/packagingChain.test.ts` 的
  `node_modules 不进包时关闭原生模块重建`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run compile-tests && node scripts/run-tests.mjs packaging-chain` | 红 | `FAIL package:app:installer 显式指定 win 平台`（1 通过 / 1 失败）；`electron-builder` 调用参数只有 `--config electron-builder.config.js`，无 `--win` |
| 回归用例（修复前，RT-2） | 同上 | 绿 | RT-2 是守护项（修复不许靠删链尾校验转绿），修复前本就该绿 |
| 回归用例（修复前，RT-3） | 同上 | 红 | `FAIL node_modules 不进包时关闭原生模块重建`：配置里没有 `npmRebuild`，取 electron-builder 默认 `true` |
| 回归用例（修复后，RT-1 / RT-2 / RT-3） | 同上 | 绿 | 全部通过（3 通过 / 0 失败） |
| 端到端实跑（Linux 宿主，仅加 `--win`） | `npm run package` | 红 | x64 出包；arm64 撞 `node-gyp does not support cross-compiling native modules from source`（`@electron/rebuild`，目标 `platform=win32` ≠ 宿主 `linux`），exit 1，`package:tui` 未执行。触发模块是 `ssh2` 的可选依赖 `cpu-features`；x64 当时能过只是命中了 `node_modules/cpu-features/build/Release/.forge-meta` 里遗留的 `x64--149` 标记 |
| 端到端实跑（Linux 宿主，`npmRebuild=false` 覆盖实验） | `npx electron-builder --config electron-builder.config.js --win --config.npmRebuild=false` | 绿 | 双架构出包（`setup-x64.exe` / `setup-arm64.exe`），`verify-nsis-payload` 2 包 × 34 文件全通过；日志 `skipped dependencies rebuild  reason=npmRebuild is set to false`，全程无 `executing @electron/rebuild`；没有新增 `AppImage` / `snap` |
| 干净宿主验证（挪走 `node_modules/cpu-features/build`） | 同上 | 绿 | 打包全程没有发生任何原生构建（构建后该目录仍不存在）；对照组不带覆盖时 x64 也撞同一守卫，证实「靠遗留标记」的判断 |
| 既有回归（打包边界） | `node scripts/run-tests.mjs pdb-packaging tray-sound` | 绿 | 3 + 4 项断言全通过 |
| 既有回归（文档守卫） | `node scripts/run-tests.mjs docs-lint` | 绿 | 49 项通过 |
| 静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsconfig 与 eslint 均无输出 |
| 端到端实跑（Linux 宿主，提交后 `npm run package` 全链） | `npm run package` | not-run | 待提交后在 Linux 打包机实跑：确认 exit 0、双架构安装包与 `package:tui` 三段全绿 |
