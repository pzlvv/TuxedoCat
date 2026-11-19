---
status: 已修
---

# 缺陷：mount_proxy 的 6 条单测只在 Windows 或以 root 运行测试的机器上绿

`npm run test:core` 在 Linux CI runner 上对 `core-rs` 报 6 条失败（1235 通过 / 6 失败，
`test result: FAILED`），`cargo test` 以退出码 101 结束，`mount-proxy-rs` 的测试**根本没跑到**。
六条分两组，根因各自独立，都是**测试自身写错了**，产品代码的应有行为没有争议：

1. **契约对拍把帧头当普通字段**（4 条）：`assert_request_shape` 拿 fixture 的
   `request` 对象逐键去 `Frame.fields` 里找，而 `request` 里包含 `"op"`——Core 的
   `Frame` 却把 `op` 单独存一个字段、只在 `encode()` 时才写进载荷。于是每一条
   fixture 用例都必然报「缺字段 op」。
2. **落点判据用例依赖 runner 身份**（2 条）：`verify_installed` 先判属主再判模式，
   测试用临时目录造的不是 root 属主的文件，在非 root runner 上永远停在属主分支，
   断言「模式 04755」的那一步走不到。

## 现状

### 1. 契约对拍的字段集合比对漏算了帧头

`core-rs/src/mount_proxy/linux/client_tests.rs::assert_request_shape` 只遍历
`actual.fields`，而 `Frame` 的定义是：

```rs src=core-rs/src/mount_proxy/linux/client.rs
struct Frame {
    op: String,
    fields: serde_json::Map<String, serde_json::Value>,
}
```

`encode()` 才把 `op` 并进载荷对象。fixture（`mount-proxy-rs/fixtures/mountProxyProtocol.json`）
里每条 `request` 都带 `"op"`，于是四组用例一律在第一个键上 panic：

```
thread 'mount_proxy::imp::client::contract_tests::spawn_request_shape_matches_contract' panicked at
src/mount_proxy/linux/client_tests.rs:59:32:
spawn 的请求缺字段 op（Core 没发，或 fixture 过期）
```

同一测试文件里的 `kill` / `readFile` / `writeFile` 三条同样如此。按 `id` 反查同理：
`case_of("ping")` 之类用例的 `request.op` 一定存在，这一点不因 `Frame` 的表示而变。

**为什么本地全绿**：`core-rs/src/mount_proxy.rs` 用 `#[cfg(target_os = "linux")]` 摘掉整棵
Linux 实现树。Windows 开发机上这些用例根本不编译，`cargo test` 只跑 `protocol` 那一半；
CI 的 `tests` job 在 `ubuntu-latest` 上编译并执行它们，才第一次暴露。

### 2. 落点判据的两条模式用例依赖 runner 是 root

`verify_installed` 的判据顺序是「存在 → 属主 root → 模式恰好 04755」：

```rs src=core-rs/src/mount_proxy/linux/client.rs
    if meta.uid() != 0 {
        return Err(format!(
            "{} 的属主是 uid {}（要求 root），视为未部署",
            path.display(),
            meta.uid()
        ));
    }
    let mode = meta.mode() & 0o7777;
    if mode != 0o4755 {
```

`tests::slot()` 在 `std::env::temp_dir()` 下 `create_dir_all` + `write` 出一个普通文件，
它属于跑测试的那个 uid。GitHub runner 上是 uid 1001，于是：

```
thread 'mount_proxy::imp::client::tests::rejects_artifact_without_setuid_bit' panicked at
src/mount_proxy/linux/client.rs:907:9:
/tmp/tc-locate-10694-ThreadId(2432)/proxy 的属主是 uid 1001（要求 root），视为未部署
```

两条用例都断言错误文本含 `04755`，但在非 root 上先命中属主分支，文本里没有 `04755`。
本地（Windows）同样不编译这两条，所以也只有 CI 看得见。

`rejects_missing_slot` 不受影响：它走的是 `NotFound` 分支，与身份无关。

## 期望

- **契约对拍按线上形态比字段集合**：被比的「实际请求」把帧头 `op` 与 `fields` 合在一起，
  fixture 的 `request` 键与这个合集逐键比对，多一个少一个都要红。断言仍只比字段名与
  JSON 类型，不比具体值。
