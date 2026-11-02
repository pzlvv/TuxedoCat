//! `ObjectPersistence` 的 SQLite 实现：定位、整包读出、pack id 分配与原子发布。
//!
//! `locate` / `read_packs` 读不可变行（不开显式事务，每语句一个隐式快照）；`reserve`
//! 与 `publish` 各是一次写事务：pack 行插入 + `object_location` first-wins 插入
//! （`ON CONFLICT DO NOTHING RETURNING`）+ `store_totals` 累加——败方名单由未返回的
//! 对象推得（docs/core/layerfs.md 第 4 节）。

use std::collections::BTreeSet;
use std::sync::Arc;

use layerfs::policy::{BATCH_OBJECT_LIMIT, PACK_LIMIT};
use layerfs::port::{
    LocatedObject, ObjectKey, ObjectLocation, ObjectPersistence, PackDomain, PackInfo,
    PersistedPack, PersistenceError, Publication, Published, PublishedPack, Reserve, Reserved,
};
use layerfs::{ObjectId, ObjectRole, StoragePolicy};
use rusqlite::{params, Connection, ToSql};

use crate::connection::Session;
use crate::error::{map, BackendError};

/// 应用持有的物理端口；`Handles::storage` 以 `Arc` 共享给 `Storage::new`。
pub struct StorageProvider {
    pub(crate) session: Arc<Session>,
}

impl ObjectPersistence for StorageProvider {
    fn policy(&self) -> Result<StoragePolicy, PersistenceError> {
        self.session.policy().map_err(Into::into)
    }

    fn locate(
        &self,
        ids: &[ObjectId],
        out: &mut Vec<LocatedObject>,
    ) -> Result<(), PersistenceError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.session
            .read_immutable(|connection| locate(connection, ids, out))
            .map_err(Into::into)
    }

    fn read_packs(
        &self,
        ids: &[i64],
        out: &mut Vec<PersistedPack>,
    ) -> Result<(), PersistenceError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.session
            .read_immutable(|connection| read_packs(connection, ids, out))
            .map_err(Into::into)
    }

    fn reserve(&self, request: Reserve) -> Result<Reserved, PersistenceError> {
        self.session
            .run(true, |connection| reserve(connection, request))
            .map_err(Into::into)
    }

    fn publish(&self, batch: &Publication) -> Result<Published, PersistenceError> {
        self.session
            .run(true, |connection| publish(connection, batch))
            .map_err(Into::into)
    }
}

fn locate(
    connection: &Connection,
    ids: &[ObjectId],
    out: &mut Vec<LocatedObject>,
) -> Result<(), BackendError> {
    let mut statement = connection
        .prepare_cached(
            "SELECT o.role,o.canonical_length,o.pack_id,o.group_number,o.record_number,p.domain,p.digest,p.length FROM object_location o JOIN pack p ON p.pack_id=o.pack_id WHERE o.object_id=?1",
        )
        .map_err(map)?;
    for id in ids {
        let mut rows = statement
            .query(params![id.as_bytes().as_slice()])
            .map_err(map)?;
        let Some(row) = rows.next().map_err(map)? else {
            continue;
        };
        let role = ObjectRole::from_code(
            u8::try_from(row.get::<_, i64>(0).map_err(map)?)
                .map_err(|_| BackendError::Integrity)?,
        )
        .map_err(|_| BackendError::Integrity)?;
        let domain = PackDomain::from_code(
            u8::try_from(row.get::<_, i64>(5).map_err(map)?)
                .map_err(|_| BackendError::Integrity)?,
        )
        .map_err(|_| BackendError::Integrity)?;
        let digest: [u8; 32] = row
            .get::<_, Vec<u8>>(6)
            .map_err(map)?
            .try_into()
            .map_err(|_| BackendError::Integrity)?;
        let to_usize = |value: i64| usize::try_from(value).map_err(|_| BackendError::Integrity);
        let pack_id = row.get::<_, i64>(2).map_err(map)?;
        out.push(LocatedObject {
            location: ObjectLocation {
                object_id: *id,
                role,
                canonical_length: to_usize(row.get::<_, i64>(1).map_err(map)?)?,
                pack_id,
                group_number: to_usize(row.get::<_, i64>(3).map_err(map)?)?,
                record_number: to_usize(row.get::<_, i64>(4).map_err(map)?)?,
            },
            pack: PackInfo {
                pack_id,
                domain,
                key: ObjectKey::from_bytes(digest),
                length: to_usize(row.get::<_, i64>(7).map_err(map)?)?,
            },
        });
    }
    Ok(())
}

