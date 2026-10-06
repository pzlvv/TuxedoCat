//! 宿主 i18n（`src/host/i18n.ts` + `src/tui/i18n.ts` 的移植）。
//!
//! 语言归 UI：`tt()` 在中英之间二选一，语言在启动期收敛（settings.json 的
//! `uiLanguage` → 宿主 locale → 系统语言）；core `notice` 键复用 webview 字典数据
//! （键缺失回显键本身，与 webview 的 t() 同口径，见 docs/core-ui-separation.md 第 4.9 节）。

use std::sync::Mutex;

use serde_json::Value;

/// 宿主语言。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    Zh,
    En,
}

impl Locale {
    fn from_setting(value: &str) -> Option<Locale> {
        match value {
            "zh" => Some(Locale::Zh),
            "en" => Some(Locale::En),
            _ => None,
        }
    }
}

static LOCALE: Mutex<Option<Locale>> = Mutex::new(None);

pub fn get_locale() -> Locale {
    let slot = LOCALE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    slot.unwrap_or(Locale::En)
}

/// 启动期收敛（`primeHostLocale` 移植）：先记录宿主 locale，再按 `uiLanguage` 收敛。
/// 顺序不能反——`auto` 的兜底是宿主 locale，显式 zh/en 直接生效。
pub fn prime_locale(host_locale: &str, ui_language: &str) {
    let mut slot = LOCALE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(match Locale::from_setting(ui_language) {
        Some(locale) => locale,
        None => {
            let system = system_locale();
            let zh = host_locale.to_lowercase().starts_with("zh")
                || (!system.is_empty() && system.to_lowercase().starts_with("zh"));
            if zh {
                Locale::Zh
            } else {
                Locale::En
            }
        }
    });
}

/// 按当前语言在中文 / 英文之间二选一。
pub fn tt(zh: &str, en: &str) -> String {
    match get_locale() {
        Locale::Zh => zh.to_string(),
        Locale::En => en.to_string(),
    }
}

// ==================== core notice 键 → 文案（webview 字典数据） ====================

/// core notice / 命令描述键的翻译表（与 `src/webview/i18n/zh.ts` / `en.ts` 对应条目一致；
/// 由 `coreTextKeys.json` 锁定的键必须在表里，`src/test/coreTextParity.test.ts` 口径）。
const DICT_ZH: &[(&str, &str)] = &[
    ("command.spin.description", "执行 Spin 任务"),
    ("notice.spin.engineNotWired", "Spin 引擎未接线，无法执行 Spin 任务。"),
    ("notice.spin.designMissing", "未找到 spin.json 设计文件，请先创建并保存 Spin 设计。"),
    ("notice.spin.cannotRead", "无法读取 spin.json。"),
    ("notice.spin.emptyNode", "存在空节点（缺少任务描述），请完善节点后重试。"),
    ("notice.spin.notDag", "流程图不是有效的无环有向图（DAG），请检查连线后重试。"),
    ("notice.spin.variableNoValue", "存在未赋值的变量，请在 Spin 设计器中填写变量值后重试。"),
    (
        "notice.spin.variableNoValueWithNames",
        "存在未赋值的变量（{names}），请在 Spin 设计器中填写变量值后重试。",
    ),
    ("notice.spin.invalid", "spin.json 格式不合法，请检查文件内容。"),
    ("notice.spin.allCompleted", "所有任务已完成！"),
];

const DICT_EN: &[(&str, &str)] = &[
    ("command.spin.description", "Execute Spin tasks"),
    ("notice.spin.engineNotWired", "The Spin engine is not wired up, so Spin tasks cannot run."),
    (
        "notice.spin.designMissing",
        "spin.json design file not found, please create and save a Spin design first.",
    ),
    ("notice.spin.cannotRead", "Cannot read spin.json."),
    ("notice.spin.emptyNode", "There are empty nodes (missing task descriptions), please complete them and retry."),
    (
        "notice.spin.notDag",
        "The flow is not a valid directed acyclic graph (DAG), please check the edges and retry.",
    ),
    (
        "notice.spin.variableNoValue",
        "There are variables without a value, please fill in their values in the Spin Designer and retry.",
    ),
    (
        "notice.spin.variableNoValueWithNames",
        "Variables without a value ({names}), please fill in their values in the Spin Designer and retry.",
    ),
    ("notice.spin.invalid", "spin.json is invalid, please check the file content."),
    ("notice.spin.allCompleted", "All tasks completed!"),
];

/// core notice 键 → 当前语言文本；键缺失回显键本身（与 webview 的 t() 同口径）。
pub fn notice_text(key: &str, params: &Value) -> String {
    let table = match get_locale() {
        Locale::Zh => DICT_ZH,
        Locale::En => DICT_EN,
    };
    let Some((_, template)) = table.iter().find(|(name, _)| *name == key) else {
        return key.to_string();
    };
    // `{name}` 占位符替换；参数缺失保留原样（与 TS 的 replace 口径一致）
    let params = params.as_object();
    let mut out = String::with_capacity(template.len());
    let mut rest = *template;
    while let Some(start) = rest.find('{') {
        let Some(close) = rest[start..].find('}') else {
            break;
        };
        let name = &rest[start + 1..start + close];
        out.push_str(&rest[..start]);
        match params.and_then(|map| map.get(name)) {
            Some(value) => {
                out.push_str(&match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                });
            }
            None => out.push_str(&rest[start..=start + close]),
        }
        rest = &rest[start + close + 1..];
    }
    out.push_str(rest);
    out
}

// ==================== 系统语言探测 ====================

static SYSTEM_LOCALE: Mutex<Option<String>> = Mutex::new(None);

/// 操作系统语言（探测一次并缓存；`getSystemLocale` 移植）。
///
/// Windows 上 `Intl` 不可用，用 PowerShell 查 UI 语言 / 区域格式；任一是中文即优先
/// 返回中文 locale。失败退到环境变量。
pub fn system_locale() -> String {
    let mut slot = SYSTEM_LOCALE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = slot.as_ref() {
        return cached.clone();
    }
    let locale = probe_locale();
    *slot = Some(locale.clone());
    locale
}

#[cfg(windows)]
fn probe_locale() -> String {
    if let Ok(output) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Write-Output (Get-UICulture).Name; Write-Output (Get-Culture).Name"])
        .output()
    {
        let lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if let Some(zh) = lines.iter().find(|line| line.to_lowercase().starts_with("zh")) {
            return zh.clone();
        }
        if let Some(first) = lines.first() {
            return first.clone();
        }
    }
    std::env::var("LANG").unwrap_or_default()
}

#[cfg(not(windows))]
fn probe_locale() -> String {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "i18n_tests.rs"]
mod tests;
