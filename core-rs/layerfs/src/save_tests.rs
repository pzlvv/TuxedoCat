//! Save 会话的测试：确认语义、去重、闭包、批次上界、放弃、UnknownOutcome 与竞态裁决。

use std::sync::{Arc, Mutex};

use super::*;
use crate::object::{FinalizedConsumer, ObjectRole};
use crate::policy::StoragePolicy;
use crate::port::{
    LocatedObject, ObjectLocation, ObjectPersistence, PackDomain, PersistenceError, Publication,
    Published, Reserve, Reserved,
};
use crate::test_support::{chunk_object, whole_file_object, MemPersistence};
use crate::Storage;

const BATCH_OBJECT_LIMIT: usize = crate::policy::BATCH_OBJECT_LIMIT;

fn storage() -> (Arc<MemPersistence>, Storage) {
    let port = Arc::new(MemPersistence::new());
    let storage = Storage::new(Arc::clone(&port) as Arc<dyn ObjectPersistence>).expect("storage");
    (port, storage)
}

/// 竞态端口：locate 照常透传；publish 时若已武装，先插入一份「并发胜方」的定位行，
/// 再对其余对象执行 first-wins 插入并报告败方——模拟另一保存先提交同身份。
struct RacePort {
    inner: Arc<MemPersistence>,
    winner: Mutex<Option<(ObjectId, Vec<u8>)>>,
}

impl RacePort {
    fn new(inner: Arc<MemPersistence>) -> Self {
        Self {
            inner,
            winner: Mutex::new(None),
        }
    }

    fn arm(&self, id: ObjectId, bytes: Vec<u8>) {
        *self.winner.lock().expect("mutex") = Some((id, bytes));
    }

    fn publish_armed(&self, batch: &Publication) -> Result<Published, PersistenceError> {
        let armed = self.winner.lock().expect("mutex").take();
        if let Some((id, bytes)) = armed {
            let pack_id = batch.objects[0].pack_id + 1000;
            self.inner.put_pack(pack_id, bytes, PackDomain::Payload);
            self.inner.put_location(ObjectLocation {
                object_id: id,
                role: ObjectRole::Chunk,
                canonical_length: batch.objects[0].canonical_length,
                pack_id,
                group_number: 0,
                record_number: 0,
            });
            let rest = Publication {
                packs: batch.packs[1..].to_vec(),
                objects: batch.objects[1..].to_vec(),
            };
            let mut lost = vec![id];
            lost.extend(self.inner.publish(&rest)?.lost);
            return Ok(Published { lost });
        }
        self.inner.publish(batch)
    }
}

impl ObjectPersistence for RacePort {
    fn policy(&self) -> Result<StoragePolicy, PersistenceError> {
        self.inner.policy()
    }

    fn locate(
        &self,
        ids: &[ObjectId],
        out: &mut Vec<LocatedObject>,
    ) -> Result<(), PersistenceError> {
        self.inner.locate(ids, out)
    }

    fn read_packs(
        &self,
        ids: &[i64],
        out: &mut Vec<crate::port::PersistedPack>,
    ) -> Result<(), PersistenceError> {
        self.inner.read_packs(ids, out)
    }

    fn reserve(&self, request: Reserve) -> Result<Reserved, PersistenceError> {
        self.inner.reserve(request)
    }

    fn publish(&self, batch: &Publication) -> Result<Published, PersistenceError> {
        self.publish_armed(batch)
    }
}

#[test]
fn whole_file_save_acknowledged_by_finish() {
    let (_port, storage) = storage();
    let caps = storage.capacities();
    let object = whole_file_object(&caps, b"hello world\n").expect("object");
    let id = object.id();
    let canonical = object.canonical().to_vec();
    let save = storage.begin_save().expect("save");
    save.accept(object).expect("accept");
    let outcome = save.finish().expect("finish");
    // 持有返回值即确认：立即可读且计数正确。
    assert_eq!(outcome.inserted, 1);
    assert_eq!(outcome.reused, 0);
    assert_eq!(outcome.packs, 1);
    assert_eq!(outcome.canonical_bytes, canonical.len() as u64);
    assert_eq!(outcome.stored_bytes, canonical.len() as u64);
    let read = storage.reader().read_objects(&[id]).expect("read");
    assert_eq!(read[0], canonical);
}

