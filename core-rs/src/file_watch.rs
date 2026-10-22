//! 远程工作区文件监听（specs/018 FR-002 / FR-003）。
//!
//! 宿主为当前查看器窗口注册一个 `watchId`，Core 用 `notify` 监听目标文件的**父目录**
//! （非递归）并按 basename 过滤：编辑器常见的「写临时文件 + rename」会让文件级 watcher
//! 失效，父目录监听能同时捕获 replace / delete / recreate。
//!
//! 每个 watch 一条去抖线程（50ms）：`notify` 回调只把原始事件送进 channel，线程合并后
//! 以「目标文件当前是否存在」判定 `changed` / `deleted`，经 `SharedBus` 发一条
//! `CoreEvent.workspaceFileChanged`。事件只带路径与元数据，不带文件内容。

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};

use crate::engine::SharedBus;

/// 去抖窗口：一次保存产生的多条 notify 事件合并为一条 CoreEvent。
const DEBOUNCE: Duration = Duration::from_millis(50);

/// notify 回调送入去抖线程的原始事件。
enum RawEvent {
    /// 目标文件发生文件系统事件；最终以文件是否存在判定 changed / deleted。
    Fs,
    /// watcher 自身错误。
    Error(String),
    /// 注销时唤醒线程退出。
    Stop,
}

/// 一个已注册的 watch。drop 时停掉去抖线程并释放 watcher。
struct WatchEntry {
    /// watcher 必须保持存活；drop 即停止监听。
    _watcher: RecommendedWatcher,
    stop: Sender<RawEvent>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for WatchEntry {
    fn drop(&mut self) {
        let _ = self.stop.send(RawEvent::Stop);
        if let Some(thread) = self.thread.take() {
            // 去抖线程最多阻塞在 50ms 的 recv_timeout 上；join 保证 unwatch 返回后
            // 不会再有迟到事件（关闭 / 顶替时的确定性）。
            let _ = thread.join();
        }
    }
}

/// 监听注册表：Core 进程内唯一，按 `watchId` 持有 watcher。
pub struct FileWatchRegistry {
    entries: Mutex<HashMap<String, WatchEntry>>,
}

impl FileWatchRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// 注册监听。`workspace_root` 与 `path` 都是目标机器上的绝对路径。
    ///
    /// 失败（越界 / 不存在 / 不是普通文件 / watcher 创建失败）如实返回错误字符串，
    /// 由宿主显示「自动刷新不可用」，不静默放行。
    pub fn watch(
        &self,
        bus: SharedBus,
        watch_id: String,
        workspace_root: &str,
        path: &str,
    ) -> Result<(), String> {
        let target = validate_target(workspace_root, path)?;
        let parent = target
            .parent()
            .ok_or_else(|| format!("watch target has no parent: {}", target.display()))?
            .to_path_buf();
        let target_name = target
            .file_name()
            .ok_or_else(|| format!("watch target has no file name: {}", target.display()))?
            .to_os_string();

        let (tx, rx) = channel::<RawEvent>();
        let callback_tx = tx.clone();
        let filter_name = target_name.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
                Ok(event) => {
                    if matches!(event.kind, EventKind::Access(_)) {
                        return;
                    }
                    // 父目录里其它文件的噪音按 basename 过滤（notify 的路径可能保留原始
                    // 大小写，Windows 下按不区分大小写比较）。
                    let touched = event
                        .paths
                        .iter()
                        .any(|path| path.file_name().is_some_and(|name| same_name(name, &filter_name)));
                    if touched {
                        let _ = callback_tx.send(RawEvent::Fs);
                    }
                }
                Err(err) => {
                    let _ = callback_tx.send(RawEvent::Error(err.to_string()));
                }
            })
            .map_err(|err| format!("failed to create file watcher: {err}"))?;

        watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|err| format!("failed to watch {}: {err}", parent.display()))?;

        let thread = spawn_debounce_thread(bus, watch_id.clone(), target, rx);

        let entry = WatchEntry {
            _watcher: watcher,
            stop: tx,
            thread: Some(thread),
        };
        let mut entries = self.entries.lock().unwrap();
        // 同一 watchId 重复注册：先替换旧条目（drop 会停掉旧 watcher / 线程）。
        entries.insert(watch_id, entry);
        Ok(())
    }

    /// 注销监听；未知 `watchId` 按已注销处理（关闭 / 顶替竞态下幂等）。
    pub fn unwatch(&self, watch_id: &str) -> Result<(), String> {
        let mut entries = self.entries.lock().unwrap();
        entries.remove(watch_id);
        Ok(())
    }
}

