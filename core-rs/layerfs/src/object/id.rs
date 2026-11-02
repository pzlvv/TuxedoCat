//! 规范对象身份：固定 32 字节的域分隔摘要。
//!
//! 身份是 BLAKE3 over 冻结域分隔符 + 完整规范对象字节，因此不是载荷的裸内容摘要；
//! 相同规范字节恒得相同身份，结构与长度都被认证而非假定。与上游 LayerFS v1.1.0
//! `layerfs-content/src/object/id.rs` 逐字节兼容（docs/core/layerfs.md 第 2 节）。

use std::fmt::{self, Write};
use std::str::FromStr;

use crate::error::{ContentError, ContentResult};

/// 规范对象身份的宽度（字节）。
pub const DIGEST_BYTES: usize = 32;

/// v2 对象身份的冻结域分隔符。
pub const OBJECT_DOMAIN: &[u8] = b"layerfs/object/v2\0";

/// 不可变的规范对象身份。
#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct ObjectId([u8; DIGEST_BYTES]);

impl ObjectId {
    /// `canonical` 在冻结对象域下的身份。
    pub fn for_bytes(canonical: &[u8]) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(OBJECT_DOMAIN);
        hasher.update(canonical);
        Self(*hasher.finalize().as_bytes())
    }

    /// 开始计算分段到达的规范字节的身份。
    pub fn stream() -> IdentityStream {
        let mut hasher = blake3::Hasher::new();
        hasher.update(OBJECT_DOMAIN);
        IdentityStream(hasher)
    }

    /// 从定宽表示重建身份。
    pub fn from_bytes(bytes: &[u8]) -> ContentResult<Self> {
        let digest: [u8; DIGEST_BYTES] =
            bytes
                .try_into()
                .map_err(|_| ContentError::InvalidIdentityLength {
                    expected: DIGEST_BYTES,
                    actual: bytes.len(),
                })?;
        Ok(Self(digest))
    }

    /// 借用定宽表示。
    pub const fn as_bytes(&self) -> &[u8; DIGEST_BYTES] {
        &self.0
    }

    /// 复制定宽表示。
    pub const fn to_bytes(self) -> [u8; DIGEST_BYTES] {
        self.0
    }
}

/// 按序分段提供的规范字节的身份：等于 `ObjectId::for_bytes` 对其拼接的结果。
/// 固定大小，不保留任何给过它的字节。
#[derive(Clone, Debug)]
pub struct IdentityStream(blake3::Hasher);

impl IdentityStream {
    /// 追加下一段规范字节。
    pub fn update(&mut self, part: &[u8]) {
        self.0.update(part);
    }

    /// 迄今追加的全部字节的身份。
    pub fn finish(&self) -> ObjectId {
        ObjectId(*self.0.finalize().as_bytes())
    }
}

impl fmt::Debug for ObjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ObjectId")
            .field(&self.to_string())
            .finish()
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in self.0 {
            formatter.write_char(char::from(HEX[usize::from(byte >> 4)]))?;
            formatter.write_char(char::from(HEX[usize::from(byte & 0x0f)]))?;
        }
        Ok(())
    }
}

impl FromStr for ObjectId {
    type Err = ContentError;

    fn from_str(value: &str) -> ContentResult<Self> {
        if value.len() != DIGEST_BYTES * 2 {
            return Err(ContentError::InvalidIdentityText);
        }
        let mut bytes = [0_u8; DIGEST_BYTES];
        for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
            bytes[index] = (hex(pair[0])? << 4) | hex(pair[1])?;
        }
        Ok(Self(bytes))
    }
}

fn hex(value: u8) -> ContentResult<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(ContentError::InvalidIdentityText),
    }
}
