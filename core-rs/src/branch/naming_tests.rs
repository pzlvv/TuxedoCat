//! 分支命名（specs/037 FR-009）

use std::collections::HashSet;

use crate::branch::naming::{
    branch_ref, generate_name, generate_name_with, is_valid_name, BRANCH_NAMESPACE, BRANCH_ROLE_NAMES,
    SUFFIX_LEN,
};

/// 格式 `^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$`（AC-22）
#[test]
fn generated_names_match_the_documented_pattern() {
    for seed in 0u64..200 {
        let name = generate_name_with(|count| seed.wrapping_mul(2_654_435_761).wrapping_add(count));
        assert!(
            is_valid_name(&name),
            "name {name} does not match ^[a-z]+(-[a-z]+)*-[a-z0-9]{{{SUFFIX_LEN}}}$"
        );
        let regex_like = is_valid_name(&name);
        assert!(regex_like, "self-consistent check for {name}");
    }
}

/// 真实随机源产生的名字同样合法（200 次，覆盖角色名与后缀的取值面）
#[test]
fn random_names_are_valid() {
    for _ in 0..200 {
        let name = generate_name();
        assert!(is_valid_name(&name), "invalid name from real entropy: {name}");
    }
}

/// 常量表非空且唯一（角色名重复会让取模分布偏斜）
#[test]
fn role_names_are_non_empty_and_unique() {
    assert!(!BRANCH_ROLE_NAMES.is_empty(), "role name table is empty");
    let unique: HashSet<&&str> = BRANCH_ROLE_NAMES.iter().collect();
    assert_eq!(
        unique.len(),
        BRANCH_ROLE_NAMES.len(),
        "role name table contains duplicates"
    );
    for role in BRANCH_ROLE_NAMES {
        assert!(!role.is_empty(), "empty role name");
        assert!(
            role.split('-')
                .all(|word| !word.is_empty() && word.bytes().all(|byte| byte.is_ascii_lowercase())),
            "role name {role} is not lowercase words joined by '-'"
        );
    }
}

/// 撞名重试收敛：同一熵值只影响首字节，同名概率有限；换名重试必须能拿到不同的名字
#[test]
fn names_change_across_successive_calls() {
    let mut seen: HashSet<String> = HashSet::new();
    let mut collisions = 0;
    for _ in 0..64 {
        let name = generate_name();
        if !seen.insert(name) {
            collisions += 1;
        }
    }
    // 64 次里允许极少撞名（24 个角色 × 46656 后缀），但绝不能每次都一样
    assert!(
        seen.len() > 50,
        "too many collisions: {} unique out of 64 (collisions={collisions})",
        seen.len()
    );
}

/// 后缀长度固定 3 位，只含小写字母与数字（AC-22）
#[test]
fn suffix_is_three_lowercase_alphanumerics() {
    for seed in 0u64..100 {
        let name = generate_name_with(|_| seed.wrapping_mul(2_246_822_519));
        let suffix = name.rsplit_once('-').expect("name has a dash").1;
        assert_eq!(suffix.chars().count(), SUFFIX_LEN, "bad suffix in {name}");
        assert!(
            suffix
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()),
            "suffix {suffix} of {name} has invalid characters"
        );
    }
}

/// git 分支名带 `tuxedo/` 命名空间（AC-5）
#[test]
fn branch_ref_uses_the_tuxedo_namespace() {
    assert_eq!(BRANCH_NAMESPACE, "tuxedo");
    assert_eq!(branch_ref("ellen-k3f"), "tuxedo/ellen-k3f");
}

/// 非法名字被拒（大写、后缀长度不对、空角色名、缺后缀）
#[test]
fn invalid_names_are_rejected() {
    for bad in [
        "",
        "ellen",
        "ellen-k3",
        "ellen-k3ff",
        "Ellen-k3f",
        "ellen-K3F",
        "-k3f",
        "ellen--k3f",
        "ellen-k3!",
    ] {
        assert!(!is_valid_name(bad), "{bad} should be rejected");
    }
    for good in ["anby-000", "zhu-yuan-k3f", "ellen-9zz", "nicole-abc"] {
        assert!(is_valid_name(good), "{good} should be accepted");
    }
}
