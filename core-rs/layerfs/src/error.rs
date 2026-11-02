//! 类型化错误：内容层 `ContentError` 与存储层 `StorageError`。
//!
//! 每个变体只由一处检查产出。一次操作只做一次尝试：失败原样返回给调用方，不走错误驱动的
//! 替代算法；让持久化结果无法证明的失败以 [`StorageError::UnknownOutcome`] 上报，绝不
//! 触发重发、轮询或基于猜测的破坏性清理（docs/core/layerfs.md 第 4 节）。

use std::fmt;

use crate::object::ObjectId;
use crate::port::PersistenceError;

/// 规范封装、构造与逻辑读取产出的失败。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentError {
    /// 配置值落在显式实现的 profile 之外。
    UnsupportedPolicy {
        /// 被拒绝的策略字段。
        field: &'static str,
    },
    /// 带检查的长度 / 偏移运算溢出。
    LengthOverflow,
    /// 输入在声明的结构结束前提前结束。
    UnexpectedEof,
    /// 声明的结构之后还有尾随字节。
    TrailingBytes,
    /// 规范封装的 magic 或 kind 不是支持的那一个。
    UnsupportedFraming,
    /// 规范值属于另一个逻辑角色。
    WrongLogicalRole,
    /// 某个结构不变量不成立；标签点名失败的检查。
    InvalidRecord(&'static str),
    /// 会超出某个声明上界。
    ObjectLimitExceeded {
        /// 会被超出的上界（字节）。
        limit: usize,
        /// 请求或发现的大小。
        actual: usize,
    },
    /// 字节摘要与其被提供时所用的身份不一致。
    IdentityMismatch,
    /// 提供方不持有请求的对象。
    ///
    /// 这是**提供方缺席**：读路径请求了一个身份而提供方给不出。持有状态但无法服务
    /// （损坏、容量拒绝）一律是 [`ContentError::ProviderFailure`]，两类严格分开。
    MissingObject,
    /// 提供方持有该请求的状态但无法服务：损坏、容量拒绝或引擎失败。
    ProviderFailure {
        /// 提供方命名的拒绝类别。
        what: &'static str,
    },
    /// 原始身份宽度错误。
    InvalidIdentityLength {
        /// 要求的宽度（字节）。
        expected: usize,
        /// 提供的宽度（字节）。
        actual: usize,
    },
    /// 身份文本不是正确宽度的十六进制。
    InvalidIdentityText,
    /// 经提供的 sink 读写失败。
    Io,
    /// 提供的有界消费者拒绝了对象。
    OutputRejected,
    /// 某个声明的有界容量被超出。
    BoundedCapacityExceeded {
        /// 有界资源名，如 `object.predecessors`。
        what: &'static str,
        /// 声明的上限。
        limit: u64,
        /// 请求或观察到的大小。
        actual: u64,
    },
    /// 提供方返回的批次基数不对。
    BatchCardinality {
        /// 请求的标识数。
        requested: usize,
        /// 返回的值数。
        returned: usize,
    },
}

impl fmt::Display for ContentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPolicy { field } => {
                write!(formatter, "unsupported construction policy field: {field}")
            }
            Self::LengthOverflow => formatter.write_str("length overflow"),
            Self::UnexpectedEof => formatter.write_str("unexpected end of input"),
            Self::TrailingBytes => formatter.write_str("trailing bytes"),
            Self::UnsupportedFraming => formatter.write_str("unsupported canonical framing"),
            Self::WrongLogicalRole => formatter.write_str("wrong logical role"),
            Self::InvalidRecord(what) => write!(formatter, "invalid record: {what}"),
            Self::ObjectLimitExceeded { limit, actual } => {
                write!(formatter, "object limit {limit} exceeded by {actual}")
            }
            Self::IdentityMismatch => formatter.write_str("object identity mismatch"),
            Self::MissingObject => formatter.write_str("object not available"),
            Self::ProviderFailure { what } => write!(formatter, "provider failure: {what}"),
            Self::InvalidIdentityLength { expected, actual } => {
                write!(formatter, "identity width {actual}, expected {expected}")
            }
            Self::InvalidIdentityText => formatter.write_str("invalid identity text"),
            Self::Io => formatter.write_str("content I/O failure"),
            Self::OutputRejected => formatter.write_str("finalized output rejected"),
            Self::BoundedCapacityExceeded {
                what,
                limit,
                actual,
            } => write!(
                formatter,
                "bounded capacity {what} limit {limit} exceeded by {actual}"
            ),
            Self::BatchCardinality {
                requested,
                returned,
            } => write!(
                formatter,
                "batch returned {returned} of {requested} objects"
            ),
        }
    }
}

impl std::error::Error for ContentError {}

/// 内容层结果别名。
pub type ContentResult<T> = Result<T, ContentError>;

