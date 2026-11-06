//! Edit / Write 的读后失效守卫（specs/038，`docs/core/tool-read-guard.md`）。
//!
//! 事实：每个会话内「文件 → 最近一次读取 / 写入时的内容指纹」。Read 成功登记，
//! Edit / Write 执行前比对磁盘当前字节；内容不一致就是「模型手上的认知已过期」。
//!
//! 为什么用内容指纹而不是 mtime：同秒写入、时钟回拨、网络盘与 WSL 挂载上时间戳
//! 不可靠，而「本会话自己的写入更新记录」这一条（spec FR-002）必须与「外部改动
//! 一定拦住」共存——只有比对内容才能同时满足。
//!
//! 记录只在进程内、按会话隔离：Core 重启后表为空，第一次 Edit 必然要求先 Read
//! （保守方向，spec FR-003）。
//!
//! 一份事实一个写入点：记录表的写只有本模块的 `record_read` / `record_write` /
//! `clear_session`，判定只有 `verify`——`run_read` / `run_edit` / `run_write` 只做
//! 三个接入点。

use std::collections::HashMap;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::tools::expand_path;

/// 文件在会话最后一次读取之后被改过：拒绝编辑并要求重新读取。
///
/// 工具错误文案统一用英文（与 `tools.rs` 的其它工具错误一致），`{path}` 是调用方
/// 传入的 `file_path` 原文——模型据此知道该重读哪个文件。
pub fn stale_message(file_path: &str, absolute: &str) -> String {
    format!(
        "File has been modified since it was last read: {file_path}\n\
         The file on disk no longer matches what you read (resolved path: {absolute}). \
         Read the file again before editing it."
    )
}

/// 本会话从未读过该文件（文件已存在）：要求先读取。
pub fn missing_message(file_path: &str, absolute: &str) -> String {
    format!(
        "Please read the file before editing it: {file_path}\n\
         This session has not read the file yet (resolved path: {absolute}). \
         Read it first so edits are based on its current content."
    )
}

/// 内容指纹：SHA-256 十六进制（64 字符）。
///
/// 对**原始字节**求哈希，不走 `String::from_utf8_lossy`——Read 的展示层是 lossy 的，
/// 但两份不同的非法 UTF-8 文件必须得到不同指纹，否则守卫会把它们当成同一份内容。
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileFingerprint(String);

impl FileFingerprint {
    fn of(bytes: &[u8]) -> FileFingerprint {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = hasher.finalize();
        FileFingerprint(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

/// 会话 → 规范化路径 → 指纹。`None` 表示表尚未创建（与 `tools.rs` 的 `TODOS` 同款
/// 惰性初始化：只有在真的 Read 过文件时才分配，`reset_for_test` 用整体置空代替逐条清）。
static RECORDS: std::sync::Mutex<Option<HashMap<String, HashMap<String, FileFingerprint>>>> =
    std::sync::Mutex::new(None);

/// 取表锁；锁中毒（持锁线程 panic）沿用内部数据继续，不让后续每次调用都 panic。
fn lock()
-> std::sync::MutexGuard<'static, Option<HashMap<String, HashMap<String, FileFingerprint>>>> {
    RECORDS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 路径规范化：同一份文件的不同写法落到同一条记录。
///
/// `canonicalize` 成功即取（解析 `..`、符号链接与大小写差异）；失败（文件不存在 /
/// 权限）退化为 `expand_path` 的产物——`expand_path` 已经做了词法折叠，足以让
/// `a.ts`、`./a.ts`、`sub/../a.ts` 在「文件还不存在」的 Write 新建路径上对齐。
fn normalize(cwd: &str, path: &Path) -> String {
    match std::fs::canonicalize(path) {
        Ok(resolved) => resolved.to_string_lossy().to_string(),
        Err(_) => expand_path(cwd, &path.to_string_lossy())
            .to_string_lossy()
            .to_string(),
    }
}

/// 记录一次成功的 Read（文本分支，整份文件原始字节）。
pub fn record_read(session_id: &str, cwd: &str, path: &Path, bytes: &[u8]) {
    let key = normalize(cwd, path);
    let mut guard = lock();
    guard
        .get_or_insert_with(HashMap::new)
        .entry(session_id.to_string())
        .or_insert_with(HashMap::new)
        .insert(key, FileFingerprint::of(bytes));
}

/// Edit / Write 执行前的比对。
///
/// `current` 是本会话刚读到的磁盘字节（文件不存在时 `None`，只有 Write 新建会走到）。
/// 返回 `None` 表示放行，`Some(message)` 是工具错误文案。
pub fn verify(
    session_id: &str,
    cwd: &str,
    path: &Path,
    file_path: &str,
    current: Option<&[u8]>,
) -> Option<String> {
    let key = normalize(cwd, path);
    let absolute = path.to_string_lossy().to_string();
    let recorded = lock()
        .as_ref()
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|files| files.get(&key))
        .cloned();
    match (recorded, current) {
        // 指纹相等：盘上内容就是模型手上的那份
        (Some(recorded), Some(bytes)) if recorded == FileFingerprint::of(bytes) => None,
        // 指纹不等：外部（或未登记的本进程路径）改过
        (Some(_), Some(_)) => Some(stale_message(file_path, &absolute)),
        // 从未读过、文件存在
        (None, Some(_)) => Some(missing_message(file_path, &absolute)),
        // 从未读过、文件不存在：Write 新建没有可踩的旧内容
        (None, None) => None,
        // 有记录但文件已不存在：删除后重建按「新建」处理，不叠加守卫
        // （spec 边界：「文件在 Read 之后被删除」不归本守卫管；Edit 的 ENOENT 文案
        // 在 `run_edit` 里先行返回，走不到这里）
        (Some(_), None) => None,
    }
}

/// Edit / Write 成功之后刷新记录（spec FR-002：等价于「刚读过写入后的结果」）。
///
/// 调用方传入**从磁盘读回**的字节而不是内存里的 `content`：落盘可能被换行 / 编码
/// 处理过，记录必须与磁盘真实内容一致，否则下一次 Edit 会被自己误拒。
pub fn record_write(session_id: &str, cwd: &str, path: &Path, bytes: &[u8]) {
    record_read(session_id, cwd, path, bytes);
}

/// 会话释放：关闭 / 删除时清掉该会话的记录，避免全局表无界增长（spec FR-003）。
pub fn clear_session(session_id: &str) {
    if let Some(sessions) = lock().as_mut() {
        sessions.remove(session_id);
    }
}

/// 清空整张表（单测隔离用；静态表跨用例可见，与 `bash_task::reset_for_test` 同款）。
#[cfg(test)]
pub fn reset_for_test() {
    *lock() = None;
}

#[cfg(test)]
#[path = "read_guard_tests.rs"]
mod tests;
