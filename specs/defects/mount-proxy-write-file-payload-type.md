---
status: 已修
---

# 缺陷：Overlay 会话的 Write 工具必然失败（writeFile 载荷类型不匹配）

隔离会话里调用 Write 工具，任何一次写入都失败，错误文案是
`writeFile.bytes 类型不对`。影响面是 specs/051 的 FR-007 代执行边界：隔离会话的
全部写能力（Write / Edit）都走同一个 `writeFile` 请求。

## 现状

Core 侧把字节按**十六进制字符串**编码后发出去：

```ts src=core-rs/src/mount_proxy/linux/client.rs
          "bytes".to_string(),
          serde_json::Value::String(encode_hex(bytes)),
```

代理侧的分支只匹配进程内枚举 `Value::Bytes`：

```ts src=mount-proxy-rs/src/serve.rs
        "writeFile" => match (frame.str_field("path"), frame.get("bytes")) {
            (Ok(path), Some(Value::Bytes(bytes))) => {
```

线上传过来的是 `Value::Str`（`bytes_field` 的文档里写明了这一点：
「线上形态是十六进制字符串……直接匹配 `Value::Bytes` 永远不成立」），因此
`Some(Value::Bytes(_))` 永不命中，落到 `(Ok(_), Some(other))` 那条分支，每次都回
「类型不对」。

**为什么既有测试没抓到**：`write_then_read_roundtrip` 用
`Frame::new("writeFile").with("bytes", Value::Bytes(...))` 构造请求——那是**进程内**
的枚举形态，不是线上形态。测试自洽地绕过了这个差异，而真实链路全红。

## 期望

`writeFile` 接受线上形态的十六进制字符串载荷，与 `readFile` / `gitShow` 的
`bytes` 字段解码口径一致（都用 `Frame::bytes_field`）。

## 不变量

- 二进制安全：任意字节（含 `0x00`、非法 UTF-8）原样往返；
- `writeFile` 仍然先建父目录（Write 工具建新文件的正常路径）；
- 载荷缺失或十六进制非法时回明确错误，不静默写空文件。

## 回归测试

- **RT-1**：`serve::tests::write_file_accepts_hex_string_payload`——按 Core 的实际编码
  构造帧（`Value::Str(hex)`），断言回 `ok` 且落盘字节正确。
- **RT-2**：`write_then_read_roundtrip` 保留（覆盖进程内形态）。
- **RT-3**：**双端契约对拍**——`mount-proxy-rs/fixtures/mountProxyProtocol.json` 是两侧
  共用的帧契约。Core 侧 `client_tests.rs` 的 `assert_request_shape` 锁「实际发什么」
  （字段集合 + 类型），代理侧 `parses_every_contract_request` /
  `consumes_contract_write_file_payload` 锁「吃得下」。任一侧改编码，另一侧立刻红。

  这条是本次最重要的补强：问题 1 的根因是两侧各自自洽而合起来不通，单侧测试天然
  抓不到，只有共享 fixture 能把它变成编译/测试期错误。

  **fixture 的位置不是随手放的**：`core-rs/` 的构建指纹守卫
  （`scripts/build-core.mjs` 的 `assertIncludesAreHashed`）会拦下产品源文件里指向指纹
  输入集之外的 `include*!`，而它是**文本扫描**、分不清 `#[cfg(test)]`。因此：

  - fixture 放在 `mount-proxy-rs/fixtures/`——反方向不行，Core 的 `fixtures/` 不在指纹
    输入集里，代理引用它会让「改 fixture 但不重编 Core」；
  - Core 侧的引用写在 `mount_proxy/linux/client_tests.rs`——`_tests.rs` 后缀由
    `isProductSourceFile` 整体排除，守卫因此放行。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `cargo test --target x86_64-unknown-linux-musl`（新增用例） | 红 | `write_file_accepts_hex_string_payload` 新建即红：回「类型不对」 |
| 单测（修复后） | 同上 | 绿 | 33 通过 / 0 失败（含 4 条契约用例） |
| 回归有效性（把 `bytes_field` 改回只认 `Value::Bytes`） | 同上 | 红 | 4 条相关用例同时变红：`write_file_accepts_hex_string_payload`、`consumes_contract_write_file_payload`、`consumes_contract_spawn_payload`、`roundtrip_bytes_and_escapes` |
| 真机端到端（修复前） | `python3 repro.py`（`8.136.22.171`） | 红 | `writeFile -> error 类型不对` |
| 真机端到端（修复后） | 同上 | 绿 | `writeFile -> ok`，`readFile` 读回 `written-by-write-tool` |

修复：代理侧改用 `frame.bytes_field("bytes")`，与 `readFile` 的解码口径统一。
