//! `Save` 会话：有界批次、引用闭包、first-wins 与持有返回值即确认。
//!
//! 写入以 `Save` 会话为单位：`accept` / `SaveSink` 逐对象提交，按有界批次走短事务
//! 原子发布。`finish()` 封装并注册剩余输出，返回 `WriteOutcome`——**持有返回值即
//! 确认**，任何其他结果都是类型化错误；结果未证明时以 `UnknownOutcome` 上报。
//! `Save` 被 Drop 而未 finish 即放弃：已发布的引用闭包批次仍然存活，仅作废候选状态。

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::{provider_error, ContentError, ContentResult, StorageError, StorageResult};
use crate::object::{
    validate_role_payload, AuthenticatedObjects, FinalizedConsumer, FinalizedObject, ObjectId,
};
use crate::policy::StorageCapacities;
use crate::port::{
    ObjectKey, ObjectLocation, PackDomain, PackInfo, Publication, PublishedPack, Reserve,
};
use crate::storage::Storage;

/// 一次保存确认后的计数：描述实际完成的写入。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WriteOutcome {
    /// 新写入的对象数。
    pub inserted: u64,
    /// 由已存储定位行服务的对象次数。
    pub reused: u64,
    /// 已写入的 pack 数。
    pub packs: u64,
    /// 新写入对象的规范字节总数。
    pub canonical_bytes: u64,
    /// 已写入 pack 的物理字节总数。
    pub stored_bytes: u64,
}

/// 一个有界生产者。已发布的引用闭包批次在后续失败后仍然存活。
pub struct Save<'a> {
    storage: &'a Storage,
    pending: RefCell<PendingBatch>,
    outcome: Cell<WriteOutcome>,
    terminal: Cell<bool>,
    failure: RefCell<Option<StorageError>>,
    finished: Cell<bool>,
}

impl<'a> Save<'a> {
    pub(crate) fn new(storage: &'a Storage) -> Self {
        Self {
            storage,
            pending: RefCell::new(PendingBatch::new(storage.capacities())),
            outcome: Cell::new(WriteOutcome::default()),
            terminal: Cell::new(false),
            failure: RefCell::new(None),
            finished: Cell::new(false),
        }
    }

