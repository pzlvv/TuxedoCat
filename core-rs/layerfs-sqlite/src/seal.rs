//! seal：消费唯一会话，TRUNCATE checkpoint 一次，校验关闭且无侧文件残留。

use std::sync::Arc;

use layerfs::PersistenceError;

use crate::connection::Session;
use crate::error::{map, BackendError};
use crate::open::Handles;
use crate::profile::SqlitePersistenceProfile;
use crate::writer_lock::Writer;

/// 经检查的已关闭 Store 文件，可供一次显式交付。
#[derive(Clone, Debug)]
pub struct SealedStore {
    /// 已关闭的数据库文件；seal 完成时没有侧文件存在。
    pub path: std::path::PathBuf,
    /// 打开交付后的 Store 时应使用的 profile。
    pub profile: SqlitePersistenceProfile,
    /// 创建 / seal 该文件的 SQLite 版本。
    pub sqlite_version: String,
    /// WAL checkpoint 并关连接后的主文件字节数。
    pub bytes: u64,
}

impl Handles {
    /// 消费唯一会话，checkpoint 一次，关闭并校验只剩一个文件。
    ///
    /// 仍被持有的 provider / `Storage` / `Reader` / `Save` 在任何 checkpoint 之前以
    /// `Busy` 拒绝。另一进程可能阻碍 checkpoint 或留下侧文件：两种情况都不触发重试
    /// 或删除。交付期间必须由供给流程排除新的打开者。
    pub fn seal(self) -> Result<SealedStore, PersistenceError> {
        let Self { storage } = self;
        let storage = Arc::try_unwrap(storage).map_err(|_| PersistenceError::Busy)?;
        let session = Arc::try_unwrap(storage.session).map_err(|_| PersistenceError::Busy)?;
        session.seal()
    }
}

impl Session {
    pub(crate) fn seal(self) -> Result<SealedStore, PersistenceError> {
        if !self.writable {
            return Err(BackendError::ReadOnly.into());
        }
        let state = self
            .state
            .into_inner()
            .map_err(|_| PersistenceError::Uncertain)?;
        if state.quarantined || !state.connection.is_autocommit() {
            return Err(PersistenceError::Uncertain);
        }
        // seal 同样走写者车道：checkpoint 与检查关闭期间独占跨进程准入。
        let mut state = state;
        state.writer_hold = Some(Writer::acquire(&self.path)?);
        let busy: i64 = state
            .connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(map)?;
        if busy != 0 {
            return Err(PersistenceError::Busy);
        }
        state.connection.close().map_err(|(_, error)| map(error))?;
        // SQLite 已检查关闭，之后才释放跨进程所有权；更早的错误出口按字段声明顺序
        // 先 drop 连接再 drop 锁。
        if let Some(writer) = state.writer_hold {
            writer.release().map_err(|_| PersistenceError::Uncertain)?;
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            match std::fs::symlink_metadata(self.path.sidecar(suffix)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Ok(_) => {
                    return Err(PersistenceError::Refused {
                        status: "Store sidecar remains after seal".into(),
                    })
                }
                Err(error) => {
                    return Err(PersistenceError::Refused {
                        status: error.to_string(),
                    })
                }
            }
        }
        let bytes = std::fs::metadata(self.path.as_path())
            .map_err(|error| PersistenceError::Refused {
                status: error.to_string(),
            })?
            .len();
        Ok(SealedStore {
            path: self.path.into_path_buf(),
            profile: self.profile.persistence,
            sqlite_version: self.profile.sqlite_version,
            bytes,
        })
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
