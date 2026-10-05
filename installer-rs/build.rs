//! 构建期载荷嵌入（docs/tui-installer.md 第 3 节）。
//!
//! 按编译目标三元组挑选 `resources/core/<arch>-<platform>/` 里的产物（Core 二进制、
//! 捆绑 ripgrep、指纹文件）与 TUI bundle（`dist/tui.mjs`），生成 `payload.rs`：
//! `include_bytes!` 把它们烧进安装器——产物缺失直接构建失败并给出补救命令。
//!
//! 目录名 / 文件名与 `scripts/build-core.mjs`、`src/config/project.json` 的根集合
//! 保持一致（`tuxedo-cat-core`、`ripgrep/rg`、`fingerprint`）；此处是 Rust 侧第二
//! 份拷贝，改名时两处同步。

use std::env;
use std::fs;
use std::path::PathBuf;

/// 三元组 → 产物目录（`resources/core/` 下的名字），与 build-core.mjs 的 TARGETS 一致
fn pkg_dir(triple: &str) -> &'static str {
    match triple {
        "x86_64-pc-windows-msvc" => "x64-win32",
        "aarch64-pc-windows-msvc" => "arm64-win32",
        "x86_64-unknown-linux-musl" => "x64-linux",
        "aarch64-unknown-linux-musl" => "arm64-linux",
        _ => panic!("不支持的安装器目标三元组：{triple}"),
    }
}

fn main() {
    let triple = env::var("TARGET").expect("cargo 必须设置 TARGET");
    let pkg = pkg_dir(&triple);
    let is_windows = triple.contains("windows");
    let ext = if is_windows { ".exe" } else { "" };

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir.parent().unwrap().to_path_buf();

    // 载荷来源可注入（测试 / 定制用），默认取仓库产物
    let payload_root = env::var("TUI_INSTALL_PAYLOAD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root.join("resources").join("core"));
    let bundle = env::var("TUI_INSTALL_BUNDLE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root.join("dist").join("tui.mjs"));
    let version =
        env::var("TUI_INSTALL_VERSION").unwrap_or_else(|_| "dev".to_string());

    let pkg_dir_path = payload_root.join(pkg);
    // (安装后相对路径, 源文件, 可执行位)
    let core_name = format!("tuxedo-cat-core{ext}");
    let entries: Vec<(String, PathBuf, bool)> = vec![
        ("tui.mjs".to_string(), bundle.clone(), false),
        (
            format!("resources/core/{pkg}/{core_name}"),
            pkg_dir_path.join(&core_name),
            true,
        ),
        (
            format!("resources/core/{pkg}/ripgrep/rg{ext}"),
            pkg_dir_path.join("ripgrep").join(format!("rg{ext}")),
            true,
        ),
        (
            format!("resources/core/{pkg}/fingerprint"),
            pkg_dir_path.join("fingerprint"),
            false,
        ),
    ];

    let mut payload = String::new();
    payload.push_str(&format!(
        "/// 目标产物目录名（resources/core/ 下）\npub const TARGET_PKG: &str = \"{pkg}\";\n\n"
    ));
    payload.push_str(&format!(
        "/// 安装器版本（构建期注入）\npub const VERSION: &str = \"{version}\";\n\n"
    ));
    payload.push_str("/// 内嵌载荷：(安装后相对路径, 字节, 可执行位)\n");
    payload.push_str("pub const FILES: &[(&str, &[u8], bool)] = &[\n");
    for (rel, source, executable) in &entries {
        if !source.is_file() {
            panic!(
                "缺少安装器载荷：{}。\n先构建对应产物：Core → `npm run build:core`（或 \
                 `npm run build:core -- --target {triple}`），TUI bundle → `npm run build:tui`。",
                source.display()
            );
        }
        // Windows 路径反斜杠在 include_bytes! 字符串里转义
        let source_literal = source.to_string_lossy().replace('\\', "/");
        payload.push_str(&format!(
            "    (\"{rel}\", include_bytes!(\"{source_literal}\"), {executable}),\n"
        ));
    }
    payload.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("payload.rs"), payload).expect("写入 payload.rs 失败");
    println!("cargo:rerun-if-env-changed=TUI_INSTALL_PAYLOAD_DIR");
    println!("cargo:rerun-if-env-changed=TUI_INSTALL_BUNDLE");
    println!("cargo:rerun-if-env-changed=TUI_INSTALL_VERSION");
}
