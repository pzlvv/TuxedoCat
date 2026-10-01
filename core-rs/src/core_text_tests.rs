use super::*;

/// 两侧共用 `src/test/fixtures/coreTextKeys.json`：TS 侧 `coreTextParity.test.ts`
/// 校验键集合与 webview 词典，Rust 侧在这里校验常量与同一份对照表一致。
const FIXTURE: &str = include_str!("../../src/test/fixtures/coreTextKeys.json");

#[test]
fn core_text_keys_match_the_shared_fixture() {
    let expected: Vec<String> = serde_json::from_str(FIXTURE).expect("parse coreTextKeys.json");
    let actual: Vec<String> = CORE_TEXT_KEYS.iter().map(|key| key.to_string()).collect();
    assert_eq!(actual, expected);
}

#[test]
fn core_text_keys_are_distinct() {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for key in CORE_TEXT_KEYS {
        assert!(seen.insert(key), "duplicate core text key: {key}");
    }
}
