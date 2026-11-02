//! 最终化的规范输出：交给有界消费者的自持对象。
//!
//! 构造只在对象的字节、角色与直接引用都已确立、且后续输入无法再改变它们时才发出对象。
//! 分配的所有权移交消费者；本层不保留载荷副本。

use crate::error::{ContentError, ContentResult};
use crate::object::predecessor::AdvisoryPredecessors;
use crate::object::{codec, ObjectId};

/// 规范对象的逻辑含义；不是物理 FULL / DELTA 的选择。
///
/// 13 个角色的持久化 code 与上游 v1.1.0 同一张表。本 crate 只产出并语义校验
/// `WholeFile` 与 `Chunk`，其余角色保留编码、在引入对应解码器前不被 `Save` 接受
/// （docs/core/layerfs.md 第 2 节）。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum ObjectRole {
    /// 低于构造阈值的非空普通文件的完整载荷。
    WholeFile,
    /// 冻结 CDC profile 产出的一个规范块载荷。
    Chunk,
    /// 范围树叶：一页载荷切片。
    ExtentLeaf,
    /// 范围树枝：一页子节点摘要。
    ExtentBranch,
    /// 文件状态：分块文件的逻辑根。
    FileState,
    /// 紧凑 inode 值叶。
    InodeLeaf,
    /// 紧凑目录叶：`name -> inode serial` 行。
    DirectoryLeaf,
    /// 紧凑目录枝。
    DirectoryBranch,
    /// 紧凑 inode 表枝。
    InodeBranch,
    /// 带作用域的文件系统根。
    FilesystemRoot,
    /// 属性树叶：`domain + key -> value root` 条目。
    AttributeLeaf,
    /// 属性树枝。
    AttributeBranch,
    /// 符号链接目标。
    Symlink,
}

impl ObjectRole {
    /// 稳定的持久化角色 code。
    pub const fn code(self) -> u8 {
        match self {
            Self::WholeFile => 1,
            Self::Chunk => 2,
            Self::ExtentLeaf => 3,
            Self::ExtentBranch => 4,
            Self::FileState => 5,
            Self::InodeLeaf => 6,
            Self::DirectoryLeaf => 7,
            Self::DirectoryBranch => 8,
            Self::InodeBranch => 9,
            Self::FilesystemRoot => 10,
            Self::AttributeLeaf => 11,
            Self::AttributeBranch => 12,
            Self::Symlink => 13,
        }
    }

    /// 从持久化 code 重建角色。
    pub const fn from_code(code: u8) -> ContentResult<Self> {
        match code {
            1 => Ok(Self::WholeFile),
            2 => Ok(Self::Chunk),
            3 => Ok(Self::ExtentLeaf),
            4 => Ok(Self::ExtentBranch),
            5 => Ok(Self::FileState),
            6 => Ok(Self::InodeLeaf),
            7 => Ok(Self::DirectoryLeaf),
            8 => Ok(Self::DirectoryBranch),
            9 => Ok(Self::InodeBranch),
            10 => Ok(Self::FilesystemRoot),
            11 => Ok(Self::AttributeLeaf),
            12 => Ok(Self::AttributeBranch),
            13 => Ok(Self::Symlink),
            _ => Err(ContentError::InvalidRecord("object role code")),
        }
    }

    /// 本 crate 持有解码器、`Save` 接受的角色。
    pub const fn has_decoder(self) -> bool {
        matches!(self, Self::WholeFile | Self::Chunk)
    }
}

/// 一个最终化的规范对象：身份、角色、自持字节、直接引用与建议前驱。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalizedObject {
    id: ObjectId,
    role: ObjectRole,
    canonical: Vec<u8>,
    references: Vec<ObjectId>,
    predecessors: AdvisoryPredecessors,
}

