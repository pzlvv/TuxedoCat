//! 认证批量读取：按请求顺序返回经身份校验的规范字节。
//!
//! 读取是认证的：每块字节的身份必须与请求的 id 一致（不符报 `IdentityMismatch`）；
//! 缺失只能是 `ObjectMissing(id)`，持有状态但无法服务的损坏一律报 provider 错误——
//! 两类严格分开，不冒充缺席（docs/core/layerfs.md 第 4 节）。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::{ContentError, StorageError, StorageResult};
use crate::object::codec;
use crate::object::ObjectId;
use crate::port::{LocatedObject, PersistedPack};
use crate::storage::Storage;

/// 操作级读取器：持有读取窗口，一次操作结束即丢弃。
pub struct Reader<'a> {
    storage: &'a Storage,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(storage: &'a Storage) -> Self {
        Self { storage }
    }

    /// 按请求顺序批量返回解码后的规范字节。
    ///
    /// 数量与规范字节总量有固定窗口上界；单记录布局之外的组 / 记录寻址被拒绝。
    pub fn read_objects(&self, ids: &[ObjectId]) -> StorageResult<Vec<Vec<u8>>> {
        let capacities = self.storage.capacities();
        if ids.len() > capacities.read_objects {
            return Err(StorageError::CapacityExceeded {
                what: "read.objects",
                limit: capacities.read_objects as u64,
                actual: ids.len() as u64,
            });
        }
        let located = self.locate(ids)?;
        let mut total = 0_u64;
        for id in ids {
            let entry = located
                .get(id)
                .ok_or_else(|| StorageError::ObjectMissing(*id))?;
            total = total.saturating_add(entry.location.canonical_length as u64);
            if total > capacities.read_bytes as u64 {
                return Err(StorageError::CapacityExceeded {
                    what: "read.canonical_bytes",
                    limit: capacities.read_bytes as u64,
                    actual: total,
                });
            }
        }
        let packs = self.read_packs(located.values().map(|entry| entry.pack.pack_id))?;
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            let entry = &located[id];
            let body = packs
                .get(&entry.pack.pack_id)
                .ok_or(StorageError::Integrity("located pack missing"))?;
            let record = record_bytes(&body.body, entry)?;
            if ObjectId::for_bytes(record) != *id {
                return Err(StorageError::Content(ContentError::IdentityMismatch));
            }
            codec::decode_bytes_object(record)?;
            result.push(record.to_vec());
        }
        Ok(result)
    }

    /// 定位一批 id（去重）；缺席者不在结果里。
    pub(crate) fn locate(
        &self,
        ids: &[ObjectId],
    ) -> StorageResult<BTreeMap<ObjectId, LocatedObject>> {
        let unique: Vec<ObjectId> = ids
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut found = Vec::new();
        for window in unique.chunks(self.storage.capacities().read_objects) {
            self.storage
                .persistence()
                .locate(window, &mut found)
                .map_err(StorageError::from)?;
        }
        Ok(found
            .into_iter()
            .map(|entry| (entry.location.object_id, entry))
            .collect())
    }

    /// 读出并认证一批 pack；长度或摘要不符一律 `Integrity`。
    pub(crate) fn read_packs<I: IntoIterator<Item = i64>>(
        &self,
        pack_ids: I,
    ) -> StorageResult<BTreeMap<i64, Arc<PersistedPack>>> {
        let unique: Vec<i64> = pack_ids
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut packs = Vec::new();
        self.storage
            .persistence()
            .read_packs(&unique, &mut packs)
            .map_err(StorageError::from)?;
        let mut result = BTreeMap::new();
        for pack in packs {
            if pack.authenticate().is_err() {
                return Err(StorageError::Integrity("pack length or digest"));
            }
            result.insert(pack.info.pack_id, Arc::new(pack));
        }
        Ok(result)
    }
}

/// 单记录布局的记录就是 pack 本体；组 / 记录序号非零或长度不符都拒绝。
fn record_bytes<'a>(body: &'a [u8], entry: &LocatedObject) -> StorageResult<&'a [u8]> {
    if entry.location.group_number != 0 || entry.location.record_number != 0 {
        return Err(StorageError::Integrity("record addressing"));
    }
    if body.len() != entry.location.canonical_length {
        return Err(StorageError::Integrity("record length"));
    }
    Ok(body)
}

#[cfg(test)]
#[path = "reader_tests.rs"]
mod tests;