fn read_packs(
    connection: &Connection,
    ids: &[i64],
    out: &mut Vec<PersistedPack>,
) -> Result<(), BackendError> {
    let mut statement = connection
        .prepare_cached("SELECT domain,digest,length,body FROM pack WHERE pack_id=?1")
        .map_err(map)?;
    for pack_id in ids {
        let mut rows = statement.query(params![pack_id]).map_err(map)?;
        let Some(row) = rows.next().map_err(map)? else {
            continue;
        };
        let domain = PackDomain::from_code(
            u8::try_from(row.get::<_, i64>(0).map_err(map)?)
                .map_err(|_| BackendError::Integrity)?,
        )
        .map_err(|_| BackendError::Integrity)?;
        let digest: [u8; 32] = row
            .get::<_, Vec<u8>>(1)
            .map_err(map)?
            .try_into()
            .map_err(|_| BackendError::Integrity)?;
        let length = usize::try_from(row.get::<_, i64>(2).map_err(map)?)
            .map_err(|_| BackendError::Integrity)?;
        let body: Vec<u8> = row.get(3).map_err(map)?;
        out.push(PersistedPack {
            info: PackInfo {
                pack_id: *pack_id,
                domain,
                key: ObjectKey::from_bytes(digest),
                length,
            },
            body,
        });
    }
    Ok(())
}

fn reserve(connection: &Connection, request: Reserve) -> Result<Reserved, BackendError> {
    let count = i64::try_from(request.packs).map_err(|_| BackendError::Capacity)?;
    let first: i64 = connection
        .query_row(
            "UPDATE store_policy SET next_pack_id=next_pack_id+?1 WHERE id=1 RETURNING next_pack_id-?1",
            params![count],
            |row| row.get(0),
        )
        .map_err(map)?;
    if first <= 0 {
        return Err(BackendError::Integrity);
    }
    Ok(Reserved {
        first_pack_id: first,
    })
}

fn publish(connection: &Connection, batch: &Publication) -> Result<Published, BackendError> {
    write_packs(connection, &batch.packs)?;
    let mut inserted: BTreeSet<ObjectId> = BTreeSet::new();
    let mut statement = connection
        .prepare_cached(
            "INSERT INTO object_location(object_id,role,canonical_length,pack_id,group_number,record_number) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(object_id) DO NOTHING RETURNING object_id",
        )
        .map_err(map)?;
    for row in &batch.objects {
        let mut rows = statement
            .query(params![
                row.object_id.as_bytes().as_slice(),
                i64::from(row.role.code()),
                row.canonical_length as i64,
                row.pack_id,
                row.group_number as i64,
                row.record_number as i64,
            ])
            .map_err(map)?;
        if rows.next().map_err(map)?.is_some() {
            inserted.insert(row.object_id);
        }
    }
    drop(statement);
    let canonical: u64 = batch
        .objects
        .iter()
        .filter(|row| inserted.contains(&row.object_id))
        .map(|row| row.canonical_length as u64)
        .sum();
    let stored: u64 = batch.packs.iter().map(|pack| pack.info.length as u64).sum();
    let metadata: u64 = batch
        .packs
        .iter()
        .filter(|pack| pack.info.domain == PackDomain::Metadata)
        .map(|pack| pack.info.length as u64)
        .sum();
    if canonical != 0 || stored != 0 || metadata != 0 {
        connection
            .execute(
                "UPDATE store_totals SET canonical=canonical+?1,stored=stored+?2,metadata=metadata+?3 WHERE id=1",
                params![canonical as i64, stored as i64, metadata as i64],
            )
            .map_err(map)?;
    }
    Ok(Published {
        lost: batch
            .objects
            .iter()
            .filter(|row| !inserted.contains(&row.object_id))
            .map(|row| row.object_id)
            .collect(),
    })
}

/// 按调用顺序把完整不可变包体分页插入；一页的绑定字节不超过一个普通 pack 的上限。
fn write_packs(connection: &Connection, packs: &[PublishedPack]) -> Result<(), BackendError> {
    if packs.is_empty() {
        return Ok(());
    }
    const PREFIX: &str = "INSERT INTO pack(pack_id,domain,digest,length,body) VALUES ";
    const ROW: &str = "(?,?,?,?,?)";
    let mut remaining = packs;
    while !remaining.is_empty() {
        let mut count = 1;
        let mut bytes = remaining[0].body.len() as u64 + 56;
        while count < remaining.len().min(BATCH_OBJECT_LIMIT) {
            let next = remaining[count].body.len() as u64 + 56;
            if bytes.saturating_add(next) > PACK_LIMIT as u64 + 56 {
                break;
            }
            bytes += next;
            count += 1;
        }
        let (page, tail) = remaining.split_at(count);
        remaining = tail;
        let sql = format!(
            "{PREFIX}{}",
            std::iter::repeat_n(ROW, page.len())
                .collect::<Vec<_>>()
                .join(",")
        );
        let encoded: Vec<(i64, i64, &[u8], i64, &[u8])> = page
            .iter()
            .map(|pack| {
                (
                    pack.info.pack_id,
                    i64::from(pack.info.domain.code()),
                    pack.info.key.as_bytes().as_slice(),
                    pack.info.length as i64,
                    pack.body.as_slice(),
                )
            })
            .collect();
        let values: Vec<&dyn ToSql> = encoded
            .iter()
            .flat_map(|row| [&row.0 as &dyn ToSql, &row.1, &row.2, &row.3, &row.4])
            .collect();
        connection.execute(&sql, values.as_slice()).map_err(map)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
