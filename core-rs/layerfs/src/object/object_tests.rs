//! 对象身份与封装的测试：上游 v1.1.0 对照向量 + 拒绝顺序 + 角色表。

use std::str::FromStr;

use super::*;
use crate::policy::MAX_CANONICAL_OBJECT_BYTES;
use crate::test_support::{chunk_object, decode_value, whole_file_object};
use crate::Storage;

/// 上游 v1.1.0：`encode_bytes_object(b"hello")` 的规范字节。
const ENVELOPE_HELLO_HEX: &str = "4c46534f01000000090000000568656c6c6f";
/// 上游 v1.1.0：上述封装对象的身份。
const OBJECT_ID_HELLO: &str = "bd479f17fe211a423718f70ce65a8abf2578f7e4055770db6d97ee0e44d7b641";
/// 上游 v1.1.0：WholeFile(b"hello world\n") 的规范字节（`LFS5SML\0` + 版本 1 + 载荷）。
const WHOLE_FILE_CANONICAL_HEX: &str =
    "4c46534f010000001a000000164c465335534d4c00000168656c6c6f20776f726c640a";
/// 上游 v1.1.0：该 WholeFile 对象的身份。
const WHOLE_FILE_ID: &str = "1a5db0d8a522994e8be4db01cb99730759a1f19ea849a549814bb52c45486bd7";
/// 上游 v1.1.0：Chunk 对象的规范字节（`LFS4CHK\0` + 载荷，载荷 = (i*7)%251, i<200）。
const CHUNK_CANONICAL_HEX: &str = "4c46534f01000000d4000000d04c46533443484b0000070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef501080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f9050c131a21282f363d444b525960676e757c838a";
/// 上游 v1.1.0：该 Chunk 对象的身份。
const CHUNK_ID: &str = "3a8b601f62a824dff618bdc379a5942f6933f18ea550617422c4d14c46ec6887";

fn unhex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).expect("hex"))
        .collect()
}

fn chunk_payload() -> Vec<u8> {
    (0..200usize).map(|i| (i * 7 % 251) as u8).collect()
}

#[test]
fn identity_and_envelope_match_upstream_bytes() {
    let envelope = encode_bytes_object(b"hello").expect("encode");
    assert_eq!(envelope, unhex(ENVELOPE_HELLO_HEX));
    let id = ObjectId::for_bytes(&envelope);
    assert_eq!(id.to_string(), OBJECT_ID_HELLO);
    // 大小写不敏感解析 + hex 往返。
    assert_eq!(
        ObjectId::from_str(&OBJECT_ID_HELLO.to_uppercase()).expect("parse"),
        id
    );
    assert_eq!(
        ObjectId::from_str("zz").unwrap_err(),
        ContentError::InvalidIdentityText
    );
}

#[test]
fn whole_file_and_chunk_grammar_match_upstream() {
    let storage = Storage::new(std::sync::Arc::new(
        crate::test_support::MemPersistence::new(),
    ))
    .expect("storage");
    let whole = whole_file_object(&storage.capacities(), b"hello world\n").expect("whole");
    assert_eq!(whole.canonical(), unhex(WHOLE_FILE_CANONICAL_HEX));
    assert_eq!(whole.id().to_string(), WHOLE_FILE_ID);
    assert_eq!(
        decode_value(whole.canonical()).expect("decode"),
        [
            WHOLE_FILE_MAGIC.as_slice(),
            &WHOLE_FILE_VERSION.to_be_bytes(),
            b"hello world\n"
        ]
        .concat()
    );

    let chunk = crate::test_support::chunk_object(&chunk_payload()).expect("chunk");
    assert_eq!(chunk.canonical(), unhex(CHUNK_CANONICAL_HEX));
    assert_eq!(chunk.id().to_string(), CHUNK_ID);
    // ChunkIdentity 与 encode_chunk_object 同身份。
    let streamed = crate::object::chunk_id(&chunk_payload()).expect("chunk id");
    assert_eq!(streamed, chunk.id());
}

#[test]
fn envelope_rejects_in_upstream_order() {
    let good = encode_bytes_object(b"hello").expect("encode");
    // 截断：短头。
    assert_eq!(
        decode_bytes_object(&good[..8]).unwrap_err(),
        ContentError::UnexpectedEof
    );
    // magic。
    let mut bad = good.clone();
    bad[0] = b'X';
    assert_eq!(
        decode_bytes_object(&bad).unwrap_err(),
        ContentError::UnsupportedFraming
    );
    // kind。
    let mut bad = good.clone();
    bad[4] = 2;
    assert_eq!(
        decode_bytes_object(&bad).unwrap_err(),
        ContentError::WrongLogicalRole
    );
    // 值长度越过 8 MiB 字段上限。
    let mut bad = good.clone();
    bad[9..13].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(
        decode_bytes_object(&bad).unwrap_err(),
        ContentError::ObjectLimitExceeded {
            limit: crate::policy::MAX_OBJECT_FIELD_BYTES,
            actual: u32::MAX as usize,
        }
    );
    // 载荷长度越过 16 MiB 载荷上限。
    let mut bad = good.clone();
    bad[5..9].copy_from_slice(&(u32::MAX - 3).to_be_bytes());
    assert_eq!(
        decode_bytes_object(&bad).unwrap_err(),
        ContentError::ObjectLimitExceeded {
            limit: crate::object::MAX_PAYLOAD_BYTES,
            actual: (u32::MAX - 3) as usize,
        }
    );
    // 尾随字节。
    let mut bad = good.clone();
    bad.push(0);
    assert_eq!(
        decode_bytes_object(&bad).unwrap_err(),
        ContentError::TrailingBytes
    );
    // 超长对象。
    let oversize = vec![0_u8; MAX_CANONICAL_OBJECT_BYTES + 1];
    assert_eq!(
        decode_bytes_object(&oversize).unwrap_err(),
        ContentError::ObjectLimitExceeded {
            limit: MAX_CANONICAL_OBJECT_BYTES,
            actual: oversize.len(),
        }
    );
    // FinalizedObject::new 拒绝不可解码的规范字节。
    assert!(FinalizedObject::new(ObjectRole::Chunk, b"not an envelope".to_vec()).is_err());
}

