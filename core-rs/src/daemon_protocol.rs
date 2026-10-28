//! daemon 控制通道协议（见 `docs/core/core-daemon.md` 第 7 节）。
//!
//! 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧（与内层帧通道同一口径）。
//! 控制通道上只有一条连接；每个 Core 的帧通道是它上面的一条逻辑 channel。
//! daemon 除忙闲快照缓存与请求帧暂存两处只读窥探外不解读内层帧，只按 channel
//! 转发（specs/031，见 `docs/adr/0012-daemon-frame-peek.md`）。
//!
//! 协议没有版本握手：daemon 与 Host 随同一份产物分发，版本由分发保证；
//! 内层 Core 与 Host 的协议版本校验仍在各自 channel 的 `hello` / `ready` 上完成。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Host → daemon 的控制帧。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostToDaemonFrame {
    /// 打开一个工作区：daemon 启动 Core 进程、分配 channel、回 `workspaceOpened`
    OpenWorkspace {
        id: u64,
        #[serde(rename = "workspaceRef")]
        workspace_ref: Value,
    },
    /// 关闭工作区：向该 Core 发 `shutdown`，超时后强制结束
    CloseWorkspace { channel: u64 },
    /// 后台运行（specs/031）：把该 Core 移入孤儿表继续执行，连接与其余 channel 不受影响；
    /// daemon 回 `workspaceClosed { reason: 'detached' }`
    DetachWorkspace { channel: u64 },
    /// 转发一帧内层帧（Host → Core）
    Frame { channel: u64, frame: Value },
    /// 列出远端目录（远程目录选择器用）；`path` 为 `null` 时从主目录开始
    ListDirectories { id: u64, path: Option<String> },
    /// 新建远端目录（远程目录选择器用）；父目录不存在时一并创建
    CreateDirectory { id: u64, path: String },
    /// 重命名远端目录（远程目录选择器用）；只改同一父目录下的名字，不是移动
    RenameDirectory { id: u64, path: String, name: String },
    /// 删除远端目录（远程目录选择器用）；`recursive` 为 `false` 时只接受空目录
    DeleteDirectory {
        id: u64,
        path: String,
        recursive: bool,
    },
    /// 关闭全部 channel 并退出
    Shutdown,
    /// 心跳（`docs/core/core-remote.md` 第 2.5 节）：Host 定期发送，daemon 回 `pong`
    /// 并以「最近一次收到控制帧」判定 Host 死活。
    Ping,
}

/// daemon → Host 的控制帧。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DaemonToHostFrame {
    /// 心跳应答（`docs/core/core-remote.md` 第 2.5 节）：对 `ping` 的回应。Host 见到
    /// 首个 `pong` 即武装「沉默判定」——此后长时间无任何入站帧按断开处理。
    Pong,
    /// 工作区已打开：回带 Host 的请求 id 与 channel / 描述符
    WorkspaceOpened {
        id: u64,
        channel: u64,
        descriptor: ChannelDescriptor,
    },
    /// 工作区打开失败（启动 Core 进程失败等）
    WorkspaceFailed { id: u64, error: String },
    /// channel 关闭
    WorkspaceClosed {
        channel: u64,
        reason: WorkspaceCloseReason,
    },
    /// channel 连接重置（Core 崩溃后在同一 channel 上重启）
    ChannelReset { channel: u64, reason: String },
    /// 转发一帧内层帧（Core → Host）
    Frame { channel: u64, frame: Value },
    /// 目录列举结果
    DirectoriesListed {
        id: u64,
        path: String,
        parent: Option<String>,
        entries: Vec<DirectoryEntry>,
    },
    /// 目录已新建
    DirectoryCreated { id: u64, path: String },
    /// 目录已重命名（`path` 是改名后的新路径）
    DirectoryRenamed { id: u64, path: String },
    /// 目录已删除
    DirectoryDeleted { id: u64, path: String },
    /// 目录操作失败（列举 / 新建 / 删除共用；按 `id` 对应请求）
    DirectoryFailed {
        id: u64,
        error: String,
        reason: DirectoryFailureReason,
    },
}

/// 目录操作失败的原因。
///
/// `NotEmpty` 单独拎出来：Host 据此把删除按钮升成「目录非空，确认连同内容一起删除？」，
/// 而不是让用户对着一段错误文本猜该不该重试。
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryFailureReason {
    /// 目录非空，且本次请求没有要求递归删除
    NotEmpty,
    /// 其它失败（路径不存在 / 无权限 / 相对路径等）
    Other,
}

/// 目录列举的一项（只列子目录）
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    /// 目录名（basename）
    pub name: String,
    /// 绝对路径
    pub path: String,
}

/// ChannelDescriptor（`docs/core/core-daemon.md` 第 4.1 节）：
/// 今天表达「走这条控制通道、channel N」，将来可以表达「去连这个地址」。
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChannelDescriptor {
    /// 走当前控制通道的该 channel（本规格实现）
    Multiplexed { channel: u64 },
    /// 直连一个独立端点（预留，不实现）
    #[allow(dead_code)]
    Direct { transport: String, address: String },
}

/// channel 关闭原因。
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceCloseReason {
    /// Host 主动关闭
    Closed,
    /// Core 崩溃且不再重启（daemon 自身退出时的清理；wire 契约的一部分）
    #[allow(dead_code)]
    Crashed,
    /// 重启次数超过上限 / 无法启动
    Failed,
    /// 后台运行（specs/031）：Core 已转入孤儿表继续执行，只是本 channel 摘除
    Detached,
}

impl DaemonToHostFrame {
    /// 编码为一帧（含结尾换行）。
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        let mut line = serde_json::to_string(self)?;
        line.push('\n');
        Ok(line)
    }
}

#[cfg(test)]
#[path = "daemon_protocol_tests.rs"]
mod tests;
