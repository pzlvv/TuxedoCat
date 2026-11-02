//! 测试支撑：内存版 `ObjectPersistence`，供 save / reader 的模块测试驱动真实核心逻辑
//! 而不触碰文件系统。仅测试编译（coverage 的排除名单也跳过本文件）。

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::error::ContentResult;
use crate::object::{decode_bytes_object, encode_chunk_object, encode_whole_file, FinalizedObject};
use crate::policy::{StorageCapacities, StoragePolicy};
use crate::port::{
    LocatedObject, ObjectKey, ObjectLocation, ObjectPersistence, PackDomain, PackInfo,
    PersistedPack, PersistenceError, Publication, Published, Reserve, Reserved,
};

/// 全内存端口：定位行与 pack 体都在 BTreeMap 里，语义与 SQLite 实现同构
/// （first-wins、locate 缺席省略、read_packs 整包返回）。
#[derive(Default)]
pub struct MemPersistence {
    inner: Mutex<MemInner>,
}

#[derive(Default)]
struct MemInner {
    policy: Option<StoragePolicy>,
    locations: BTreeMap<crate::object::ObjectId, ObjectLocation>,
    packs: BTreeMap<i64, (PackInfo, Vec<u8>)>,
    next_pack_id: i64,
}

impl MemPersistence {
    /// 空端口；`policy()` 返回冻结默认策略。
    pub fn new() -> Self {
        Self::default()
    }

    /// 直接注册一个 pack（测试预置用）。
    pub fn put_pack(&self, pack_id: i64, body: Vec<u8>, domain: PackDomain) {
        let mut inner = self.inner.lock().expect("mem port mutex");
        let info = PackInfo {
            pack_id,
            domain,
            key: ObjectKey::for_bytes(&body),
            length: body.len(),
        };
        inner.packs.insert(pack_id, (info, body));
        if pack_id >= inner.next_pack_id {
            inner.next_pack_id = pack_id + 1;
        }
    }

    /// 直接注册一条定位行（测试预置用）。
    pub fn put_location(&self, location: ObjectLocation) {
        let mut inner = self.inner.lock().expect("mem port mutex");
        inner.locations.insert(location.object_id, location);
    }
}

impl ObjectPersistence for MemPersistence {
    fn policy(&self) -> Result<StoragePolicy, PersistenceError> {
        let inner = self.inner.lock().expect("mem port mutex");
        Ok(inner.policy.unwrap_or_else(StoragePolicy::frozen_default))
    }

    fn locate(
        &self,
        ids: &[crate::object::ObjectId],
        out: &mut Vec<LocatedObject>,
    ) -> Result<(), PersistenceError> {
        let inner = self.inner.lock().expect("mem port mutex");
        for id in ids {
            if let Some(location) = inner.locations.get(id) {
                let pack = inner
                    .packs
                    .get(&location.pack_id)
                    .ok_or(PersistenceError::Missing)?;
                out.push(LocatedObject {
                    location: *location,
                    pack: pack.0,
                });
            }
        }
        Ok(())
    }

    fn read_packs(
        &self,
        ids: &[i64],
        out: &mut Vec<PersistedPack>,
    ) -> Result<(), PersistenceError> {
        let inner = self.inner.lock().expect("mem port mutex");
        for id in ids {
            if let Some((info, body)) = inner.packs.get(id) {
                out.push(PersistedPack {
                    info: *info,
                    body: body.clone(),
                });
            }
        }
        Ok(())
    }

    fn reserve(&self, request: Reserve) -> Result<Reserved, PersistenceError> {
        let mut inner = self.inner.lock().expect("mem port mutex");
        let first = if request.packs == 0 {
            inner.next_pack_id.max(1)
        } else {
            let first = if inner.next_pack_id <= 0 {
                1
            } else {
                inner.next_pack_id
            };
            inner.next_pack_id = first + request.packs as i64;
            first
        };
        Ok(Reserved {
            first_pack_id: first,
        })
    }

    fn publish(&self, batch: &Publication) -> Result<Published, PersistenceError> {
        let mut inner = self.inner.lock().expect("mem port mutex");
        let mut lost = Vec::new();
        for pack in &batch.packs {
            inner
                .packs
                .entry(pack.info.pack_id)
                .or_insert_with(|| (pack.info, pack.body.as_ref().clone()));
        }
        for row in &batch.objects {
            if inner.locations.insert(row.object_id, *row).is_some() {
                lost.push(row.object_id);
            }
        }
        Ok(Published { lost })
    }
}

/// 便捷构造：把 `bytes` 作为 Chunk 对象交给内存端口可写入的 `FinalizedObject`。
pub fn chunk_object(bytes: &[u8]) -> ContentResult<FinalizedObject> {
    FinalizedObject::new(
        crate::object::ObjectRole::Chunk,
        encode_chunk_object(bytes)?,
    )
}

/// 便捷构造：把 `bytes` 作为 WholeFile 对象交给内存端口可写入的 `FinalizedObject`。
pub fn whole_file_object(
    capacities: &StorageCapacities,
    bytes: &[u8],
) -> ContentResult<FinalizedObject> {
    FinalizedObject::new(
        crate::object::ObjectRole::WholeFile,
        encode_whole_file(&capacities.construction, bytes)?,
    )
}

/// 便捷校验：解码后的字节角色对象值（测试断言用）。
pub fn decode_value(canonical: &[u8]) -> ContentResult<Vec<u8>> {
    decode_bytes_object(canonical).map(|slice| slice.to_vec())
}
