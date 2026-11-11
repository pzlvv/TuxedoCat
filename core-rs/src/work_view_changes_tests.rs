//! `work_view_changes` 的纯解析用例（specs/047 FR-001）。
//!
//! 只驱动不依赖命名空间的部分：`-z` 输出的分段与过滤、行数口径。真正在视图里跑 git 的
//! 用例在 `work_view_tests.rs`（需要 `unshare` + overlay）。
//!
//! 模块路径：本文件由 `work_view.rs` 里的 `git_view` 模块以 `#[path]` 引入，`super` 即
//! 该模块。

use super::{count_lines, parse_numstat_z, parse_paths_z, ChangeScope};

/// 普通条目：`<add>\t<del>\t<path>\0`
#[test]
fn parses_plain_numstat_entries() {
    let entries = parse_numstat_z("1\t1\tf.txt\0003\t0\tsrc/a.ts\0");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].path, "f.txt");
    assert_eq!((entries[0].plus, entries[0].minus), (1, 1));
    assert_eq!(entries[1].path, "src/a.ts");
    assert_eq!((entries[1].plus, entries[1].minus), (3, 0));
}

/// 重命名：`<add>\t<del>\t\0<old>\0<new>\0` —— 取新名。
#[test]
fn parses_renamed_entries_with_new_path() {
    let entries = parse_numstat_z("2\t1\t\0old.txt\0new.txt\0");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "new.txt");
    assert_eq!((entries[0].plus, entries[0].minus), (2, 1));
}

/// 纯重命名（0/0）不显示：与宿主 `parseNumstat` 同口径。
#[test]
fn drops_pure_renames() {
    assert!(parse_numstat_z("0\t0\t\0a.txt\0b.txt\0").is_empty());
    assert!(parse_numstat_z("0\t0\tsame.txt\0").is_empty());
}

/// 二进制条目（`-\t-`）跳过：行数没有意义。
#[test]
fn drops_binary_entries() {
    assert!(parse_numstat_z("-\t-\tlogo.png\0").is_empty());
}

/// 文件名允许首尾空格与中文——原样保留，不 trim、不转义。
#[test]
fn keeps_spaces_and_unicode_in_paths() {
    let entries = parse_numstat_z("1\t0\t lead.txt\0001\t0\t中文.txt\0");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].path, " lead.txt");
    assert_eq!(entries[1].path, "中文.txt");
}

/// 畸形条目（非数字行数）跳过而不是把整个清单打成错误。
#[test]
fn skips_malformed_entries() {
    assert!(parse_numstat_z("x\ty\tf.txt\0").is_empty());
    assert!(
        parse_numstat_z("1\t1\0").is_empty(),
        "缺路径的重命名条目应跳过"
    );
}

/// `ls-files -z`：每段一个路径，空段丢弃。
#[test]
fn parses_nul_separated_paths() {
    assert_eq!(parse_paths_z("a.txt\0b/c.md\0"), vec!["a.txt", "b/c.md"]);
    assert_eq!(
        parse_paths_z("a b.txt\0中文.md\0"),
        vec!["a b.txt", "中文.md"]
    );
    assert!(parse_paths_z("").is_empty());
}

/// 行数口径：末尾换行不另计一行；空文件 0 行（与 `electron/sidebarDocView.ts::countLines` 一致）。
#[test]
fn counts_lines_like_the_host() {
    assert_eq!(count_lines(""), 0);
    assert_eq!(count_lines("a"), 1);
    assert_eq!(count_lines("a\n"), 1);
    assert_eq!(count_lines("a\nb"), 2);
    assert_eq!(count_lines("a\nb\n"), 2);
    assert_eq!(count_lines("\n"), 1);
}

/// `scope` 只接受两个判别值：拼错时拒绝而不是猜一个默认范围。
#[test]
fn scope_parsing_rejects_unknown_values() {
    assert_eq!(ChangeScope::parse("doc"), Ok(ChangeScope::Doc));
    assert_eq!(ChangeScope::parse("all"), Ok(ChangeScope::All));
    assert!(ChangeScope::parse("markdown").is_err());
    assert!(ChangeScope::parse("").is_err());
}
