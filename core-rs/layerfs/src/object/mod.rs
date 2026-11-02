//! 规范对象层：身份、封装、角色 / 最终化输出、角色值语法与认证读端口。

pub mod codec;
pub mod id;
pub mod output;
pub mod payload;
pub mod predecessor;

pub use codec::{
    canonical_len, decode_bytes_object, encode_bytes_object, encode_bytes_object_to, BYTES_KIND,
    HEADER_LEN, MAX_PAYLOAD_BYTES, OBJECT_MAGIC, VALUE_LEN_BYTES,
};
pub use id::{IdentityStream, ObjectId, DIGEST_BYTES, OBJECT_DOMAIN};
pub use output::{DiscardingConsumer, FinalizedConsumer, FinalizedObject, ObjectParts, ObjectRole};
pub use payload::{
    chunk_canonical_len, chunk_id, chunk_payload, encode_chunk_object, encode_whole_file,
    validate_role_payload, whole_file_canonical_len, whole_file_payload, ChunkIdentity,
    CHUNK_MAGIC, WHOLE_FILE_MAGIC, WHOLE_FILE_VALUE_HEADER, WHOLE_FILE_VERSION,
};
pub use predecessor::{
    AdvisoryPredecessor, AdvisoryPredecessors, PredecessorProvenance, MAXIMUM_ADVISORY_PREDECESSORS,
};

use crate::error::{ContentError, ContentResult};

/// 面向构造与逻辑读的认证规范对象提供方。
///
/// 实现必须按 `ids[index]` 的顺序返回身份为该 id 的规范字节。返回不属于请求身份的
/// 字节是契约违例；无法确立身份的提供方必须返回 [`ContentError::IdentityMismatch`]。
/// 缺席只能报 [`ContentError::MissingObject`]；持有状态但无法服务（损坏、超出可见
/// 范围、容量拒绝）报 [`ContentError::ProviderFailure`]，两类保持可区分。
pub trait AuthenticatedObjects {
    /// 以一次有界成组需求读取全部请求对象。
    fn read_canonical_batch(&self, ids: &[ObjectId]) -> ContentResult<Vec<Vec<u8>>>;

    /// 读一个对象；点读就是单 id 批次。
    fn read_canonical(&self, id: ObjectId) -> ContentResult<Vec<u8>> {
        let mut values = self.read_canonical_batch(std::slice::from_ref(&id))?;
        if values.len() != 1 {
            return Err(ContentError::BatchCardinality {
                requested: 1,
                returned: values.len(),
            });
        }
        values.pop().ok_or(ContentError::BatchCardinality {
            requested: 1,
            returned: 0,
        })
    }
}

#[cfg(test)]
#[path = "object_tests.rs"]
mod tests;
