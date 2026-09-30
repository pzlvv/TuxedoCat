//! `bus` 的单元测试。

use super::*;

    fn bus() -> CoreBus<Vec<u8>> {
        CoreBus::new(Vec::new())
    }

    fn written(bus: &CoreBus<Vec<u8>>) -> String {
        String::from_utf8(bus.out.clone()).unwrap()
    }

    #[test]
    fn emit_writes_one_event_frame_per_line() {
        let mut bus = bus();
        assert!(bus.emit(json!({ "type": "aiBegin", "sessionId": "s1" })));
        assert!(bus.log("hello"));
        assert_eq!(
            written(&bus),
            "{\"kind\":\"event\",\"event\":{\"type\":\"aiBegin\",\"sessionId\":\"s1\"}}\n\
             {\"kind\":\"event\",\"event\":{\"type\":\"log\",\"message\":\"hello\"}}\n"
        );
    }

    #[test]
    fn request_assigns_increasing_ids_and_resolves_response() {
        let mut bus = bus();
        let (first, rx) = bus
            .request(json!({ "type": "userChoice", "sessionId": "s1" }))
            .unwrap();
        let (second, _) = bus
            .request(json!({ "type": "toolPermissionRequested", "sessionId": "s1" }))
            .unwrap();
        assert_eq!((first, second), (1, 2));
        assert_eq!(bus.pending_count(), 2);

        bus.handle_response(first, true, json!({ "index": 0 }), None);
        assert_eq!(bus.pending_count(), 1);
        assert_eq!(rx.recv().unwrap(), json!({ "index": 0 }));
    }

    #[test]
    fn ui_events_are_counted_by_type() {
        let mut bus = bus();
        bus.handle_ui_event(&json!({ "type": "workspaceChanged", "workspacePath": null }));
        bus.handle_ui_event(&json!({ "type": "workspaceChanged", "workspacePath": "D:/repo" }));
        bus.handle_ui_event(&json!({ "type": "conversationOpened", "sessionId": "s1" }));
        assert_eq!(bus.ui_event_count("workspaceChanged"), 2);
        assert_eq!(bus.ui_event_count("conversationOpened"), 1);
        assert_eq!(bus.ui_event_count("unknown"), 0);
    }

    #[test]
    fn ui_event_without_type_is_dropped() {
        let mut bus = bus();
        assert!(bus.handle_ui_event(&json!({ "sessionId": "s1" })).is_none());
        assert!(written(&bus).is_empty());
    }

#[test]
fn handle_response_with_unknown_id_is_ignored() {
    let mut bus = bus();
    bus.handle_response(42, true, json!({}), None);
    assert_eq!(bus.pending_count(), 0);
}

#[test]
fn failed_response_is_delivered_as_an_error_payload() {
    let mut bus = bus();
    let (id, rx) = bus.request(json!({ "type": "userChoice" })).unwrap();
    bus.handle_response(id, false, Value::Null, Some("host refused".to_string()));
    assert_eq!(bus.pending_count(), 0);
    assert_eq!(rx.recv().unwrap(), json!({ "error": "host refused" }));

    // 没有错误描述时用空串
    let (id, rx) = bus.request(json!({ "type": "userChoice" })).unwrap();
    bus.handle_response(id, false, Value::Null, None);
    assert_eq!(rx.recv().unwrap(), json!({ "error": "" }));
}

#[test]
fn wait_response_times_out_and_detects_closed_channels() {
    let (_id, rx) = {
        let mut bus = bus();
        bus.request(json!({ "type": "userChoice" })).unwrap()
    };
    // 尚未应答 → 超时返回 None
    assert!(wait_response(rx, Duration::from_millis(20)).is_none());
}

#[test]
fn wait_response_returns_the_delivered_payload() {
    let mut bus = bus();
    let (id, rx) = bus.request(json!({ "type": "userChoice" })).unwrap();
    bus.handle_response(id, true, json!({ "index": 0 }), None);
    assert_eq!(
        wait_response(rx, Duration::from_millis(200)),
        Some(json!({ "index": 0 }))
    );
}

#[test]
fn request_without_a_type_still_gets_an_id() {
    let mut bus = bus();
    let (id, rx) = bus.request(json!({ "sessionId": "s1" })).unwrap();
    assert_eq!(id, 1);
    assert_eq!(bus.pending_count(), 1);
    bus.handle_response(id, true, json!({ "ok": true }), None);
    assert_eq!(rx.recv().unwrap(), json!({ "ok": true }));
}

#[test]
fn send_reports_failure_when_the_host_is_gone() {
    let mut bus = CoreBus::new(crate::test_support::FailingWriter);
    assert!(!bus.emit(json!({ "type": "aiBegin" })));
    assert!(!bus.log("hello"));
    // 写不出去时不应登记待应答请求，避免永远等不到回应
    assert!(bus.request(json!({ "type": "userChoice" })).is_none());
    assert_eq!(bus.pending_count(), 0);
}

#[test]
fn frames_are_written_one_per_line_even_with_newlines_in_payloads() {
    let mut bus = bus();
    bus.emit(json!({ "type": "message", "data": { "content": "a\nb" } }));
    let output = written(&bus);
    assert_eq!(output.matches('\n').count(), 1);
    assert!(output.ends_with('\n'));
}