#[test]
fn same_content_resave_counts_reused_without_new_pack() {
    let (_port, storage) = storage();
    let caps = storage.capacities();
    let object = whole_file_object(&caps, b"dedup me").expect("object");
    let id = object.id();
    let first = storage.begin_save().expect("save");
    first.accept(object.clone()).expect("accept");
    let first_outcome = first.finish().expect("finish");
    assert_eq!(first_outcome.inserted, 1);

    let second = storage.begin_save().expect("save");
    second.accept(object).expect("accept");
    let second_outcome = second.finish().expect("finish");
    assert_eq!(second_outcome.reused, 1);
    assert_eq!(second_outcome.inserted, 0);
    // 物理上只有一份：第二次保存不写任何 pack。
    assert_eq!(second_outcome.packs, 0);
    assert_eq!(second_outcome.stored_bytes, 0);
    assert_eq!(storage.reader().read_objects(&[id]).expect("read").len(), 1);
}

#[test]
fn chunk_objects_round_trip() {
    let (_port, storage) = storage();
    let save = storage.begin_save().expect("save");
    let mut ids = Vec::new();
    for i in 0..10_u32 {
        let payload = i.to_be_bytes().repeat((i as usize % 7) + 1);
        let object = chunk_object(&payload).expect("object");
        ids.push(object.id());
        save.accept(object).expect("accept");
    }
    let outcome = save.finish().expect("finish");
    assert_eq!(outcome.inserted, 10);
    let read = storage.reader().read_objects(&ids).expect("read");
    assert_eq!(read.len(), 10);
    for (id, bytes) in ids.iter().zip(&read) {
        assert_eq!(&ObjectId::for_bytes(bytes), id);
    }
}

#[test]
fn batch_bound_publishes_previous_wave() {
    let (_port, storage) = storage();
    let save = storage.begin_save().expect("save");
    let mut first_wave_id = None;
    for i in 0..(BATCH_OBJECT_LIMIT + 10) {
        let object = chunk_object(&(i as u64).to_be_bytes()).expect("object");
        if i == 0 {
            first_wave_id = Some(object.id());
        }
        save.accept(object).expect("accept");
        if i == BATCH_OBJECT_LIMIT {
            // 第 513 个 accept 触发前一波次发布：批内只剩第 513 个对象，且已发布
            // 对象在 finish 之前即可经存储读取。
            assert_eq!(
                save.pending_canonical_bytes(),
                crate::object::chunk_canonical_len(8) as u64
            );
            let read = storage
                .reader()
                .read_objects(&[first_wave_id.expect("id")])
                .expect("read");
            assert_eq!(read.len(), 1);
        }
    }
    let outcome = save.finish().expect("finish");
    assert_eq!(outcome.inserted, (BATCH_OBJECT_LIMIT + 10) as u64);
}

#[test]
fn missing_reference_rejects_whole_batch_without_effect() {
    let (_port, storage) = storage();
    let caps = storage.capacities();
    let child = whole_file_object(&caps, b"child bytes").expect("object");
    let child_id = child.id();
    let missing = chunk_object(&[1, 2, 3])
        .expect("object")
        .with_references(vec![ObjectId::for_bytes(b"never stored")]);
    let save = storage.begin_save().expect("save");
    save.accept(child).expect("accept");
    save.accept(missing).expect("accept");
    let error = save.finish().expect_err("finish must fail");
    let StorageError::MissingDependency { reference, .. } = error else {
        panic!("expected MissingDependency, got {error:?}");
    };
    assert_eq!(reference, ObjectId::for_bytes(b"never stored"));
    // 整批无效果：合法的 child 也不可见。
    let StorageError::ObjectMissing(missing_id) =
        storage.reader().read_objects(&[child_id]).unwrap_err()
    else {
        panic!("expected ObjectMissing");
    };
    assert_eq!(missing_id, child_id);
}

#[test]
fn role_without_decoder_rejected_and_save_terminates() {
    let (_port, storage) = storage();
    let canonical = crate::object::encode_bytes_object(b"payload").expect("encode");
    let object = FinalizedObject::new(ObjectRole::Symlink, canonical).expect("object");
    let save = storage.begin_save().expect("save");
    let error = save.accept(object).expect_err("accept must fail");
    assert!(matches!(
        error,
        StorageError::UnsupportedPolicy {
            field: "object_role"
        }
    ));
    // 终止性失败后同一保存继续拒绝。
    assert!(matches!(
        save.accept(chunk_object(&[1]).expect("object"))
            .unwrap_err(),
        StorageError::Aborted
    ));
    assert!(matches!(save.finish().unwrap_err(), StorageError::Aborted));
}

