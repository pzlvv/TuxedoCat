//! 策略与容量的测试：校验范围、表示选择、派生算术与持久化策略核对。

use super::*;
use crate::cdc::{MAXIMUM_CHUNK_BYTES, MINIMUM_CHUNK_BYTES};

#[test]
fn construction_policy_validation_ranges() {
    // 默认即被接受。
    assert!(ConstructionPolicy::frozen_default().validated().is_ok());
    // 阈值：128 KiB..=1 MiB 的 2 的幂。
    assert!(ConstructionPolicy::new(131_072, 16, 8).validated().is_ok());
    assert!(ConstructionPolicy::new(1_048_576, 16, 8)
        .validated()
        .is_ok());
    assert_eq!(
        ConstructionPolicy::new(65_536, 16, 8)
            .validated()
            .unwrap_err(),
        ContentError::UnsupportedPolicy {
            field: "small_file_threshold_bytes"
        }
    );
    assert_eq!(
        ConstructionPolicy::new(2_097_152, 16, 8)
            .validated()
            .unwrap_err(),
        ContentError::UnsupportedPolicy {
            field: "small_file_threshold_bytes"
        }
    );
    assert_eq!(
        ConstructionPolicy::new(196_608, 16, 8)
            .validated()
            .unwrap_err(),
        ContentError::UnsupportedPolicy {
            field: "small_file_threshold_bytes"
        }
    );
    // 深度：0..=50。
    assert!(ConstructionPolicy::new(131_072, 0, 0).validated().is_ok());
    assert!(ConstructionPolicy::new(131_072, 50, 50).validated().is_ok());
    assert_eq!(
        ConstructionPolicy::new(131_072, 51, 8)
            .validated()
            .unwrap_err(),
        ContentError::UnsupportedPolicy {
            field: "whole_file_delta_max_depth"
        }
    );
    assert_eq!(
        ConstructionPolicy::new(131_072, 8, 51)
            .validated()
            .unwrap_err(),
        ContentError::UnsupportedPolicy {
            field: "chunk_delta_max_depth"
        }
    );
}

#[test]
fn representation_selection_and_derived_capacities() {
    let policy = ConstructionPolicy::new(131_072, 16, 8)
        .validated()
        .expect("policy");
    assert_eq!(policy.representation(0), Representation::Empty);
    assert_eq!(policy.representation(1), Representation::WholeFile);
    assert_eq!(policy.representation(131_071), Representation::WholeFile);
    assert_eq!(policy.representation(131_072), Representation::Chunked);
    let capacities = policy.capacities();
    assert_eq!(capacities.whole_file_raw_limit, 131_071);
    assert_eq!(
        capacities.whole_file_canonical_limit,
        131_071 + crate::policy::WHOLE_FILE_CANONICAL_OVERHEAD
    );
    assert_eq!(capacities.chunk_raw_limit, MAXIMUM_CHUNK_BYTES);
    assert_eq!(capacities.chunk_minimum_raw, MINIMUM_CHUNK_BYTES);
    assert_eq!(
        capacities.canonical_object_limit,
        MAX_CANONICAL_OBJECT_BYTES
    );
}

#[test]
fn storage_policy_validates_each_field() {
    let policy = StoragePolicy::frozen_default();
    assert!(policy.validated().is_ok());
    assert_eq!(policy.format_profile(), crate::policy::FORMAT_PROFILE);
    // CDC 身份不符拒开。
    let mut tampered = policy;
    tampered.cdc_profile_id = [0_u8; 32];
    assert!(matches!(
        tampered.validated().unwrap_err(),
        StorageError::UnsupportedPolicy {
            field: "cdc_profile_id"
        }
    ));
    // 格式 profile 不符拒开。
    let tampered = StoragePolicy::from_persisted(
        2,
        policy.cdc_profile_id(),
        policy.construction(),
        policy.metadata_delta_max_depth(),
    );
    assert!(matches!(
        tampered.validated().unwrap_err(),
        StorageError::UnsupportedPolicy {
            field: "format_profile"
        }
    ));
    // 元数据深度越界拒开。
    let tampered = StoragePolicy::from_persisted(
        policy.format_profile(),
        policy.cdc_profile_id(),
        policy.construction(),
        51,
    );
    assert!(matches!(
        tampered.validated().unwrap_err(),
        StorageError::UnsupportedPolicy {
            field: "metadata_delta_max_depth"
        }
    ));
}

#[test]
fn storage_capacities_derive_from_policy() {
    let policy = StoragePolicy::frozen_default();
    let capacities = StorageCapacities::from_policy(policy).expect("capacities");
    assert_eq!(capacities.batch_objects, crate::policy::BATCH_OBJECT_LIMIT);
    assert_eq!(
        capacities.batch_bytes,
        crate::policy::BATCH_CANONICAL_BYTES_LIMIT
    );
    assert_eq!(
        capacities.transaction_rows,
        crate::policy::TRANSACTION_ROW_LIMIT
    );
    assert_eq!(
        capacities.transaction_bytes,
        crate::policy::TRANSACTION_CANONICAL_BYTES_LIMIT
    );
    assert_eq!(capacities.read_objects, crate::policy::READ_OBJECT_LIMIT);
    assert_eq!(
        capacities.read_bytes,
        crate::policy::READ_CANONICAL_BYTES_LIMIT
    );
}
