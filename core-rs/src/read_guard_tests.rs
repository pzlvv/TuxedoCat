//! `read_guard` 的单元测试：判定矩阵四行、路径归一、文案逐字锁定（specs/038 AC-1～AC-7）。

use super::*;
use crate::test_support::Sandbox;

/// 把 `rel` 展开成绝对路径（守卫的调用方都先 `expand_path`）。
fn abs(sandbox: &Sandbox, rel: &str) -> std::path::PathBuf {
    expand_path(&sandbox.workspace.to_string_lossy(), rel)
}

#[test]
fn equal_fingerprint_passes() {
    let sandbox = Sandbox::new("read-guard-equal");
    reset_for_test();
    let path = sandbox.write_file("a.ts", "hello\n");
    record_read("s-guard", &sandbox.workspace.to_string_lossy(), &path, b"hello\n");

    let outcome = verify(
        "s-guard",
        &sandbox.workspace.to_string_lossy(),
        &path,
        "a.ts",
        Some(b"hello\n"),
    );
    assert_eq!(outcome, None);
}

#[test]
fn changed_fingerprint_is_rejected() {
    let sandbox = Sandbox::new("read-guard-stale");
    reset_for_test();
    let path = sandbox.write_file("a.ts", "hello\n");
    record_read("s-guard", &sandbox.workspace.to_string_lossy(), &path, b"hello\n");

    let outcome = verify(
        "s-guard",
        &sandbox.workspace.to_string_lossy(),
        &path,
        "a.ts",
        Some(b"hello world\n"),
    );
    assert_eq!(
        outcome,
        Some(stale_message("a.ts", &path.to_string_lossy()))
    );
}

#[test]
fn unread_existing_file_is_rejected() {
    let sandbox = Sandbox::new("read-guard-missing");
    reset_for_test();
    let path = sandbox.write_file("a.ts", "hello\n");

    let outcome = verify(
        "s-guard",
        &sandbox.workspace.to_string_lossy(),
        &path,
        "a.ts",
        Some(b"hello\n"),
    );
    assert_eq!(
        outcome,
        Some(missing_message("a.ts", &path.to_string_lossy()))
    );
}

#[test]
fn unread_absent_file_passes() {
    let sandbox = Sandbox::new("read-guard-create");
    reset_for_test();
    let path = abs(&sandbox, "new.ts");

    let outcome = verify(
        "s-guard",
        &sandbox.workspace.to_string_lossy(),
        &path,
        "new.ts",
        None,
    );
    assert_eq!(outcome, None);
}

#[test]
fn equivalent_spellings_share_one_record() {
    let sandbox = Sandbox::new("read-guard-normalize");
    reset_for_test();
    sandbox.write_file("sub/a.ts", "hello\n");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let plain = abs(&sandbox, "sub/a.ts");
    record_read("s-guard", &cwd, &plain, b"hello\n");

    // `./sub/a.ts` 与 `sub/../sub/a.ts` 是同一份文件：内容与记录相等即放行。
    for spelling in ["./sub/a.ts", "sub/../sub/a.ts"] {
        let path = abs(&sandbox, spelling);
        assert_eq!(
            verify("s-guard", &cwd, &path, spelling, Some(b"hello\n")),
            None,
            "spelling {spelling} did not resolve to the recorded path"
        );
    }
}

#[test]
fn invalid_utf8_bytes_get_distinct_fingerprints() {
    // 两份不同的非法 UTF-8 内容：展示层都会 lossy 成 U+FFFD，但指纹必须不同，
    // 否则守卫会把「已过期」当成「没变」（spec FR-002 的判定依据是原始字节）。
    let first = FileFingerprint::of(&[0xff, 0xfe, 0x00]);
    let second = FileFingerprint::of(&[0xff, 0xfe, 0x01]);
    assert_ne!(first, second);
    // 64 字符十六进制
    assert_eq!(first.0.len(), 64);
    assert!(first.0.chars().all(|ch| ch.is_ascii_hexdigit()));
}

#[test]
fn messages_are_locked_verbatim() {
    // 两条文案逐字锁定：模型看到的提示与文档（docs/core/tool-read-guard.md 第 3 节）
    // 必须同口径，改文案要同时改测试与文档。
    assert_eq!(
        stale_message("a.ts", "/abs/a.ts"),
        "File has been modified since it was last read: a.ts\n\
         The file on disk no longer matches what you read (resolved path: /abs/a.ts). \
         Read the file again before editing it."
    );
    assert_eq!(
        missing_message("a.ts", "/abs/a.ts"),
        "Please read the file before editing it: a.ts\n\
         This session has not read the file yet (resolved path: /abs/a.ts). \
         Read it first so edits are based on its current content."
    );
}

#[test]
fn sessions_are_isolated() {
    // 会话 A 的读取记录不影响会话 B（spec FR-003 第 1 条）。
    let sandbox = Sandbox::new("read-guard-sessions");
    reset_for_test();
    let path = sandbox.write_file("a.ts", "hello\n");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    record_read("s-a", &cwd, &path, b"hello\n");

    assert_eq!(verify("s-a", &cwd, &path, "a.ts", Some(b"hello\n")), None);
    assert_eq!(
        verify("s-b", &cwd, &path, "a.ts", Some(b"hello\n")),
        Some(missing_message("a.ts", &path.to_string_lossy()))
    );
}

#[test]
fn clear_session_drops_only_that_session() {
    let sandbox = Sandbox::new("read-guard-clear");
    reset_for_test();
    let path = sandbox.write_file("a.ts", "hello\n");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    record_read("s-a", &cwd, &path, b"hello\n");
    record_read("s-b", &cwd, &path, b"hello\n");

    clear_session("s-a");
    assert_eq!(
        verify("s-a", &cwd, &path, "a.ts", Some(b"hello\n")),
        Some(missing_message("a.ts", &path.to_string_lossy()))
    );
    assert_eq!(verify("s-b", &cwd, &path, "a.ts", Some(b"hello\n")), None);
}
