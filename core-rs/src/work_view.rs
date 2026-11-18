//! 对话级 overlay 工作视图（specs/045）。
//!
//! 隔离视图对话的 Read / Write / Edit / Bash / Grep 看到「真实工作区 + 本对话改动」的叠加
//! 结果：`lowerdir` 是活磁盘，`upperdir` 是该对话私有的上层目录。因此磁盘是唯一基线事实
//! ——磁盘上后来新增 / 修改 / 删除的文件，对话里立即可见，不需要任何同步动作；而对话内的
//! 改动只落上层，不污染磁盘，对话之间互不可见。
//!
//! ## 为什么不是「分支快照」
//!
//! 快照语义要求「基线内容」来自导入那一刻的副本，磁盘后续改动看不见（这正是
//! specs/045 要解决的问题）。overlay 的 `lowerdir` 直接就是磁盘目录，无需复制、无需同步。
//!
//! ## 为什么上层不能用 LayerFS 分支
//!
//! overlay 要求上层能写扩展属性（`trusted.overlay.*`）并创建字符设备 whiteout（表达删除），
//! 而 `layerfs-fuse` 的 `setxattr` 系列回调全部返回拒绝、`mknod` 仅放行普通文件与目录。
//! 实测挂载直接失败，故上层用普通目录。
//!
//! ## 删除目录需要 `userxattr`
//!
//! 非特权用户命名空间里，overlay 若不启用 `userxattr`，删除目录会 `EIO`（它需要写
//! `trusted.overlay.*` 而当前用户没有该命名空间的 CAP_SYS_ADMIN）。挂载参数因此固定带
//! `userxattr`。
//!
//! 平台：只在 Linux 上提供能力。其它平台编译出同签名类型，能力恒回不可用。

#[allow(unused_imports)]
pub use imp::{
    bind_view_onto_workspace, capabilities, changes, enter, file_diff, list_view_dir, release,
    remove, WorkView, WorkViewHandle,
};

/// 视图里的 git 取数（specs/047）：变更清单与文件两侧原文。
///
/// 平台无关的解析与编排在这里，挂载与句柄由平台实现提供。非 Linux 上无法构造
/// （`WorkViewHandle::of` 恒 `None`），能力探测也回不可用。
#[path = "work_view_changes.rs"]
mod git_view;

#[cfg_attr(not(test), allow(unused_imports))]
pub use git_view::{ChangeEntry, ChangeScope, ChangesOutcome, FileDiffOutcome, GitView};

/// 本能力的应答（`UiRequest.storageCapabilitiesRequested`，specs/045 FR-001）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// 能否为对话建立隔离工作视图。
    ///
    /// 判据 = 常驻代理就绪**且**它报回 overlay 实测可挂（specs/051 FR-001）。Core 自身
    /// 不进命名空间，因此本字段为 true 必然意味着 `mount_proxy == Ready`。
    pub isolated_work_view: bool,
    /// 挂载代理的状态（specs/051 FR-001 的根字段）。
    pub mount_proxy: MountProxyState,
    /// `isolated_work_view` 为 false 时，「装代理」是否**可能**解决它（派生字段）。
    ///
    /// 推导点只有 Core 一处：平台是 Linux + 内核支持 overlayfs + 代理尚未就绪。宿主不重算、
    /// 不缓存，每次需要都问 Core。
    pub deployable: bool,
    /// 不可用的原因；可用时为空串（契约成员全必选，「没有」用空串而非 `null`）。
    pub reason: String,
}

/// 挂载代理的就位状态（`UiRequest.storageCapabilitiesRequested` 的 `mountProxy`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MountProxyState {
    /// 已安装、协议版本匹配、且它报回 overlay 实测可挂。
    Ready,
    /// 未安装 / 版本不匹配 / 自检未通过 / 未拉起——三者对界面的含义都是「需要部署」。
    Absent,
}

impl MountProxyState {
    pub fn as_str(self) -> &'static str {
        match self {
            MountProxyState::Ready => "ready",
            MountProxyState::Absent => "absent",
        }
    }
}

impl Capabilities {
    pub fn available() -> Self {
        Self {
            isolated_work_view: true,
            mount_proxy: MountProxyState::Ready,
            deployable: false,
            reason: String::new(),
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self::with_mount_proxy(MountProxyState::Absent, false, reason)
    }

    /// 代理未就绪，但**部署它可能解决问题**（Linux + 有 overlayfs）。
    pub fn deployable(reason: impl Into<String>) -> Self {
        Self::with_mount_proxy(MountProxyState::Absent, true, reason)
    }

    pub fn with_mount_proxy(
        mount_proxy: MountProxyState,
        deployable: bool,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            isolated_work_view: false,
            mount_proxy,
            deployable,
            reason: reason.into(),
        }
    }
}

#[cfg(target_os = "linux")]
#[path = "work_view_linux.rs"]
mod imp;

#[cfg(not(target_os = "linux"))]
#[path = "work_view_unsupported.rs"]
mod imp;

#[cfg(all(test, target_os = "linux"))]
#[path = "work_view_tests.rs"]
mod tests;