impl FinalizedObject {
    /// 包装可信的构造输出并一次性计算身份。只检查封装，不做语义准入。
    pub fn new(role: ObjectRole, canonical: Vec<u8>) -> ContentResult<Self> {
        // 任何角色的对象都必须先是可解码的规范对象。
        codec::decode_bytes_object(&canonical)?;
        let id = ObjectId::for_bytes(&canonical);
        Ok(Self {
            id,
            role,
            canonical,
            references: Vec::new(),
            predecessors: AdvisoryPredecessors::new(),
        })
    }

    /// 附上构造该对象所依据的直接逻辑引用。
    pub fn with_references(mut self, references: Vec<ObjectId>) -> Self {
        self.references = references;
        self
    }

    /// 附上物理表示用的有界建议前驱。
    pub fn with_predecessors(mut self, predecessors: AdvisoryPredecessors) -> Self {
        self.predecessors = predecessors;
        self
    }

    /// 规范字节的身份。
    pub const fn id(&self) -> ObjectId {
        self.id
    }

    /// 已确立的语义角色。
    pub const fn role(&self) -> ObjectRole {
        self.role
    }

    /// 含封装的规范字节。
    pub fn canonical(&self) -> &[u8] {
        &self.canonical
    }

    /// 规范长度（字节）。
    pub fn canonical_len(&self) -> usize {
        self.canonical.len()
    }

    /// 规范序的直接逻辑子身份。
    pub fn references(&self) -> &[ObjectId] {
        &self.references
    }

    /// 偏好序的有界建议前驱。
    pub fn predecessors(&self) -> &AdvisoryPredecessors {
        &self.predecessors
    }

    /// 把自持的各部分移交给存储或转发它们的消费者。
    ///
    /// 五个部分是身份、角色、规范字节、直接引用**与建议前驱**：前驱是生产保存路径用来
    /// 选物理表示的输入，经此取得所有权的消费者必须收到它——静默丢弃就是丢了对象
    /// 构造时的一份输入。
    pub fn into_parts(self) -> ObjectParts {
        ObjectParts {
            id: self.id,
            role: self.role,
            canonical: self.canonical,
            references: self.references,
            predecessors: self.predecessors,
        }
    }
}

/// [`FinalizedObject::into_parts`] 移交的各部分。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectParts {
    /// 规范身份。
    pub id: ObjectId,
    /// 逻辑角色。
    pub role: ObjectRole,
    /// 规范字节。
    pub canonical: Vec<u8>,
    /// 规范序的直接逻辑子身份。
    pub references: Vec<ObjectId>,
    /// 偏好序的有界建议前驱。
    pub predecessors: AdvisoryPredecessors,
}

/// 最终化规范对象的有界 sink。
///
/// `accept` 取得所有权。返回错误即结束构造：调用方收到该错误一次，不重试、不重发、
/// 不走替代路径。
pub trait FinalizedConsumer {
    /// 接受一个最终化对象。
    fn accept(&mut self, object: FinalizedObject) -> ContentResult<()>;
}

/// 不持久化、只计数的消费者：构造可以在没有任何数据库 / pack / 文件参与时完成。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiscardingConsumer {
    objects: u64,
    canonical_bytes: u64,
    peak_object_bytes: u64,
}

impl DiscardingConsumer {
    /// 空消费者。
    pub const fn new() -> Self {
        Self {
            objects: 0,
            canonical_bytes: 0,
            peak_object_bytes: 0,
        }
    }

    /// 已接受的对象数。
    pub const fn objects(self) -> u64 {
        self.objects
    }

    /// 已接受的规范字节总数。
    pub const fn canonical_bytes(self) -> u64 {
        self.canonical_bytes
    }

    /// 最大的单个已接受规范对象。
    pub const fn peak_object_bytes(self) -> u64 {
        self.peak_object_bytes
    }
}

impl FinalizedConsumer for DiscardingConsumer {
    fn accept(&mut self, object: FinalizedObject) -> ContentResult<()> {
        let length = object.canonical_len() as u64;
        self.objects = self.objects.saturating_add(1);
        self.canonical_bytes = self.canonical_bytes.saturating_add(length);
        self.peak_object_bytes = self.peak_object_bytes.max(length);
        Ok(())
    }
}