impl Default for FileWatchRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 校验目标文件落在工作区根内，并返回 canonicalize 后的路径。
fn validate_target(workspace_root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root)
        .map_err(|err| format!("workspace root is not accessible: {workspace_root}: {err}"))?;
    let target = fs::canonicalize(path)
        .map_err(|err| format!("watch target is not accessible: {path}: {err}"))?;
    if target == root {
        return Err(format!("watch target is the workspace root: {path}"));
    }
    if !target.starts_with(&root) {
        return Err(format!("watch target escapes the workspace root: {path}"));
    }
    if !target.is_file() {
        return Err(format!("watch target is not a regular file: {path}"));
    }
    Ok(target)
}

/// 文件名比较：Windows 大小写不敏感，其它平台按字节比较。
fn same_name(left: &OsStr, right: &OsStr) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

/// 去抖线程：收第一条事件后持续吸收 50ms 内的后续事件，再按最终状态发一条事件。
fn spawn_debounce_thread(
    bus: SharedBus,
    watch_id: String,
    target: PathBuf,
    rx: Receiver<RawEvent>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("file-watch-{watch_id}"))
        .spawn(move || loop {
            let first = match rx.recv() {
                Ok(RawEvent::Stop) => return,
                Ok(event) => event,
                Err(_) => return,
            };
            let mut events = vec![first];
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(RawEvent::Stop) => return,
                    Ok(event) => events.push(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            emit_event(&bus, &watch_id, &target, &events);
        })
        .expect("failed to spawn file watch thread")
}

fn emit_event(bus: &SharedBus, watch_id: &str, target: &Path, events: &[RawEvent]) {
    // watcher 错误优先上报；文件状态仍由宿主下一次事件 / 重注册纠正。
    if let Some(RawEvent::Error(message)) = events
        .iter()
        .find(|event| matches!(event, RawEvent::Error(_)))
    {
        emit(
            bus,
            json!({
                "type": "workspaceFileChanged",
                "watchId": watch_id,
                "path": target.to_string_lossy(),
                "kind": "error",
                "mtimeMs": 0,
                "size": 0,
                "error": message,
            }),
        );
        return;
    }

    // 最终状态以文件当前是否存在为准：一次「remove + create」的原子保存应报 changed。
    match fs::metadata(target) {
        Ok(meta) => {
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            emit(
                bus,
                json!({
                    "type": "workspaceFileChanged",
                    "watchId": watch_id,
                    "path": target.to_string_lossy(),
                    "kind": "changed",
                    "mtimeMs": mtime_ms,
                    "size": meta.len(),
                    "error": null,
                }),
            );
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            emit(
                bus,
                json!({
                    "type": "workspaceFileChanged",
                    "watchId": watch_id,
                    "path": target.to_string_lossy(),
                    "kind": "deleted",
                    "mtimeMs": 0,
                    "size": 0,
                    "error": null,
                }),
            );
        }
        Err(err) => {
            emit(
                bus,
                json!({
                    "type": "workspaceFileChanged",
                    "watchId": watch_id,
                    "path": target.to_string_lossy(),
                    "kind": "error",
                    "mtimeMs": 0,
                    "size": 0,
                    "error": err.to_string(),
                }),
            );
        }
    }
}

fn emit(bus: &SharedBus, event: Value) {
    let mut bus = bus.lock().unwrap();
    bus.emit(event);
}
