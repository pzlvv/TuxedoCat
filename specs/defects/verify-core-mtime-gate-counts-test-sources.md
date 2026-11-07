---
status: 已修
---

# 缺陷：verify-core 的 mtime 闸门把测试源码算进来，产物内容全新也被判过期

`npm run package` 的最后一道闸门 `scripts/verify-core-artifacts.mjs` 会先按文件 mtime
判断「Core 产物是否比 Rust 源码旧」。这一步的源码扫描没有排除 `_tests.rs` /
`test_support.rs` / `tests/` / `fixtures/`——只改测试文件也会把「源码最新时间」推到产物
之后，于是内容完全正确的产物被打回过期，打包链在最后一步中断。

## 现状

- **复现**：在 `main`（HEAD `fe648af`）直接跑 `npm run package`。Core 产物此前已按当前源码
  构建完成，但上一条提交 `62a0e24`（只改 `core-rs/src/shell_env_tests.rs`，给一条
  Windows 专有用例补 `#[cfg(windows)]` 守卫，未触碰产品代码）让该文件的 mtime 晚于
  `resources/core/x64-win32/tuxedo-cat-core.exe`。
- **失败输出**：

  ```
  [verify-core] 打包要携带的 Core 产物不合格：
    - resources/core/x64-win32/tuxedo-cat-core.exe 比 Rust 源码旧（源码 2026-11-06T22:59:01.721Z，
      产物 2026-11-06T20:55:16.018Z）；重新构建：npm run build:core
  ```

- **产物其实是最新的**：该产物烧录的构建指纹是 `f6e9974c73523a003dbb7da85881a1649b89f8810a058689b3da4b70f1dfd5f5`，
  与当前源码重算的 `computeFingerprint('x86_64-pc-windows-msvc', 'release')` 逐位一致。
  内容判据（指纹）能过，时间判据（mtime）却先把这次检查 `continue` 掉了——指纹那一关根本没跑到。
- **根因**：`sourceMtime` 的计算是

  ```js
  Math.max(...RUST_SOURCES.map((entry) => newestMtime(join(repoRoot, entry), isProductSourceFile)))
  ```

  `isProductSourceFile` 作为 `include` 回调只作用于**目录展开后的文件**；`RUST_SOURCES` 里
  `core-rs/src` 是目录能过滤，但 `core-rs/Cargo.toml` / `core-rs/Cargo.lock` 是文件，走
  `newestMtime` 的非目录分支直接返回 mtime、不过 `include`——这与本缺陷无关，真正的问题是
  该 `include` 过滤对目录内的 `_tests.rs` 生效、**却仍把产品源码与测试源码混在一起取最大值**，
  使「改测试」等价于「改产品」。同一进程里带的 `isProductSourceFile` 本身口径是对的
  （排除 `_tests.rs` / `test_support.rs` / `tests/` / `fixtures/` / cargo 产物目录），
  问题在于 mtime 闸门把两种源码视为一体。
- **影响面**：只在「改过测试文件、未重建 Core」时触发，`npm run package` /
  `npm run package:app` 会直接失败；`npm run build:core`（重建）能绕过，但代价是几分钟的
  全平台交叉编译，而产物内容根本没变。

## 期望

- mtime 闸门只在**产品源码**（参与构建指纹同一口径：`isProductSourceFile` 为真）比产物新时
  报错；只改测试文件不触发。
- 内容判据（构建指纹重算）保持不变且仍是最终裁决：mtime 只是快速诊断，给出「源码改在什么
  时候、该跑哪条重建命令」。
- 失败提示仍然点明具体产物路径与重建命令，不因为放宽而丢掉可操作性。

## 不变量

- 构建指纹的算法与输入集（`computeFingerprint` / `collectCoreSourceFiles` /
  `isProductSourceFile`）不变，已有产物指纹不失效。
- 真的改了产品源码而未重建时，mtime 闸门仍然报错（放宽不等于失效）。
- 指纹重算那一关的判据与报错文案不变。
- `dist/resources/` 副本与 `resources/` 原件的一致性检查不变。

## 回归测试

- **RT-1**：只把某个 `_tests.rs` 的 mtime 推到产物之后，mtime 闸门不报该产物过期
  （落点：`src/test/coreFingerprint.test.ts` 的「RT-1：只改测试文件不推高源码最新时间」）。
- **RT-2**：把某个产品源码文件（如 `core-rs/src/main.rs`）的 mtime 推到产物之后，mtime 闸门
  仍然报错（同一文件内，确保 RT-1 的放宽没有把判据改废；落点同上的「RT-2：产品源码仍然
  计入源码最新时间」）。
- **RT-3**：`sourceMtime` 的扫描根与 `isProductSourceFile` 同源（从 `build-core.mjs` 导入，
  不自带第二份过滤），并由既有断言继续锁定。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `npm run package` | 红 | `[verify-core] resources/core/x64-win32/tuxedo-cat-core.exe 比 Rust 源码旧`，而该产物指纹与源码重算值一致 |
| 回归用例（修复前） | `npm run test:unit -- core-fingerprint` | 红 | `FAIL verify-core-artifacts 导出 productSourceMtime`，26 通过 / 1 失败 |
| 回归用例（修复后） | `npm run test:unit -- core-fingerprint` | 绿 | 30 通过 / 0 失败（RT-1 / RT-2 逐条通过） |
| 闸门本体（修复后） | `node scripts/verify-core-artifacts.mjs` | 绿 | `产物齐全且比 Rust 源码新（profile release）：x64-win32 / arm64-win32 / x64-linux / arm64-linux` |
| 端到端复跑（修复后） | `npm run package` | 绿 | 退出码 0；VSIX 41.94 MB / 两个 NSIS 安装包 / 两个 TUI 安装器全部产出，`[verify-nsis-payload] 全部通过（2 个安装包）` |
