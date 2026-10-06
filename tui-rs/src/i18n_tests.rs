//! i18n 测试：notice 键翻译、占位符替换、键缺失回显。

use serde_json::json;

use super::*;

#[test]
fn notice_keys_translate_in_both_locales() {
    *LOCALE.lock().unwrap() = Some(Locale::Zh);
    assert_eq!(notice_text("notice.spin.allCompleted", &json!({})), "所有任务已完成！");
    *LOCALE.lock().unwrap() = Some(Locale::En);
    assert_eq!(notice_text("notice.spin.allCompleted", &json!({})), "All tasks completed!");
    *LOCALE.lock().unwrap() = Some(Locale::Zh);
}

#[test]
fn placeholder_substitution() {
    let params = json!({ "names": "a, b" });
    assert_eq!(
        notice_text("notice.spin.variableNoValueWithNames", &params),
        "存在未赋值的变量（a, b），请在 Spin 设计器中填写变量值后重试。"
    );
    // 参数缺失保留占位符原样（与 TS replace 口径一致）
    assert!(notice_text("notice.spin.variableNoValueWithNames", &json!({})).contains("{names}"));
}

#[test]
fn missing_key_echoes_itself() {
    assert_eq!(notice_text("notice.unknown.key", &json!({})), "notice.unknown.key");
}

#[test]
fn tt_picks_by_locale() {
    *LOCALE.lock().unwrap() = Some(Locale::En);
    assert_eq!(tt("会话", "Sessions"), "Sessions");
    *LOCALE.lock().unwrap() = Some(Locale::Zh);
    assert_eq!(tt("会话", "Sessions"), "会话");
}
