//! Linux 上的代理客户端（specs/051 FR-007 / FR-007b）。
//!
//! 本文件只做两件事：**会话 → 常驻代理**的登记表，以及能力探测。帧收发与代执行原语
//! 在 `linux/client.rs` 里。
//!
//! ## 能力探测为什么也要拉起代理
//!
//! 「本机能不能挂 overlay」只有真挂一次才知道，而 Core 不在任何命名空间里、没有
//! `CAP_SYS_ADMIN`（ADR-0018），自己挂必然失败。因此探测本身就是一次「拉一个临时代理、
//! 让它挂一次、再收掉」——结论来自唯一有资格的进程。
//!
//! 探测失败不改任何状态：能力回 `absent` 并带上代理给的原因（FR-001 的 `reason`）。

use crate::mount_proxy::{MountProxyState, PROXY_DIR, PROXY_NAME};
use client::ViewPaths;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[path = "linux/client.rs"]
mod client;

pub use client::{SessionProxy, SpawnOutcome, SpawnSpec};

/// 一个路径的事实（`stat` 的应答）
pub struct PathFacts {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}
/// 视图的四条路径 + bind 目标
pub type View = ViewPaths;

/// 能力探测的结果（平台无关的载体）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProbe {
    pub ready: bool,
    pub overlay_ok: bool,
    pub overlay_usable: bool,
    pub reason: String,
}

/// 会话 id → 常驻代理。
///
/// 一个隔离会话一个代理：代理持有该会话视图的挂载命名空间，工具由它 fork
/// （见 `mount-proxy-rs/src/privilege.rs` 的进程图）。
///
/// 存 `Arc`：调用方（工具层）在一条工具调用期间持有句柄，登记表同时保留自己那一份。
/// 最后一个 `Arc` 被丢弃时才真正回收进程——因此「会话关闭」与「在途工具调用」不会
/// 互相踩（会话关闭后仍在跑的那条 Bash 不会因为 fd 被提前关掉而静默丢输出）。
fn sessions() -> &'static Mutex<HashMap<String, Arc<SessionProxy>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<SessionProxy>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取某会话的代理；不在（或已死）时按需拉起。
///
/// `paths` 是视图的四条路径 + bind 目标。拉起失败只回错误，不改任何全局状态：调用方
/// （工具层）据此报错，**不退回真实磁盘**（FR-010 的 fail-closed）。
///
/// 已登记但进程已死时摘掉它再拉一个新的——这是 FR-007 的「代理运行中被杀后，下次需要
/// 时重新拉起、不重启 Core」。能力查询与工具调用都走这里，因此两条路径都能自愈。
pub fn session_proxy(session_id: &str, paths: ViewPaths) -> Result<Arc<SessionProxy>, String> {
    let mut table = sessions()
        .lock()
        .map_err(|error| format!("代理登记表损坏（{error}）"))?;
    if let Some(existing) = table.get(session_id) {
        if existing.is_alive() {
            return Ok(Arc::clone(existing));
        }
    }
    if table.remove(session_id).is_some() {
        eprintln!("[core] 会话 {session_id} 的挂载代理已退出，重新拉起");
    }
    let proxy = Arc::new(client::spawn_session(session_id, &paths)?);
    table.insert(session_id.to_string(), Arc::clone(&proxy));
    Ok(proxy)
}

/// 已登记的代理（不拉起）；工具与视图取数用它在「该会话没有代理」时明确报错。
pub fn existing_proxy(session_id: &str) -> Option<Arc<SessionProxy>> {
    sessions()
        .lock()
        .ok()
        .and_then(|table| table.get(session_id).cloned())
        .filter(|proxy| proxy.is_alive())
}

/// 丢弃某会话的代理（会话关闭 / 删除时调用）。
///
/// 丢弃 = 关闭 socketpair = 代理读到 EOF 自行退出（FR-007b 的回收主路径，不依赖信号）。
/// 在途工具仍持有自己的 `Arc`，它们的输出不会因此丢失。
pub fn release_session(session_id: &str) {
    if let Ok(mut table) = sessions().lock() {
        table.remove(session_id);
    }
}

/// 结束全部会话代理（Core 退出时调用）
pub fn shutdown() {
    if let Ok(mut table) = sessions().lock() {
        table.clear();
    }
}

/// 探测能力（FR-001 的四个字段都从这里推）。
///
/// 每次都反映**当前**状态，不用启动期缓存：代理随时可能消失（AC-28b / AC-28d）。
pub fn probe_capabilities() -> CapabilityProbe {
    // `overlay_usable` 回答的是「部署代理**可能**解决问题吗」：需要 Linux 有 overlayfs
    // 且代理二进制本身存在（否则装它也无从谈起——那是「未部署」，由 `deployable` 表达）。
    //
    // 注意这两个条件都不是「now 能挂」：能不能挂由下面真挂一次回答。
    let overlay_usable = kernel_has_overlay();
    let probe_root =
        std::path::Path::new("/tmp").join(format!("tc-core-probe-{}", std::process::id()));
    let lower = probe_root.join("lower");
    let upper = probe_root.join("upper");
    let work = probe_root.join("work");
    let merged = probe_root.join("merged");
    let workspace = probe_root.join("workspace");
    let result = (|| -> Result<(), String> {
        for dir in [&lower, &workspace] {
            std::fs::create_dir_all(dir)
                .map_err(|error| format!("建探测目录 {} 失败（{error}）", dir.display()))?;
        }
        // 视图必须非空：代理把「读到的视图是空的」判成挂载没生效
        std::fs::write(lower.join("probe.txt"), b"probe\n")
            .map_err(|error| format!("写探测文件失败（{error}）"))?;
        let paths = ViewPaths {
            lower: lower.clone(),
            upper,
            work,
            merged,
            workspace,
        };
        // 探测用的代理不进会话表：`spawn_session` 失败即判不可用
        let proxy = client::spawn_session("__probe__", &paths)?;
        drop(proxy);
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&probe_root);
    match result {
        Ok(()) => CapabilityProbe {
            ready: true,
            overlay_ok: true,
            overlay_usable,
            reason: String::new(),
        },
        Err(reason) => CapabilityProbe {
            ready: false,
            overlay_ok: false,
            overlay_usable,
            reason,
        },
    }
}

/// 内核是否支持 overlayfs
///
/// 不复用 `/proc/self/mountinfo`：能力判据要回答「**能不能**挂」，不是「现在挂没挂」。
fn kernel_has_overlay() -> bool {
    std::fs::read_to_string("/proc/filesystems")
        .map(|text| text.lines().any(|line| line.trim() == "nodev\toverlay"))
        .unwrap_or(false)
}

/// 挂载代理的状态（供 `Capabilities` 的 `mountProxy` 字段用）
pub fn state_of(probe: &CapabilityProbe) -> MountProxyState {
    if probe.ready && probe.overlay_ok {
        MountProxyState::Ready
    } else {
        MountProxyState::Absent
    }
}

/// 诊断用：代理的安装位点
pub fn installed_path() -> String {
    format!("{PROXY_DIR}/{PROXY_NAME}")
}
