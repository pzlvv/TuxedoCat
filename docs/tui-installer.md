# 规格：TUI 安装程序

> TUI 版的分发与 Core 部署程序：单个自解压可执行文件，内嵌 Standalone Core、
> 捆绑 ripgrep 与 TUI bundle，安装时提取到用户目录。TUI 自身不承担部署
> （`docs/tui.md` 第 2.4 节的产物定位是它的消费方）。

本规格界定安装程序的能力、安装布局、CLI 与构建链路。Core 产物矩阵与指纹见
`docs/standalone-core.md` 第 4 节；平台目标（Windows / Linux × x64 / arm64，Linux
一律 musl）沿用 `scripts/build-core.mjs` 的 `TARGETS`。

---

## 1. 能力

1. **单文件自解压**：`installer-rs/`（纯 Rust、零第三方依赖）经构建期
   `include_bytes!` 把载荷烧进安装器：`dist/tui.mjs`（TUI bundle）+
   `resources/core/<arch>-<platform>/` 三件套（`tuxedo-cat-core[.exe]`、
   `ripgrep/rg[.exe]`、`fingerprint`）。产物缺失时构建失败并给出补救命令。
2. **四个目标平台**：Windows x64 / arm64（msvc）、Linux x64 / arm64（musl，
   静态链接零运行库依赖）。每个目标一个安装器，只内嵌自己平台的 Core。
3. **安装布局与 Electron 应用一致**：`<prefix>/tui.mjs` +
   `<prefix>/resources/core/<pkg>/…`——TUI 沿用 `resolveCoreBinary(extensionPath)`
   的同一搜索路径，安装后 `node <prefix>/tui.mjs` 直接可用（需要 Node ≥ 18）。
4. **幂等与原子**：内容未变的文件跳过（保留可执行位）；写盘走同目录临时文件 +
   改名，中断不留半个文件；unix 上可执行文件统一 0755。
5. **默认前缀 `~/.tuxedo-cat/tui`**（`src/config/project.json` 的 `configDir`）；
   `--prefix <dir>` 覆盖，`TUXEDO_CAT_TUI_ROOT` 环境变量让 TUI 找到自定义前缀。

## 2. CLI

```
tuxedo-cat-tui-installer [--prefix <dir>] [--print-prefix] [--version] [--help]
```

| 参数 | 行为 |
| --- | --- |
| （默认） | 安装到前缀（默认 `~/.tuxedo-cat/tui`），逐文件打印 已安装 / 未变化，结尾给运行命令 |
| `--prefix <dir>` | 指定安装前缀（自定义前缀 + `TUXEDO_CAT_TUI_ROOT` 组合使用） |
| `--print-prefix` | 只打印默认前缀并退出 |
| `--version` | 打印版本（构建期取包版本）与内嵌载荷摘要 |
| `--help` | 用法说明 |

退出码：0 成功；1 安装失败（IO 错误）；2 用法错误。

## 3. 载荷嵌入（`installer-rs/build.rs`）

- 目标三元组 → 产物目录的映射与 `build-core.mjs` 的 `TARGETS` 一致（Rust 侧第二份
  拷贝，改名两处同步）。
- 载荷来源可用环境变量注入（测试 / 定制）：`TUI_INSTALL_PAYLOAD_DIR`（默认
  `<repo>/resources/core`）、`TUI_INSTALL_BUNDLE`（默认 `<repo>/dist/tui.mjs`）、
  `TUI_INSTALL_VERSION`（默认 `dev`；构建脚本传包版本）。
- 生成 `$OUT_DIR/payload.rs`：`FILES: &[(&str, &[u8], bool)]`（相对路径、字节、
  可执行位）。

## 4. 构建链路

```
npm run package:tui
  └─ npm run build:tui                        # dist/tui.mjs（ESM bundle）
  └─ node scripts/build-tui-installer.mjs     # 每个目标：
       1. Core 产物就位检查（缺则 build-core.mjs --target <triple>）
       2. TUI bundle 就位检查（缺则 tui/esbuild.js）
       3. cargo build --release --target <triple>（cwd=installer-rs，
          musl 的 rust-lld 配在 installer-rs/.cargo/config.toml）
       4. 复制到 <releaseDir>/tui-installer/tuxedo-cat-tui-installer-<pkg>[.exe]
```

- `npm run package` 链尾挂 `package:tui`（ext → app → tui）。
- 目标集合：无参 = 宿主可构建的全部四目标（msvc 目标只能在 Windows 宿主构建）；
  `--host` = 只构建当前宿主平台；`--target <triple>` = 显式指定。
- **工具链缺口显式跳过**（默认集合）：如 Windows ARM64 的 Core 交叉构建需要
  clang（ring 的 C 部分），缺失时跳过该目标并说明补救方式——打包机没装全工具链
  也能产出其余目标；显式 `--target` 时严格失败。一个都没产出则整脚本失败。
- 安装器自身是纯 Rust（无 C 依赖）：Linux musl 交叉只需 rustup 的 rust-lld
  （`rustup target add <triple>`），不需要 zig。

## 5. 测试

- e2e：`e2e/tui/installer.spec.ts`（playwright project `tui-installer`）——构建宿主
  安装器 → 临时前缀安装 → 布局 / 指纹一致性 / 幂等断言 → 内嵌 Core `--version`
  可执行 → 安装目录里的 `tui.mjs` 可启动（`--version` 与非 TTY 守卫，后者同时
  验证从安装位置解析 Core 产物的候选链）。
- 前置产物：`npm run build:core`（宿主平台）；darwin 等无产物平台整文件跳过。
