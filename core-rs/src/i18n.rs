//! Core 层轻量 i18n（对齐 Embedded `src/core/i18n.ts`）。
//!
//! **迁移状态**：目前只有 `tt()` 有生产消费者（内置命令的 description）。locale 的
//! 入口（`set_core_locale` / `set_core_ui_language` / `get_system_locale`）是 M6-200
//! 的对接面——等 `UiEvent` 把宿主 locale 交给 Core 后即被消费，这里先整体放行
//! `dead_code`，避免为「尚未接线的入口」逐条加注解。
#![allow(dead_code)]
//!
//! Core 被多个宿主（VS Code 扩展 / Electron）共用，不能直接依赖
//! `vscode.env.language`；宿主在启动时通过一次事件把 locale 交给 Core。
//!
//! `tt()` 按当前 core locale 在中文 / 英文之间二选一。**非 UI 文案**（日志、
//! 不允许本地化的提示词）不应走这里。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::util;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CoreLocale {
    Zh,
    En,
}

/// 默认 `en`：与 Embedded 的 `let coreLocale: 'zh' | 'en' = 'en'` 一致，
/// 宿主未上报 locale 前保持英文。
static CORE_LOCALE: Mutex<CoreLocale> = Mutex::new(CoreLocale::En);
/// 宿主上报的原始 locale（BCP-47 等）
static CORE_LOCALE_SOURCE: Mutex<String> = Mutex::new(String::new());
/// 系统语言：只探测一次并缓存（`_cachedSystemLocale`）
static SYSTEM_LOCALE: Mutex<Option<String>> = Mutex::new(None);

pub fn get_core_locale() -> CoreLocale {
    *CORE_LOCALE.lock().unwrap()
}

/// 按当前 core locale 选中英文或中文文案（对齐 `tt(zh, en)`）
pub fn tt(zh: &str, en: &str) -> String {
    match get_core_locale() {
        CoreLocale::Zh => zh.to_string(),
        CoreLocale::En => en.to_string(),
    }
}

fn apply_core_locale(next: CoreLocale) {
    let mut current = CORE_LOCALE.lock().unwrap();
    *current = next;
    // 注意：Embedded 在语言**真正变化**时通知 `onCoreLocaleChanged` 订阅者
    // （宿主据此刷新原生菜单）。Standalone 侧暂无订阅者，等 M6-200 接入
    // `UiEvent` 时再补通知。
}

fn is_chinese(locale: &str) -> bool {
    locale.to_lowercase().starts_with("zh")
}

/// 收敛有效语言：宿主上报值或系统语言任一以 `zh` 开头即中文
fn refresh_core_locale() {
    let source = CORE_LOCALE_SOURCE.lock().unwrap().clone();
    let system = get_system_locale();
    let chinese = is_chinese(&source) || (!system.is_empty() && is_chinese(&system));
    apply_core_locale(if chinese { CoreLocale::Zh } else { CoreLocale::En });
}

/// 设置宿主 locale（任意以 `zh` 开头的值视为中文）
pub fn set_core_locale(locale: Option<&str>) {
    *CORE_LOCALE_SOURCE.lock().unwrap() = locale.unwrap_or("").to_string();
    refresh_core_locale();
}

/// 按用户的 UI 语言设置覆盖自动探测：`zh` / `en` 直接生效，`auto` 回退到
/// 宿主 locale + 系统语言（对齐 `setCoreUiLanguage`）
pub fn set_core_ui_language(language: &str) {
    match language {
        "zh" => apply_core_locale(CoreLocale::Zh),
        "en" => apply_core_locale(CoreLocale::En),
        _ => refresh_core_locale(),
    }
}

/// 系统语言（`zh-CN` / `en-US` 之类）。
///
/// 与 Embedded 一致：Windows 上查 PowerShell 的 `Get-UICulture`（界面语言）与
/// `Get-Culture`（区域格式），任一为中文则优先返回中文 locale。
///
/// 差异说明：Embedded 在 PowerShell 失败后回退 `Intl.DateTimeFormat()
/// .resolvedOptions().locale`；Rust 侧没有等价的 ICU 查询，直接跳到
/// `LANG` / `LC_ALL` 环境变量（Windows 上通常为空 → 回退到 PowerShell 的结果）。
pub fn get_system_locale() -> String {
    if let Some(cached) = SYSTEM_LOCALE.lock().unwrap().clone() {
        return cached;
    }

    let mut locale = String::new();

    if cfg!(windows) {
        if let Some(output) = run_powershell_ui_culture() {
            let lines: Vec<String> = output
                .lines()
                .map(|line| util::js_trim(line).to_string())
                .filter(|line| !line.is_empty())
                .collect();
            // 界面语言或区域格式为中文 → 优先中文
            locale = lines
                .iter()
                .find(|line| is_chinese(line))
                .cloned()
                .or_else(|| lines.first().cloned())
                .unwrap_or_default();
        }
    }

    if locale.is_empty() {
        locale = std::env::var("LANG")
            .or_else(|_| std::env::var("LC_ALL"))
            .unwrap_or_default();
    }

    *SYSTEM_LOCALE.lock().unwrap() = Some(locale.clone());
    locale
}

/// 仅测试用：清空系统语言缓存
#[cfg(test)]
pub fn reset_system_locale() {
    *SYSTEM_LOCALE.lock().unwrap() = None;
}

/// 仅测试用：把系统语言固定成给定值。
///
/// 收敛规则是「宿主 locale **或**系统语言任一为中文即中文」，所以断言
/// `set_core_locale("en-US") → 英文` 必须先固定系统语言，否则在中文
/// Windows 上会（正确地）收敛成中文，用例随机器而红。
#[cfg(test)]
pub fn set_system_locale_for_test(locale: &str) {
    *SYSTEM_LOCALE.lock().unwrap() = Some(locale.to_string());
}

/// 仅测试用：清空宿主 locale 来源（恢复到默认 `en`）
#[cfg(test)]
pub fn reset_core_locale() {
    *CORE_LOCALE_SOURCE.lock().unwrap() = String::new();
    apply_core_locale(CoreLocale::En);
}

/// 执行 PowerShell 查询界面 / 区域语言；超时 5s（对齐 Embedded 的 `timeout: 5000`）
fn run_powershell_ui_culture() -> Option<String> {
    let mut command = std::process::Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output (Get-UICulture).Name; Write-Output (Get-Culture).Name",
    ]);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());
    util::hide_console(&mut command);

    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_millis(5000);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(test)]
#[path = "i18n_tests.rs"]
mod tests;
