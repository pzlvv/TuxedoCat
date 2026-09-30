//! `frame` 的单元测试：帧的编解码与边界。

use super::*;
use serde_json::json;

#[test]
fn protocol_version_is_one() {
    assert_eq!(CORE_PROTOCOL_VERSION, 2);
}

#[test]
fn hello_decodes() {
    let frame: UiToCoreFrame = serde_json::from_str(r#"{"kind":"hello","protocol":1}"#).unwrap();
    match frame {
        UiToCoreFrame::Hello { protocol } => assert_eq!(protocol, 1),
        other => panic!("unexpected frame: {other:?}"),
    }
}

#[test]
fn hello_requires_protocol_field() {
    assert!(serde_json::from_str::<UiToCoreFrame>(r#"{"kind":"hello"}"#).is_err());
}

#[test]
fn shutdown_decodes() {
    let frame: UiToCoreFrame = serde_json::from_str(r#"{"kind":"shutdown"}"#).unwrap();
    assert!(matches!(frame, UiToCoreFrame::Shutdown));
}

#[test]
fn response_decodes_ok_and_error() {
    let ok: UiToCoreFrame =
        serde_json::from_str(r#"{"kind":"response","id":7,"ok":true,"result":{"index":0}}"#).unwrap();
    match ok {
        UiToCoreFrame::Response { id, ok, result, error } => {
            assert_eq!(id, 7);
            assert!(ok);
            assert_eq!(result["index"], 0);
            assert!(error.is_none());
        }
        other => panic!("unexpected frame: {other:?}"),
    }

    let failed: UiToCoreFrame =
        serde_json::from_str(r#"{"kind":"response","id":8,"ok":false,"error":"boom"}"#).unwrap();
    match failed {
        UiToCoreFrame::Response { id, ok, error, .. } => {
            assert_eq!(id, 8);
            assert!(!ok);
            assert_eq!(error.as_deref(), Some("boom"));
        }
        other => panic!("unexpected frame: {other:?}"),
    }
}

#[test]
fn response_defaults_result_and_error() {
    let frame: UiToCoreFrame = serde_json::from_str(r#"{"kind":"response","id":1,"ok":true}"#).unwrap();
    match frame {
        UiToCoreFrame::Response { result, error, .. } => {
            assert!(result.is_null());
            assert!(error.is_none());
        }
        other => panic!("unexpected frame: {other:?}"),
    }
}

#[test]
fn ui_event_decodes() {
    let frame: UiToCoreFrame = serde_json::from_str(
        r#"{"kind":"uiEvent","event":{"type":"workspaceChanged","workspacePath":null}}"#,
    )
    .unwrap();
    match frame {
        UiToCoreFrame::UiEvent { event } => {
            assert_eq!(event["type"], "workspaceChanged");
            assert!(event["workspacePath"].is_null());
        }
        other => panic!("unexpected frame: {other:?}"),
    }
}

#[test]
fn core_frames_encode_with_camel_case_kind() {
    assert_eq!(CoreToUiFrame::Ready.encode().unwrap(), "{\"kind\":\"ready\"}\n");

    let event = CoreToUiFrame::Event { event: json!({ "type": "log", "message": "hi" }) };
    assert_eq!(
        event.encode().unwrap(),
        "{\"kind\":\"event\",\"event\":{\"type\":\"log\",\"message\":\"hi\"}}\n"
    );

    let request = CoreToUiFrame::Request { id: 3, request: json!({ "type": "userChoice" }) };
    assert_eq!(
        request.encode().unwrap(),
        "{\"kind\":\"request\",\"id\":3,\"request\":{\"type\":\"userChoice\"}}\n"
    );
}

#[test]
fn unknown_kind_is_rejected() {
    let error = serde_json::from_str::<UiToCoreFrame>(r#"{"kind":"nope"}"#).unwrap_err();
    assert!(error.to_string().contains("unknown variant"), "got {error}");
}

#[test]
fn malformed_json_is_rejected() {
    assert!(serde_json::from_str::<UiToCoreFrame>("{oops").is_err());
    assert!(serde_json::from_str::<UiToCoreFrame>("").is_err());
}

#[test]
fn ui_event_frame_keeps_nested_payload() {
    let frame = CoreToUiFrame::Event {
        event: json!({ "type": "toolResult", "output": "line1\nline2" }),
    };
    let encoded = frame.encode().unwrap();
    assert!(encoded.ends_with('\n'));
    // 帧内换行必须被 JSON 转义，否则帧边界会被破坏
    assert_eq!(encoded.matches('\n').count(), 1);
    assert!(encoded.contains(r"line1\nline2"), "got {encoded}");
}
