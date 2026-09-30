//! `subagent` 注册表单测。

use super::*;

#[test]
fn registry_tracks_creator_and_membership() {
    reset_for_test();
    register("sub_1", "s1");
    register("sub_2", "s1");
    register("sub_3", "s2");

    assert_eq!(creator_of("sub_1").as_deref(), Some("s1"));
    assert_eq!(creator_of("sub_2").as_deref(), Some("s1"));
    assert_eq!(creator_of("sub_3").as_deref(), Some("s2"));
    assert_eq!(creator_of("missing"), None);

    assert!(has_active_for_creator("s1"));
    assert!(has_active_for_creator("s2"));
    assert!(!has_active_for_creator("s3"));

    assert_eq!(list_for_creator("s1"), ["sub_1", "sub_2"]);
    assert_eq!(list_for_creator("s2"), ["sub_3"]);
    assert!(list_for_creator("s3").is_empty());

    // 重复登记同一 id：覆盖而不是追加（对齐 `Map.set`）
    register("sub_1", "s9");
    assert_eq!(creator_of("sub_1").as_deref(), Some("s9"));
    assert_eq!(list_for_creator("s1"), ["sub_2"]);

    unregister("sub_2");
    assert!(!has_active_for_creator("s1"));
    assert_eq!(creator_of("sub_2"), None);

    assert!(created_at("sub_3").is_some());
    assert_eq!(created_at("missing"), None);
    reset_for_test();
}

#[test]
fn generated_ids_use_the_embedded_shape() {
    let id = generate_sub_session_id();
    assert!(id.starts_with("sub_"), "{id}");
    assert_ne!(generate_sub_session_id(), generate_sub_session_id());
}
