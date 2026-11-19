---
status: 已修
---

# 缺陷：挂载代理帧协议的字节串字段解码后读不到（`bytes_field` 恒错）

`mount-proxy-rs` 的帧协议把 `Value::Bytes` 编码成十六进制字符串上线，但解码回来的
`Value::Str` 在 `bytes_field` 里不认，于是任何携带字节串的请求 / 应答读出来都是
「字段 X 不是字节串」。阶段一没有 op 用到字节串字段（挂载类请求全走字符串路径），
所以线上不触发；但它是已定型的协议面，阶段二 `readFile` / `writeFile` / `gitShow`
一接上就必然踩中。

## 现状

`mount-proxy-rs/src/protocol.rs`：

- 编码侧 `Value::Bytes` → `json_string(&hex_encode(bytes))`，线上是 hex 字符串；
- 解码侧 `parse_frame` 只产出 `Value::Str`，永远不产出 `Value::Bytes`；
- 读取侧 `bytes_field` 只匹配 `Some(Value::Bytes(..))`，其余一律
  `Err("字段 {key} 不是字节串")`。

三者拼起来：`Frame::new(..).with("bytes", Value::Bytes(..))` 编码后可正常解码，
但 `decoded.bytes_field("bytes")` 必失败。仓库里已有覆盖这条路径的单测
（`protocol::tests::roundtrip_bytes_and_escapes`），它一直是红的——只是没被执行。

**为什么没被发现**：`mount-proxy-rs/src/main.rs` 此前用 `#[cfg(target_os = "linux")]`
把整棵树（含 `mod protocol;`）都摘在 Linux 之下。Windows 开发机上
`cargo test --manifest-path mount-proxy-rs/Cargo.toml` 编译出 0 个测试并以
`test result: ok` 退出，看起来是绿的。真实执行发生在 CI（Linux）上，但
`mount-proxy-rs` 此前未挂进 `test:core`，CI 从未跑过它。

## 期望

1. `bytes_field` 能读出解码后的字节串：解码产物是 `Value::Str`（hex），
   按 hex 还原成字节；保留直接匹配 `Value::Bytes` 的分支以兼容内存中构造的帧；
   hex 非法时报错信息带上底层原因。
2. `protocol` 模块跨平台编译（它是纯 std 的编解码，不碰 unix / libc），
   使它的 8 个单测在 Windows 开发机上真实执行——整树摘掉会让 `cargo test`
   报「0 个测试 ok」，把假通过当绿。
3. `npm run test:mount-proxy` 挂进 `npm run test:core`，CI 的 tests job 覆盖它。

## 不变量

- 线上帧形状不变：长度前缀 + JSON，字节串仍是 hex 字符串（不改成别的载体）；
- 运行期 IPC 协议版本 `IPC_PROTOCOL_VERSION` 不变（这是实现补齐，不是协议变更）；
- `mount-proxy-rs` 仍是零第三方依赖、`protocol` 之外的 Linux 专属模块仍整树
  `#[cfg(target_os = "linux")]` 门控；
- 非 Linux 目标上 `main` 仍走明确失败桩（`exit 78`），不静默成功。

## 回归测试

- **RT-1**：`protocol::tests::roundtrip_bytes_and_escapes` 绿——含 `"` `\` `\n` 的
  字符串与含 `0x00` / `0xfe` / `0xff` 的字节串往返一致（落点：
  `mount-proxy-rs/src/protocol.rs` 的 `mod tests`）。
- **RT-2**：`protocol::tests::hex_roundtrip` 绿（hex 编解码本身）。
- **RT-3**：`npm run test:mount-proxy` 在 Windows 开发机上跑出 8 个测试且全绿
  （不是 0 个测试）。
- **RT-4**：`npm run test:core` 同时执行 `core-rs` 与 `mount-proxy-rs` 两套测试。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（缺陷存在） | `cargo test --manifest-path mount-proxy-rs/Cargo.toml`（`protocol` 改成跨平台后） | 红 | `roundtrip_bytes_and_escapes` 失败：`called Result::unwrap() on an Err value: "字段 bytes 不是字节串"`，7 passed / 1 failed |
| 修复后单测 | 同上 | 绿 | 8 passed / 0 failed |
| 缺陷为何长期隐形 | `cargo test`（`protocol` 仍在 linux cfg 下） | 红 | `running 0 tests` + `test result: ok`——假通过，掩盖了上面那条失败 |
| 跨平台编译 | `cargo test --manifest-path mount-proxy-rs/Cargo.toml` 后看 warning | 绿 | 零警告（`IPC_PROTOCOL_VERSION` / `write_to` 加 `cfg_attr(not(target_os = "linux"), allow(dead_code))`，因为消费方 `serve` 非 Linux 不编译） |
| Linux 目标仍可编译 | `cargo check --manifest-path mount-proxy-rs/Cargo.toml --target x86_64-unknown-linux-musl` | 绿 | `Finished dev profile` |
| 接入 test:core | `npm run test:core` | not-run | 本机缺 clang，`core-rs` 构建失败（既有环境限制，与本次改动无关）；CI 的 Linux tests job 覆盖 |
