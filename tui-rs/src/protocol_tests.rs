//! 帧协议测试：编码 / 解码与信封校验（对齐 core-rs/src/frame_tests.rs 的口径）。

use serde_json::json;

use super::*;

#[test]
fn hello_encodes_protocol_version() {
    let line = UiToCoreFrame::Hello.encode().unwrap();
    let value: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(value["kind"], "hello");
    assert_eq!(value["protocol"], CORE_PROTOCOL_VERSION);
    assert!(line.ends_with('\n'));
}

#[test]
fn ui_event_roundtrip_shape() {
    let event = json!({ "type": "userMessageSubmitted", "sessionId": "s1", "content": "你好", "uuid": "u1" });
    let line = UiToCoreFrame::UiEvent(event.clone()).encode().unwrap();
    let value: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(value["kind"], "uiEvent");
    assert_eq!(value["event"], event);
}

#[test]
fn request_response_shapes() {
    let line = UiToCoreFrame::Request { id: 7, request: json!({ "type": "skillsRequested" }) }.encode().unwrap();
    let value: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(value["kind"], "request");
    assert_eq!(value["id"], 7);

    let line = UiToCoreFrame::Response {
        id: 7,
        ok: true,
        result: json!({ "skills": [] }),
        error: None,
    }
    .encode()
    .unwrap();
    let value: Value = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(value["kind"], "response");
    assert_eq!(value["ok"], true);
    assert_eq!(value["result"]["skills"], json!([]));
}

#[test]
fn decode_ready_and_event() {
    let frame = decode_frame(r#"{"kind":"ready"}"#).unwrap();
    assert_eq!(frame, CoreToUiFrame::Ready);

    let frame = decode_frame(r#"{"kind":"event","event":{"type":"coreReady"}}"#).unwrap();
    assert_eq!(frame, CoreToUiFrame::Event(json!({ "type": "coreReady" })));
}

#[test]
fn decode_rejects_unknown_envelopes() {
    assert!(decode_frame(r#"{"kind":"mystery"}"#).is_none());
    assert!(decode_frame("not json").is_none());
    // request 缺 id 不是合法帧
    assert!(decode_frame(r#"{"kind":"request","request":{}}"#).is_none());
}

#[test]
fn decoder_splits_lines_and_skips_bad_rows() {
    let mut decoder = FrameDecoder::new();
    decoder.push(b"{\"kind\":\"ready\"}\n\n{\"kind\":\"junk\n");
    decoder.push(b"\"}\n{\"kind\":\"event\",\"event\":{\"type\":\"coreReady\"}}\n");
    assert_eq!(decoder.frames.len(), 2);
    assert_eq!(decoder.frames[0], CoreToUiFrame::Ready);
    assert_eq!(decoder.frames[1], CoreToUiFrame::Event(json!({ "type": "coreReady" })));
    // 坏行是两段：{"kind":"junk（第一段就被 \n 截断）与 "}（第二段的残行）
    assert_eq!(decoder.bad_lines, 2);
}

#[test]
fn decoder_handles_crlf_and_partial_chunks() {
    let mut decoder = FrameDecoder::new();
    decoder.push(b"{\"kind\":");
    assert!(decoder.frames.is_empty());
    decoder.push(b"\"ready\"}\r\n");
    assert_eq!(decoder.frames.len(), 1);
    assert_eq!(decoder.frames[0], CoreToUiFrame::Ready);
}
