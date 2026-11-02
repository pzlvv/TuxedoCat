//! 显式创建 / 打开与只读授权：`PersistenceConfig` 与 `Handles`。

use std::fs::OpenOptions;
use std::sync::Arc;

use layerfs::{PersistenceError, StoragePolicy};

use crate::connection::Session;
use crate::platform::StorePath;
use crate::profile::{ConnectionProfile, SqlitePersistenceProfile};
use crate::provider::StorageProvider;
use crate::writer_lock::Writer;

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
        // 建库不需要外层车道：`create_new` 刚建出的文件不可能有别的进程正在恢复它的
        // WAL，而 `initialize` 的写事务本身就会取一次车道——再包一层会自锁
        // （flock 按打开文件描述归属，同进程两个 fd 对同一 inode 也会互相阻塞）。
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
        Self::establish(config, |path, profile| {
            let session = Session::connect(path, writable, false, profile)?;
            session.validate()?;
            Ok(session)
        })
    }

    /// 在写者车道内完成「建立连接 + 打开期校验」的整体。
    ///
    /// 车道必须包住这两步的**整体**：连接建立期的 WAL 索引恢复要独占 `-shm`，而随后的
    /// 校验事务持有 `-shm` 共享锁；中间松开一次，另一个进程的恢复就会被挡成精确 `Busy`
    /// （`busy_timeout` 固定为 0）。车道在返回前释放，不跨 `Handles` 的生命周期——两个
    /// 进程「先各自打开、再各自写」的形态与既有一致
    /// （specs/defects/layerfs-open-busy-outside-writer-lane.md）。
    fn establish(
        config: PersistenceConfig,
        body: impl FnOnce(
            StorePath,
            SqlitePersistenceProfile,
        ) -> Result<Session, PersistenceError>,
    ) -> Result<Self, PersistenceError> {
        let lane = Writer::acquire(&config.path)?;
        let established = body(config.path, config.profile);
        let released = lane.release();
        // 建立的真实失败优先于释放结果上报。
        let session = established?;
        released.map_err(|_| PersistenceError::Uncertain)?;
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
