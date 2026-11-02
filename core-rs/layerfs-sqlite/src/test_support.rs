//! 测试支撑：临时目录里的 Store、对象构造与读写辅助。仅测试编译。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use layerfs::{
    encode_chunk_object, FinalizedObject, ObjectId, ObjectPersistence, ObjectRole, Storage,
    StoragePolicy,
};

use crate::{Handles, PersistenceConfig, SqlitePersistenceProfile, StorePath};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 进程唯一的临时目录，Drop 时尽力清理（Windows 上需先释放全部句柄）。
pub struct TempStore {
    dir: PathBuf,
}

impl TempStore {
    pub fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "layerfs-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join("store.layerfs")
    }

    pub fn path(&self) -> StorePath {
        StorePath::from_os(&self.file()).expect("store path")
    }

    pub fn config(&self) -> PersistenceConfig {
        PersistenceConfig::sqlite(self.path(), SqlitePersistenceProfile::Disposable)
    }

    pub fn create(&self) -> Handles {
        Handles::create(self.config(), StoragePolicy::frozen_default()).expect("create")
    }

    pub fn open_writable(&self) -> Handles {
        Handles::open_writable(self.config()).expect("open writable")
    }
}

impl Drop for TempStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 以 `bytes` 为载荷的 Chunk 对象。
pub fn chunk_object(bytes: &[u8]) -> FinalizedObject {
    FinalizedObject::new(
        ObjectRole::Chunk,
        encode_chunk_object(bytes).expect("encode"),
    )
    .expect("object")
}

/// 用一个独立 `Storage` 句柄把若干 Chunk 载荷存进 Store，返回身份。
pub fn store_chunks(handles: &Handles, payloads: &[&[u8]]) -> Vec<ObjectId> {
    let storage =
        Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>).expect("storage");
    let save = storage.begin_save().expect("save");
    let mut ids = Vec::new();
    for payload in payloads {
        let object = chunk_object(payload);
        ids.push(object.id());
        save.accept(object).expect("accept");
    }
    save.finish().expect("finish");
    ids
}

/// 读回身份序列的规范字节。
pub fn read_objects(
    handles: &Handles,
    ids: &[ObjectId],
) -> Result<Vec<Vec<u8>>, layerfs::StorageError> {
    let storage =
        Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>).expect("storage");
    storage.reader().read_objects(ids)
}

/// 用 rusqlite 直连篡改 Store（模拟外部写入 / 版本漂移）。
pub fn tamper(path: &Path, sql: &str) {
    let connection = rusqlite::Connection::open(path).expect("tamper open");
    connection.execute_batch(sql).expect("tamper sql");
}
