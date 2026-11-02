//! 本 crate 持有解码器的两个角色的值语法：`WholeFile` 与 `Chunk`。
//!
//! 两者都是字节角色对象（`BYTES_KIND`）的值，各带冻结 magic：WholeFile 值 =
//! `LFS5SML\0` + 大端 u16 版本 1 + 文件字节；Chunk 值 = `LFS4CHK\0` + 块字节。
//! 与上游 v1.1.0 `file/construction/bytes.rs` 与 `file/mapping/codec.rs` 逐字节兼容，
//! 同一内容在两边得到同一个 `ObjectId`（docs/core/layerfs.md 第 2 节）。

use crate::cdc::MAXIMUM_CHUNK_BYTES;
use crate::error::{ContentError, ContentResult};
use crate::object::codec::{
    canonical_len, decode_bytes_object, encode_bytes_object, BYTES_KIND, HEADER_LEN, OBJECT_MAGIC,
    VALUE_LEN_BYTES,
};
use crate::object::{IdentityStream, ObjectId, ObjectRole};
use crate::policy::ConstructionCapacities;

/// WholeFile 值的 magic。
pub const WHOLE_FILE_MAGIC: &[u8; 8] = b"LFS5SML\0";
/// WholeFile 值语法版本。
pub const WHOLE_FILE_VERSION: u16 = 1;
/// WholeFile 值头宽度：magic + 版本。
pub const WHOLE_FILE_VALUE_HEADER: usize = 10;
/// Chunk 值的 magic。
pub const CHUNK_MAGIC: &[u8; 8] = b"LFS4CHK\0";

/// 编码一个 WholeFile 载荷的规范对象。
///
/// 载荷必须非空且不超过策略的整文件上限；规范长度同时受整文件规范上限约束。
pub fn encode_whole_file(
    capacities: &ConstructionCapacities,
    bytes: &[u8],
) -> ContentResult<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > capacities.whole_file_raw_limit {
        return Err(ContentError::BoundedCapacityExceeded {
            what: "construction.whole_file",
            limit: capacities.whole_file_raw_limit as u64,
            actual: bytes.len() as u64,
        });
    }
    let mut value = Vec::with_capacity(WHOLE_FILE_VALUE_HEADER + bytes.len());
    value.extend_from_slice(WHOLE_FILE_MAGIC);
    value.extend_from_slice(&WHOLE_FILE_VERSION.to_be_bytes());
    value.extend_from_slice(bytes);
    let canonical = encode_bytes_object(&value)?;
    if canonical.len() > capacities.whole_file_canonical_limit {
        return Err(ContentError::BoundedCapacityExceeded {
            what: "construction.whole_file_canonical",
            limit: capacities.whole_file_canonical_limit as u64,
            actual: canonical.len() as u64,
        });
    }
    Ok(canonical)
}

/// 若 `canonical` 是 WholeFile 对象则借出其载荷；magic 不符返回 `None`，版本不符报错。
pub fn whole_file_payload(canonical: &[u8]) -> ContentResult<Option<&[u8]>> {
    let value = decode_bytes_object(canonical)?;
    if !value.starts_with(WHOLE_FILE_MAGIC) {
        return Ok(None);
    }
    if value.get(8..10) != Some(&WHOLE_FILE_VERSION.to_be_bytes()) {
        return Err(ContentError::InvalidRecord("whole-file framing"));
    }
    Ok(Some(&value[WHOLE_FILE_VALUE_HEADER..]))
}

/// 块载荷为 `raw` 字节时的规范对象宽度。
pub const fn chunk_canonical_len(raw: usize) -> usize {
    HEADER_LEN + VALUE_LEN_BYTES + CHUNK_MAGIC.len() + raw
}

/// 编码一个 Chunk 载荷的规范对象：封装与值头一次写入最终分配，载荷只复制一次。
pub fn encode_chunk_object(bytes: &[u8]) -> ContentResult<Vec<u8>> {
    if bytes.len() > MAXIMUM_CHUNK_BYTES {
        return Err(ContentError::ObjectLimitExceeded {
            limit: MAXIMUM_CHUNK_BYTES,
            actual: bytes.len(),
        });
    }
    let value_len = CHUNK_MAGIC
        .len()
        .checked_add(bytes.len())
        .ok_or(ContentError::LengthOverflow)?;
    let canonical_length = chunk_canonical_len(bytes.len());
    let payload_len =
        u32::try_from(value_len + VALUE_LEN_BYTES).map_err(|_| ContentError::LengthOverflow)?;
    let mut canonical = Vec::with_capacity(canonical_length);
    canonical.extend_from_slice(&OBJECT_MAGIC);
    canonical.push(BYTES_KIND);
    canonical.extend_from_slice(&payload_len.to_be_bytes());
    canonical.extend_from_slice(
        &u32::try_from(value_len)
            .map_err(|_| ContentError::LengthOverflow)?
            .to_be_bytes(),
    );
    canonical.extend_from_slice(CHUNK_MAGIC);
    canonical.extend_from_slice(bytes);
    debug_assert_eq!(canonical.len(), canonical_length);
    Ok(canonical)
}

