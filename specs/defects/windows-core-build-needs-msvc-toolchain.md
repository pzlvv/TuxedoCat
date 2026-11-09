---
status: 已修
---

# 缺陷：Windows x64 Core 在依赖变化后无法重建

`npm run build:core` 的 Windows 目标在依赖图变化后构建失败，报
`error occurred in cc-rs: failed to find tool "lib.exe": No such file or directory`。

## 现状

`scripts/build-core.mjs` 的 `crossToolchainEnv` 只给两类目标注入 C 工具链：

```js
const isWindowsArm64 = triple === 'aarch64-pc-windows-msvc';
if (!isLinuxTriple && !isWindowsArm64) return {};
```

Windows **x64**（`x86_64-pc-windows-msvc`）因此拿到空环境，`ring` 的 C / 汇编部分经 cc-rs
按默认路径找 MSVC 的 `lib.exe`——Linux 宿主上没有这个工具。

它此前能构建成功，是因为 `ring` 的产物已在缓存里：只要 cargo 不判定需要重编，缺陷就不会
暴露。一旦依赖图变化（本分支新增过一个只在 Linux 生效的 `target` 依赖就触发了），必然失败。

## 期望

在 Linux 宿主机上 `npm run build:core` 能把两个 Windows 目标都建出来，不依赖「缓存里恰好
有上次的 `ring` 产物」。

## 根因

Windows msvc 目标需要 Windows SDK 的 CRT 头文件（assert.h 等）与 `lib.exe`。zig 能提供
前者但不带 SDK 的库文件；`cargo-xwin` 自带整套 Windows SDK，是本机可用的路径。

## 不变量

1. Linux 目标的构建路径不变（本机 cc 直编 musl / gnu）。
2. 构建失败要如实报错，不静默产出半成品。
3. 缓存命中与否不改变成功与否。

## 回归测试

- **RT-1**：清掉 `ring` 的构建缓存后 `npm run build:core` 仍能产出两个 Windows 产物
  （落点：`scripts/build-core.mjs`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `node scripts/build-core.mjs --target x86_64-pc-windows-msvc` | 红 | `failed to find tool "lib.exe"` |
| 绕行验证（x64） | `cargo xwin build --target x86_64-pc-windows-msvc --release` | 绿 | 产物 8.5 MB，已拷进 `resources/core/x64-win32/` |
| 绕行验证（arm64） | 同上换 aarch64 | 红 | `crossToolchainEnv` 注入的 `CC` 覆盖 xwin 包装，`/imsvc` 丢参数 |
| 清环境重试（arm64） | `env -u CC_... cargo xwin build ...` | 红 | `/imsvc` 仍被当成独立参数 |
| shim 初版（`-imsvc`） | `clang ... /imsvc <dir>` | 红 | clang 22 没有 `-imsvc`，报 unknown argument |
| shim 定版（`-isystem`） | 同上 | 绿 | arm64 编译通过，60 秒完成 |
| 脚本内 arm64 | `PATH=<shim>:$PATH node scripts/build-core.mjs --target aarch64-pc-windows-msvc` | 绿 | 指纹正确烧入，产物进 `resources/core/arm64-win32/` |

## Windows arm64 的特殊约束

`ring` 0.17.14 的 `build.rs` 对「Windows + AArch64 + 非 clang」这一组合硬编码把编译器
改成 `clang`：

```rust
let compiler = if target.os == WINDOWS && target.arch == AARCH64 && !compiler.is_like_clang() {
    let _ = c.compiler("clang");
```

而 `cargo-xwin` 随后仍按 clang-cl 的口径传 `/imsvc <dir>`（两个独立参数）。普通 clang 只认
`-imsvc <dir>`，于是报 `clang: no such file or directory: '/imsvc'`。

修法是在 PATH 前面放一个 `clang` shim，只做参数重写（`/imsvc` → `-imsvc`），其余透传：

```sh
# ~/.local/bin/msvc-shim/clang
for arg in "$@"; do
  case "$arg" in
    /imsvc) pending=1 ;;
    /imsvc*) out="$out -imsvc ${arg#/imsvc}" ;;
    *) ...
  esac
done
exec /usr/bin/clang $out
```

shim 只改工具调用形式，不改 ring 的行为。它属于本机环境准备，不进仓库。

## 已知缺口

`crossToolchainEnv` 已改为让两个 Windows 目标都走 `cargo-xwin`（不再用 zig 拼 SDK）。
arm64 还需要上面那个 clang shim 才能编出来，而 shim 属于本机环境——换一台机器仍会失败。

把 shim 收进 `scripts/` 并由构建脚本自动注入 PATH，是正确的收尾方向；本次未做。
