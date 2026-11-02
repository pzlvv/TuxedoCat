//! 带显式来源的有界建议前驱。
//!
//! 前驱是提示而非依赖：构造方按偏好序声明它认为新对象与哪些已存储对象相似，物理层
//! 决定是否取用并据此编码。列表有界，并记录每个身份被提议的原因。本 crate 的构造
//! 路径恒产出空列表；类型与编码为编码 spec 预留（docs/core/layerfs.md 第 2 节）。

use crate::error::{ContentError, ContentResult};
use crate::object::ObjectId;

/// 一个对象最多携带的建议前驱数。
pub const MAXIMUM_ADVISORY_PREDECESSORS: usize = 4;

/// 建议前驱被提议的原因。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PredecessorProvenance {
    /// 本次操作声明要编辑的基对象。
    OriginalBase,
    /// 紧邻被替换范围之前持有字节的对象。
    UnchangedPrefix,
    /// 覆盖复用子树或范围区间的已存储对象。
    ReusedRange,
}

/// 一个建议前驱。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdvisoryPredecessor {
    id: ObjectId,
    provenance: PredecessorProvenance,
}

impl AdvisoryPredecessor {
    /// 被提议为基的身份。
    pub const fn id(self) -> ObjectId {
        self.id
    }

    /// 提议原因。
    pub const fn provenance(self) -> PredecessorProvenance {
        self.provenance
    }
}

/// 有序、有界的建议前驱列表。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AdvisoryPredecessors {
    entries: Vec<AdvisoryPredecessor>,
}

impl AdvisoryPredecessors {
    /// 空列表。
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// 追加一个前驱；超出声明上界则拒绝，重复身份忽略。
    pub fn push(&mut self, id: ObjectId, provenance: PredecessorProvenance) -> ContentResult<()> {
        if self.entries.len() >= MAXIMUM_ADVISORY_PREDECESSORS {
            return Err(ContentError::BoundedCapacityExceeded {
                what: "object.predecessors",
                limit: MAXIMUM_ADVISORY_PREDECESSORS as u64,
                actual: self.entries.len() as u64 + 1,
            });
        }
        if self.entries.iter().any(|entry| entry.id == id) {
            return Ok(());
        }
        self.entries.push(AdvisoryPredecessor { id, provenance });
        Ok(())
    }

    /// 持有的前驱数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 没有任何前驱被提议时为真。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 偏好序的被提议身份。
    pub fn ids(&self) -> impl Iterator<Item = ObjectId> + '_ {
        self.entries.iter().map(|entry| entry.id)
    }

    /// 偏好序的条目及其来源。
    pub fn entries(&self) -> &[AdvisoryPredecessor] {
        &self.entries
    }

    /// 由一个显式前驱构成的列表。
    pub fn explicit(id: ObjectId) -> ContentResult<Self> {
        let mut list = Self::new();
        list.push(id, PredecessorProvenance::OriginalBase)?;
        Ok(list)
    }
}