/// 物理存储组件产出的失败。
#[derive(Debug)]
pub enum StorageError {
    /// 一次持久化尝试在产生任何效果前遇到被持有的写锁。
    Busy,
    /// 规范构造、封装或读取检查失败。
    Content(ContentError),
    /// 宿主文件系统 / 引擎拒绝了物理 Store 操作。
    Io(std::io::Error),
    /// 请求的对象未存储。
    ObjectMissing(ObjectId),
    /// 已存储字节与同一身份下提供的字节不同。
    Collision(ObjectId),
    /// 某个直接逻辑依赖既未存储也不在当前批次。
    MissingDependency {
        /// 引用未解析的对象。
        object: ObjectId,
        /// 未解析的直接引用。
        reference: ObjectId,
    },
    /// 本句柄已有活动的 `Save`。
    OwnershipUnavailable,
    /// 请求的策略 / profile / 角色不被本实现支持。
    UnsupportedPolicy {
        /// 被拒绝的字段或 profile。
        field: &'static str,
    },
    /// 物理封装、定位或基数不变量不成立。
    Integrity(&'static str),
    /// 会超出某个声明上界。
    CapacityExceeded {
        /// 有界资源名。
        what: &'static str,
        /// 声明的上限。
        limit: u64,
        /// 请求或观察到的大小。
        actual: u64,
    },
    /// 确认未成立，写入可能已提交也可能没有。
    UnknownOutcome {
        /// 阻止确认的那个失败。
        original: Box<StorageError>,
    },
    /// 操作在成功前被显式终止（此前已有终止性失败）。
    Aborted,
    /// 会话已关闭；排队中与后续调用都得到它。
    Closed,
    /// 等待被信号打断，一次尝试未发生。
    Cancelled,
}

impl StorageError {
    /// 该失败是否让持久化结果无法证明。
    pub fn is_unknown_outcome(&self) -> bool {
        matches!(self, Self::UnknownOutcome { .. })
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("Store busy before effect"),
            Self::Content(error) => write!(formatter, "content: {error}"),
            Self::Io(error) => write!(formatter, "physical Store I/O: {error}"),
            Self::ObjectMissing(id) => write!(formatter, "object {id} is not stored"),
            Self::Collision(id) => write!(formatter, "identity collision for {id}"),
            Self::MissingDependency { object, reference } => {
                write!(formatter, "{object} depends on missing {reference}")
            }
            Self::OwnershipUnavailable => formatter.write_str("save ownership unavailable"),
            Self::UnsupportedPolicy { field } => {
                write!(formatter, "unsupported storage policy: {field}")
            }
            Self::Integrity(what) => write!(formatter, "storage integrity: {what}"),
            Self::CapacityExceeded {
                what,
                limit,
                actual,
            } => write!(
                formatter,
                "bounded capacity {what} limit {limit} exceeded by {actual}"
            ),
            Self::UnknownOutcome { original } => {
                write!(formatter, "unknown persistence outcome after: {original}")
            }
            Self::Aborted => formatter.write_str("save aborted before success"),
            Self::Closed => formatter.write_str("Store session closed"),
            Self::Cancelled => formatter.write_str("wait cancelled by signal"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<ContentError> for StorageError {
    fn from(error: ContentError) -> Self {
        Self::Content(error)
    }
}

impl From<PersistenceError> for StorageError {
    fn from(error: PersistenceError) -> Self {
        match error {
            PersistenceError::Busy => Self::Busy,
            PersistenceError::Closed => Self::Closed,
            PersistenceError::Cancelled => Self::Cancelled,
            PersistenceError::Uncertain => Self::UnknownOutcome {
                original: Box::new(Self::Io(std::io::Error::other(error))),
            },
            other => Self::Io(std::io::Error::other(other)),
        }
    }
}

/// 存储层结果别名。
pub type StorageResult<T> = Result<T, StorageError>;

/// 把一次 Store 读失败映射到提供方契约的错误类别。
///
/// `MissingObject` 只回答缺席；其余失败（损坏的定位行或 pack、容量拒绝、引擎失败）
/// 以可区分的 [`ContentError::ProviderFailure`] 到达构造方，不冒充缺席。
pub(crate) fn provider_error(error: &StorageError) -> ContentError {
    match error {
        StorageError::ObjectMissing(_) => ContentError::MissingObject,
        StorageError::Content(content) => content.clone(),
        StorageError::Integrity(what) => ContentError::ProviderFailure { what },
        StorageError::CapacityExceeded { what, .. } => ContentError::ProviderFailure { what },
        StorageError::UnsupportedPolicy { field } => ContentError::ProviderFailure { what: field },
        StorageError::Collision(_) => ContentError::ProviderFailure {
            what: "identity collision",
        },
        StorageError::MissingDependency { .. } => ContentError::ProviderFailure {
            what: "missing dependency",
        },
        _ => ContentError::ProviderFailure {
            what: "store read failure",
        },
    }
}
