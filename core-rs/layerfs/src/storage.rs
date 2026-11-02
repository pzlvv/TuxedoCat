//! `Storage` 句柄：策略读回、`begin_save` / `reader` 与认证读端口实现。

use std::cell::Cell;
use std::sync::Arc;

use crate::error::{provider_error, ContentResult, StorageError, StorageResult};
use crate::object::{AuthenticatedObjects, ObjectId};
use crate::policy::{StorageCapacities, StoragePolicy};
use crate::port::ObjectPersistence;
use crate::{reader, save};

/// 物理存储的引擎无关句柄：一份持久化策略、派生容量与「每句柄一个活动 Save」的所有权。
///
/// 独立句柄可并发写；句柄不是 `Sync`（内部所有权标志是 `Cell`），跨线程各持句柄。
pub struct Storage {
    persistence: Arc<dyn ObjectPersistence>,
    policy: StoragePolicy,
    capacities: StorageCapacities,
    save_active: Cell<bool>,
}

impl Storage {
    /// 以一份已确认的持久化策略打开一个句柄。不做任何服务引导。
    pub fn new(persistence: Arc<dyn ObjectPersistence>) -> StorageResult<Self> {
        let policy = persistence
            .policy()
            .map_err(StorageError::from)?
            .validated()?;
        let capacities = StorageCapacities::from_policy(policy)?;
        Ok(Self {
            persistence,
            policy,
            capacities,
            save_active: Cell::new(false),
        })
    }

    /// 持久化且已验证的存储策略。
    pub const fn policy(&self) -> StoragePolicy {
        self.policy
    }

    /// 该策略下既有的规范、pack 与事务窗口上界。
    pub const fn capacities(&self) -> StorageCapacities {
        self.capacities
    }

    /// 开始一个生产者的有界保存。同一句柄同时只允许一个活动 `Save`；并发生产者
    /// 各持独立句柄。
    pub fn begin_save(&self) -> StorageResult<save::Save<'_>> {
        if self.save_active.get() {
            return Err(StorageError::OwnershipUnavailable);
        }
        self.save_active.set(true);
        Ok(save::Save::new(self))
    }

    /// 创建一个操作级的认证读取器。
    pub fn reader(&self) -> reader::Reader<'_> {
        reader::Reader::new(self)
    }

    /// 端口出口：Save 与 Reader 的物理操作都经它。
    pub(crate) fn persistence(&self) -> &Arc<dyn ObjectPersistence> {
        &self.persistence
    }

    /// Save 结束（finish 或 Drop）时释放活动标志。
    pub(crate) fn release_save(&self) {
        self.save_active.set(false);
    }
}

impl AuthenticatedObjects for Storage {
    fn read_canonical_batch(&self, ids: &[ObjectId]) -> ContentResult<Vec<Vec<u8>>> {
        let bytes = self
            .reader()
            .read_objects(ids)
            .map_err(|error| provider_error(&error))?;
        Ok(bytes)
    }
}
