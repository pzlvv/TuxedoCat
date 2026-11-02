//! LayerFS 内核库：对象身份、`LFSO` 封装、冻结 CDC 分块、`Storage` / `Save` / `Reader`
//! 与 `ObjectPersistence` 端口面。本 crate **无任何 I/O**——文件与数据库只存在于适配器
//! crate（`layerfs-sqlite`）；身份、封装与分块边界与上游 LayerFS v1.1.0 逐字节兼容
//! （docs/core/layerfs.md 第 1 节）。
//!
//! 入口类型：[`Storage`]（[`Storage::begin_save`] / [`Storage::reader`]）、
//! [`Save`]（持有 [`WriteOutcome`] 即确认）、[`Reader`]（认证批量读）、
//! [`ObjectPersistence`] 端口（适配器实现）。
#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod cdc;
pub mod error;
pub mod object;
pub mod policy;
pub mod port;
mod reader;
mod save;
mod storage;

pub use error::{ContentError, ContentResult, StorageError, StorageResult};
pub use object::{
    encode_chunk_object, encode_whole_file, AuthenticatedObjects, DiscardingConsumer,
    FinalizedConsumer, FinalizedObject, ObjectId, ObjectRole,
};
pub use policy::{
    ConstructionCapacities, ConstructionPolicy, Representation, StorageCapacities, StoragePolicy,
};
pub use port::{
    LocatedObject, ObjectKey, ObjectLocation, ObjectPersistence, PackDomain, PackInfo,
    PersistedPack, PersistenceError, Publication, Published, PublishedPack, Reserve, Reserved,
};
pub use reader::Reader;
pub use save::{Save, SaveSink, WriteOutcome};
pub use storage::Storage;

#[cfg(test)]
#[path = "test_support.rs"]
mod test_support;