    /// 接受一个最终化对象；批次到界时先发布前一个引用闭包波次。
    ///
    /// 角色必须有解码器（本 crate：`WholeFile` / `Chunk`）且值语法与角色一致；此后
    /// 任何失败都会终止本保存。
    pub fn accept(&self, object: FinalizedObject) -> StorageResult<()> {
        if self.terminal.get() {
            return Err(StorageError::Aborted);
        }
        let result = (|| {
            if !object.role().has_decoder() {
                return Err(StorageError::UnsupportedPolicy {
                    field: "object_role",
                });
            }
            validate_role_payload(
                object.role(),
                object.canonical(),
                &self.storage.capacities().construction,
            )?;
            if let Some(objects) = self.pending.borrow_mut().push(object)? {
                self.wave(objects)?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.terminal.set(true);
        }
        result
    }

    /// 与本保存共享同一操作提供方的 C1 交接消费者。
    pub fn sink(&self) -> SaveSink<'_, 'a> {
        SaveSink { save: self }
    }

    /// 封装并注册剩余的引用闭包输出，恰好一次。
    pub fn finish(self) -> StorageResult<WriteOutcome> {
        if let Some(error) = self.failure.borrow_mut().take() {
            return Err(error);
        }
        if self.terminal.get() {
            return Err(StorageError::Aborted);
        }
        let objects = self.pending.borrow_mut().drain();
        self.wave(objects)?;
        self.finished.set(true);
        Ok(self.outcome.get())
    }

    /// 取走 C1 sink 在放弃保存前保留的原始错误。
    pub fn take_failure(&self) -> Option<StorageError> {
        self.failure.borrow_mut().take()
    }

    /// 批次中等待发布的规范字节数。
    pub fn pending_canonical_bytes(&self) -> u64 {
        self.pending.borrow().canonical_bytes
    }

    /// 发布一个波次：去重 → 已存者计 reused → 闭包检查 → 拓扑序 → reserve →
    /// 按事务上界拆分发布 → 败方字节裁决。
    fn wave(&self, objects: Vec<FinalizedObject>) -> StorageResult<()> {
        if objects.is_empty() {
            return Ok(());
        }
        // 同一波次内的重复身份：首见者参与发布，其余按 reused 计数并丢弃。
        let mut members: BTreeMap<ObjectId, FinalizedObject> = BTreeMap::new();
        let mut order: Vec<ObjectId> = Vec::with_capacity(objects.len());
        for object in objects {
            let id = object.id();
            if members.insert(id, object).is_none() {
                order.push(id);
            } else {
                self.count_reused();
            }
        }
        let located = self.storage.reader().locate(&order)?;
        let mut fresh: Vec<ObjectId> = Vec::new();
        for id in &order {
            if located.contains_key(id) {
                // 内容寻址：同身份即同字节，定位命中即 reused，不再读回比对。
                self.count_reused();
            } else {
                fresh.push(*id);
            }
        }
        if fresh.is_empty() {
            return Ok(());
        }
        self.check_closure(&fresh, &members)?;
        let ordered = topo_order(&fresh, &members)?;
        let reserved = self
            .storage
            .persistence()
            .reserve(Reserve {
                packs: ordered.len(),
            })
            .map_err(StorageError::from)?;
        if reserved.first_pack_id <= 0 {
            return Err(StorageError::Integrity("pack id allocation"));
        }
        let limits = self.storage.capacities();
        let mut canonical_of: BTreeMap<ObjectId, Vec<u8>> = BTreeMap::new();
        let mut batch = Publication::default();
        let mut batch_rows = 0_u64;
        let mut batch_bytes = 0_u64;
        for (offset, id) in ordered.iter().enumerate() {
            let object = &members[id];
            let canonical = object.canonical().to_vec();
            canonical_of.insert(*id, canonical.clone());
            let location = ObjectLocation {
                object_id: *id,
                role: object.role(),
                canonical_length: canonical.len(),
                pack_id: reserved.first_pack_id + offset as i64,
                group_number: 0,
                record_number: 0,
            };
            // 单记录布局：每对象 2 行（pack 行 + 定位行）。
            let rows = 2_u64;
            let bytes = canonical.len() as u64;
            if !batch.objects.is_empty()
                && (batch_rows + rows > limits.transaction_rows
                    || batch_bytes + bytes > limits.transaction_bytes)
            {
                self.acknowledge(&batch, &canonical_of)?;
                batch = Publication::default();
                batch_rows = 0;
                batch_bytes = 0;
            }
            batch.packs.push(PublishedPack {
                info: PackInfo {
                    pack_id: location.pack_id,
                    domain: PackDomain::for_role(object.role()),
                    key: ObjectKey::for_bytes(&canonical),
                    length: canonical.len(),
                },
                body: Arc::new(canonical),
            });
            batch.objects.push(location);
            batch_rows += rows;
            batch_bytes += bytes;
        }
        if !batch.objects.is_empty() {
            self.acknowledge(&batch, &canonical_of)?;
        }
        Ok(())
    }

    /// 引用闭包：fresh 对象的直接引用必须已存储或同在 fresh 集内，否则整批拒绝
    /// （`MissingDependency`，无任何效果）。
    fn check_closure(
        &self,
        fresh: &[ObjectId],
        members: &BTreeMap<ObjectId, FinalizedObject>,
    ) -> StorageResult<()> {
        let fresh_set: BTreeSet<ObjectId> = fresh.iter().copied().collect();
        let mut external: BTreeSet<ObjectId> = BTreeSet::new();
        let mut parents: BTreeMap<ObjectId, ObjectId> = BTreeMap::new();
        for id in fresh {
            for reference in members[id].references() {
                if fresh_set.contains(reference) {
                    continue;
                }
                external.insert(*reference);
                parents.entry(*reference).or_insert(*id);
            }
        }
        if external.is_empty() {
            return Ok(());
        }
        let window = self.storage.capacities().read_objects.max(1);
        let external: Vec<ObjectId> = external.into_iter().collect();
        let mut available: BTreeSet<ObjectId> = BTreeSet::new();
        for chunk in external.chunks(window) {
            for id in self.storage.reader().locate(chunk)?.into_keys() {
                available.insert(id);
            }
        }
        for reference in external {
            if !available.contains(&reference) {
                return Err(StorageError::MissingDependency {
                    object: parents[&reference],
                    reference,
                });
            }
        }
        Ok(())
    }

    /// 发布一个批次并裁决 first-wins 败方：字节一致计 reused，不一致报 `Collision`。
    fn acknowledge(
        &self,
        batch: &Publication,
        canonical_of: &BTreeMap<ObjectId, Vec<u8>>,
    ) -> StorageResult<()> {
        let published = self
            .storage
            .persistence()
            .publish(batch)
            .map_err(StorageError::from)?;
        let batch_set: BTreeSet<ObjectId> = batch.objects.iter().map(|row| row.object_id).collect();
        let mut lost: BTreeSet<ObjectId> = BTreeSet::new();
        for id in &published.lost {
            if !batch_set.contains(id) || !lost.insert(*id) {
                return Err(StorageError::Integrity("registration lost identities"));
            }
        }
        if !lost.is_empty() {
            // 败方裁决：读回胜方已提交的字节，与我们提供的不一致即 `Collision`。
            let ids: Vec<ObjectId> = lost.iter().copied().collect();
            let read = self.storage.reader().read_objects(&ids)?;
            for (id, winner) in ids.iter().zip(read) {
                if winner.as_slice() != canonical_of[id].as_slice() {
                    return Err(StorageError::Collision(*id));
                }
            }
        }
        let mut outcome = self.outcome.get();
        for row in &batch.objects {
            if lost.contains(&row.object_id) {
                outcome.reused += 1;
            } else {
                outcome.inserted += 1;
                outcome.canonical_bytes += row.canonical_length as u64;
            }
        }
        // pack 字节无论胜败都已写入（败方留下孤儿 pack，孤儿按边界条款容忍）。
        outcome.packs += batch.packs.len() as u64;
        outcome.stored_bytes += batch
            .packs
            .iter()
            .map(|pack| pack.body.len() as u64)
            .sum::<u64>();
        self.outcome.set(outcome);
        Ok(())
    }

    fn count_reused(&self) {
        let mut outcome = self.outcome.get();
        outcome.reused += 1;
        self.outcome.set(outcome);
    }
}

impl Drop for Save<'_> {
    fn drop(&mut self) {
        // 释放「每句柄一个活动 Save」的所有权；已发布的引用闭包批次存活，候选状态随
        // 本结构丢弃（放弃的保存没有待清理的物理状态）。
        self.storage.release_save();
    }
}

/// C1 的消费者适配；原始的类型化存储错误被保留给 finish。
pub struct SaveSink<'s, 'a> {
    save: &'s Save<'a>,
}

impl FinalizedConsumer for SaveSink<'_, '_> {
    fn accept(&mut self, object: FinalizedObject) -> ContentResult<()> {
        self.save.accept(object).map_err(|error| {
            self.save.remember_failure(error);
            ContentError::OutputRejected
        })
    }
}

impl Save<'_> {
    fn remember_failure(&self, error: StorageError) {
        let mut failure = self.failure.borrow_mut();
        if failure.is_none() {
            *failure = Some(error);
        }
    }
}

