//! 一个数据库会话：连接、准入队列、写者锁持有与隔离标志；以及一次尝试的事务车道。
//!
//! 车道顺序：会话 FIFO 轮次 → （写事务）父目录 flock → 单次 `BEGIN IMMEDIATE` →
//! 事务体 → 已知 COMMIT 或明确 ROLLBACK → 释放锁。`SQLITE_BUSY / LOCKED / PROTOCOL`
//! 映射为类型化 `Busy`，绝不重试、不重放；结果无法证明的失败让会话进入隔离
//! （`quarantined`），此后一切调用报 `Unknown`（docs/core/layerfs.md 第 5 节）。

use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};

use crate::admission::Admission;
use crate::error::{map, BackendError};
use crate::platform::StorePath;
use crate::profile::{self, ConnectionProfile, SqlitePersistenceProfile};
use crate::writer_lock::Writer;

pub(crate) struct State {
    pub(crate) connection: Connection,
    pub(crate) quarantined: bool,
    pub(crate) writer_hold: Option<Writer>,
}

impl State {
    /// 释放写者锁；释放失败即隔离会话并保留锁（连接拆除先于锁释放）。
    pub(crate) fn finish_writer(&mut self) -> Result<(), BackendError> {
        if self.quarantined {
            return Ok(());
        }
        if let Some(writer) = self.writer_hold.take() {
            if let Err(retained) = writer.release() {
                self.quarantined = true;
                self.writer_hold = Some(retained);
                return Err(BackendError::Unknown);
            }
        }
        Ok(())
    }
}

pub(crate) struct Session {
    pub(crate) admission: Admission,
    pub(crate) state: Mutex<State>,
    pub(crate) writable: bool,
    pub(crate) profile: ConnectionProfile,
    pub(crate) path: StorePath,
}

impl Session {
    pub(crate) fn connect(
        path: StorePath,
        writable: bool,
        create: bool,
        selected: SqlitePersistenceProfile,
    ) -> Result<Self, BackendError> {
        let flags = if writable {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(path.as_path(), flags).map_err(map)?;
        connection.set_prepared_statement_cache_capacity(64);
        connection
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(map)?;
        connection
            .set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
            .map_err(map)?;
        profile::apply(&connection, create, selected)?;
        let profile = profile::read_back(&connection, selected)?;
        profile::check(&profile)?;
        Ok(Self {
            admission: Admission::default(),
            state: Mutex::new(State {
                connection,
                quarantined: false,
                writer_hold: None,
            }),
            writable,
            profile,
            path,
        })
    }

    /// 只读不可变行的读取：经准入与状态锁，不开显式事务——每条语句各自取隐式快照。
    /// 只对一旦可见就不再变化的行安全（定位行只插入、pack 禁改删、计数器只增）。
    pub(crate) fn read_immutable<T>(
        &self,
        body: impl FnOnce(&Connection) -> Result<T, BackendError>,
    ) -> Result<T, BackendError> {
        let _turn = self.admission.enter()?;
        let mut state = self.state.lock().map_err(|_| BackendError::Unknown)?;
        if state.quarantined {
            return Err(BackendError::Unknown);
        }
        // 更早的不确定事务不可被继承，也不可猜测已完成。
        if !state.connection.is_autocommit() {
            state.quarantined = true;
            return Err(BackendError::Unknown);
        }
        let result = body(&state.connection);
        if !state.connection.is_autocommit() || result.is_unknown() {
            state.quarantined = true;
            return Err(BackendError::Unknown);
        }
        result
    }

    /// 一次尝试的事务：写事务先取父目录锁再 `BEGIN IMMEDIATE`，读事务 `BEGIN`。
    pub(crate) fn run<T>(
        &self,
        writable: bool,
        body: impl FnOnce(&Connection) -> Result<T, BackendError>,
    ) -> Result<T, BackendError> {
        if writable && !self.writable {
            return Err(BackendError::ReadOnly);
        }
        let _turn = self.admission.enter()?;
        let mut state = self.state.lock().map_err(|_| BackendError::Unknown)?;
        if state.quarantined {
            return Err(BackendError::Unknown);
        }
        if writable {
            // State 在 BEGIN 之前就拥有它，跨 panic unwind 也一样。
            state.writer_hold = Some(Writer::acquire(&self.path)?);
        }
        let begin = if writable { "BEGIN IMMEDIATE" } else { "BEGIN" };
        if let Err(error) = state.connection.execute_batch(begin).map_err(map) {
            if error == BackendError::Unknown {
                state.quarantined = true;
            }
            state.finish_writer()?;
            return Err(error);
        }
        let result = body(&state.connection);
        if result.is_unknown() {
            state.quarantined = true;
            state.finish_writer()?;
            return Err(BackendError::Unknown);
        }
        let result = match result {
            Ok(value) => match state.connection.execute_batch("COMMIT").map_err(map) {
                Ok(()) => Ok(value),
                Err(error) => {
                    if error == BackendError::Unknown {
                        state.quarantined = true;
                        Err(error)
                    } else if !state.connection.is_autocommit()
                        && state.connection.execute_batch("ROLLBACK").is_err()
                    {
                        state.quarantined = true;
                        Err(BackendError::Unknown)
                    } else {
                        Err(error)
                    }
                }
            },
            Err(error) => {
                if !state.connection.is_autocommit() {
                    match state.connection.execute_batch("ROLLBACK") {
                        Ok(()) => Err(error),
                        Err(_) => {
                            state.quarantined = true;
                            Err(BackendError::Unknown)
                        }
                    }
                } else {
                    Err(error)
                }
            }
        };
        state.finish_writer()?;
        result
    }
}

/// `Result<T, BackendError>` 与 `Err(Unknown)` 的相等比较要求 `T: PartialEq`；
/// 用显式判别代替，避免给每个 `T` 加约束。
trait UnknownOutcome {
    fn is_unknown(&self) -> bool;
}

impl<T> UnknownOutcome for Result<T, BackendError> {
    fn is_unknown(&self) -> bool {
        matches!(self, Err(BackendError::Unknown))
    }
}

#[cfg(test)]
#[path = "lane_tests.rs"]
mod tests;