#[test]
fn second_begin_save_on_same_handle_is_ownership_unavailable() {
    let (_port, storage) = storage();
    let first = storage.begin_save().expect("first save");
    assert!(matches!(
        storage.begin_save(),
        Err(StorageError::OwnershipUnavailable)
    ));
    drop(first);
    // Drop 释放所有权。
    assert!(storage.begin_save().is_ok());
}

#[test]
fn abandoned_save_keeps_published_batches() {
    let (_port, storage) = storage();
    let save = storage.begin_save().expect("save");
    let mut published_id = None;
    for i in 0..(BATCH_OBJECT_LIMIT + 1) {
        let object = chunk_object(&(i as u64).to_be_bytes()).expect("object");
        if i == 0 {
            published_id = Some(object.id());
        }
        save.accept(object).expect("accept");
    }
    // 第 513 个 accept 已触发前一波次发布；随后放弃（不 finish）。
    drop(save);
    let read = storage
        .reader()
        .read_objects(&[published_id.expect("id")])
        .expect("read");
    assert_eq!(read.len(), 1);
    // 句柄所有权已释放。
    assert!(storage.begin_save().is_ok());
}

#[test]
fn sink_error_surfaces_through_finish() {
    let (_port, storage) = storage();
    let canonical = crate::object::encode_bytes_object(b"payload").expect("encode");
    let save = storage.begin_save().expect("save");
    let mut sink = save.sink();
    let result =
        sink.accept(FinalizedObject::new(ObjectRole::FileState, canonical).expect("object"));
    assert_eq!(result.unwrap_err(), ContentError::OutputRejected);
    // 未被 take 的原始错误由 finish 原样返回。
    assert!(matches!(
        save.finish().unwrap_err(),
        StorageError::UnsupportedPolicy {
            field: "object_role"
        }
    ));
}

#[test]
fn sink_error_can_be_taken_with_take_failure() {
    let (_port, storage) = storage();
    let canonical = crate::object::encode_bytes_object(b"payload").expect("encode");
    let save = storage.begin_save().expect("save");
    let mut sink = save.sink();
    let result =
        sink.accept(FinalizedObject::new(ObjectRole::FileState, canonical).expect("object"));
    assert_eq!(result.unwrap_err(), ContentError::OutputRejected);
    let error = save.take_failure().expect("retained failure");
    assert!(matches!(
        error,
        StorageError::UnsupportedPolicy {
            field: "object_role"
        }
    ));
    // 取走后保存已终止：finish 报 Aborted，不再重复原始错误。
    assert!(matches!(save.finish().unwrap_err(), StorageError::Aborted));
}

/// 事务结果未知的端口：publish 一律 Uncertain，不重试、不假定失败。
struct UncertainPort(Arc<MemPersistence>);

impl ObjectPersistence for UncertainPort {
    fn policy(&self) -> Result<StoragePolicy, PersistenceError> {
        self.0.policy()
    }

    fn locate(
        &self,
        ids: &[ObjectId],
        out: &mut Vec<LocatedObject>,
    ) -> Result<(), PersistenceError> {
        self.0.locate(ids, out)
    }

    fn read_packs(
        &self,
        ids: &[i64],
        out: &mut Vec<crate::port::PersistedPack>,
    ) -> Result<(), PersistenceError> {
        self.0.read_packs(ids, out)
    }

    fn reserve(&self, request: Reserve) -> Result<Reserved, PersistenceError> {
        self.0.reserve(request)
    }

    fn publish(&self, _batch: &Publication) -> Result<Published, PersistenceError> {
        Err(PersistenceError::Uncertain)
    }
}

#[test]
fn unproven_outcome_reports_unknown_outcome() {
    let port = Arc::new(MemPersistence::new());
    let storage =
        Storage::new(Arc::new(UncertainPort(Arc::clone(&port))) as Arc<dyn ObjectPersistence>)
            .expect("storage");
    let save = storage.begin_save().expect("save");
    save.accept(chunk_object(&[9, 9]).expect("object"))
        .expect("accept");
    let error = save.finish().expect_err("finish must fail");
    assert!(error.is_unknown_outcome());
    let StorageError::UnknownOutcome { .. } = error else {
        panic!("expected UnknownOutcome, got {error:?}");
    };
}

