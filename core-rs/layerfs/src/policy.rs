//! 带检查的构造 profile、派生容量与持久化的存储策略。
//!
//! 构造 profile 在显式支持的范围内真正可配：整文件阈值接受 128 KiB–1 MiB 的任意 2 的幂，
//! 各角色深度接受 0（关闭该角色的 delta）到声明上限；其余一律在任何工作开始前拒绝。
//! 容量由被接受的 profile 以检查算术派生。策略常量只在本模块定义一处
//! （docs/core/layerfs.md 第 3 节）。

use crate::cdc;
use crate::error::{ContentError, ContentResult, StorageError, StorageResult};

/// 持久化 schema 的格式 profile（本系列自己的常量，与上游 Store 无关）。
pub const FORMAT_PROFILE: u8 = 1;

/// 默认排他构造阈值：达到该长度的文件走分块。
pub const DEFAULT_SMALL_FILE_THRESHOLD_BYTES: u64 = 131_072;
/// 最小接受的构造阈值。
pub const MINIMUM_SMALL_FILE_THRESHOLD_BYTES: u64 = 131_072;
/// 最大接受的构造阈值。
pub const MAXIMUM_SMALL_FILE_THRESHOLD_BYTES: u64 = 1_048_576;
/// 默认整文件依赖上界。
pub const DEFAULT_WHOLE_FILE_DELTA_MAX_DEPTH: u8 = 16;
/// 默认块依赖上界。
pub const DEFAULT_CHUNK_DELTA_MAX_DEPTH: u8 = 8;
/// 任一角色接受的最大依赖深度。
pub const MAXIMUM_DELTA_MAX_DEPTH: u8 = 50;
/// 默认元数据角色依赖上界（043 按上游校验范围持久化预留，未使用）。
pub const DEFAULT_METADATA_DELTA_MAX_DEPTH: u8 = 8;

/// 本 profile 接受的最大规范对象（16 MiB）：与角色无关的封装上界。
pub const MAX_CANONICAL_OBJECT_BYTES: usize = 16 * 1024 * 1024;
/// 规范字节角色对象单个值的上限（8 MiB）。
pub const MAX_OBJECT_FIELD_BYTES: usize = 8 * 1024 * 1024;

/// 一个批次 / 波次的最大对象数。
pub const BATCH_OBJECT_LIMIT: usize = 512;
/// 一个待发批次的规范字节上界。
pub const BATCH_CANONICAL_BYTES_LIMIT: u64 = 512 * 1024;
/// 单个发布事务的最大行数。
pub const TRANSACTION_ROW_LIMIT: u64 = 8_191;
/// 单个发布事务的规范字节上界。
pub const TRANSACTION_CANONICAL_BYTES_LIMIT: u64 = 4 * 1024 * 1024 - 1;
/// 一次读需求的最大对象数。
pub const READ_OBJECT_LIMIT: usize = 4_096;
/// 一次读需求的规范字节窗口上界。
pub const READ_CANONICAL_BYTES_LIMIT: usize = 32 * 1024 * 1024;
/// 元数据域单 pack 上限（043 的 pack 是单记录布局，域路由见 port::PackDomain）。
pub const PACK_LIMIT: usize = 256 * 1024;
/// 载荷域单 pack 上限：最大规范对象 + 帧余量（043 沿用上游单例上限口径）。
pub const SINGLETON_PACK_LIMIT: usize = MAX_CANONICAL_OBJECT_BYTES + 4 * 1024;

/// WholeFile 对象在原始载荷之外的规范字节开销：13 字节封装 + 10 字节值头。
pub const WHOLE_FILE_CANONICAL_OVERHEAD: usize = 23;

/// 不可变构造策略：一个阈值与两个角色各自的深度上界。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConstructionPolicy {
    small_file_threshold_bytes: u64,
    whole_file_delta_max_depth: u8,
    chunk_delta_max_depth: u8,
}

impl ConstructionPolicy {
    /// 默认被接受的策略。
    pub const fn frozen_default() -> Self {
        Self {
            small_file_threshold_bytes: DEFAULT_SMALL_FILE_THRESHOLD_BYTES,
            whole_file_delta_max_depth: DEFAULT_WHOLE_FILE_DELTA_MAX_DEPTH,
            chunk_delta_max_depth: DEFAULT_CHUNK_DELTA_MAX_DEPTH,
        }
    }

