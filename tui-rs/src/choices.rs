//! 用户选择 / 权限确认的宿主管理（`src/host/ui/userChoice.ts` + `toolHandler.ts` 的移植）。
//!
//! - 每个会话最多一个 pending 的选择请求（新请求覆盖旧的，旧的以错误应答收场）；
//! - 请求只投递给「已 open」的会话——单视图宿主 open == 当前显示的会话；
//!   未 open（如子代理会话不在前台）时保留 pending，等会话打开后重新投递；
//! - 弹出 / 应答都要上报 `userChoicePendingChanged`（core 据此维护 sessionRuntime.waiting）；
//! - Edit / Write 的 diff 快照是「当前请求」的全局暂存位，记下写入方会话，
//!   dropSession 时只清理归属该会话的快照，不误伤其它会话正在进行的 Edit / Write。
//!
//! 每条记录都带 `CoreRequest` 帧的 id：core 在帧通道上等应答，覆盖 / 丢弃都必须
//! 以成功或错误帧收场，否则 core 侧永久挂起（`request()` 无内置超时）。

use std::collections::HashMap;

use serde_json::Value;

use crate::store::{ChoiceItem, PendingChoice};

/// 权限确认 / ask user 携带的选择选项（`UserChoiceOptions` 的投影）。
///
/// diff 六字段随请求到达、弹出时并入 diff 快照；TUI v1 只读 before/after，
/// 其余保留为快照完整性（与 TS 的 UserChoiceOptions 同口径）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ChoiceOptions {
    pub tool_name: String,
    pub message: String,
    pub choices: Vec<ChoiceItem>,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    pub start_line: Option<f64>,
    pub end_line: Option<f64>,
}

impl ChoiceOptions {
    pub fn from_value(value: &Value) -> ChoiceOptions {
        let text_list = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter(|line| !line.is_null())
                        .map(|line| match line {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        })
                        .filter(|line| !line.trim().is_empty() && line != "undefined")
                        .collect()
                })
                .unwrap_or_default()
        };
        ChoiceOptions {
            tool_name: value.get("toolName").and_then(Value::as_str).unwrap_or("").to_string(),
            message: value.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
            choices: value
                .get("choices")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|choice| ChoiceItem {
                            label: choice.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                            description: choice.get("description").and_then(Value::as_str).map(str::to_string),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            before_content: value.get("beforeContent").and_then(Value::as_str).map(str::to_string),
            after_content: value.get("afterContent").and_then(Value::as_str).map(str::to_string),
            context_before: text_list("contextBefore"),
            context_after: text_list("contextAfter"),
            start_line: value.get("startLine").and_then(Value::as_f64),
            end_line: value.get("endLine").and_then(Value::as_f64),
        }
    }
}

/// Edit / Write 的 diff 快照（权限确认框与工具卡片共用）。
///
/// context / 行号字段随快照保留（TS 同口径）；TUI v1 的 diff 覆盖层只消费
/// before / after 全文。
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct DiffSnapshot {
    pub before_content: String,
    pub after_content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    pub start_line: Option<f64>,
    pub end_line: Option<f64>,
}

/// 入队 / 投递的结果。
pub enum ChoiceDelivery {
    /// 会话 open：立即弹框（app 显示覆盖层并等待应答）
    Show(PendingChoice),
    /// 会话未 open：保留 pending，等会话打开后由 `on_session_loaded` 重新投递
    Held,
    /// 本次请求替换了该会话旧的 pending（未投递或已弹出）：旧帧必须以错误应答收场
    Replaced { replaced_frames: Vec<u64>, delivery: Box<ChoiceDelivery> },
}

/// 已弹出、等应答的选择。
#[derive(Debug, Clone)]
pub struct ShownChoice {
    pub choice: PendingChoice,
    pub frame_id: u64,
}

#[derive(Default)]
pub struct ChoiceManager {
    diff: DiffSnapshot,
    diff_session: Option<String>,
    /// 已入队但尚未投递（会话未 open）；每会话最多一个，新请求覆盖旧的
    held: Option<(String, ChoiceOptions, u64)>,
    /// 已弹出、等应答：choiceId → 记录
    shown: HashMap<String, ShownChoice>,
}

impl ChoiceManager {
    pub fn save_diff_snapshot(&mut self, session_id: &str, snapshot: DiffSnapshot) {
        self.diff_session = Some(session_id.to_string());
        self.diff = snapshot;
    }

    pub fn diff_snapshot(&self) -> &DiffSnapshot {
        &self.diff
    }