- **落点判据的每一条都能被独立驱动**：属主判据与模式判据各自有可执行用例，且用例的
  结论只取决于被测输入，不取决于跑测试的进程是不是 root。判据本身（存在 / root 属主 /
  恰好 04755 / 组与其他不可写）与报错文案不变——`locate()` 对外行为不受影响。
- 六条用例在 `ubuntu-latest` 上转绿，`npm run test:core` 能走到 `mount-proxy-rs` 那一段。

## 不变量

- `verify_installed` 对外契约不变：四条判据、判据顺序（属主先于模式）、错误文案里点名的
  具体信息（`uid N` / `04755` / `mode` 的八进制值）都不变。
- `locate()` 只认 `<core.mountProxyDir>/<core.mountProxyName>`，不新增任何回退分支。
- 契约 fixture 仍是两侧唯一的事实来源，位置（`mount-proxy-rs/fixtures/`）与 `include_str!`
  的落点（`client_tests.rs`，`_tests.rs` 后缀由 `isProductSourceFile` 排除）不变。
- 代理侧的同名对拍（`serve.rs::parses_every_contract_request` 等）不改语义。
- 领域行为不变：这正是「测试怎么写」层面的不一致，不涉及 FR-005b 的落点判据内容。

## 回归测试

- **RT-1**：契约对拍的字段集合包含帧头 `op`——四条 `*_request_shape_matches_contract`
  在 Linux 上通过（落点：`core-rs/src/mount_proxy/linux/client_tests.rs` 的
  `spawn_request_shape_matches_contract` / `kill_request_shape_matches_contract` /
  `read_file_request_shape_matches_contract` / `write_file_sends_hex_string_bytes`）。
- **RT-2**：对拍不是「永远绿」——Core 多一个 fixture 未声明的字段、或漏发 fixture 声明的
  字段，都必须红（落点：同文件的 `request_shape_rejects_undeclared_field` /
  `request_shape_rejects_missing_field`，两条 `#[should_panic]`）。
- **RT-3**：模式判据能独立于属主判据被驱动——非 root 属主 + 模式 04755 与
  root 属主 + 模式 0755 分别命中各自的拒绝原因（落点：`core-rs/src/mount_proxy/linux/client.rs`
  的 `tests::rejects_artifact_without_setuid_bit` / `tests::rejects_group_or_other_writable`；
  属主那一条由 `tests::rejects_non_root_owner` 单独锁住）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | CI run `44216519761` 的 `tests` job | 红 | `cargo test --manifest-path core-rs/Cargo.toml`：`1235 passed; 6 failed`，退出码 101；4 条报「缺字段 op」，2 条报「属主是 uid 1001」 |
| 本机复现 | `cargo test --manifest-path core-rs/Cargo.toml`（Windows） | not-run | Windows 上 `mount_proxy::linux` 整棵树被 `cfg` 摘掉，这些用例不编译——红只能在 Linux runner 上看到 |
| 修复后编译（Linux 目标） | `cargo check --tests --target x86_64-unknown-linux-musl`（zig 充当 C 工具链） | 绿 | 退出码 0，`Finished dev profile`；警告全是改动之前就有的 `dead_code`，新增的 `wire_fields` / `judge_installed_facts` / `proxy_slot` 无告警 |
| 代理侧既有回归 | `cargo test --manifest-path mount-proxy-rs/Cargo.toml` | 绿 | 9 条全过（`protocol` 那一半；Linux 专属用例同样不编译） |
| 格式基线 | `npm run fmt:rust:check` | 绿 | 四个 crate 的 `cargo fmt --check` 全过 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 2 组全过（本缺陷规格的章节与 status 由该守卫校验） |
| 修复后测试（Linux 执行） | CI run `44235306849` 的 `tests` job（`npm run test:core`） | 绿 | job 整体 `pass`（10m32s），`test:core` 走过 `core-rs` 并首次真正执行 `mount-proxy-rs` 那一半；同一 run 的 `docs-lint` 也 `pass` |
| 本机执行说明 | — | skipped | 本机没有可执行 Linux 二进制的环境（无 WSL 发行版、无 qemu / 容器），这 6 条用例只能由 CI 确认——因此上一行是唯一有效的执行证据 |
