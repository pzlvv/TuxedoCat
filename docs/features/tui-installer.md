---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：TUI 安装程序

本规格界定 TUI 版的分发与 Core 部署程序：单个自解压可执行文件，内嵌 Standalone Core、
捆绑 ripgrep 与 TUI 原生二进制（tui-rs），安装时提取到本机部署布局。TUI 自身不承担
部署（[docs/hosts/tui.md 第 2.4 节](../hosts/tui.md#24-core-产物定位tui-rssrccore_rootrs)的产物定位是它的消费方）。

交叉引用：Core 产物矩阵与指纹见 [docs/core/standalone-core.md 第 3 节](../core/standalone-core.md#3-core-形态)；
平台目标（Windows / Linux × x64 / arm64，Linux 一律 musl）沿用 `scripts/build-core.mjs` 的 `TARGETS`。

## 1. 用户场景与验收标准

- 场景 1：构建安装器
  - **AC-1**（FR-001）：GIVEN 目标平台的 Core 产物与 TUI 二进制就位 WHEN 构建该目标 THEN 产出单个自解压安装器，内嵌本平台 Core、ripgrep 与 TUI 二进制
  - **AC-2**（FR-001）：GIVEN 载荷产物缺失 WHEN 构建 THEN 构建失败并给出补救命令
  - **AC-3**（FR-002）：GIVEN 产物自带的 `fingerprint` 文件内容不是 64 位小写 hex WHEN 构建 THEN 构建失败
- 场景 2：安装与布局
  - **AC-4**（FR-002）：GIVEN 安装完成 WHEN 检查部署布局 THEN 指纹槽位内的 Core 二进制与 `fingerprint`、槽位间共享的 ripgrep、产品目录里的 TUI 二进制按布局落位
  - **AC-5**（FR-003）：GIVEN unix WHEN 安装到默认前缀 THEN `<prefix>/bin/<产品名>` 软链接可用，且升级换指纹槽位后链接目标不变、不断链
  - **AC-6**（FR-004）：GIVEN 文件内容未变 WHEN 重复安装 THEN 该文件跳过（保留可执行位）；写盘中断不留半个文件
- 场景 3：CLI
  - **AC-7**（FR-005）：GIVEN `--print-prefix` WHEN 运行 THEN 只打印默认前缀并以 0 退出；GIVEN 非法用法 WHEN 运行 THEN 以退出码 2 结束
- 场景 4：构建编排
  - **AC-8**（FR-006）：GIVEN 默认目标集合中某目标工具链缺失 WHEN 构建 THEN 跳过该目标并说明补救方式；显式 `--target` 指定该目标时严格失败

## 2. 功能需求

### FR-001：单文件自解压与平台矩阵

1. **单文件自解压**：`installer-rs/`（纯 Rust、零第三方依赖）经构建期
   `include_bytes!` 把载荷烧进安装器。产物缺失时构建失败并给出补救命令。
2. **四个目标平台**：Windows x64 / arm64（msvc）、Linux x64 / arm64（musl，
   静态链接零运行库依赖）。每个目标一个安装器，只内嵌自己平台的 Core。

### FR-002：部署布局与指纹槽位

部署布局（载荷的相对路径在构建期定死）：

```
<prefix>/share/<core.deployPrefix>/<指纹>/<core.binaryName>[.exe] + fingerprint
<prefix>/share/<core.deployPrefix>/ripgrep/rg[.exe]      # 全部指纹槽位共享一份
<prefix>/share/<core.deployPrefix>/tui[.exe]             # TUI 原生二进制（无需 Node.js）
```

指纹槽位按 Core 构建指纹隔离（多版本并存互不覆盖），ripgrep 与指纹无关、
全部槽位共享；Core 以「所在槽位的上一级目录里的 `ripgrep`」定位共享位
（core-rs/src/tools.rs 的 `ripgrep_candidates`），TUI 按同一布局定位 Core 槽位
（tui-rs/src/core_root.rs）。产品名取 `src/config/project.json` 的
`core.deployPrefix`，指纹读自产物自带的 `fingerprint` 文件（构建期校验 64 位
小写 hex，不合法直接构建失败）。

### FR-003：默认前缀与软链接

**默认前缀（应用根）`~/.local`**：产品落 `~/.local/share/<产品名>/`（XDG 数据
目录）；Windows 没有这个惯例，落在 `~/<configDir>`，加不加 PATH 由用户决定。
`--prefix <dir>` 覆盖；`<envPrefix>_TUI_ROOT` 环境变量让 TUI 找到自定义前缀。

**软链接**（unix）：安装时建 `<prefix>/bin/<core.deployPrefix>` → 产品目录里的
`tui`（相对目标 `../share/<产品名>/tui`，前缀整体挪动不断链）——TUI 升级换指纹
槽位时链接目标不变，`~/.local/bin/<产品名>` 直接可用。旧布局的拷贝或指向不同的
旧链接经临时链接 + rename 原子替换；同名目录不是本安装器建的，报错让用户处理。
Windows 无此步（符号链接要特权），直接以产品目录路径运行。

### FR-004：幂等与原子

内容未变的文件跳过（保留可执行位）；写盘走同目录临时文件 +
改名，中断不留半个文件；unix 上可执行文件统一 0755。

### FR-005：CLI 契约

```
<extensionName>-tui-installer [--prefix <dir>] [--print-prefix] [--version] [--help]
```

| 参数 | 行为 |
| --- | --- |
| （默认） | 安装到前缀（应用根，默认 `~/.local`，Windows `~/<configDir>`），逐文件打印 已安装 / 未变化，建软链接（unix），结尾给运行命令 |
| `--prefix <dir>` | 指定安装前缀（自定义前缀 + `<envPrefix>_TUI_ROOT` 组合使用） |
| `--print-prefix` | 只打印默认前缀并退出 |
| `--version` | 打印版本（构建期取包版本）、构建指纹与内嵌载荷摘要 |
| `--help` | 用法说明 |

退出码：0 成功；1 安装失败（IO 错误）；2 用法错误。

### FR-006：构建链路

```
npm run package:tui
  └─ npm run build:tui                        # tui-rs 的宿主 release 构建
  └─ node scripts/build-tui-installer.mjs     # 每个目标：
       1. Core 产物就位检查（缺则 build-core.mjs --target <triple>）
       2. cargo build --release --target <triple>（cwd=tui-rs，增量；
          不做「产物在就跳过」——TUI 无新旧标记，旧产物会被静默嵌入）
       3. cargo build --release --target <triple>（cwd=installer-rs，
          musl 的 rust-lld 配在 installer-rs/.cargo/config.toml）
       4. 复制到 <releaseDir>/tui-installer/<extensionName>-tui-installer-<pkg>[.exe]
```

- `npm run package` 链尾挂 `package:tui`（ext → app → tui）。
- 目标集合：无参 = 宿主可构建的全部四目标（msvc 目标只能在 Windows 宿主构建）；
  `--host` = 只构建当前宿主平台；`--arch <arch>` = 只构建某架构的全部平台
  （x64 / arm64，同样受宿主可构建性过滤）；`--target <triple>` = 显式指定。
- **工具链缺口显式跳过**（默认集合）：如 Windows ARM64 的 Core 交叉构建需要
  zig 充当 clang（ring 的 C 部分，见 [docs/core/standalone-core.md 第 3.3 节](../core/standalone-core.md#33-构建与目标平台)），缺失时跳过该目标并说明补救方式——打包机没装全工具链
  也能产出其余目标；显式 `--target` 时严格失败。一个都没产出则整脚本失败。
- 安装器自身是纯 Rust（无 C 依赖）：Linux musl 交叉只需 rustup 的 rust-lld
  （`rustup target add <triple>`），不需要 zig。

## 3. 行为规格

### 3.1 载荷嵌入（`installer-rs/build.rs`）

- 目标三元组 → 产物目录的映射与 `build-core.mjs` 的 `TARGETS` 一致（Rust 侧拷贝，
  改名多处同步）。
- 产品名与指纹在构建期从仓库读出并烧进载荷常量（`PRODUCT_DIR` =
  `share/<core.deployPrefix>`、`FINGERPRINT`）：读 `src/config/project.json`
  （install-rs 保持零第三方依赖，用定向字段提取，排版变化即构建失败）与产物自带
  的 `fingerprint` 文件。
- 载荷来源可用环境变量注入（测试 / 定制）：`TUI_INSTALL_PAYLOAD_DIR`（默认
  `<repo>/resources/core`）、`TUI_INSTALL_TUI_BINARY`（默认
  `<repo>/tui-rs/target/<triple>/release/standalone-tui[.exe]`）、
  `TUI_INSTALL_VERSION`（默认 `dev`；构建脚本传包版本）。
- 生成 `$OUT_DIR/payload.rs`：`FILES: &[(&str, &[u8], bool)]`（部署布局内的相对
  路径、字节、可执行位）+ 上述常量。

## 4. 边界与错误路径

- **载荷产物缺失**：构建失败并给出补救命令（AC-2）。
- **指纹不合法**：`fingerprint` 文件不是 64 位小写 hex → 构建失败（AC-3）。
- **同名目录冲突**：`<prefix>/bin/` 下的同名目录不是本安装器建的 → 报错让用户处理。
- **Windows 无软链接**：符号链接要特权，Windows 直接以产品目录路径运行。
- **工具链缺口**：默认集合跳过并说明补救；显式 `--target` 严格失败；一个都没产出整脚本失败（AC-8）。
- **退出码**：0 成功 / 1 安装失败（IO 错误）/ 2 用法错误（FR-005）。

## 5. 非目标

- TUI 自身不承担部署（其 Core 产物定位是本安装器布局的消费方）。
- Core 产物矩阵与指纹的定义在 [docs/core/standalone-core.md](../core/standalone-core.md)，本规格只消费。

## 6. 对需求基线的影响

无关联 US：安装器面向 TUI 分发场景，不在 [user-stories.md](user-stories.md) 的产品
用户故事范围内；无新增 US。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `installer-rs/build.rs` 的 `include_bytes!` 载荷生成 | e2e `e2e/tui/installer.spec.ts`（内嵌 Core `--version` 可执行） | 自动 |
| FR-002 | `installer-rs/build.rs` 的 `PRODUCT_DIR` / `FINGERPRINT` 常量与部署布局 | e2e `e2e/tui/installer.spec.ts`（部署布局 / 指纹一致性断言） | 自动 |
| FR-003 | `installer-rs` 的默认前缀与软链接逻辑 | e2e `e2e/tui/installer.spec.ts`（临时前缀安装、TUI 启动的指纹槽位候选链） | 自动 |
| FR-004 | `installer-rs` 的临时文件 + rename 原子写盘 | e2e `e2e/tui/installer.spec.ts`（幂等断言） | 自动 |
| FR-005 | `installer-rs` 的 CLI 解析 | e2e `e2e/tui/installer.spec.ts`（`--version` 与非 TTY 守卫） | 自动 |
| FR-006 | `scripts/build-tui-installer.mjs` | 无自动覆盖 + 构建编排脚本，由打包流程与人工运行验证 | 无自动覆盖 + 编排类脚本不进测试车道 |
