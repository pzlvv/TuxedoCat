//! 打开路径的测试：创建 → 重开（AC-1 半边）、版本漂移拒开且字节不变（AC-2）、
//! 非 WAL 拒开（AC-3）、已存在路径拒建、只读会话拒写。

use layerfs::{ObjectPersistence, PersistenceError, Reserve};

use crate::test_support::{read_objects, store_chunks, tamper, TempStore};
use crate::Handles;

fn file_bytes(path: &std::path::Path) -> Vec<u8> {
    std::fs::read(path).expect("read file")
}

#[test]
fn create_then_reopen_round_trips() {
    let temp = TempStore::new("schema");
    let handles = temp.create();
    let ids = store_chunks(&handles, &[b"alpha", b"beta"]);
    assert_eq!(handles.profile().identity, "sqlite-wal-off-v2");
    assert_eq!(handles.profile().synchronous, 0);
    assert_eq!(handles.profile().journal_mode, "wal");
    assert_eq!(handles.profile().page_size, 4096);
    assert_eq!(handles.profile().busy_timeout, 0);
    drop(handles);
    let reopened = temp.open_writable();
    let read = read_objects(&reopened, &ids).expect("read");
    assert_eq!(read.len(), 2);
}

#[test]
fn higher_schema_version_is_refused_without_touching_bytes() {
    let temp = TempStore::new("version");
    let handles = temp.create();
    store_chunks(&handles, &[b"payload"]);
    // 关闭并 checkpoint，让主文件自包含后再篡改版本号。
    handles.seal().expect("seal");
    tamper(&temp.file(), "PRAGMA user_version=99;");
    let before = file_bytes(&temp.file());
    let error = Handles::open_writable(temp.config()).unwrap_err();
    assert!(matches!(error, PersistenceError::Malformed));
    assert_eq!(file_bytes(&temp.file()), before);
    // 更低的版本同样拒绝。
    tamper(&temp.file(), "PRAGMA user_version=0;");
    let error = Handles::open_writable(temp.config()).unwrap_err();
    assert!(matches!(error, PersistenceError::Malformed));
}

#[test]
fn non_wal_journal_is_refused() {
    let temp = TempStore::new("journal");
    let handles = temp.create();
    handles.seal().expect("seal");
    tamper(&temp.file(), "PRAGMA journal_mode=delete;");
    let error = Handles::open_writable(temp.config()).unwrap_err();
    assert!(matches!(error, PersistenceError::Malformed));
}

#[test]
fn unexpected_table_is_refused() {
    let temp = TempStore::new("extra-table");
    let handles = temp.create();
    handles.seal().expect("seal");
    tamper(&temp.file(), "CREATE TABLE intruder(x INTEGER);");
    let error = Handles::open_writable(temp.config()).unwrap_err();
    assert!(matches!(error, PersistenceError::Malformed));
}

#[test]
fn create_over_existing_path_is_refused() {
    let temp = TempStore::new("existing");
    let handles = temp.create();
    drop(handles);
    let error =
        Handles::create(temp.config(), layerfs::StoragePolicy::frozen_default()).unwrap_err();
    assert!(matches!(error, PersistenceError::Refused { .. }));
}

#[test]
fn read_only_session_refuses_writes_before_sql() {
    let temp = TempStore::new("read-only");
    let handles = temp.create();
    let ids = store_chunks(&handles, &[b"read me"]);
    drop(handles);
    let reader = Handles::open_read_only(temp.config()).expect("open read-only");
    assert_eq!(read_objects(&reader, &ids).expect("read").len(), 1);
    let error = reader.storage.reserve(Reserve { packs: 1 }).unwrap_err();
    assert!(matches!(error, PersistenceError::Refused { ref status } if status == "ReadOnly"));
}

#[test]
fn policy_round_trips_through_store() {
    let temp = TempStore::new("policy");
    let handles = temp.create();
    let policy = handles.storage.policy().expect("policy");
    assert_eq!(policy, layerfs::StoragePolicy::frozen_default());
}
