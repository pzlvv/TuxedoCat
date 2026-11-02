//! 显式创建 / 打开与只读授权：`PersistenceConfig` 与 `Handles`。

use std::fs::OpenOptions;
use std::sync::Arc;

use layerfs::{PersistenceError, StoragePolicy};

use crate::connection::Session;
use crate::platform::StorePath;
use crate::profile::{ConnectionProfile, SqlitePersistenceProfile};
use crate::provider::StorageProvider;

/// 一个完整的 Store 数据库路径与 profile 选择；无默认值、不由失败或环境推断。
#[derive(Clone, Debug)]
pub struct PersistenceConfig {
    /// 宿主本地的 SQLite 文件；绝不是网络端点。
    pub path: StorePath,
    /// 显式 profile。
    pub profile: SqlitePersistenceProfile,
}

impl PersistenceConfig {
    /// 在显式路径上选定 SQLite 引擎与 profile。
    pub fn sqlite(path: StorePath, profile: SqlitePersistenceProfile) -> Self {
        Self { path, profile }
    }
}

/// 应用持有的物理端口句柄；一个会话、无服务引导、无隐式授权创建。
pub struct Handles {
    /// 有界的 pack 发布 / 读取 / 分配端口。
    pub storage: Arc<StorageProvider>,
}

impl Handles {
    /// 创建一个全新的 Store：已存在的文件被拒绝，不覆盖。
    pub fn create(
        config: PersistenceConfig,
        policy: StoragePolicy,
    ) -> Result<Self, PersistenceError> {
        let policy = policy
            .validated()
            .map_err(|_| PersistenceError::Malformed)?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(config.path.as_path())
            .map_err(|error| PersistenceError::Refused {
                status: error.kind().to_string(),
            })?;
        let session = Session::connect(config.path, true, true, config.profile)?;
        session.initialize(policy)?;
        session.validate()?;
        Ok(Self {
            storage: Arc::new(StorageProvider {
                session: Arc::new(session),
            }),
        })
    }

    /// 以显式 profile 打开可写会话；schema 与 profile 逐项校验。
    pub fn open_writable(config: PersistenceConfig) -> Result<Self, PersistenceError> {
        Self::open(config, true)
    }

    /// 打开一个只读会话；写在 BEGIN 或 SQL 之前即被拒绝。
    pub fn open_read_only(config: PersistenceConfig) -> Result<Self, PersistenceError> {
        Self::open(config, false)
    }

    fn open(config: PersistenceConfig, writable: bool) -> Result<Self, PersistenceError> {
        let session = Session::connect(config.path, writable, false, config.profile)?;
        session.validate()?;
        Ok(Self {
            storage: Arc::new(StorageProvider {
                session: Arc::new(session),
            }),
        })
    }

    /// 关闭本会话的准入：每个排队或此后请求连接的调用都报 `Closed`，不尝试 SQL。
    /// 正持有连接的调用及其车道跑到完成。
    pub fn close(&self) {
        self.storage.session.admission.close();
    }

    /// 从真实连接读回的设置。
    pub fn profile(&self) -> &ConnectionProfile {
        &self.storage.session.profile
    }
}

impl std::fmt::Debug for Handles {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Handles")
            .field("path", &self.storage.session.path)
            .field("profile", &self.storage.session.profile.identity)
            .field("writable", &self.storage.session.writable)
            .finish()
    }
}
