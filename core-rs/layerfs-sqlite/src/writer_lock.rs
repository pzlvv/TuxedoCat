//! 跨进程写者车道的平台缝：Linux 上是 Store 父目录的独占 flock。
//!
//! 绝不对 SQLite 的主 / WAL / SHM 文件另开描述符：关闭主文件的任何描述符都会取消本
//! 进程在该 inode 上的全部 POSIX 锁（含 SQLite 存活的 SHARED 锁）。独立打开的父目录
//! 描述符协调短写者作业而不干扰 SQLite 的描述符；同目录多个 Store 共享这条粗粒度车道。
//! 非 Linux 目标没有这层：跨进程写者冲突由 SQLite 自身的文件锁以精确 `Busy` 上报
//! （与上游 macOS 同款），Windows 换锁文件的扩展只动本文件（docs/core/layerfs.md 第 5 节）。

use crate::error::BackendError;
use crate::platform::StorePath;

#[cfg(target_os = "linux")]
use {
    nix::{
        errno::Errno,
        fcntl::{Flock, FlockArg},
    },
    std::fs::File,
};

/// 持有期间 = 单个原子事务（到已知 COMMIT 或明确 ROLLBACK）。
pub(crate) struct Writer {
    #[cfg(target_os = "linux")]
    lock: Flock<File>,
}

impl Writer {
    pub(crate) fn acquire(path: &StorePath) -> Result<Self, BackendError> {
        #[cfg(target_os = "linux")]
        {
            let directory = path.parent_dir();
            let file = File::open(&directory).map_err(|_| BackendError::Integrity)?;
            if !file
                .metadata()
                .map_err(|_| BackendError::Integrity)?
                .is_dir()
            {
                return Err(BackendError::Integrity);
            }
            // 在会话 FIFO 轮次之后的一次阻塞内核等待：每会话至多一个线程在此等待。
            // 出口：拿到锁（持有者进程退出即释放）；信号打断 → Cancelled。尚未尝试
            // BEGIN 或事务体。
            match Flock::lock(file, FlockArg::LockExclusive) {
                Ok(lock) => Ok(Self { lock }),
                Err((_, Errno::EINTR)) => Err(BackendError::Cancelled),
                Err(_) => Err(BackendError::Integrity),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Ok(Self {})
        }
    }

    pub(crate) fn release(self) -> Result<(), Self> {
        #[cfg(target_os = "linux")]
        {
            match self.lock.unlock() {
                Ok(file) => {
                    drop(file);
                    Ok(())
                }
                Err((lock, _)) => Err(Self { lock }),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(())
        }
    }
}
