//! 平台缝：Store 路径的词法规范化与父目录确定。
//!
//! 规范化只做词法操作（折叠冗余分隔符、去掉 `.` 段），不触碰文件系统、不解析符号
//! 链接、不折叠 `..`；两种等价写法在库内落为同一个 `StorePath`，库对外返回的路径即
//! 规范化形式（docs/core/layerfs.md 第 5 节）。跨进程写锁的平台实现在 writer_lock.rs。

use std::fmt;
use std::path::{Component, Path, PathBuf};

use layerfs::PersistenceError;

/// 规范化后的 Store 主文件路径。
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct StorePath {
    path: PathBuf,
}

impl StorePath {
    /// 从宿主路径构造：空路径或以分隔符结尾（没有文件名段）的路径被拒绝。
    pub fn from_os(path: &Path) -> Result<Self, PersistenceError> {
        if path.as_os_str().is_empty() {
            return Err(PersistenceError::Refused {
                status: "empty Store path".into(),
            });
        }
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                Component::CurDir => continue,
                other => normalized.push(other.as_os_str()),
            }
        }
        if normalized.file_name().is_none() {
            return Err(PersistenceError::Refused {
                status: "Store path has no file name".into(),
            });
        }
        Ok(Self { path: normalized })
    }

    /// 规范化路径。
    pub fn as_path(&self) -> &Path {
        &self.path
    }

    /// 写车道的协调键：Store 主文件所在目录；裸文件名用 `.`。
    pub fn parent_dir(&self) -> PathBuf {
        match self.path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        }
    }

    /// 主文件旁的侧文件路径（`-wal` / `-shm` / `-journal`）。
    pub(crate) fn sidecar(&self, suffix: &str) -> PathBuf {
        let mut os = self.path.as_os_str().to_os_string();
        os.push(suffix);
        PathBuf::from(os)
    }

    /// 取出规范化路径。
    pub fn into_path_buf(self) -> PathBuf {
        self.path
    }
}

impl fmt::Display for StorePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.path.display())
    }
}

#[cfg(test)]
#[path = "platform_tests.rs"]
mod tests;
