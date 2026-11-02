//! 规范对象封装：帧格式、带检查的解码与单遍编码。
//!
//! 封装为 `LFSO` + 1 字节 kind + 大端载荷长度 + 大端值长度 + 值。编码一次写入最终分配；
//! 解码从提供的字节里借出值，并拒绝它发现的每一处长度、kind 与尾随字节违例。
//! 与上游 LayerFS v1.1.0 `layerfs-content/src/object/codec.rs` 逐字节兼容。

use std::io::Write;

use crate::error::{ContentError, ContentResult};
use crate::policy::{MAX_CANONICAL_OBJECT_BYTES, MAX_OBJECT_FIELD_BYTES};

/// 规范封装 magic。
pub const OBJECT_MAGIC: [u8; 4] = *b"LFSO";
/// 字节角色对象的 kind 标签。
pub const BYTES_KIND: u8 = 1;
/// 封装头宽度（字节）。
pub const HEADER_LEN: usize = 9;

/// 接受的最大载荷：16 MiB 减封装头。
pub const MAX_PAYLOAD_BYTES: usize = MAX_CANONICAL_OBJECT_BYTES - HEADER_LEN;

/// 规范值携带的长度前缀宽度（字节）。
pub const VALUE_LEN_BYTES: usize = 4;

/// 值长 `value_len` 字节的规范对象总宽度。
pub const fn canonical_len(value_len: usize) -> ContentResult<usize> {
    if value_len > MAX_OBJECT_FIELD_BYTES {
        return Err(ContentError::ObjectLimitExceeded {
            limit: MAX_OBJECT_FIELD_BYTES,
            actual: value_len,
        });
    }
    let payload = match value_len.checked_add(VALUE_LEN_BYTES) {
        Some(payload) => payload,
        None => return Err(ContentError::LengthOverflow),
    };
    match HEADER_LEN.checked_add(payload) {
        Some(total) if total <= MAX_CANONICAL_OBJECT_BYTES => Ok(total),
        _ => Err(ContentError::ObjectLimitExceeded {
            limit: MAX_CANONICAL_OBJECT_BYTES,
            actual: value_len,
        }),
    }
}

/// 把一个规范字节角色对象写进 `writer`。
///
/// 调用方按 [`canonical_len`] 预留并只写一次，同一份字节不存在中间分配。
pub fn encode_bytes_object_to<W: Write>(value: &[u8], writer: &mut W) -> ContentResult<()> {
    canonical_len(value.len())?;
    let payload_len = u32::try_from(value.len() + VALUE_LEN_BYTES).map_err(|_| {
        ContentError::ObjectLimitExceeded {
            limit: MAX_PAYLOAD_BYTES,
            actual: value.len(),
        }
    })?;
    let value_len = u32::try_from(value.len()).map_err(|_| ContentError::ObjectLimitExceeded {
        limit: MAX_PAYLOAD_BYTES,
        actual: value.len(),
    })?;
    write(writer, &OBJECT_MAGIC)?;
    write(writer, &[BYTES_KIND])?;
    write(writer, &payload_len.to_be_bytes())?;
    write(writer, &value_len.to_be_bytes())?;
    write(writer, value)
}

/// 把一个规范字节角色对象编码进新分配。
pub fn encode_bytes_object(value: &[u8]) -> ContentResult<Vec<u8>> {
    let total = canonical_len(value.len())?;
    let mut canonical = Vec::with_capacity(total);
    encode_bytes_object_to(value, &mut canonical)?;
    Ok(canonical)
}

/// 完整帧检查后返回规范字节角色对象的值。
///
/// 返回切片借用提供的字节：持有已认证所有权的调用方解码时不复制载荷。拒绝顺序固定：
/// 超长对象 → 短头 → magic → kind → 载荷超长 → 值超长 → 值越过载荷 → 截断 → 尾随字节。
pub fn decode_bytes_object(canonical: &[u8]) -> ContentResult<&[u8]> {
    if canonical.len() > MAX_CANONICAL_OBJECT_BYTES {
        return Err(ContentError::ObjectLimitExceeded {
            limit: MAX_CANONICAL_OBJECT_BYTES,
            actual: canonical.len(),
        });
    }
    if canonical.len() < HEADER_LEN + VALUE_LEN_BYTES {
        return Err(ContentError::UnexpectedEof);
    }
    if canonical[..OBJECT_MAGIC.len()] != OBJECT_MAGIC {
        return Err(ContentError::UnsupportedFraming);
    }
    if canonical[4] != BYTES_KIND {
        return Err(ContentError::WrongLogicalRole);
    }
    let payload_len = read_u32(canonical, 5)?;
    if payload_len > MAX_PAYLOAD_BYTES {
        return Err(ContentError::ObjectLimitExceeded {
            limit: MAX_PAYLOAD_BYTES,
            actual: payload_len,
        });
    }
    let value_len = read_u32(canonical, HEADER_LEN)?;
    if value_len > MAX_OBJECT_FIELD_BYTES {
        return Err(ContentError::ObjectLimitExceeded {
            limit: MAX_OBJECT_FIELD_BYTES,
            actual: value_len,
        });
    }
    let encoded_value_len = value_len
        .checked_add(VALUE_LEN_BYTES)
        .ok_or(ContentError::LengthOverflow)?;
    if encoded_value_len > payload_len {
        return Err(ContentError::UnexpectedEof);
    }
    let total = HEADER_LEN
        .checked_add(payload_len)
        .ok_or(ContentError::LengthOverflow)?;
    if canonical.len() < total {
        return Err(ContentError::UnexpectedEof);
    }
    if encoded_value_len != payload_len || canonical.len() != total {
        return Err(ContentError::TrailingBytes);
    }
    Ok(&canonical[HEADER_LEN + VALUE_LEN_BYTES..total])
}

fn read_u32(bytes: &[u8], offset: usize) -> ContentResult<usize> {
    let end = offset.checked_add(4).ok_or(ContentError::LengthOverflow)?;
    let slice = bytes.get(offset..end).ok_or(ContentError::UnexpectedEof)?;
    let value = u32::from_be_bytes(slice.try_into().map_err(|_| ContentError::UnexpectedEof)?);
    Ok(value as usize)
}

fn write<W: Write>(writer: &mut W, bytes: &[u8]) -> ContentResult<()> {
    writer.write_all(bytes).map_err(|_| ContentError::Io)
}
