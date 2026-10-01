//! daemon 控制通道协议（见 `docs/core-daemon.md` 第 7 节）。
//!
//! 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧（与内层帧通道同一口径）。
//! 控制通道上只有一条连接；每个 Core 的帧通道是它上面的一条逻辑 channel。
//! daemon 不解读内层帧，只按 channel 转发。
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
    /// 转发一帧内层帧（Host → Core）
    Frame { channel: u64, frame: Value },
    /// 关闭全部 channel 并退出
    Shutdown,
}

/// daemon → Host 的控制帧。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DaemonToHostFrame {
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
}

/// ChannelDescriptor（`docs/core-daemon.md` 第 4.1 节）：
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
