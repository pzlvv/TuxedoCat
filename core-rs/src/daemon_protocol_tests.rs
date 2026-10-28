//! daemon 控制通道协议的编解码用例（`docs/core/core-daemon.md` 第 7 节）。

use super::*;
use serde_json::json;

#[test]
fn host_frames_decode_with_camel_case_fields() {
    let open: HostToDaemonFrame = serde_json::from_value(json!({
        "kind": "openWorkspace",
        "id": 7,
        "workspaceRef": { "scheme": "file", "path": "D:/repo", "endpoint": null },
    }))
    .unwrap();
    match open {
        HostToDaemonFrame::OpenWorkspace { id, workspace_ref } => {
            assert_eq!(id, 7);
            assert_eq!(workspace_ref["path"], "D:/repo");
        }
        other => panic!("unexpected frame: {other:?}"),
    }

    let close: HostToDaemonFrame =
        serde_json::from_value(json!({ "kind": "closeWorkspace", "channel": 3 })).unwrap();
    assert!(matches!(close, HostToDaemonFrame::CloseWorkspace { channel: 3 }));

    let detach: HostToDaemonFrame =
        serde_json::from_value(json!({ "kind": "detachWorkspace", "channel": 5 })).unwrap();
    assert!(matches!(detach, HostToDaemonFrame::DetachWorkspace { channel: 5 }));

    let frame: HostToDaemonFrame = serde_json::from_value(json!({
        "kind": "frame",
        "channel": 1,
        "frame": { "kind": "hello", "protocol": 2 },
    }))
    .unwrap();
    assert!(matches!(frame, HostToDaemonFrame::Frame { channel: 1, .. }));

    let shutdown: HostToDaemonFrame =
        serde_json::from_value(json!({ "kind": "shutdown" })).unwrap();
    assert!(matches!(shutdown, HostToDaemonFrame::Shutdown));
}

#[test]
fn host_frames_reject_unknown_or_malformed() {
    assert!(serde_json::from_value::<HostToDaemonFrame>(json!({ "kind": "nope" })).is_err());
    assert!(serde_json::from_value::<HostToDaemonFrame>(json!({})).is_err());
    assert!(
        serde_json::from_value::<HostToDaemonFrame>(json!({ "kind": "frame", "channel": 1 }))
            .is_err()
    );
}

#[test]
fn daemon_frames_encode_with_camel_case_fields() {
    let opened = DaemonToHostFrame::WorkspaceOpened {
        id: 1,
        channel: 2,
        descriptor: ChannelDescriptor::Multiplexed { channel: 2 },
    };
    let encoded = opened.encode().unwrap();
    assert!(encoded.ends_with('\n'));
    let value: serde_json::Value = serde_json::from_str(encoded.trim_end()).unwrap();
    assert_eq!(value["kind"], "workspaceOpened");
    assert_eq!(value["id"], 1);
    assert_eq!(value["channel"], 2);
    assert_eq!(value["descriptor"]["kind"], "multiplexed");
    assert_eq!(value["descriptor"]["channel"], 2);

    let failed = DaemonToHostFrame::WorkspaceFailed {
        id: 1,
        error: "boom".to_string(),
    };
    let value: serde_json::Value =
        serde_json::from_str(failed.encode().unwrap().trim_end()).unwrap();
    assert_eq!(value["kind"], "workspaceFailed");
    assert_eq!(value["error"], "boom");

    let reset = DaemonToHostFrame::ChannelReset {
        channel: 1,
        reason: "crashed".to_string(),
    };
    let value: serde_json::Value =
        serde_json::from_str(reset.encode().unwrap().trim_end()).unwrap();
    assert_eq!(value["kind"], "channelReset");

    let closed = DaemonToHostFrame::WorkspaceClosed {
        channel: 1,
        reason: WorkspaceCloseReason::Failed,
    };
    let value: serde_json::Value =
        serde_json::from_str(closed.encode().unwrap().trim_end()).unwrap();
    assert_eq!(value["kind"], "workspaceClosed");
    assert_eq!(value["reason"], "failed");
}

#[test]
fn workspace_closed_encodes_the_detached_reason() {
    // specs/031：后台运行的收尾帧——宿主据此不算 fatal
    let frame = DaemonToHostFrame::WorkspaceClosed {
        channel: 4,
        reason: WorkspaceCloseReason::Detached,
    };
    let value: serde_json::Value =
        serde_json::from_str(frame.encode().unwrap().trim_end()).unwrap();
    assert_eq!(value["kind"], "workspaceClosed");
    assert_eq!(value["channel"], 4);
    assert_eq!(value["reason"], "detached");
}

#[test]
fn inner_frame_payload_is_not_interpreted() {
    // daemon 只做信封：内层帧原样嵌套在 frame.frame 里
    let inner = json!({ "kind": "event", "event": { "type": "log", "message": "hi" } });
    let outer = DaemonToHostFrame::Frame {
        channel: 5,
        frame: inner.clone(),
    };
    let value: serde_json::Value =
        serde_json::from_str(outer.encode().unwrap().trim_end()).unwrap();
    assert_eq!(value["kind"], "frame");
    assert_eq!(value["channel"], 5);
    assert_eq!(value["frame"], inner);
}