    /// 检查指定会话是否有等待中的选择（已弹出或未投递都算）。
    #[allow(dead_code)] // 宿主接线保留：会话切换提醒 / 托盘口径复用
    pub fn has_pending(&self, session_id: &str) -> bool {
        self.shown.values().any(|entry| entry.choice.session_id == session_id)
            || self.held.as_ref().map(|(owner, _, _)| owner == session_id).unwrap_or(false)
    }

    /// 请求用户选择或确认（`CoreRequest.userChoice` 的入口）。`choice_id` 在投递时刻生成。
    pub fn request(&mut self, session_id: &str, options: ChoiceOptions, frame_id: u64, choice_id: String, is_open: bool) -> ChoiceDelivery {
        // 每会话最多一个 pending：新请求覆盖旧的（未投递的直接替换；已弹出的摘下），
        // 被替换的旧帧必须以错误应答收场，否则 core 侧永久挂起
        let mut replaced_frames: Vec<u64> = Vec::new();
        if let Some((_, _, old_frame)) = self.held.take_if(|(owner, _, _)| owner == session_id) {
            replaced_frames.push(old_frame);
        }
        let stale: Vec<String> = self
            .shown
            .iter()
            .filter(|(_, entry)| entry.choice.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(entry) = self.shown.remove(&id) {
                replaced_frames.push(entry.frame_id);
            }
        }
        let delivery = if is_open {
            let choice = PendingChoice {
                session_id: session_id.to_string(),
                choice_id,
                tool_name: options.tool_name.clone(),
                message: options.message.clone(),
                choices: options.choices.clone(),
            };
            self.shown.insert(
                choice.choice_id.clone(),
                ShownChoice { choice: choice.clone(), frame_id },
            );
            ChoiceDelivery::Show(choice)
        } else {
            self.held = Some((session_id.to_string(), options, frame_id));
            ChoiceDelivery::Held
        };
        if replaced_frames.is_empty() {
            delivery
        } else {
            ChoiceDelivery::Replaced { replaced_frames, delivery: Box::new(delivery) }
        }
    }

