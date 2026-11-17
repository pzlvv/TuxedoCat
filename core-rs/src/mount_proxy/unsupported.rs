//! 非 Linux 的占位实现（specs/051 FR-001 AC-3）。
//!
//! 用户 / 挂载命名空间、overlayfs、setuid 语义都是 Linux 的：Windows / macOS 上装代理
//! 也解决不了，因此 `deployable: false`，界面整块入口不渲染（FR-002 / AC-5）。
//!
//! 保持同签名：上层（`work_view::capabilities` / 能力应答）不按平台分支。

/// 能力探测的结果（平台无关的载体）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProbe {
    /// 常驻代理是否就绪（已安装 + 协议匹配 + 自检通过）
    pub ready: bool,
    /// 代理报回的 overlay 实测是否可挂
    pub overlay_ok: bool,
    /// 本平台**可能**通过装代理获得能力（Linux 且内核有 overlayfs）
    pub overlay_usable: bool,
    /// 不可用的原因（就绪且可挂时为空串）
    pub reason: String,
}

/// 探测能力。非 Linux 恒回「平台不支持，装代理也解决不了」。
pub fn probe_capabilities() -> CapabilityProbe {
    CapabilityProbe {
        ready: false,
        overlay_ok: false,
        overlay_usable: false,
        reason: format!(
            "对话工作视图只在 Linux Core 上可用：当前平台是 {}，装挂载代理也解决不了",
            std::env::consts::OS
        ),
    }
}

/// 结束代理连接。非 Linux 上没有代理可回收——保留同签名让调用点不必按平台分支。
pub fn shutdown() {}