    /// 构造策略候选；使用前先调 [`Self::validated`]。
    pub const fn new(
        small_file_threshold_bytes: u64,
        whole_file_delta_max_depth: u8,
        chunk_delta_max_depth: u8,
    ) -> Self {
        Self {
            small_file_threshold_bytes,
            whole_file_delta_max_depth,
            chunk_delta_max_depth,
        }
    }

    /// 每个字段都在支持范围内才接受。
    ///
    /// 阈值必须是 [`MINIMUM_SMALL_FILE_THRESHOLD_BYTES`]..=[`MAXIMUM_SMALL_FILE_THRESHOLD_BYTES`]
    /// 内的 2 的幂；两个深度接受 0 到 [`MAXIMUM_DELTA_MAX_DEPTH`]。
    pub const fn validated(self) -> ContentResult<Self> {
        let threshold = self.small_file_threshold_bytes;
        if !threshold.is_power_of_two()
            || threshold < MINIMUM_SMALL_FILE_THRESHOLD_BYTES
            || threshold > MAXIMUM_SMALL_FILE_THRESHOLD_BYTES
        {
            return Err(ContentError::UnsupportedPolicy {
                field: "small_file_threshold_bytes",
            });
        }
        if self.whole_file_delta_max_depth > MAXIMUM_DELTA_MAX_DEPTH {
            return Err(ContentError::UnsupportedPolicy {
                field: "whole_file_delta_max_depth",
            });
        }
        if self.chunk_delta_max_depth > MAXIMUM_DELTA_MAX_DEPTH {
            return Err(ContentError::UnsupportedPolicy {
                field: "chunk_delta_max_depth",
            });
        }
        Ok(self)
    }

    /// 排他的构造阈值（字节）。
    pub const fn small_file_threshold_bytes(self) -> u64 {
        self.small_file_threshold_bytes
    }

    /// 整文件依赖上界；`0` 关闭整文件 delta 选择。
    pub const fn whole_file_delta_max_depth(self) -> u8 {
        self.whole_file_delta_max_depth
    }

    /// 块依赖上界；`0` 关闭块 delta 选择。
    pub const fn chunk_delta_max_depth(self) -> u8 {
        self.chunk_delta_max_depth
    }

    /// 按 `logical_len` 选择文件的整文件表示。
    pub const fn representation(self, logical_len: u64) -> Representation {
        if logical_len == 0 {
            Representation::Empty
        } else if logical_len < self.small_file_threshold_bytes {
            Representation::WholeFile
        } else {
            Representation::Chunked
        }
    }

    /// 以检查算术从本策略派生的容量。
    pub const fn capacities(self) -> ConstructionCapacities {
        debug_assert!(
            self.small_file_threshold_bytes >= MINIMUM_SMALL_FILE_THRESHOLD_BYTES,
            "capacities() 要求已被 validated 的阈值"
        );
        let raw = (self.small_file_threshold_bytes as usize).saturating_sub(1);
        ConstructionCapacities {
            whole_file_raw_limit: raw,
            whole_file_canonical_limit: raw.saturating_add(WHOLE_FILE_CANONICAL_OVERHEAD),
            chunk_raw_limit: cdc::MAXIMUM_CHUNK_BYTES,
            chunk_minimum_raw: cdc::MINIMUM_CHUNK_BYTES,
            canonical_object_limit: MAX_CANONICAL_OBJECT_BYTES,
            whole_file_delta_max_depth: self.whole_file_delta_max_depth,
            chunk_delta_max_depth: self.chunk_delta_max_depth,
        }
    }
}

impl Default for ConstructionPolicy {
    fn default() -> Self {
        Self::frozen_default()
    }
}

/// 按逻辑长度选择的整文件表示。
///
/// `Empty` 的对象形态属于映射树 spec：本 crate 的选择器如实返回它，但不产出对象。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Representation {
    /// 零长度文件。
    Empty,
    /// `0 < 长度 < 阈值`：一个整文件规范对象。
    WholeFile,
    /// `长度 >= 阈值`：块序列上的文件状态。
    Chunked,
}

