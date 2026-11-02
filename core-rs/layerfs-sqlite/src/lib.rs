//! LayerFS SQLite 持久化适配器：`PersistenceConfig` / `Handles` 出口，profile PRAGMA、
//! schema v1、进程内 FIFO 准入 + Linux 父目录 flock、seal。本 crate 是唯一触碰文件与
//! 数据库的层（docs/core/layerfs.md 第 5 节）。
//!
//! 典型用法：`Handles::create` / `open_writable` 得到 [`Handles`]，把
//! `Arc<StorageProvider>` 交给 `layerfs::Storage::new` 做保存与读取，最后 `seal` 交付
//! 单个自包含文件。
#![deny(unsafe_code)]
#![deny(missing_docs)]

mod admission;
mod connection;
mod error;
mod open;
mod platform;
mod profile;
mod provider;
mod schema;
mod seal;
mod writer_lock;

pub use open::{Handles, PersistenceConfig};
pub use platform::StorePath;
pub use profile::{ConnectionProfile, SqlitePersistenceProfile};
pub use provider::StorageProvider;
pub use seal::SealedStore;

#[cfg(test)]
#[path = "test_support.rs"]
mod test_support;
