//! schema v1：创建时写入 DDL 与策略行；打开时精确校验身份与定义。
//!
//! 校验是精确的：`application_id` / `user_version` 必须完全一致，表名单不多不少
//! （`sqlite_%` 内部表除外），每个表 / 触发器的定义文本必须与用同一 DDL 在内存库里
//! 建出的定义逐字一致（因此 `STRICT`、role 边界等 CHECK 文本都被核对）；更高或更低的
//! schema 版本一律拒绝，不迁移、不修改文件（docs/core/layerfs.md 第 5 节）。

use layerfs::policy::{ConstructionPolicy, StoragePolicy};
use rusqlite::{params, Connection};

use crate::connection::Session;
use crate::error::{map, BackendError};

/// 本系列自己的 application_id（`"TCLF"` 的大端 u32），与上游 Store 无关。
pub(crate) const APPLICATION_ID: i64 = 0x5443_4C46;
/// 本系列的 schema 版本；后续编码 spec 前向递增，旧版拒开不迁移。
pub(crate) const USER_VERSION: i64 = 1;
/// schema v1 DDL。
pub(crate) const SCHEMA_V1: &str = include_str!("../sql/schema_v1.sql");

/// 期望的表名单（已排序）。
const TABLES: [&str; 4] = ["object_location", "pack", "store_policy", "store_totals"];

impl Session {
    /// 一次事务内写入身份、DDL、策略行与计数行。
    pub(crate) fn initialize(&self, policy: StoragePolicy) -> Result<(), BackendError> {
        self.run(true, |connection| {
            connection
                .execute_batch(&format!(
                    "PRAGMA application_id={APPLICATION_ID};PRAGMA user_version={USER_VERSION};"
                ))
                .map_err(map)?;
            connection.execute_batch(SCHEMA_V1).map_err(map)?;
            let construction = policy.construction();
            connection
                .execute(
                    "INSERT INTO store_policy(id,format_profile,cdc_profile_id,small_file_threshold_bytes,whole_file_delta_max_depth,chunk_delta_max_depth,metadata_delta_max_depth,next_pack_id) VALUES(1,?1,?2,?3,?4,?5,?6,1)",
                    params![
                        i64::from(policy.format_profile()),
                        policy.cdc_profile_id().as_slice(),
                        construction.small_file_threshold_bytes() as i64,
                        i64::from(construction.whole_file_delta_max_depth()),
                        i64::from(construction.chunk_delta_max_depth()),
                        i64::from(policy.metadata_delta_max_depth()),
                    ],
                )
                .map_err(map)?;
            connection
                .execute("INSERT INTO store_totals(id) VALUES(1)", [])
                .map_err(map)?;
            Ok(())
        })
    }

    /// 打开期校验：身份、表名单、定义文本逐字一致。
    pub(crate) fn validate(&self) -> Result<(), BackendError> {
        self.run(false, |connection| check(connection))
    }

    /// 读回持久化策略行。
    pub(crate) fn policy(&self) -> Result<StoragePolicy, BackendError> {
        self.read_immutable(|connection| read_policy(connection))
    }
}

pub(crate) fn read_policy(connection: &Connection) -> Result<StoragePolicy, BackendError> {
    let row = connection
        .query_row(
            "SELECT format_profile,cdc_profile_id,small_file_threshold_bytes,whole_file_delta_max_depth,chunk_delta_max_depth,metadata_delta_max_depth FROM store_policy WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .map_err(map)?;
    let format_profile = u8::try_from(row.0).map_err(|_| BackendError::Integrity)?;
    let cdc_profile_id: [u8; 32] = row.1.try_into().map_err(|_| BackendError::Integrity)?;
    let threshold = u64::try_from(row.2).map_err(|_| BackendError::Integrity)?;
    let depth = |value: i64| u8::try_from(value).map_err(|_| BackendError::Integrity);
    Ok(StoragePolicy::from_persisted(
        format_profile,
        cdc_profile_id,
        ConstructionPolicy::new(threshold, depth(row.3)?, depth(row.4)?),
        depth(row.5)?,
    ))
}

fn check(connection: &Connection) -> Result<(), BackendError> {
    let application_id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(map)?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(map)?;
    if application_id != APPLICATION_ID || user_version != USER_VERSION {
        return Err(BackendError::Integrity);
    }
    let actual = table_names(connection)?;
    if actual != TABLES {
        return Err(BackendError::Integrity);
    }
    if definition(connection)? != expected_definition()? {
        return Err(BackendError::Integrity);
    }
    Ok(())
}

fn table_names(connection: &Connection) -> Result<Vec<String>, BackendError> {
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7)!='sqlite_' ORDER BY name")
        .map_err(map)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(map)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map)?;
    Ok(names)
}

/// 全部非内部对象的 `type,name,sql` 定义文本。
fn definition(connection: &Connection) -> Result<String, BackendError> {
    let mut statement = connection
        .prepare("SELECT type,name,sql FROM sqlite_schema WHERE substr(name,1,7)!='sqlite_' ORDER BY type,name")
        .map_err(map)?;
    let rows = statement
        .query_map([], |row| {
            Ok(format!(
                "{}\n{}\n{}\n",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?
            ))
        })
        .map_err(map)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map)?;
    Ok(rows.concat())
}

/// 同一 DDL 在内存库里的定义文本：打开期比对的唯一基准。
fn expected_definition() -> Result<String, BackendError> {
    let reference = Connection::open_in_memory().map_err(map)?;
    reference.execute_batch(SCHEMA_V1).map_err(map)?;
    definition(&reference)
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
