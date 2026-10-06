//! 构建期载荷嵌入（docs/tui-installer.md 第 3 节）。
//!
//! 按编译目标三元组挑选 `resources/core/<arch>-<platform>/` 里的产物（Core 二进制、
//! 捆绑 ripgrep、指纹文件）与 TUI 二进制（`tui-rs` 的 release 产物），生成
//! `payload.rs`：`include_bytes!` 把它们烧进安装器——产物缺失直接构建失败并给出
//! 补救命令。
//!
//! 安装布局在构建期就定死（安装器是自解压，落点即载荷的相对路径）：
//!
//! ```text
//! <prefix>/share/<产品名>/<指纹>/tuxedo-cat-core[.exe]   # 按指纹的槽位
//! <prefix>/share/<产品名>/<指纹>/fingerprint
//! <prefix>/share/<产品名>/ripgrep/rg[.exe]               # 全部槽位共享一份
//! <prefix>/share/<产品名>/tui[.exe]                      # TUI 二进制
//! ```
//!
//! 产品名取 `src/config/project.json` 的 `core.deployPrefix`，指纹读自产物自带的
//! `fingerprint` 文件（与宿主 `readCoreFingerprint` 同一校验口径：64 位小写 hex，
//! 不合法直接构建失败——猜一个指纹会落到错误的槽位）。Core 侧以「自己所在槽位的
//! 上一级目录里的 `ripgrep`」定位共享 rg（core-rs/src/tools.rs），与这里配对。
//!
//! 三元组 → 产物目录的映射与 `scripts/build-core.mjs`、`src/config/project.json`
//! 的根集合保持一致（`tuxedo-cat-core`、`ripgrep/rg`、`fingerprint`、`tuxedo-cat-tui`）；
//! 此处是 Rust 侧拷贝，改名时各处同步。

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

/// 从 `src/config/project.json` 里取字符串字段的值（`"key": "value"`）。
///
/// 安装器保持零第三方依赖（Cargo.toml），build.rs 也不为读一个配置键引 serde：
/// 本仓库自有的 project.json 排版固定，按「定位键 → 跳过空白 → 读双引号字符串」
/// 提取足够；取不到或排版变化都直接 panic（构建期错误不静默降级）。
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
    // TUI 与安装器按同一 triple 交叉构建（scripts/build-tui-installer.mjs 负责）；
    // 宿主同三元组时回退到 `npm run build:tui` 的原生产物（无 triple 目录），
    // 让 `cargo test`（installer-rs）在常规构建后即可运行
    let tui_binary = env::var("TUI_INSTALL_TUI_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let triple_specific = repo_root
                .join("tui-rs")
                .join("target")
                .join(triple.clone())
                .join("release")
                .join(format!("tuxedo-cat-tui{ext}"));
            let host_native = repo_root
                .join("tui-rs")
                .join("target")
                .join("release")
                .join(format!("tuxedo-cat-tui{ext}"));
            let host_matches = env::var("HOST").map(|host| host == triple).unwrap_or(false);
            if triple_specific.is_file() || !host_matches {
                triple_specific
            } else {
                host_native
            }
        });
    let version =
        env::var("TUI_INSTALL_VERSION").unwrap_or_else(|_| "dev".to_string());

    // 产品名：部署布局的产品目录段（`share/<core.deployPrefix>`），与宿主
    // `coreDeployShareDirName` 同一配置来源
    let project_text = fs::read_to_string(repo_root.join("src").join("config").join("project.json"))
        .expect("读取 src/config/project.json 失败");
    let product = json_string_field(&project_text, "deployPrefix");
    let product_dir = format!("share/{product}");

    let pkg_dir_path = payload_root.join(pkg);
    // 指纹在构建期读进安装器：软链接校验与 --version 都要用，不合法直接失败
    let fingerprint = fs::read_to_string(pkg_dir_path.join("fingerprint"))
        .unwrap_or_else(|error| {
            panic!(
                "缺少安装器载荷：{}/fingerprint（{error}）。\n先构建对应产物：\
                 `npm run build:core`（或 `npm run build:core -- --target {triple}`）。",
                pkg_dir_path.display()
            )
        })
        .trim()
        .to_string();
    if !(fingerprint.len() == 64 && fingerprint.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())) {
        panic!(
            "构建指纹不合法：{}/fingerprint 必须是 64 位小写 hex，实际是「{fingerprint}」。",
            pkg_dir_path.display()
        );
    }

    // (安装后相对路径, 源文件, 可执行位)
    let core_name = format!("tuxedo-cat-core{ext}");
    let tui_name = format!("tui{ext}");
    let entries: Vec<(String, PathBuf, bool)> = vec![
        (format!("{product_dir}/{tui_name}"), tui_binary, true),
        (
            format!("{product_dir}/{fingerprint}/{core_name}"),
            pkg_dir_path.join(&core_name),
            true,
        ),
        (
            format!("{product_dir}/{fingerprint}/fingerprint"),
            pkg_dir_path.join("fingerprint"),
            false,
        ),
        (
            format!("{product_dir}/ripgrep/rg{ext}"),
            pkg_dir_path.join("ripgrep").join(format!("rg{ext}")),
            true,
        ),
    ];

    let mut payload = String::new();
    payload.push_str(&format!(
        "/// 目标产物目录名（resources/core/ 下）\npub const TARGET_PKG: &str = \"{pkg}\";\n\n"
    ));
    payload.push_str(&format!(
        "/// 安装器版本（构建期注入）\npub const VERSION: &str = \"{version}\";\n\n"
    ));
    payload.push_str(&format!(
        "/// 部署产品目录（相对安装前缀）：`share/<core.deployPrefix>`\npub const PRODUCT_DIR: &str = \"{product_dir}\";\n\n"
    ));
    payload.push_str(&format!(
        "/// 构建指纹（构建期读自产物，64 位小写 hex）\npub const FINGERPRINT: &str = \"{fingerprint}\";\n\n"
    ));
    payload.push_str(&format!(
        "/// TUI 二进制的安装后路径（相对前缀）\npub const TUI_REL: &str = \"{}/{}\";\n\n",
        product_dir, tui_name
    ));
    payload.push_str("/// 内嵌载荷：(安装后相对路径, 字节, 可执行位)\n");
    payload.push_str("pub const FILES: &[(&str, &[u8], bool)] = &[\n");
    for (rel, source, executable) in &entries {
        if !source.is_file() {
            panic!(
                "缺少安装器载荷：{}。\n先构建对应产物：Core → `npm run build:core`（或 \
                 `npm run build:core -- --target {triple}`），TUI → `npm run build:tui`。",
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
    println!("cargo:rerun-if-env-changed=TUI_INSTALL_TUI_BINARY");
    println!("cargo:rerun-if-env-changed=TUI_INSTALL_VERSION");
    // 产品名 / 指纹变化要重嵌载荷
    println!("cargo:rerun-if-changed=../src/config/project.json");
}
