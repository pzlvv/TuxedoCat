//! 后端错误：一次元数据操作尝试的类型化结果，与上游 persistence 的 `BackendError` 同形。

use layerfs::PersistenceError;
use rusqlite::{Error, ErrorCode};

/// 后端内部错误；对外经 `From` 映射为 [`PersistenceError`]。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BackendError {
    /// 写锁被持有或引擎报 BUSY / LOCKED / PROTOCOL；未产生写效果。
    Busy,
    /// Store 在调用排队或开始前已关闭。
    Closed,
    /// 信号打断了跨进程写者等待（仅 Linux）。
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Cancelled,
    /// 只读会话上请求写事务。
    ReadOnly,
    /// 磁盘满或超出引擎大小上限。
    Capacity,
    /// schema / 约束 / 文件身份不符。
    Integrity,
    /// 结果未知：I/O 失败或连接被隔离。
    Unknown,
}

impl From<BackendError> for PersistenceError {
    fn from(error: BackendError) -> Self {
        match error {
            BackendError::Unknown => Self::Uncertain,
            BackendError::Busy => Self::Busy,
            BackendError::Integrity => Self::Malformed,
            BackendError::Closed => Self::Closed,
            BackendError::Cancelled => Self::Cancelled,
            other => Self::Refused {
                status: format!("{other:?}"),
            },
        }
    }
}

/// rusqlite 错误到后端错误的唯一映射（与上游 rows::error 同表）。
pub(crate) fn map(error: Error) -> BackendError {
    match error {
        Error::SqliteFailure(code, _) => match code.code {
            ErrorCode::DatabaseBusy
            | ErrorCode::DatabaseLocked
            | ErrorCode::FileLockingProtocolFailed => BackendError::Busy,
            ErrorCode::ReadOnly => BackendError::ReadOnly,
            ErrorCode::DiskFull | ErrorCode::TooBig => BackendError::Capacity,
            ErrorCode::SystemIoFailure | ErrorCode::CannotOpen | ErrorCode::OutOfMemory => {
                BackendError::Unknown
            }
            ErrorCode::ConstraintViolation
            | ErrorCode::TypeMismatch
            | ErrorCode::DatabaseCorrupt
            | ErrorCode::NotADatabase => BackendError::Integrity,
            _ => BackendError::Unknown,
        },
        _ => BackendError::Integrity,
    }
}