#[test]
fn first_wins_loser_with_identical_bytes_counts_reused() {
    let port = Arc::new(MemPersistence::new());
    let race = Arc::new(RacePort::new(Arc::clone(&port)));
    let storage = Storage::new(Arc::clone(&race) as Arc<dyn ObjectPersistence>).expect("storage");
    let ours = chunk_object(&[1, 2, 3]).expect("object");
    let id = ours.id();
    let ours_bytes = ours.canonical().to_vec();
    let save = storage.begin_save().expect("save");
    // 武装「另一保存先提交的同身份同字节」胜方。
    race.arm(id, ours_bytes.clone());
    save.accept(ours).expect("accept");
    let outcome = save.finish().expect("finish");
    assert_eq!(outcome.reused, 1);
    assert_eq!(outcome.inserted, 0);
    let read = storage.reader().read_objects(&[id]).expect("read");
    assert_eq!(read[0], ours_bytes);
}

/// 同一身份下「字节不一致」只能由真实哈希碰撞产生——那时胜方字节能通过身份认证，
/// 进入字节裁决并报 `Collision`。可构造的替身是「他者对象占据了本 id 的定位行」：
/// 认证严格先于裁决，读回报 `IdentityMismatch`，不冒充缺席也不静默当作 reused。
#[test]
fn first_wins_loser_failing_authentication_reports_identity_mismatch() {
    let port = Arc::new(MemPersistence::new());
    let race = Arc::new(RacePort::new(Arc::clone(&port)));
    let storage = Storage::new(Arc::clone(&race) as Arc<dyn ObjectPersistence>).expect("storage");
    let ours = chunk_object(&[1, 2, 3]).expect("object");
    let id = ours.id();
    let winner_bytes = chunk_object(&[9, 9, 9])
        .expect("object")
        .canonical()
        .to_vec();
    let save = storage.begin_save().expect("save");
    // 武装「另一保存先提交的同身份不同字节」胜方。
    race.arm(id, winner_bytes.clone());
    save.accept(ours).expect("accept");
    let error = save.finish().expect_err("finish must fail");
    assert!(matches!(
        error,
        StorageError::Content(ContentError::IdentityMismatch)
    ));
    // 本 id 的定位行被他者占据：直接读取同样被认证拒绝。
    assert!(matches!(
        storage.reader().read_objects(&[id]).unwrap_err(),
        StorageError::Content(ContentError::IdentityMismatch)
    ));
    drop(winner_bytes);
}

#[test]
fn save_reads_pending_and_stored_objects_with_same_save_visibility() {
    let (_port, storage) = storage();
    let stored = store_before(&storage, &[7, 7]);
    let save = storage.begin_save().expect("save");
    let pending = chunk_object(&[8, 8, 8]).expect("object");
    let pending_id = pending.id();
    let pending_bytes = pending.canonical().to_vec();
    save.accept(pending).expect("accept");
    // 待发布的对象对本保存可见，对存储级读取器不可见。
    let read = save.read_objects(&[pending_id, stored]).expect("read");
    assert_eq!(read[0], pending_bytes);
    assert_eq!(ObjectId::for_bytes(&read[1]), stored);
    assert!(matches!(
        storage.reader().read_objects(&[pending_id]).unwrap_err(),
        StorageError::ObjectMissing(_)
    ));
    // 两边都没有的身份是 ObjectMissing。
    let ghost = ObjectId::for_bytes(b"ghost");
    assert!(matches!(
        save.read_objects(&[ghost]).unwrap_err(),
        StorageError::ObjectMissing(id) if id == ghost
    ));
    // 端口形式沿用同一语义。
    assert_eq!(
        AuthenticatedObjects::read_canonical(&save, pending_id).expect("read"),
        pending_bytes
    );
}

fn store_before(storage: &Storage, payload: &[u8]) -> ObjectId {
    let save = storage.begin_save().expect("save");
    let object = chunk_object(payload).expect("object");
    let id = object.id();
    save.accept(object).expect("accept");
    save.finish().expect("finish");
    id
}
