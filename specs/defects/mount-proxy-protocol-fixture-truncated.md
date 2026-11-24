---
status: 已修
---

# 缺陷：契约 fixture 被截断，而契约测试在非 Linux 上一条都不编译

`mount-proxy-rs/fixtures/mountProxyProtocol.json` 是 Core 与常驻挂载代理之间帧契约的
唯一事实来源：两侧各有一个测试读它（Core 用 `serde_json`、代理用零依赖手写解析），任何
一侧改编码都会让另一侧立刻红。它被截断后，两侧的「契约对拍」这一整层保护同时失效。

## 现状

`specs/056` 往该文件插入三个新 op 时，把文件尾部吃掉了：内容停在 `"op": "spawn"` 一行，
JSON 到此结束（`EOF while parsing a value`，line 118）。后果分两层：

1. **CI 上红**：`contract_protocol_version_matches` 与 `request_shape_rejects_undeclared_field`
   两条用例在 `rust-tests` 分片里失败——
   `mountProxyProtocol.json 必须是合法 JSON: Error("EOF while parsing a value", line: 118, column: 0)`
   （PR #81 的 smoke run 45355922227，shard 1/4）。
2. **本机上看不出来**：`core-rs/src/mount_proxy/linux/client_tests.rs` 整个模块被
   `cfg(target_os = "linux")` 门控。Windows 开发机上 `cargo test client_tests` 的结果是
   `0 passed; 1231 filtered out` —— 一条都不编译，而退出码是 0。「本机绿」在这个模块上
   不构成任何证据。

同一类形态在 `specs/defects/mount-proxy-write-function-payload-type.md` 已经记过一次
（Core 发十六进制、代理只认枚举，两侧各自自洽而线上不通）；这次是它的镜像面：**两侧的
对拍用例都没跑，而「没跑」长得跟「通过」一样**。

## 期望

- `mountProxyProtocol.json` 是合法 JSON，含 `ping` / `version` / `probeOverlay` /
  `readFile` / `writeFile` / `listDir` / `stat` / `mkdirAll` / `gitShow` / `spawn` /
  `kill` / `renamePath` / `unlinkPath` / `readRange` 共 14 条用例，无重复 op。
- `ipcProtocolVersion` 与代理侧 `IPC_PROTOCOL_VERSION`、Core 侧同名常量三者一致（当前 2）。
- 契约测试在被门控的平台上**不应静默通过**：非 Linux 上要么不宣称覆盖，要么给出可见的
  跳过原因，不能以 `0 passed` 的形式充当绿的证据。

## 不变量

- fixture 是两个 crate 共用的唯一来源，不复制出第二份。
- 既有 11 条用例的 `request` / `expect` 形状逐字不变（追加新 op，不改老 op）。
- `IPC_PROTOCOL_VERSION` 与安装握手版本（`TC_PROTOCOL_VERSION`）继续分开，不合并。

## 回归测试

- **RT-1**：fixture 是合法 JSON、14 条用例、无重复 op。
  落点：`core-rs/src/mount_proxy/linux/client_tests.rs` 的 `contract()`（`include_str!`
  在编译期读取，JSON 坏则整个模块编不过）+ 本次提交前的 `node -e "JSON.parse(...)"` 校验。
- **RT-2**：`ipcProtocolVersion` 与两侧常量一致。
  落点：`contract_protocol_version_matches`。
- **RT-3**：两侧对拍在 Linux 目标下真实编译并通过。
  落点：`CC_x86_64_unknown_linux_musl="zig cc" cargo test --target x86_64-unknown-linux-musl --no-run`
  + `mount-proxy-rs` 的 9 条用例。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | PR #81 的 smoke run 45355922227 shard 1/4 | 红 | `EOF while parsing a value, line: 118` |
| 本机复现（修复前） | `node -e "JSON.parse(readFileSync('mount-proxy-rs/fixtures/mountProxyProtocol.json'))"` | 红 | `Expected double-quoted property name ... line 118 column 1` |
| 回归用例（修复后） | 同上 | 绿 | 14 条用例、无重复 op、`ipcProtocolVersion: 2` |
| 两侧对拍编译 | `cargo test --target x86_64-unknown-linux-musl --no-run`（zig 工具链） | 绿 | fixture 走 `include_str!`，编译期即读 |
| mount-proxy 单测 | `node scripts/test-core.mjs --manifest-path mount-proxy-rs/Cargo.toml` | 绿 | 9 passed |
| Windows 上契约测试 | `node scripts/test-core.mjs --manifest-path core-rs/Cargo.toml contract_` | skipped | 该模块 `cfg(target_os = "linux")`，Windows 上 0 条编译——本缺陷的成因之一，不当作绿的证据 |
| CI 复跑 | PR #81 的 smoke / all 车道 | not-run | 提交后由 PR 触发 |