impl AuthenticatedObjects for Save<'_> {
    fn read_canonical_batch(&self, ids: &[ObjectId]) -> ContentResult<Vec<Vec<u8>>> {
        // 同保存可见性：先查本保存仍待发布的批次，其余走存储；缺席即 MissingObject。
        let mut result: Vec<Option<Vec<u8>>> = vec![None; ids.len()];
        let mut rest: Vec<(usize, ObjectId)> = Vec::new();
        {
            let pending = self.pending.borrow();
            for (index, id) in ids.iter().enumerate() {
                match pending.pending_canonical(id) {
                    Some(bytes) => result[index] = Some(bytes.to_vec()),
                    None => rest.push((index, *id)),
                }
            }
        }
        if !rest.is_empty() {
            let unique: Vec<ObjectId> = rest
                .iter()
                .map(|(_, id)| *id)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let bytes = self
                .storage
                .reader()
                .read_objects(&unique)
                .map_err(|error| provider_error(&error))?;
            let resolved: BTreeMap<ObjectId, Vec<u8>> = unique.into_iter().zip(bytes).collect();
            for (index, id) in &rest {
                result[*index] = resolved.get(id).cloned();
            }
        }
        result
            .into_iter()
            .map(|slot| slot.ok_or(ContentError::MissingObject))
            .collect()
    }
}

