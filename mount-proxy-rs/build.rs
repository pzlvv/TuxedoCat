//! 构建脚本：把 `src/config/project.json` 的代理身份与协议版本烧成编译期环境变量。
//!
//! 代理名（`mountProxyName`）、安装落点（`mountProxyDir`）在源码里一律经 `env!` 取
//! 这里的值——产品改名 / 换落点只动 `project.json`，Rust 侧不出现产品字面量
//! （`docs/hosts/product-identity.md` 第 2 节）。
//!
//! `json_string_field` 与 `core-rs/build.rs` 是同一手法的拷贝：本 crate 保持零第三方
//! 依赖（要带 setuid 位跑，依赖面越小越好），不为读两个配置键引 serde。

use std::env;
use std::fs;
use std::path::PathBuf;

/// 安装握手协议版本（specs/051 FR-005「协议版本握手」）。
///
/// 与运行期 IPC 版本（`protocol.rs` 的 `IPC_PROTOCOL_VERSION`）**分开**：前者回答
/// 「装的那份代理能不能被这个 Core 用」，后者回答「运行期帧语义是否兼容」。改代理的
/// 前置语义必须递增该值。
const PROTOCOL_VERSION: u32 = 1;

/// 从 `src/config/project.json` 里取字符串字段的值（`"key": "value"`）。
fn json_string_field(text: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = text.find(&needle).unwrap_or_else(|| {
        panic!("src/config/project.json 缺字段 {needle}");
    });
    let rest = &text[start + needle.len()..];
    let colon = rest
        .find(':')
        .unwrap_or_else(|| panic!("{needle} 后没有冒号"));
    let after = rest[colon + 1..].trim_start();
    if !after.starts_with('"') {
        panic!("{needle} 的值不是字符串");
    }
    let value_start = 1;
    let value_len = after[value_start..]
        .find('"')
        .unwrap_or_else(|| panic!("{needle} 的字符串没有闭合引号"));
    after[value_start..value_start + value_len].to_string()
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let project_text = fs::read_to_string(manifest_dir.join("../src/config/project.json"))
        .expect("读取 src/config/project.json 失败：mount-proxy-rs 须在仓库内构建");
    for (env_key, field) in [
        ("TC_MOUNT_PROXY_NAME", "mountProxyName"),
        ("TC_MOUNT_PROXY_DIR", "mountProxyDir"),
    ] {
        println!(
            "cargo:rustc-env={env_key}={}",
            json_string_field(&project_text, field)
        );
    }
    println!("cargo:rustc-env=TC_PROTOCOL_VERSION={PROTOCOL_VERSION}");
    println!("cargo:rerun-if-changed=../src/config/project.json");
    println!("cargo:rerun-if-changed=build.rs");
}
