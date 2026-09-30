use super::*;
use crate::test_support::serial;

#[test]
fn defaults_to_english_before_host_reports_locale() {
    let _guard = serial();
    reset_core_locale();
    // 系统语言固定成英文：否则在中文 Windows 上会（正确地）收敛成中文
    set_system_locale_for_test("en-US");
    assert_eq!(get_core_locale(), CoreLocale::En);
    assert_eq!(tt("中文", "English"), "English");
    reset_system_locale();
}

#[test]
fn chinese_locale_picks_chinese_text() {
    let _guard = serial();
    reset_core_locale();
    set_system_locale_for_test("en-US");
    set_core_locale(Some("zh-CN"));
    assert_eq!(get_core_locale(), CoreLocale::Zh);
    assert_eq!(tt("中文", "English"), "中文");

    // 大小写不敏感、只看前缀
    set_core_locale(Some("ZH-hant"));
    assert_eq!(get_core_locale(), CoreLocale::Zh);

    // 非中文 → 英文
    set_core_locale(Some("en-US"));
    assert_eq!(get_core_locale(), CoreLocale::En);

    // 未上报 / 空串 → 回退系统语言：系统语言为中文时收敛成中文
    set_system_locale_for_test("zh-TW");
    set_core_locale(None);
    assert_eq!(get_core_locale(), CoreLocale::Zh);
    set_system_locale_for_test("en-US");
    set_core_locale(Some(""));
    assert_eq!(get_core_locale(), CoreLocale::En);

    reset_core_locale();
    reset_system_locale();
}

#[test]
fn ui_language_overrides_auto_detection() {
    let _guard = serial();
    reset_core_locale();
    set_system_locale_for_test("en-US");

    set_core_ui_language("zh");
    assert_eq!(get_core_locale(), CoreLocale::Zh);

    set_core_ui_language("en");
    assert_eq!(get_core_locale(), CoreLocale::En);

    // `auto` 回退到宿主 locale + 系统语言
    set_core_locale(Some("zh-TW"));
    set_core_ui_language("auto");
    assert_eq!(get_core_locale(), CoreLocale::Zh);

    // 宿主 locale 非中文、系统语言中文 → 仍是中文（「任一为中文即中文」）
    set_core_locale(Some("en-US"));
    set_system_locale_for_test("zh-CN");
    set_core_ui_language("auto");
    assert_eq!(get_core_locale(), CoreLocale::Zh);

    reset_core_locale();
    reset_system_locale();
}

#[test]
fn system_locale_is_cached() {
    let _guard = serial();
    reset_system_locale();
    let first = get_system_locale();
    let second = get_system_locale();
    assert_eq!(first, second, "系统语言只探测一次");
    reset_system_locale();
}
