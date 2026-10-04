//! 构建脚本：把 `scripts/build-core.mjs` 算好的构建指纹透传给编译期环境
//! （`docs/standalone-core.md` 第 4.4 节）。
//!
//! `CORE_FINGERPRINT` 由构建脚本在调用 cargo 时设置，指纹只由源码内容与编译器身份
//! 决定；本脚本**不做任何计算**——指纹的单一事实来源在构建脚本里，这里只透传，
//! 避免同一份指纹有两处实现（`DEVELOPMENT.md` 第 12 章：一份事实只有一个写入点）。
//! `cargo:rerun-if-env-changed` 保证指纹变化（源码 / 编译器 / 三元组 / profile 变了）
//! 时重新编译；缺省时透传空值，Rust 侧取 `manual-build` 占位（见
//! `remote.rs::build_fingerprint`），只影响绕过构建脚本的手动 cargo 构建。

fn main() {
    println!("cargo:rerun-if-env-changed=CORE_FINGERPRINT");
    let fingerprint = std::env::var("CORE_FINGERPRINT").unwrap_or_default();
    println!("cargo:rustc-env=CORE_FINGERPRINT={fingerprint}");
}