/// 有界的待发布批次：对象数与规范字节总数都有上界，超界即先发布前一波次。
struct PendingBatch {
    objects: Vec<FinalizedObject>,
    canonical_bytes: u64,
    object_limit: usize,
    byte_limit: u64,
}

impl PendingBatch {
    fn new(capacities: StorageCapacities) -> Self {
        Self {
            objects: Vec::new(),
            canonical_bytes: 0,
            object_limit: capacities.batch_objects,
            byte_limit: capacities.batch_bytes,
        }
    }

    /// 接受一个对象；到界时返回排空的波次。超过整个字节上界的对象在空批次里仍被
    /// 单独接受（单例路径保持可用）。
    fn push(&mut self, object: FinalizedObject) -> StorageResult<Option<Vec<FinalizedObject>>> {
        let length = object.canonical_len() as u64;
        if !self.objects.is_empty()
            && (self.objects.len() >= self.object_limit
                || self.canonical_bytes.saturating_add(length) > self.byte_limit)
        {
            let drained = self.drain();
            self.canonical_bytes = length;
            self.objects.push(object);
            return Ok(Some(drained));
        }
        self.canonical_bytes =
            self.canonical_bytes
                .checked_add(length)
                .ok_or(StorageError::CapacityExceeded {
                    what: "batch.canonical_bytes",
                    limit: self.byte_limit,
                    actual: u64::MAX,
                })?;
        self.objects.push(object);
        Ok(None)
    }

    fn drain(&mut self) -> Vec<FinalizedObject> {
        self.canonical_bytes = 0;
        std::mem::take(&mut self.objects)
    }

    /// 仍在批次内等待的 `id` 的规范字节（同保存读取用它）。
    fn pending_canonical(&self, id: &ObjectId) -> Option<&[u8]> {
        self.objects
            .iter()
            .find(|object| object.id() == *id)
            .map(FinalizedObject::canonical)
    }
}

/// Kahn 拓扑序：fresh 内部引用在前；环拒绝。
fn topo_order(
    fresh: &[ObjectId],
    members: &BTreeMap<ObjectId, FinalizedObject>,
) -> StorageResult<Vec<ObjectId>> {
    let fresh_set: BTreeSet<ObjectId> = fresh.iter().copied().collect();
    let mut counts: BTreeMap<ObjectId, usize> = BTreeMap::new();
    let mut dependents: BTreeMap<ObjectId, Vec<ObjectId>> = BTreeMap::new();
    let mut frontier: Vec<ObjectId> = Vec::new();
    for id in fresh {
        let unresolved = members[id]
            .references()
            .iter()
            .filter(|reference| fresh_set.contains(reference))
            .count();
        counts.insert(*id, unresolved);
        if unresolved == 0 {
            frontier.push(*id);
        }
        for reference in members[id].references() {
            if fresh_set.contains(reference) {
                dependents.entry(*reference).or_default().push(*id);
            }
        }
    }
    let mut order = Vec::with_capacity(fresh.len());
    while let Some(id) = frontier.pop() {
        order.push(id);
        if let Some(children) = dependents.remove(&id) {
            for child in children {
                let count = counts
                    .get_mut(&child)
                    .ok_or(StorageError::Integrity("closure count"))?;
                *count -= 1;
                if *count == 0 {
                    frontier.push(child);
                }
            }
        }
    }
    if order.len() != fresh.len() {
        return Err(StorageError::Integrity("registration reference cycle"));
    }
    Ok(order)
}

#[cfg(test)]
#[path = "save_tests.rs"]
mod tests;