    /// 会话被打开 / 加载：重新投递该会话的 pending 选择（若有），生成新的 choiceId。
    /// 返回 (已弹出的选择, 被清理的旧帧 id——调用方错误应答)。
    pub fn on_session_loaded(&mut self, session_id: &str, choice_id: String) -> (Option<ShownChoice>, Vec<u64>) {
        let Some((owner, options, frame_id)) = self.held.take() else {
            return (None, Vec::new());
        };
        if owner != session_id {
            self.held = Some((owner, options, frame_id));
            return (None, Vec::new());
        }
        // 清理该会话旧的已弹出条目（与 TS 的 stale 清理同语义）；旧帧由调用方错误应答
        let stale: Vec<String> = self
            .shown
            .iter()
            .filter(|(_, entry)| entry.choice.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut stale_frames: Vec<u64> = Vec::new();
        for id in stale {
            if let Some(entry) = self.shown.remove(&id) {
                stale_frames.push(entry.frame_id);
            }
        }
        let choice = PendingChoice {
            session_id: session_id.to_string(),
            choice_id,
            tool_name: options.tool_name.clone(),
            message: options.message.clone(),
            choices: options.choices.clone(),
        };
        let entry = ShownChoice { choice: choice.clone(), frame_id };
        self.shown.insert(choice.choice_id.clone(), entry.clone());
        (Some(entry), stale_frames)
    }

    /// 用户已应答：移除 pending，返回该会话与帧 id（应答方据此解除 waiting 并回帧）。
    pub fn respond(&mut self, choice_id: &str) -> Option<ShownChoice> {
        self.shown.remove(choice_id)
    }

    /// 会话的 UI 侧状态已释放：丢弃挂起的回调与归属该会话的 diff 快照。
    /// 返回 (需错误应答的帧 id 列表, 是否有已弹出的选择被清除)。
    pub fn drop_session(&mut self, session_id: &str) -> (Vec<u64>, bool) {
        let mut frames = Vec::new();
        if let Some((owner, _, frame_id)) = self.held.take_if(|(owner, _, _)| owner == session_id) {
            let _ = owner;
            frames.push(frame_id);
        }
        let mut had_shown = false;
        self.shown.retain(|_, entry| {
            if entry.choice.session_id == session_id {
                had_shown = true;
                frames.push(entry.frame_id);
                false
            } else {
                true
            }
        });
        if self.diff_session.as_deref() == Some(session_id) {
            self.diff = DiffSnapshot::default();
            self.diff_session = None;
        }
        (frames, had_shown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> ChoiceOptions {
        ChoiceOptions {
            tool_name: "Bash".into(),
            message: "允许执行？".into(),
            choices: vec![ChoiceItem { label: "允许".into(), description: None }],
            before_content: None,
            after_content: None,
            context_before: Vec::new(),
            context_after: Vec::new(),
            start_line: None,
            end_line: None,
        }
    }

    #[test]
    fn open_session_shows_immediately_and_respond_clears() {
        let mut manager = ChoiceManager::default();
        match manager.request("s1", options(), 11, "c1".into(), true) {
            ChoiceDelivery::Show(choice) => assert_eq!(choice.choice_id, "c1"),
            _ => panic!("open 会话应立即投递"),
        }
        assert!(manager.has_pending("s1"));
        let shown = manager.respond("c1").unwrap();
        assert_eq!(shown.frame_id, 11);
        assert!(!manager.has_pending("s1"));
    }

    #[test]
    fn held_request_redelivered_on_session_load() {
        let mut manager = ChoiceManager::default();
        assert!(matches!(manager.request("s1", options(), 11, "c1".into(), false), ChoiceDelivery::Held));
        // 别的会话打开不投递
        assert!(manager.on_session_loaded("s2", "c2".into()).0.is_none());
        let (shown, stale) = manager.on_session_loaded("s1", "c3".into());
        assert!(stale.is_empty());
        let shown = shown.expect("会话打开后重新投递");
        assert_eq!(shown.choice.choice_id, "c3");
        assert_eq!(shown.frame_id, 11, "重投递沿用原帧 id");
        assert!(manager.respond("c1").is_none(), "旧的 choiceId 已被清理");
        assert_eq!(manager.respond("c3").unwrap().frame_id, 11);
    }

    #[test]
    fn replacing_held_request_yields_old_frame_for_error_response() {
        let mut manager = ChoiceManager::default();
        let _ = manager.request("s1", options(), 11, "c1".into(), false);
        match manager.request("s1", options(), 12, "c2".into(), true) {
            ChoiceDelivery::Replaced { replaced_frames, delivery } => {
                assert_eq!(replaced_frames, vec![11]);
                assert!(matches!(*delivery, ChoiceDelivery::Show(_)));
            }
            _ => panic!("覆盖旧请求应报告旧帧"),
        }
        assert_eq!(manager.respond("c2").unwrap().frame_id, 12);
    }

    #[test]
    fn replacing_shown_choice_collects_its_frame() {
        let mut manager = ChoiceManager::default();
        let _ = manager.request("s1", options(), 11, "c1".into(), true);
        match manager.request("s1", options(), 12, "c2".into(), true) {
            ChoiceDelivery::Replaced { replaced_frames, .. } => assert_eq!(replaced_frames, vec![11]),
            _ => panic!("覆盖已弹出的选择应报告旧帧"),
        }
        assert!(manager.respond("c1").is_none(), "旧 choiceId 已被摘下");
        assert_eq!(manager.respond("c2").unwrap().frame_id, 12);
    }

    #[test]
    fn drop_session_collects_frames_for_error_response() {
        let mut manager = ChoiceManager::default();
        manager.save_diff_snapshot("s1", DiffSnapshot { before_content: "old".into(), ..Default::default() });
        let _ = manager.request("s1", options(), 11, "c1".into(), true);
        let (frames, had_shown) = manager.drop_session("s1");
        assert_eq!(frames, vec![11]);
        assert!(had_shown, "已弹出的选择随视图一起消失");
        assert!(!manager.has_pending("s1"));
        assert_eq!(manager.diff_snapshot().before_content, "", "归属该会话的 diff 快照一并清理");
        // 其它会话的快照不误伤
        manager.save_diff_snapshot("s2", DiffSnapshot { before_content: "keep".into(), ..Default::default() });
        let _ = manager.drop_session("s1");
        assert_eq!(manager.diff_snapshot().before_content, "keep");
    }

    #[test]
    fn choice_options_filters_blank_context_lines() {
        let value = serde_json::json!({
            "toolName": "Edit", "message": "m",
            "choices": [{ "label": "允许", "description": "d" }],
            "beforeContent": "a", "afterContent": "b",
            "contextBefore": ["x", "", "undefined", null],
            "startLine": 3
        });
        let options = ChoiceOptions::from_value(&value);
        assert_eq!(options.context_before, vec!["x".to_string()]);
        assert_eq!(options.start_line, Some(3.0));
        assert_eq!(options.choices[0].label, "允许");
        assert_eq!(options.choices[0].description.as_deref(), Some("d"));
    }
}
