//! 对象持久化端口：有界的原子物理存储，每个操作一次尝试。
//!
//! 本 crate（`layerfs`）不做 I/O；SQLite 适配器（`layerfs-sqlite`）实现本端口。
//! 适配器契约：`locate` / `read_packs` 返回的字节必须已经通过长度与摘要认证；
//! `publish` 是单个原子事务，first-wins 插入定位行并回答败方名单；确认或事务结果
//! 无法证明时返回 [`PersistenceError::Uncertain`]，绝不做第二次尝试
//! （docs/core/layerfs.md 第 4 节）。

use std::fmt;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::error::{ContentError, ContentResult};
use crate::object::{ObjectId, ObjectRole};
use crate::policy::StoragePolicy;

/// 包体摘要：SHA-256。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct ObjectKey([u8; 32]);

impl ObjectKey {
    /// 字节的摘要。
    pub fn for_bytes(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    /// 借用定宽表示。
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// 从定宽表示重建。
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// pack 的路由域：由载荷的物理角色决定。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackDomain {
    /// 映射与池化元数据字节。
    Metadata,
    /// 文件内容字节。
    Payload,
}

impl PackDomain {
    /// 本 crate 持有解码器的两个角色都路由到载荷域。
    pub const fn for_role(role: ObjectRole) -> Self {
        match role {
            ObjectRole::WholeFile | ObjectRole::Chunk => Self::Payload,
            _ => Self::Metadata,
        }
    }

    /// 持久化 code。
    pub const fn code(self) -> u8 {
        match self {
            Self::Metadata => 0,
            Self::Payload => 1,
        }
    }

    /// 从持久化 code 重建。
    pub const fn from_code(code: u8) -> ContentResult<Self> {
        match code {
            0 => Ok(Self::Metadata),
            1 => Ok(Self::Payload),
            _ => Err(ContentError::InvalidRecord("pack domain code")),
        }
    }
}

/// 已封包的不可变 pack 的持久化描述。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PackInfo {
    /// 与内容摘要无关的正 pack id。
    pub pack_id: i64,
    /// lane 决定的去向。
    pub domain: PackDomain,
    /// 完整封包字节的 SHA-256。
    pub key: ObjectKey,
    /// 精确封包长度，不含容量填充。
    pub length: usize,
}

/// 一个已存储对象的描述符与物理位置。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObjectLocation {
    /// 规范身份。
    pub object_id: ObjectId,
    /// 逻辑角色 code。
    pub role: ObjectRole,
    /// 保存时记录的规范对象长度。
    pub canonical_length: usize,
    /// 持有该记录的 pack。
    pub pack_id: i64,
    /// pack 内的组序号。
    pub group_number: usize,
    /// 组内的记录序号。
    pub record_number: usize,
}

/// 对象位置连同取回其 pack 所需的描述符。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LocatedObject {
    /// 规范对象描述符与位置。
    pub location: ObjectLocation,
    /// 不可变包体描述符。
    pub pack: PackInfo,
}

/// 从端口读回的完整 pack；身份认证由调用方以 [`PersistedPack::authenticate`] 强制。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedPack {
    /// 不可变包体描述符。
    pub info: PackInfo,
    /// 完整不可变字节。
    pub body: Vec<u8>,
}

impl PersistedPack {
    /// 一次性验证长度与摘要；不符即 [`PersistenceError::Malformed`]。
    pub fn authenticate(&self) -> Result<(), PersistenceError> {
        if self.body.len() != self.info.length {
            return Err(PersistenceError::Malformed);
        }
        if ObjectKey::for_bytes(&self.body) != self.info.key {
            return Err(PersistenceError::Malformed);
        }
        Ok(())
    }
}

/// 请求的分配块。零计数表示不分配该类。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Reserve {
    /// 连续 pack id 的个数。
    pub packs: usize,
}

/// 分配到的块；绝不从未确认的响应推断预留。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Reserved {
    /// 请求了 pack 时的第一个 pack id（正数）。
    pub first_pack_id: i64,
}

/// 不可变 pack 注册，携带完整包体。
#[derive(Clone, Debug)]
pub struct PublishedPack {
    /// 摘要、大小与路由域。
    pub info: PackInfo,
    /// 与定位行原子确认的完整不可变字节。
    pub body: Arc<Vec<u8>>,
}

/// 一个原子批次：调用前对直接引用封闭。
#[derive(Clone, Debug, Default)]
pub struct Publication {
    /// 已封包，两个域都带完整包体。
    pub packs: Vec<PublishedPack>,
    /// 缺席则插入的定位行；先写者胜。
    pub objects: Vec<ObjectLocation>,
}

/// 原子注册成功后的 first-wins 竞态结果。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Published {
    /// 定位行已存在的对象；发布方必须比对字节裁决 `Collision`。
    pub lost: Vec<ObjectId>,
}

/// 一次元数据操作尝试的结果。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PersistenceError {
    /// 写锁或会话被持有；未产生任何写效果。
    Busy,
    /// 选定引擎不可用；不做任何回退。
    BackendUnavailable,
    /// 必需的持久化状态缺席。
    Missing,
    /// 提供方明确拒绝操作。
    Refused {
        /// 明确的拒绝类别。
        status: String,
    },
    /// 响应违反端口的语法或上界。
    Malformed,
    /// 确认或事务结果未知。
    Uncertain,
    /// 会话已显式关闭；等待中的调用以此退出。
    Closed,
    /// 等待被信号打断；本次尝试未发生。
    Cancelled,
}

impl fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "object persistence: {self:?}")
    }
}

impl std::error::Error for PersistenceError {}

/// 已提交的不可变物理存储。每次调用一次尝试，没有恢复循环。
pub trait ObjectPersistence: Send + Sync {
    /// 每个 C2 句柄读一次持久化的 profile。
    fn policy(&self) -> Result<StoragePolicy, PersistenceError>;
    /// 定位至多 `READ_OBJECT_LIMIT` 个不同 id；缺席者省略。
    fn locate(
        &self,
        ids: &[ObjectId],
        out: &mut Vec<LocatedObject>,
    ) -> Result<(), PersistenceError>;
    /// 读出总长有界的完整 pack；结果以 [`PersistedPack::authenticate`] 一次性验证
    /// 长度与摘要，跨本边界不可变。
    fn read_packs(&self, ids: &[i64], out: &mut Vec<PersistedPack>)
        -> Result<(), PersistenceError>;
    /// 分配一个 pack id 块。
    fn reserve(&self, request: Reserve) -> Result<Reserved, PersistenceError>;
    /// 原子注册至多 `TRANSACTION_ROW_LIMIT` 行：pack 行插入 + first-wins 定位行插入。
    /// 全部封包字节属于这一个单元。
    fn publish(&self, batch: &Publication) -> Result<Published, PersistenceError>;
}
