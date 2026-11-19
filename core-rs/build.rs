//! 构建脚本（`docs/core/standalone-core.md` 第 3.4 节）：
//!
//! 1. 把 `scripts/build-core.mjs` 算好的构建指纹透传给编译期环境：`CORE_FINGERPRINT`
//!    由构建脚本在调用 cargo 时设置，指纹只由源码内容与编译器身份决定；本脚本
//!    **不做任何计算**——指纹的单一事实来源在构建脚本里，这里只透传，避免同一份
//!    指纹有两处实现（``docs/architecture/principles.md`：一份事实只有一个写入点）。
//!    `cargo:rerun-if-env-changed` 保证指纹变化（源码 / 编译器 / 三元组 / profile
//!    变了）时重新编译；缺省时透传空值，Rust 侧取 `manual-build` 占位（见
//!    `remote.rs::build_fingerprint`），只影响绕过构建脚本的手动 cargo 构建。
//! 2. 把 `src/config/project.json` 的产品身份字段烧成编译期环境变量（`TC_*`）：
//!    产品显示名 / 扩展名 / 配置目录名 / 后台任务输出目录名 / 输出上限的环境变量名。
//!    运行期代码经 `env!` 取值，源码不出现产品字面量——企业版改名只动 project.json（与
//!    tui-rs/build.rs、installer-rs/build.rs 同一口径）。`json_string_field` 是
//!    同一手法的拷贝（零第三方依赖，不为读一个配置键引 serde），取不到直接 panic。

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

/// 从 `src/config/project.json` 里取数字字段的值（`"key": 42`）。
///
/// 与 `json_string_field` 同一手法（零第三方依赖，取不到直接 panic）：代理协议版本是
/// 数字而不是字符串，字符串辅助函数在这里会把值读成空串。
fn json_number_field(text: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = text.find(&needle).unwrap_or_else(|| {
        panic!("src/config/project.json 缺字段 {needle}");
    });
    let rest = &text[start + needle.len()..];
    let colon = rest
        .find(':')
        .unwrap_or_else(|| panic!("{needle} 后没有冒号"));
    let after = rest[colon + 1..].trim_start();
    let value: String = after.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if value.is_empty() {
        panic!("{needle} 的值不是数字");
    }
    value
}

fn main() {
    println!("cargo:rerun-if-env-changed=CORE_FINGERPRINT");
    let fingerprint = std::env::var("CORE_FINGERPRINT").unwrap_or_default();
    println!("cargo:rustc-env=CORE_FINGERPRINT={fingerprint}");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let project_text = fs::read_to_string(manifest_dir.join("../src/config/project.json"))
        .expect("读取 src/config/project.json 失败：core-rs 须在仓库内构建");
    for (env_key, field) in [
        ("TC_PRODUCT_NAME", "productName"),
        ("TC_EXTENSION_NAME", "extensionName"),
        ("TC_CONFIG_DIR", "configDir"),
        ("TC_TMP_TASK_DIR_NAME", "tmpTaskDirName"),
        ("TC_ENV_MAX_OUTPUT_TOKENS", "envMaxOutputTokens"),
        // Overlay 挂载代理（specs/051 FR-005）：产物名与安装落点的唯一来源是
        // `project.json`，Core 侧定位代理时经这两个常量取值，不写产品字面量。
        ("TC_MOUNT_PROXY_NAME", "mountProxyName"),
        ("TC_MOUNT_PROXY_DIR", "mountProxyDir"),
    ] {
        println!(
            "cargo:rustc-env={env_key}={}",
            json_string_field(&project_text, field)
        );
    }
    // 代理的**安装握手协议版本**（specs/051 FR-005「协议版本握手」）：与运行期 IPC 版本
    // 分开——前者回答「装的那份代理能不能被这个 Core 用」，后者回答「运行期帧语义是否
    // 兼容」。唯一来源是 `project.json`，代理侧也在它自己的 build.rs 里读同一个键。
    println!(
        "cargo:rustc-env=TC_MOUNT_PROXY_PROTOCOL_VERSION={}",
        json_number_field(&project_text, "mountProxyProtocolVersion")
    );
    println!("cargo:rerun-if-changed=../src/config/project.json");
}
