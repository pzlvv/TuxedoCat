//! 构建脚本：把 `src/config/project.json` 的产品身份字段烧成编译期环境变量。
//!
//! 产品名（`core.deployPrefix`）、Core 二进制名（`core.binaryName`）、配置目录名
//! （`configDir`）与环境变量前缀（`envPrefix`）在源码里一律经 `env!` 取这里烧入的值
//! ——企业版改名只动 `project.json`，Rust 侧不出现任何产品字面量
//! （`DEVELOPMENT.md` 第 12 章：同一字段的默认值只有一处）。
//!
//! `json_string_field` 与 `installer-rs/build.rs` 是同一手法的拷贝（安装器保持零
//! 第三方依赖，不为读一个配置键引 serde；此处同零依赖约束），键定位依赖
//! `project.json` 的固定排版，取不到直接 panic（构建期错误不静默降级）。

use std::env;
use std::fs;
use std::path::PathBuf;

/// 从 `src/config/project.json` 里取字符串字段的值（`"key": "value"`）。
fn json_string_field(text: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = text.find(&needle).unwrap_or_else(|| {
        panic!("src/config/project.json 缺字段 {needle}");
    });
    let rest = &text[start + needle.len()..];
    let colon = rest.find(':').unwrap_or_else(|| panic!("{needle} 后没有冒号"));
    let after = rest[colon + 1..].trim_start();
    if !after.starts_with('"') {
        panic!("{needle} 的值不是字符串");
    }
    let value_start = 1;
    let value_len = after[value_start..].find('"').unwrap_or_else(|| panic!("{needle} 的字符串没有闭合引号"));
    after[value_start..value_start + value_len].to_string()
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let project_text = fs::read_to_string(manifest_dir.join("../src/config/project.json"))
        .expect("读取 src/config/project.json 失败：tui-rs 须在仓库内构建");
    for (env_key, field) in [
        ("TC_DEPLOY_PREFIX", "deployPrefix"),
        ("TC_CORE_BINARY_NAME", "binaryName"),
        ("TC_CONFIG_DIR", "configDir"),
        ("TC_ENV_PREFIX", "envPrefix"),
    ] {
        println!("cargo:rustc-env={env_key}={}", json_string_field(&project_text, field));
    }
    println!("cargo:rerun-if-changed=../src/config/project.json");
}
