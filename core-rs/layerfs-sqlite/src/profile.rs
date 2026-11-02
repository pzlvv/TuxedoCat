//! 持久化 profile：显式、不可变，打开时逐项实测，绝不自动转换 Store。
//!
//! 唯一实现的 profile 是 `Disposable`（WAL / `synchronous=OFF`，身份串
//! `sqlite-wal-off-v2`）：与上游所有者决策一致——`Durable`（`sqlite-wal-full-v2`）在上游
//! 已停用，未经所有者重新授权不得执行，本 crate 不实现它（docs/core/layerfs.md 第 5 节）。

use rusqlite::{limits::Limit, Connection};

use crate::error::{map, BackendError};

/// 显式的 SQLite 完成 / 持久性契约，打开前选定。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqlitePersistenceProfile {
    /// WAL / OFF：进程终止可存活，不提供内核崩溃持久性。
    Disposable,
}

impl SqlitePersistenceProfile {
    /// 不可变 profile 身份串。
    pub const fn identity(self) -> &'static str {
        match self {
            Self::Disposable => "sqlite-wal-off-v2",
        }
    }

    pub(crate) const fn journal(self) -> &'static str {
        "wal"
    }

    pub(crate) const fn synchronous(self) -> i64 {
        match self {
            Self::Disposable => 0,
        }
    }
}

/// 从真实连接读回的设置与引擎能力。
#[derive(Clone, Debug)]
pub struct ConnectionProfile {
    /// 显式选定的完成 / 持久性契约。
    pub persistence: SqlitePersistenceProfile,
    /// 不可变 profile 身份串。
    pub identity: &'static str,
    /// 链接的引擎版本。
    pub sqlite_version: String,
    /// 选定的 journal 模式，每个相关连接都核对。
    pub journal_mode: String,
    /// Disposable 为 0。
    pub synchronous: i64,
    /// 必须启用外键。
    pub foreign_keys: i64,
    /// 数据库页字节数。
    pub page_size: i64,
    /// 自动 checkpoint 页间隔。
    pub wal_autocheckpoint: i64,
    /// 保留的 journal 字节上限，不是 WAL 高水位保证。
    pub journal_size_limit: i64,
    /// 负 KiB 页缓存选择。
    pub cache_size: i64,
    /// busy handler 上限：零。
    pub busy_timeout: i64,
    /// 内存映射窗口：零。
    pub mmap_size: i64,
    /// 临时存储选择：2（内存）。
    pub temp_store: i64,
    /// 实际绑定变量上限。
    pub variable_limit: usize,
    /// 实际 SQL 字节上限。
    pub sql_length_limit: usize,
    /// 实际行 / BLOB 字节上限。
    pub length_limit: usize,
}

/// 应用选定 profile；创建时先定页大小再选 WAL，打开已有库时只核对不转换。
pub(crate) fn apply(
    connection: &Connection,
    create: bool,
    selected: SqlitePersistenceProfile,
) -> Result<(), BackendError> {
    // WAL 选择本身可能写主文件：先把同步策略定下来，再做任何写操作。
    pragma_set(connection, "synchronous", selected.synchronous())?;
    if create {
        pragma_set(connection, "page_size", 4096)?;
        let mode: String = connection
            .query_row(
                &format!("PRAGMA journal_mode={}", selected.journal()),
                [],
                |row| row.get(0),
            )
            .map_err(map)?;
        if mode != selected.journal() {
            return Err(BackendError::Integrity);
        }
    } else {
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(map)?;
        if mode != selected.journal() {
            return Err(BackendError::Integrity);
        }
    }
    for (name, value) in [
        ("foreign_keys", 1),
        ("wal_autocheckpoint", 1000),
        ("journal_size_limit", 4_194_304),
        ("cache_size", -2048),
        ("mmap_size", 0),
        ("temp_store", 2),
    ] {
        pragma_set(connection, name, value)?;
    }
    Ok(())
}

/// 从连接读回全部设置。
pub(crate) fn read_back(
    connection: &Connection,
    selected: SqlitePersistenceProfile,
) -> Result<ConnectionProfile, BackendError> {
    let integer = |name: &str| -> Result<i64, BackendError> {
        connection
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .map_err(map)
    };
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(map)?;
    let limit = |limit: Limit| -> Result<usize, BackendError> {
        connection
            .limit(limit)
            .map(|value| value as usize)
            .map_err(map)
    };
    Ok(ConnectionProfile {
        persistence: selected,
        identity: selected.identity(),
        sqlite_version: rusqlite::version().to_owned(),
        journal_mode,
        synchronous: integer("synchronous")?,
        foreign_keys: integer("foreign_keys")?,
        page_size: integer("page_size")?,
        wal_autocheckpoint: integer("wal_autocheckpoint")?,
        journal_size_limit: integer("journal_size_limit")?,
        cache_size: integer("cache_size")?,
        busy_timeout: integer("busy_timeout")?,
        mmap_size: integer("mmap_size")?,
        temp_store: integer("temp_store")?,
        variable_limit: limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER)?,
        sql_length_limit: limit(Limit::SQLITE_LIMIT_SQL_LENGTH)?,
        length_limit: limit(Limit::SQLITE_LIMIT_LENGTH)?,
    })
}

/// 逐项实测：任一不符即拒开。
pub(crate) fn check(profile: &ConnectionProfile) -> Result<(), BackendError> {
    let selected = profile.persistence;
    if profile.journal_mode != selected.journal()
        || profile.synchronous != selected.synchronous()
        || profile.foreign_keys != 1
        || profile.page_size != 4096
        || profile.wal_autocheckpoint != 1000
        || profile.journal_size_limit != 4_194_304
        || profile.cache_size != -2048
        || profile.busy_timeout != 0
        || profile.mmap_size != 0
        || profile.temp_store != 2
        || profile.length_limit < layerfs::policy::SINGLETON_PACK_LIMIT + 1024
        || profile.sql_length_limit < 4096
        || profile.variable_limit < 6
    {
        return Err(BackendError::Integrity);
    }
    Ok(())
}

fn pragma_set(connection: &Connection, name: &str, value: i64) -> Result<(), BackendError> {
    // 部分 PRAGMA 赋值会返回一行（如 journal_size_limit），用 query 路径统一吞掉。
    let mut statement = connection
        .prepare(&format!("PRAGMA {name}={value}"))
        .map_err(map)?;
    let mut rows = statement.query([]).map_err(map)?;
    while rows.next().map_err(map)?.is_some() {}
    Ok(())
}