/// 构造层在分配前先收取的派生不可变容量。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConstructionCapacities {
    /// 最大整文件载荷：阈值减一。
    pub whole_file_raw_limit: usize,
    /// 最大整文件规范对象（含封装）。
    pub whole_file_canonical_limit: usize,
    /// 冻结 CDC profile 接受的最大块载荷。
    pub chunk_raw_limit: usize,
    /// 冻结 CDC profile 接受的最小块载荷。
    pub chunk_minimum_raw: usize,
    /// 任一角色的最大规范对象。
    pub canonical_object_limit: usize,
    /// 记录的整文件依赖上界。
    pub whole_file_delta_max_depth: u8,
    /// 记录的块依赖上界。
    pub chunk_delta_max_depth: u8,
}

/// 持久化的存储策略：格式 profile、冻结 CDC 身份、构造策略与预留的元数据深度。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StoragePolicy {
    format_profile: u8,
    cdc_profile_id: [u8; 32],
    construction: ConstructionPolicy,
    metadata_delta_max_depth: u8,
}

impl StoragePolicy {
    /// 冻结默认策略：默认构造策略 + 当前冻结 CDC 身份。
    pub fn frozen_default() -> Self {
        Self::from_construction(ConstructionPolicy::frozen_default())
    }

    /// 以给定构造策略与默认元数据深度组成当前格式的策略。
    pub fn from_construction(construction: ConstructionPolicy) -> Self {
        Self {
            format_profile: FORMAT_PROFILE,
            cdc_profile_id: cdc::profile_id(),
            construction,
            metadata_delta_max_depth: DEFAULT_METADATA_DELTA_MAX_DEPTH,
        }
    }

    /// 从持久化字段重建策略；`validated` 逐项核对后再用。
    pub const fn from_persisted(
        format_profile: u8,
        cdc_profile_id: [u8; 32],
        construction: ConstructionPolicy,
        metadata_delta_max_depth: u8,
    ) -> Self {
        Self {
            format_profile,
            cdc_profile_id,
            construction,
            metadata_delta_max_depth,
        }
    }

    /// 格式 profile。
    pub const fn format_profile(self) -> u8 {
        self.format_profile
    }

    /// 冻结 CDC profile 身份。
    pub const fn cdc_profile_id(self) -> [u8; 32] {
        self.cdc_profile_id
    }

    /// 构造策略。
    pub const fn construction(self) -> ConstructionPolicy {
        self.construction
    }

    /// 元数据角色依赖上界（预留字段）。
    pub const fn metadata_delta_max_depth(self) -> u8 {
        self.metadata_delta_max_depth
    }

    /// 打开期逐项核对：格式 profile、CDC 身份、构造策略与元数据深度都必须被支持。
    pub fn validated(self) -> StorageResult<Self> {
        if self.format_profile != FORMAT_PROFILE {
            return Err(StorageError::UnsupportedPolicy {
                field: "format_profile",
            });
        }
        if self.cdc_profile_id != cdc::profile_id() {
            return Err(StorageError::UnsupportedPolicy {
                field: "cdc_profile_id",
            });
        }
        self.construction.validated().map_err(StorageError::from)?;
        if self.metadata_delta_max_depth > MAXIMUM_DELTA_MAX_DEPTH {
            return Err(StorageError::UnsupportedPolicy {
                field: "metadata_delta_max_depth",
            });
        }
        Ok(self)
    }
}

/// 存储层在保存 / 读取前收取的固定窗口容量。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StorageCapacities {
    /// 构造容量。
    pub construction: ConstructionCapacities,
    /// 一个待发批次的最大对象数。
    pub batch_objects: usize,
    /// 一个待发批次的规范字节上界。
    pub batch_bytes: u64,
    /// 单个发布事务的最大行数。
    pub transaction_rows: u64,
    /// 单个发布事务的规范字节上界。
    pub transaction_bytes: u64,
    /// 一次读需求的最大对象数。
    pub read_objects: usize,
    /// 一次读需求的规范字节窗口上界。
    pub read_bytes: usize,
}

impl StorageCapacities {
    /// 从已验证的策略派生：派生只做检查算术，不会因抬高一个字段而抬高另一个。
    pub fn from_policy(policy: StoragePolicy) -> StorageResult<Self> {
        Ok(Self {
            construction: policy.construction().capacities(),
            batch_objects: BATCH_OBJECT_LIMIT,
            batch_bytes: BATCH_CANONICAL_BYTES_LIMIT,
            transaction_rows: TRANSACTION_ROW_LIMIT,
            transaction_bytes: TRANSACTION_CANONICAL_BYTES_LIMIT,
            read_objects: READ_OBJECT_LIMIT,
            read_bytes: READ_CANONICAL_BYTES_LIMIT,
        })
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
