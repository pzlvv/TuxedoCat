//! Reader 认证读取的测试：顺序、窗口上界、缺失与损坏的严格分类。

use std::sync::Arc;

use super::*;
use crate::object::{AuthenticatedObjects, ObjectRole};
use crate::policy::StoragePolicy;
use crate::port::{
    LocatedObject, ObjectLocation, ObjectPersistence, PackDomain, PersistedPack, PersistenceError,
    Publication, Published, Reserve, Reserved,
};
use crate::test_support::{chunk_object, MemPersistence};
use crate::Storage;

fn storage() -> (Arc<MemPersistence>, Storage) {
    let port = Arc::new(MemPersistence::new());
    let storage = Storage::new(Arc::clone(&port) as Arc<dyn ObjectPersistence>).expect("storage");
    (port, storage)
}

fn store_chunk(storage: &Storage, payload: &[u8]) -> ObjectId {
    let save = storage.begin_save().expect("save");
    let object = chunk_object(payload).expect("object");
    let id = object.id();
    save.accept(object).expect("accept");
    save.finish().expect("finish");
    id
}

#[test]
fn reads_in_request_order_keeping_duplicates() {
    let (_port, storage) = storage();
    let a = store_chunk(&storage, &[1, 1, 1]);
    let b = store_chunk(&storage, &[2, 2, 2, 2]);
    let read = storage.reader().read_objects(&[b, a, b, a]).expect("read");
    assert_eq!(read.len(), 4);
    assert_eq!(ObjectId::for_bytes(&read[0]), b);
    assert_eq!(ObjectId::for_bytes(&read[1]), a);
    assert_eq!(ObjectId::for_bytes(&read[2]), b);
    assert_eq!(ObjectId::for_bytes(&read[3]), a);
}

#[test]
fn absence_reports_object_missing() {
    let (_port, storage) = storage();
    let ghost = ObjectId::for_bytes(b"never stored");
    let StorageError::ObjectMissing(missing) = storage.reader().read_objects(&[ghost]).unwrap_err()
    else {
        panic!("expected ObjectMissing");
    };
    assert_eq!(missing, ghost);
}

#[test]
fn request_count_over_window_rejected() {
    let (_port, storage) = storage();
    let ids: Vec<ObjectId> = (0..=crate::policy::READ_OBJECT_LIMIT)
        .map(|i| ObjectId::for_bytes(&(i as u64).to_be_bytes()))
        .collect();
    let error = storage.reader().read_objects(&ids).unwrap_err();
    let StorageError::CapacityExceeded {
        what,
        limit,
        actual,
    } = error
    else {
        panic!("expected CapacityExceeded, got {error:?}");
    };
    assert_eq!(what, "read.objects");
    assert_eq!(limit, crate::policy::READ_OBJECT_LIMIT as u64);
    assert_eq!(actual, ids.len() as u64);
}

#[test]
fn tampered_pack_reports_integrity_not_absence() {
    struct TamperPackPort(Arc<MemPersistence>);
    impl ObjectPersistence for TamperPackPort {
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
            out: &mut Vec<PersistedPack>,
        ) -> Result<(), PersistenceError> {
            self.0.read_packs(ids, out)?;
            // 篡改第一份返回的 pack 体：长度与摘要校验应拒绝。
            if let Some(pack) = out.first_mut() {
                pack.body[0] ^= 0xff;
            }
            Ok(())
        }
        fn reserve(&self, request: Reserve) -> Result<Reserved, PersistenceError> {
            self.0.reserve(request)
        }
        fn publish(&self, batch: &Publication) -> Result<Published, PersistenceError> {
            self.0.publish(batch)
        }
    }
    let port = Arc::new(MemPersistence::new());
    let storage =
        Storage::new(Arc::new(TamperPackPort(Arc::clone(&port))) as Arc<dyn ObjectPersistence>)
            .expect("storage");
    let id = store_chunk(&storage, &[7, 8, 9]);
    let error = storage.reader().read_objects(&[id]).unwrap_err();
    assert!(matches!(
        error,
        StorageError::Integrity("pack length or digest")
    ));
}

#[test]
fn lying_locator_identity_reports_identity_mismatch() {
    let (port, storage) = storage();
    // 预置：pack 里是 X 对象，但定位行把它登记成另一个 id。
    let real = chunk_object(&[4, 5, 6]).expect("object");
    let pack_id = 1;
    port.put_pack(pack_id, real.canonical().to_vec(), PackDomain::Payload);
    port.put_location(ObjectLocation {
        object_id: ObjectId::for_bytes(b"lying id"),
        role: ObjectRole::Chunk,
        canonical_length: real.canonical_len(),
        pack_id,
        group_number: 0,
        record_number: 0,
    });
    let error = storage
        .reader()
        .read_objects(&[ObjectId::for_bytes(b"lying id")])
        .unwrap_err();
    assert!(matches!(
        error,
        StorageError::Content(ContentError::IdentityMismatch)
    ));
}

#[test]
fn lying_locator_length_reports_integrity() {
    let (port, storage) = storage();
    let real = chunk_object(&[4, 5, 6]).expect("object");
    let pack_id = 1;
    port.put_pack(pack_id, real.canonical().to_vec(), PackDomain::Payload);
    port.put_location(ObjectLocation {
        object_id: real.id(),
        role: ObjectRole::Chunk,
        canonical_length: real.canonical_len() + 1,
        pack_id,
        group_number: 0,
        record_number: 0,
    });
    let error = storage.reader().read_objects(&[real.id()]).unwrap_err();
    assert!(matches!(error, StorageError::Integrity("record length")));
}

#[test]
fn storage_handle_implements_authenticated_objects() {
    let (_port, storage) = storage();
    let id = store_chunk(&storage, &[3, 3, 3]);
    let bytes = <Storage as AuthenticatedObjects>::read_canonical(&storage, id).expect("read");
    assert_eq!(ObjectId::for_bytes(&bytes), id);
    let ghost = ObjectId::for_bytes(b"ghost");
    assert_eq!(
        <Storage as AuthenticatedObjects>::read_canonical(&storage, ghost).unwrap_err(),
        ContentError::MissingObject
    );
}
