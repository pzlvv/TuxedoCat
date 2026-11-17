//! Overlay 挂载代理的客户端（specs/051 FR-005b / FR-007 / FR-007b）。
//!
//! Core 自身**不**进用户 / 挂载命名空间、不 `unshare`、不 `exec`。它只做三件事：
//!
//! 1. **定位**已安装的代理（只认 `<core.mountProxyDir>/<core.mountProxyName>`，且必须
//!    `root:root` + `04755`；随包目录里的同名产物永不执行，见 FR-005b）；
//! 2. **拉起**常驻形态（`--serve --fd <n>`）并持有 socketpair；
//! 3. 在 socketpair 上**收代执行请求的结果**——挂载类请求在本阶段实现，工具代执行属
//!    阶段二（代理侧对这些 op 明确回「未实现」，Core 转成工具错误，不静默成功）。
//!
//! ## 为什么失败只改能力、不退出
//!
//! 代理缺失 / 版本不匹配 / `euid != 0` / 建立命名空间失败，任一情形都只把能力记为
//! `absent`（FR-007 / AC-28）：daemon 看到的 Core 必须照常服务帧通道。上一轮方案用
//! `exec` 把 Core 映像替换成代理，代理一拒绝就成了 Core 的退出码并触发重启风暴——那是
//! 本模块存在的直接原因（`docs/adr/0018-resident-mount-proxy.md`）。
//!
//! ## 平台
//!
//! 只在 Linux 上有意义；非 Linux 编译出同签名占位，能力恒回 `deployable: false`
//! （平台问题装代理也解决不了，界面因此不渲染入口，FR-002 / AC-5）。

use crate::work_view::{Capabilities, MountProxyState};

/// 产物名（构建期由 `src/config/project.json` 的 `core.mountProxyName` 烧入）
pub const PROXY_NAME: &str = env!("TC_MOUNT_PROXY_NAME");
/// 安装落点目录
pub const PROXY_DIR: &str = env!("TC_MOUNT_PROXY_DIR");

#[cfg(target_os = "linux")]
#[path = "mount_proxy/linux.rs"]
mod imp;

#[cfg(not(target_os = "linux"))]
#[path = "mount_proxy/unsupported.rs"]
mod imp;

pub use imp::{probe_capabilities, shutdown, CapabilityProbe};

/// 代理的安装位点（诊断与测试用）
pub fn installed_path() -> String {
    format!("{PROXY_DIR}/{PROXY_NAME}")
}

/// 把当前状态翻译成能力应答。
///
/// `deployable` 的唯一推导点在这里（FR-001）：Linux 且内核有 overlayfs 时，「装代理」才
/// 可能解决问题。代理已就绪时 `deployable` 恒 false（没有需要部署的东西）。
pub fn capabilities_from(probe: &CapabilityProbe) -> Capabilities {
    if probe.ready {
        if probe.overlay_ok {
            return Capabilities::available();
        }
        // 代理在、但 overlay 实测不可挂：装代理解决不了（AC-5 / 边界表的「内核无
        // overlayfs」一栏），因此 deployable 为 false，但原因要点名它。
        return Capabilities::with_mount_proxy(MountProxyState::Ready, false, probe.reason.clone());
    }
    if probe.overlay_usable {
        // Linux + 内核有 overlayfs：装代理可能解决
        Capabilities::deployable(probe.reason.clone())
    } else {
        Capabilities::with_mount_proxy(MountProxyState::Absent, false, probe.reason.clone())
    }
}
