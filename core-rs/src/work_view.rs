//! 对话级 overlay 工作视图（specs/043）。
//!
//! 隔离视图对话的 Read / Write / Edit / Bash / Grep 看到「真实工作区 + 本对话改动」的叠加
//! 结果：`lowerdir` 是活磁盘，`upperdir` 是该对话私有的上层目录。因此磁盘是唯一基线事实
//! ——磁盘上后来新增 / 修改 / 删除的文件，对话里立即可见，不需要任何同步动作；而对话内的
//! 改动只落上层，不污染磁盘，对话之间互不可见。
//!
//! ## 为什么不是「分支快照」
//!
//! 快照语义要求「基线内容」来自导入那一刻的副本，磁盘后续改动看不见（这正是
//! specs/043 要解决的问题）。overlay 的 `lowerdir` 直接就是磁盘目录，无需复制、无需同步。
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

pub use imp::{
    bind_view_onto_workspace, capabilities, enter, list_view_dir, read_view_file, release, remove,
    WorkView, WorkViewHandle,
};

/// 本能力的应答（`UiRequest.storageCapabilitiesRequested`，specs/043 FR-001）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// 能否为对话建立隔离工作视图。
    pub isolated_work_view: bool,
    /// 不可用的原因；可用时为空串（契约成员全必选，「没有」用空串而非 `null`）。
    pub reason: String,
}

impl Capabilities {
    pub fn available() -> Self {
        Self {
            isolated_work_view: true,
            reason: String::new(),
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            isolated_work_view: false,
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