#[test]
fn thirteen_role_codes_match_upstream_table() {
    let expected: [(u8, ObjectRole); 13] = [
        (1, ObjectRole::WholeFile),
        (2, ObjectRole::Chunk),
        (3, ObjectRole::ExtentLeaf),
        (4, ObjectRole::ExtentBranch),
        (5, ObjectRole::FileState),
        (6, ObjectRole::InodeLeaf),
        (7, ObjectRole::DirectoryLeaf),
        (8, ObjectRole::DirectoryBranch),
        (9, ObjectRole::InodeBranch),
        (10, ObjectRole::FilesystemRoot),
        (11, ObjectRole::AttributeLeaf),
        (12, ObjectRole::AttributeBranch),
        (13, ObjectRole::Symlink),
    ];
    for (code, role) in expected {
        assert_eq!(role.code(), code);
        assert_eq!(ObjectRole::from_code(code), Ok(role));
    }
    assert_eq!(
        ObjectRole::from_code(0).unwrap_err(),
        ContentError::InvalidRecord("object role code")
    );
    assert_eq!(
        ObjectRole::from_code(14).unwrap_err(),
        ContentError::InvalidRecord("object role code")
    );
    // 只有 WholeFile / Chunk 有解码器。
    assert!(ObjectRole::WholeFile.has_decoder() && ObjectRole::Chunk.has_decoder());
    assert!(!ObjectRole::ExtentLeaf.has_decoder());
}

#[test]
fn finalized_object_moves_all_five_parts() {
    let base = chunk_object(&[1, 2, 3]).expect("object");
    let referenced = chunk_object(&[4, 5]).expect("object");
    let object = base
        .with_references(vec![referenced.id()])
        .with_predecessors(AdvisoryPredecessors::explicit(referenced.id()).expect("predecessors"));
    let parts = object.clone().into_parts();
    assert_eq!(parts.id, object.id());
    assert_eq!(parts.role, object.role());
    assert_eq!(parts.canonical, object.canonical());
    assert_eq!(parts.references, object.references());
    assert_eq!(parts.predecessors.entries().len(), 1);
    assert_eq!(
        parts.predecessors.entries()[0].provenance(),
        PredecessorProvenance::OriginalBase
    );
}

#[test]
fn advisory_predecessors_bounded_and_dedup_below_capacity() {
    let mut list = AdvisoryPredecessors::new();
    let bases: Vec<ObjectId> = (0..6u8).map(|i| ObjectId::for_bytes(&[i])).collect();
    for base in &bases[0..MAXIMUM_ADVISORY_PREDECESSORS] {
        list.push(*base, PredecessorProvenance::ReusedRange)
            .expect("push");
    }
    assert_eq!(
        list.push(bases[5], PredecessorProvenance::ReusedRange)
            .unwrap_err(),
        ContentError::BoundedCapacityExceeded {
            what: "object.predecessors",
            limit: MAXIMUM_ADVISORY_PREDECESSORS as u64,
            actual: (MAXIMUM_ADVISORY_PREDECESSORS + 1) as u64,
        }
    );
    // 未满员时重复身份静默忽略（上游语义：容量检查在前，去重随后）。
    let mut short = AdvisoryPredecessors::new();
    short
        .push(bases[0], PredecessorProvenance::OriginalBase)
        .expect("push");
    short
        .push(bases[0], PredecessorProvenance::UnchangedPrefix)
        .expect("dedup");
    assert_eq!(short.len(), 1);
    assert_eq!(
        short.entries()[0].provenance(),
        PredecessorProvenance::OriginalBase
    );
}

#[test]
fn discarding_consumer_counts_without_persisting() {
    let mut consumer = DiscardingConsumer::new();
    consumer
        .accept(chunk_object(&[1]).expect("object"))
        .expect("accept");
    consumer
        .accept(chunk_object(&[2, 3]).expect("object"))
        .expect("accept");
    assert_eq!(consumer.objects(), 2);
    assert_eq!(
        consumer.canonical_bytes(),
        (chunk_canonical_len(1) + chunk_canonical_len(2)) as u64
    );
    assert_eq!(consumer.peak_object_bytes(), chunk_canonical_len(2) as u64);
}