/// 借出 Chunk 对象的载荷：先过封装检查，再剥 magic，再核块上界。
pub fn chunk_payload(canonical: &[u8]) -> ContentResult<&[u8]> {
    let value = decode_bytes_object(canonical)?;
    let bytes = value
        .strip_prefix(CHUNK_MAGIC)
        .ok_or(ContentError::WrongLogicalRole)?;
    if bytes.len() > MAXIMUM_CHUNK_BYTES {
        return Err(ContentError::ObjectLimitExceeded {
            limit: MAXIMUM_CHUNK_BYTES,
            actual: bytes.len(),
        });
    }
    Ok(bytes)
}

/// 载荷恰为 `bytes` 的规范块对象的身份，不构建该对象：等于 `encode_chunk_object`
/// 对同一字节的结果的身份。
pub fn chunk_id(bytes: &[u8]) -> ContentResult<ObjectId> {
    let mut identity = ChunkIdentity::new(bytes.len())?;
    identity.update(bytes)?;
    identity.finish()
}

/// 长度已知、字节按序分段到达的块的规范对象身份。冻结帧先声明长度，所以帧先哈希、
/// 载荷随后；固定大小，不保留载荷字节。
#[derive(Clone, Debug)]
pub struct ChunkIdentity {
    stream: IdentityStream,
    remaining: usize,
}

impl ChunkIdentity {
    /// 开始计算载荷 `length` 字节的块身份。
    pub fn new(length: usize) -> ContentResult<Self> {
        if length > MAXIMUM_CHUNK_BYTES {
            return Err(ContentError::ObjectLimitExceeded {
                limit: MAXIMUM_CHUNK_BYTES,
                actual: length,
            });
        }
        let value_len = (CHUNK_MAGIC.len() + length) as u32;
        let mut framing = [0_u8; HEADER_LEN + VALUE_LEN_BYTES + CHUNK_MAGIC.len()];
        framing[..4].copy_from_slice(&OBJECT_MAGIC);
        framing[4] = BYTES_KIND;
        framing[5..9].copy_from_slice(&(value_len + VALUE_LEN_BYTES as u32).to_be_bytes());
        framing[9..13].copy_from_slice(&value_len.to_be_bytes());
        framing[13..].copy_from_slice(CHUNK_MAGIC);
        let mut stream = ObjectId::stream();
        stream.update(&framing);
        Ok(Self {
            stream,
            remaining: length,
        })
    }

    /// 追加下一段载荷；超出声明长度即拒绝。
    pub fn update(&mut self, part: &[u8]) -> ContentResult<()> {
        if part.len() > self.remaining {
            return Err(ContentError::TrailingBytes);
        }
        self.remaining -= part.len();
        self.stream.update(part);
        Ok(())
    }

    /// 声明长度的载荷全部到齐后的身份；短缺即拒绝。
    pub fn finish(&self) -> ContentResult<ObjectId> {
        if self.remaining != 0 {
            return Err(ContentError::UnexpectedEof);
        }
        Ok(self.stream.finish())
    }
}

/// `Save` 接受对象前的角色语法校验：角色必须有解码器，且值语法与角色一致、落在上界内。
pub fn validate_role_payload(
    role: ObjectRole,
    canonical: &[u8],
    capacities: &ConstructionCapacities,
) -> ContentResult<()> {
    match role {
        ObjectRole::WholeFile => {
            let payload = whole_file_payload(canonical)?.ok_or(ContentError::WrongLogicalRole)?;
            if payload.is_empty() || payload.len() > capacities.whole_file_raw_limit {
                return Err(ContentError::BoundedCapacityExceeded {
                    what: "construction.whole_file",
                    limit: capacities.whole_file_raw_limit as u64,
                    actual: payload.len() as u64,
                });
            }
            Ok(())
        }
        ObjectRole::Chunk => {
            let payload = chunk_payload(canonical)?;
            if payload.is_empty() {
                return Err(ContentError::InvalidRecord("empty chunk payload"));
            }
            Ok(())
        }
        _ => Err(ContentError::WrongLogicalRole),
    }
}

/// WholeFile 值长 `payload_len` 时的规范对象宽度（用于容量校验，不分配）。
pub fn whole_file_canonical_len(payload_len: usize) -> ContentResult<usize> {
    let value_len = payload_len
        .checked_add(WHOLE_FILE_VALUE_HEADER)
        .ok_or(ContentError::LengthOverflow)?;
    canonical_len(value_len)
}
