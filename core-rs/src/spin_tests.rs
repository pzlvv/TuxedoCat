//! Spin Design 引擎单测。
//!
//! 三部分：
//! - `parity_tests`：行为对照表数据在 `core-rs/fixtures/spin.json`；
//! - 引擎纯函数 / 文件读写 / 状态检测的单元测试；
//! - 假 [`SpinHost`] 驱动的 [`SpinLoop`] 端到端测试。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::*;
use crate::config;
use crate::test_support::{openai_text_sse, FakeLlm, Sandbox};

/// 行为对照表（数据见 core-rs/fixtures/）。
const FIXTURE: &str = include_str!("../fixtures/spin.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("spinParity.json 解析失败")
}

// ==================== 测试辅助 ====================

fn cwd_of(sandbox: &Sandbox) -> String {
    sandbox.workspace.to_string_lossy().to_string()
}

fn spin_path(sandbox: &Sandbox) -> std::path::PathBuf {
    config::ensure_project_conversation_dir(&cwd_of(sandbox))
        .expect("conversation dir")
        .join(SPIN_FILE)
}

fn write_spin(sandbox: &Sandbox, config_value: Value) {
    std::fs::write(
        spin_path(sandbox),
        serde_json::to_string_pretty(&config_value).unwrap(),
    )
    .expect("write spin.json");
}

fn read_spin(sandbox: &Sandbox) -> Value {
    let path = spin_path(sandbox);
    serde_json::from_str(&std::fs::read_to_string(path).expect("read spin.json"))
        .expect("parse spin.json")
}

/// 假 SpinHost：脚本化 Reply / 判定，记录 prompt / 事件 / 调用序号
struct FakeSpinHost {
    replies: Mutex<VecDeque<Result<String, String>>>,
    judges: Mutex<VecDeque<bool>>,
    events: Mutex<Vec<Value>>,
    prompts: Mutex<Vec<String>>,
    nodes: Mutex<Vec<SpinNode>>,
    sequences: Mutex<Vec<usize>>,
    labels: Mutex<Vec<String>>,
    judge_calls: Mutex<u32>,
    aborted: Arc<AtomicBool>,
    blocking: bool,
    skills: String,
}

impl FakeSpinHost {
    fn new() -> Self {
        Self {
            replies: Mutex::new(VecDeque::new()),
            judges: Mutex::new(VecDeque::new()),
            events: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            nodes: Mutex::new(Vec::new()),
            sequences: Mutex::new(Vec::new()),
            labels: Mutex::new(Vec::new()),
            judge_calls: Mutex::new(0),
            aborted: Arc::new(AtomicBool::new(false)),
            blocking: false,
            skills: String::new(),
        }
    }

    fn with_blocking(mut self) -> Self {
        self.blocking = true;
        self
    }

    fn with_abort_flag(mut self, flag: Arc<AtomicBool>) -> Self {
        self.aborted = flag;
        self
    }

    fn with_skills(mut self, skills: &str) -> Self {
        self.skills = skills.to_string();
        self
    }

    fn push_reply(&self, reply: &str) {
        self.replies
            .lock()
            .unwrap()
            .push_back(Ok(reply.to_string()));
    }

    /// 脚本一次无 Reply 失败（`run_sub_agent` 返回 Err）
    fn push_failure(&self, error: &str) {
        self.replies.lock().unwrap().push_back(Err(error.to_string()));
    }

    fn push_judge(&self, accept: bool) {
        self.judges.lock().unwrap().push_back(accept);
    }

    fn events(&self) -> Vec<Value> {
        self.events.lock().unwrap().clone()
    }

    fn prompts(&self) -> Vec<String> {
        self.prompts.lock().unwrap().clone()
    }

    fn sequences(&self) -> Vec<usize> {
        self.sequences.lock().unwrap().clone()
    }

    fn labels(&self) -> Vec<String> {
        self.labels.lock().unwrap().clone()
    }

    fn judge_count(&self) -> u32 {
        *self.judge_calls.lock().unwrap()
    }

    fn event_count(&self, event_type: &str) -> usize {
        self.events()
            .iter()
            .filter(|event| event["type"] == event_type)
            .count()
    }

    fn wait_for_prompt(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !self.prompts.lock().unwrap().is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }
}

impl SpinHost for FakeSpinHost {
    fn run_sub_agent(&self, request: SpinSubAgentRequest) -> Result<String, String> {
        self.prompts.lock().unwrap().push(request.prompt);
        self.nodes.lock().unwrap().push(request.node);
        self.sequences.lock().unwrap().push(request.sequence);
        self.labels.lock().unwrap().push(request.iteration_label);

        if self.blocking {
            while !self.aborted.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(5));
            }
            return Err("aborted".to_string());
        }

        match self.replies.lock().unwrap().pop_front() {
            Some(result) => result,
            None => Ok(String::new()),
        }
    }

    fn emit_event(&self, event: Value) {
        self.events.lock().unwrap().push(event);
    }

    fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Relaxed)
    }

    fn load_skills_prompt(&self, _names: &[String], _cwd: &str, _session_id: &str) -> String {
        self.skills.clone()
    }

    fn judge(&self, _task: &str, _criteria: &[String], _reply: &str) -> SpinJudgerResult {
        *self.judge_calls.lock().unwrap() += 1;
        let accept = self.judges.lock().unwrap().pop_front().unwrap_or(true);
        SpinJudgerResult {
            accept,
            raw_reply: String::new(),
        }
    }
}

// ==================== 对照表 ====================

mod parity_tests {
    use super::*;

    #[test]
    fn variables_without_value_parity() {
        let fixture = fixture();
        for case in fixture["variablesWithoutValue"].as_array().unwrap() {
            let result: Vec<Value> = get_variables_without_value(&case["config"])
                .into_iter()
                .map(Value::String)
                .collect();
            assert_eq!(
                Value::Array(result),
                case["result"],
                "未赋值变量不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn design_issues_parity() {
        let fixture = fixture();
        for case in fixture["designIssues"].as_array().unwrap() {
            let actual = get_spin_design_issue(&case["config"]).map(|issue| issue.as_str().to_string());
            assert_eq!(
                actual.as_deref(),
                case["issue"].as_str(),
                "结构问题不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn topological_sort_parity() {
        let fixture = fixture();
        for case in fixture["topoSort"].as_array().unwrap() {
            let nodes = parse_nodes(case.get("nodes"));
            let edges = parse_edges(case.get("edges"));
            let order = topological_sort(&nodes, &edges);
            let expected: Vec<i64> = case["order"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_i64().unwrap())
                .collect();
            assert_eq!(
                order,
                expected,
                "拓扑序不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn next_node_parity() {
        let fixture = fixture();
        for case in fixture["nextNode"].as_array().unwrap() {
            let actual = get_next_node(&case["config"]).map(|node| node.id);
            assert_eq!(
                actual,
                case["nextNodeId"].as_i64(),
                "下一个节点不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn rollout_normalization_parity() {
        let fixture = fixture();
        for case in fixture["rolloutCount"].as_array().unwrap() {
            assert_eq!(
                normalize_rollout_count(&case["value"]),
                case["result"].as_i64().unwrap(),
                "rollout 次数不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
        for case in fixture["rolloutPassed"].as_array().unwrap() {
            assert_eq!(
                normalize_rollout_passed(&case["value"]),
                case["result"].as_i64().unwrap(),
                "已完成 rollout 不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn for_each_rows_parity() {
        let fixture = fixture();
        for case in fixture["forEachRows"].as_array().unwrap() {
            let rows: Vec<Value> = split_for_each_rows(case.get("value"))
                .into_iter()
                .map(Value::String)
                .collect();
            assert_eq!(
                Value::Array(rows),
                case["rows"],
                "For Each 分行不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn run_prompt_parity() {
        let fixture = fixture();
        for case in fixture["runPrompts"].as_array().unwrap() {
            let node = parse_node(&case["node"]);
            let note = case["note"].as_str();
            let skills_prompt = case["skillsPrompt"].as_str();
            assert_eq!(
                build_run_prompt(&node, note, skills_prompt),
                case["result"].as_str().unwrap(),
                "子代理 prompt 不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn substitution_parity() {
        let fixture = fixture();
        for case in fixture["substitutions"].as_array().unwrap() {
            let variables = case.get("variables").and_then(Value::as_object);
            assert_eq!(
                substitute_spin_variables(case["text"].as_str().unwrap(), variables),
                case["result"].as_str().unwrap(),
                "变量替换不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn judge_parse_parity() {
        let fixture = fixture();
        for case in fixture["judgeParse"].as_array().unwrap() {
            assert_eq!(
                parse_accept(case["reply"].as_str().unwrap()),
                case["accept"].as_bool().unwrap(),
                "验收 JSON 提取不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn progress_parity() {
        let fixture = fixture();
        for case in fixture["progress"].as_array().unwrap() {
            let node = parse_node(&case["node"]);
            let config = json!({
                "variables": case["variables"].clone(),
                "meta": case["meta"].clone(),
            });
            let progress = compute_progress(&node, &config);
            let expected = &case["result"];
            assert_eq!(
                progress.rollout_count,
                expected["rolloutCount"].as_i64().unwrap(),
                "rolloutCount 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.for_each_var,
                expected["forEachVar"].as_str().unwrap(),
                "forEachVar 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                Value::Array(
                    progress
                        .for_each_rows
                        .iter()
                        .map(|row| Value::String(row.clone()))
                        .collect()
                ),
                expected["forEachRows"],
                "forEachRows 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.total_iterations,
                expected["totalIterations"].as_i64().unwrap(),
                "totalIterations 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.completed_iterations,
                expected["completedIterations"].as_i64().unwrap(),
                "completedIterations 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.current_row_index,
                expected["currentRowIndex"].as_i64().unwrap(),
                "currentRowIndex 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.rollout_id,
                expected["rolloutId"].as_i64().unwrap(),
                "rolloutId 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.current_row_value,
                expected["currentRowValue"].as_str().unwrap(),
                "currentRowValue 不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                progress.iteration_label,
                expected["iterationLabel"].as_str().unwrap(),
                "iterationLabel 不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }
}

// ==================== 引擎纯函数 / 读写 ====================

#[test]
fn validate_spin_design_reports_english_messages() {
    let _sandbox = Sandbox::new("spin-validate");
    // 这些文案会落盘，一律英文常量（Core 不感知语言）

    assert_eq!(
        validate_spin_design(&json!({ "nodes": [ { "id": 1, "task": "A" } ], "edges": [] })),
        None
    );
    assert_eq!(
        validate_spin_design(&json!(null)),
        Some("spin.json is not a valid object.".to_string())
    );
    assert_eq!(
        validate_spin_design(&json!([])),
        Some("spin.json is missing the nodes array.".to_string())
    );
    assert_eq!(
        validate_spin_design(&json!({ "nodes": [] })),
        Some("spin.json has no executable nodes.".to_string())
    );
    assert_eq!(
        validate_spin_design(&json!({ "nodes": [ { "id": 1, "task": "  " } ] })),
        Some("Node 1 is missing a task description.".to_string())
    );
    assert_eq!(
        validate_spin_design(
            &json!({ "nodes": [ { "id": 1, "task": "A" } ], "variables": { "ROLLOUT_ID": "1" } })
        ),
        Some(
            "Variable \"ROLLOUT_ID\" conflicts with a built-in variable. Please rename it and retry."
                .to_string()
        )
    );
    assert_eq!(
        validate_spin_design(
            &json!({ "nodes": [ { "id": 1, "task": "A" } ], "variables": { "K": "" } })
        ),
        Some(
            "Variables without a value (K), please fill in their values in the variable list and retry."
                .to_string()
        )
    );
    assert_eq!(
        validate_spin_design(&json!({ "nodes": [ { "id": 1, "task": "A", "forEach": "MISSING" } ] })),
        Some("Node 1: For Each variable \"MISSING\" does not exist.".to_string())
    );
    assert_eq!(
        validate_spin_design(&json!({
            "nodes": [ { "id": 1, "task": "A" }, { "id": 2, "task": "B" } ],
            "edges": [ { "from": 1, "to": 2 }, { "from": 2, "to": 1 } ],
        })),
        Some(
            "The flow is not a valid directed acyclic graph (DAG), please check the edges and retry."
                .to_string()
        )
    );

}

#[test]
fn detect_project_state_covers_all_states() {
    let sandbox = Sandbox::new("spin-detect");
    let cwd = cwd_of(&sandbox);

    assert_eq!(detect_project_state(&cwd), SpinProjectState::Init);

    let path = spin_path(&sandbox);
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(detect_project_state(&cwd), SpinProjectState::Invalid);

    write_spin(
        &sandbox,
        json!({ "nodes": [ { "id": 1, "task": "A" } ], "edges": [] }),
    );
    assert_eq!(detect_project_state(&cwd), SpinProjectState::Ready);

    write_spin(&sandbox, json!({ "nodes": [] }));
    assert_eq!(detect_project_state(&cwd), SpinProjectState::EmptyNode);

    write_spin(
        &sandbox,
        json!({ "nodes": [ { "id": 1, "task": "A" } ], "variables": { "K": "" } }),
    );
    assert_eq!(detect_project_state(&cwd), SpinProjectState::VariableNoValue);

    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A" }, { "id": 2, "task": "B" } ],
            "edges": [ { "from": 1, "to": 2 }, { "from": 2, "to": 1 } ],
        }),
    );
    assert_eq!(detect_project_state(&cwd), SpinProjectState::NotDag);
}

#[test]
fn update_node_meta_merges_previous_fields() {
    let sandbox = Sandbox::new("spin-meta-merge");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A" } ],
            "edges": [],
            "meta": { "1": { "passed": false, "note": "old", "rolloutPassed": 2, "extraField": "keep" } },
        }),
    );

    let mut extra = Map::new();
    extra.insert("rolloutPassed".to_string(), json!(3));
    assert!(update_node_meta(&cwd, 1, true, Some("new"), Some(&extra)));

    let config = read_spin(&sandbox);
    let meta = &config["meta"]["1"];
    assert_eq!(meta["passed"], json!(true));
    assert_eq!(meta["note"], json!("new"));
    assert_eq!(meta["rolloutPassed"], json!(3));
    assert_eq!(meta["extraField"], json!("keep"));
}

#[test]
fn update_node_meta_returns_false_without_file() {
    let sandbox = Sandbox::new("spin-meta-missing");
    let cwd = cwd_of(&sandbox);
    assert!(!update_node_meta(&cwd, 1, true, Some("x"), None));
}

#[test]
fn write_spin_json_preserves_unknown_fields() {
    let sandbox = Sandbox::new("spin-roundtrip");
    let cwd = cwd_of(&sandbox);
    let config = json!({
        "nodes": [
            { "id": 1, "x": 12.5, "y": 7, "task": "A", "title": "T", "custom": { "a": 1 } }
        ],
        "edges": [ { "from": 1, "to": 1, "fromSide": "right" } ],
        "meta": {},
        "variables": { "K": "V" },
        "variableComments": { "K": "注释" },
        "unknownTop": [1, 2, 3],
    });
    write_spin_json(&cwd, &config).unwrap();
    let read_back = read_spin_json(&cwd).unwrap();
    assert_eq!(read_back, config);
}

#[test]
fn read_spin_json_state_reports_missing_as_none() {
    let sandbox = Sandbox::new("spin-state-missing");
    let cwd = cwd_of(&sandbox);
    assert_eq!(read_spin_json_state(&cwd), Ok(None));
}

#[test]
fn read_spin_json_state_returns_parsed_value() {
    let sandbox = Sandbox::new("spin-state-ok");
    let cwd = cwd_of(&sandbox);
    let config = json!({ "nodes": [ { "id": 1, "task": "A" } ], "edges": [], "meta": {} });
    write_spin(&sandbox, config.clone());
    assert_eq!(read_spin_json_state(&cwd), Ok(Some(config)));
}

#[test]
fn read_spin_json_state_reports_invalid_json_as_error() {
    let sandbox = Sandbox::new("spin-state-invalid");
    let cwd = cwd_of(&sandbox);
    std::fs::write(spin_path(&sandbox), "{ not json").expect("write invalid spin.json");
    assert!(read_spin_json_state(&cwd).is_err());
}

#[test]
fn substitute_spin_variables_escapes_dollar() {
    let mut variables = Map::new();
    variables.insert("A".to_string(), json!("x"));
    variables.insert("LONG".to_string(), json!("${A}"));
    assert_eq!(substitute_spin_variables("$${A}", Some(&variables)), "${A}");
    assert_eq!(substitute_spin_variables("${A}${B}", Some(&variables)), "x${B}");
    assert_eq!(substitute_spin_variables("$", Some(&variables)), "$");
    assert_eq!(substitute_spin_variables("", Some(&variables)), "");
    // 长的键优先：${LONG} 先展开成 ${A}，再被 A 展开成 x
    assert_eq!(substitute_spin_variables("${LONG}", Some(&variables)), "x");
}

#[test]
fn parse_accept_handles_markdown_and_fallback() {
    assert!(parse_accept("{\"accept\": true}"));
    assert!(!parse_accept("{\"accept\": false}"));
    assert!(parse_accept("```json\n{\"accept\": true}\n```"));
    assert!(parse_accept("判定结果：{\"accept\": true}，请查收"));
    assert!(!parse_accept("{\"accept\": 1}"));
    // JSON.parse('true') 成功但没有 accept 字段 → false（不进入字母兜底）
    assert!(!parse_accept("true"));
    // JSON 解析失败 → 字母兜底
    assert!(parse_accept("True"));
    assert!(!parse_accept("FALSE"));
    assert!(!parse_accept("随便写点什么"));
    assert!(!parse_accept(""));
}

#[test]
fn judge_with_provider_without_provider_defaults_false() {
    let result = judge_with_provider(None, "任务", &["条件".to_string()], "反馈");
    assert!(!result.accept);
    assert_eq!(result.raw_reply, "(LLM call failed)");
}

#[test]
fn judge_with_provider_parses_fake_llm_reply() {
    let sandbox = Sandbox::new("spin-judge-llm");
    let llm = FakeLlm::fixed(openai_text_sse(&["{\"accept\": true}"]));
    sandbox.write_llm_settings(&llm.base_url, "auto");
    let provider = config::resolve_provider(None, None).expect("provider");

    let result = judge_with_provider(Some(&provider), "任务", &["条件".to_string()], "反馈");
    assert!(result.accept);
    assert_eq!(result.raw_reply, "{\"accept\": true}");
}

#[test]
fn split_for_each_rows_handles_all_line_endings() {
    assert_eq!(
        split_for_each_rows(Some(&json!("a\r\nb\rc\nd"))),
        vec!["a", "b", "c", "d"]
    );
    assert_eq!(
        split_for_each_rows(Some(&json!("  a  \n\n   \n b "))),
        vec!["a", "b"]
    );
    assert!(split_for_each_rows(None).is_empty());
    assert!(split_for_each_rows(Some(&json!(null))).is_empty());
    assert_eq!(split_for_each_rows(Some(&json!(42))), vec!["42"]);
}

// ==================== SpinLoop 端到端（假 SpinHost） ====================

#[test]
fn spin_loop_passes_all_nodes() {
    let sandbox = Sandbox::new("spin-pass");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [
                { "id": 1, "task": "任务A", "criteria": ["条件1"] },
                { "id": 2, "task": "任务B", "criteria": ["条件2"] },
            ],
            "edges": [ { "from": 1, "to": 2 } ],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_reply("done A");
    host.push_reply("done B");
    host.push_judge(true);
    host.push_judge(true);

    let outcome = SpinLoop::new(host.clone(), cwd.clone(), "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(true));
    assert_eq!(config["meta"]["1"]["rolloutPassed"], json!(1));
    assert_eq!(config["meta"]["1"]["note"], json!("done A"));
    assert_eq!(config["meta"]["2"]["passed"], json!(true));

    assert_eq!(host.prompts().len(), 2);
    assert_eq!(host.sequences(), vec![1, 2]);
    assert_eq!(host.judge_count(), 2);
    // 每个节点完成后都刷新一次设计器
    assert!(host.event_count("spinDesignDataChanged") >= 2);
    // 全部完成发一条瞬时提示（notice，键 + 参数）
    assert!(host.events().iter().any(|event| event["type"] == "notice"
        && event["key"] == crate::core_text::SPIN_ALL_COMPLETED));
}

#[test]
fn spin_loop_retries_after_judge_failure() {
    let sandbox = Sandbox::new("spin-retry");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A", "criteria": ["c"] } ],
            "edges": [],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_reply("first try");
    host.push_reply("second try");
    host.push_judge(false);
    host.push_judge(true);

    let outcome = SpinLoop::new(host.clone(), cwd.clone(), "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);
    assert_eq!(host.prompts().len(), 2);
    assert_eq!(host.judge_count(), 2);

    // 第二轮 prompt 带上上一轮反馈
    assert!(host.prompts()[1].contains("### 上一轮反馈\nfirst try"));

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(true));
    assert_eq!(config["meta"]["1"]["rolloutPassed"], json!(1));
    assert_eq!(config["meta"]["1"]["note"], json!("second try"));
}

#[test]
fn spin_loop_for_each_rows() {
    let sandbox = Sandbox::new("spin-foreach");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "处理 ${ITEMS} / ${LINE}", "criteria": ["不会参与"], "forEach": "ITEMS" } ],
            "edges": [],
            "variables": { "ITEMS": "alpha\nbeta\ngamma" },
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_reply("r1");
    host.push_reply("r2");
    host.push_reply("r3");

    let outcome = SpinLoop::new(host.clone(), cwd.clone(), "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);

    let prompts = host.prompts();
    assert_eq!(prompts.len(), 3);
    assert!(prompts[0].contains("处理 alpha / alpha"));
    assert!(prompts[1].contains("处理 beta / beta"));
    assert!(prompts[2].contains("处理 gamma / gamma"));
    // For Each 时验收标准不参与，也就不调用 LLM 评审
    assert_eq!(host.judge_count(), 0);
    // 迭代标签形如 [row 1/3]
    assert_eq!(host.labels(), vec![" [row 1/3]", " [row 2/3]", " [row 3/3]"]);

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(true));
    assert_eq!(config["meta"]["1"]["rolloutPassed"], json!(3));
}

#[test]
fn spin_loop_rollout_iterations() {
    let sandbox = Sandbox::new("spin-rollout");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "run ${ROLLOUT_ID}", "criteria": ["不参与"], "rollout": 3 } ],
            "edges": [],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_reply("a");
    host.push_reply("b");
    host.push_reply("c");

    let outcome = SpinLoop::new(host.clone(), cwd.clone(), "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);

    let prompts = host.prompts();
    assert_eq!(prompts.len(), 3);
    assert!(prompts[0].contains("run 0"));
    assert!(prompts[1].contains("run 1"));
    assert!(prompts[2].contains("run 2"));
    assert_eq!(host.labels(), vec![" [rollout 1/3]", " [rollout 2/3]", " [rollout 3/3]"]);
    assert_eq!(host.judge_count(), 0);

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(true));
    assert_eq!(config["meta"]["1"]["rolloutPassed"], json!(3));
}

#[test]
fn spin_loop_resumes_from_rollout_passed() {
    let sandbox = Sandbox::new("spin-resume");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "run ${ROLLOUT_ID}", "rollout": 3 } ],
            "edges": [],
            "meta": { "1": { "passed": false, "note": "", "rolloutPassed": 2 } },
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_reply("last");

    let outcome = SpinLoop::new(host.clone(), cwd.clone(), "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);
    assert_eq!(host.prompts().len(), 1);
    assert!(host.prompts()[0].contains("run 2"));

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["rolloutPassed"], json!(3));
    assert_eq!(config["meta"]["1"]["passed"], json!(true));
}

#[test]
fn spin_loop_injects_skills_prompt() {
    let sandbox = Sandbox::new("spin-skills");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A", "criteria": ["c"], "skills": ["commit"] } ],
            "edges": [],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new().with_skills("### commit\n按规范提交"));
    host.push_reply("done");
    host.push_judge(true);

    let outcome = SpinLoop::new(host.clone(), cwd, "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);
    assert!(host.prompts()[0].contains("### 已加载的 Skills\n### commit\n按规范提交"));
}

#[test]
fn spin_loop_retries_without_reply_failure_without_counting_attempts() {
    // 无 Reply 失败与验收无关（docs/features/spin-execution.md 第 2 节）：无验收条件
    // 的节点第一轮子对话收尾无 Reply → 不判通过（旧实现会把 Err 转成反馈后直接判
    // 通过），立即重试且不占用上限；重试轮 Reply 到达后节点通过。
    let sandbox = Sandbox::new("spin-no-reply-retry");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A", "criteria": [] } ],
            "edges": [],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_failure("spin sub-agent ended without a reply");
    host.push_reply("done");

    let outcome = SpinLoop::new(host.clone(), cwd.clone(), "s1").run();
    assert_eq!(outcome, SpinOutcome::Completed);
    // 失败轮重试了一次：共两次子代理调用；无验收条件不进评审
    assert_eq!(host.prompts().len(), 2);
    assert_eq!(host.judge_count(), 0);

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(true));
}

#[test]
fn spin_loop_stops_only_on_acceptance_failures() {
    // 上限只数验收失败（docs/features/spin-execution.md 第 2 节）：上限 1 时，
    // 先一次无 Reply 失败（不计数）不触发停止，再一次验收失败（计数 1）才停——
    // 共两次子代理调用；无 Reply 轮不进评审、不写 note。
    let sandbox = Sandbox::new("spin-stop-only-acceptance");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A", "criteria": ["c"] } ],
            "edges": [],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_failure("spin sub-agent ended without a reply");
    host.push_reply("y");
    host.push_judge(false);

    let mut spin = SpinLoop::new(host.clone(), cwd.clone(), "s1");
    spin.set_max_attempts(1);
    let outcome = spin.run();
    assert_eq!(outcome, SpinOutcome::Stopped);
    assert_eq!(host.prompts().len(), 2);
    assert_eq!(host.judge_count(), 1);

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(false));
    assert_eq!(config["meta"]["1"]["note"], json!("failed after 1 attempts"));
}

#[test]
fn spin_loop_stops_after_max_attempts() {
    let sandbox = Sandbox::new("spin-stop");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A", "criteria": ["c"] } ],
            "edges": [],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    host.push_reply("x");
    host.push_reply("y");
    host.push_judge(false);
    host.push_judge(false);

    let mut spin = SpinLoop::new(host.clone(), cwd.clone(), "s1");
    spin.set_max_attempts(2);
    let outcome = spin.run();
    assert_eq!(outcome, SpinOutcome::Stopped);
    assert_eq!(host.prompts().len(), 2);

    let config = read_spin(&sandbox);
    assert_eq!(config["meta"]["1"]["passed"], json!(false));
    assert_eq!(config["meta"]["1"]["note"], json!("failed after 2 attempts"));
}

#[test]
fn spin_loop_aborts_mid_run() {
    let sandbox = Sandbox::new("spin-abort-mid");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A", "criteria": ["c"] } ],
            "edges": [],
            "meta": {},
        }),
    );

    let abort = Arc::new(AtomicBool::new(false));
    let host = Arc::new(
        FakeSpinHost::new()
            .with_blocking()
            .with_abort_flag(Arc::clone(&abort)),
    );
    let spin = SpinLoop::with_abort_flag(host.clone(), cwd.clone(), "s1", Arc::clone(&abort));
    let handle = spin.spawn();

    assert!(
        host.wait_for_prompt(Duration::from_secs(5)),
        "子代理应在超时前启动"
    );
    handle.abort();
    assert_eq!(handle.join(), SpinOutcome::Aborted);

    // 中止后不写 passed
    let config = read_spin(&sandbox);
    assert!(config["meta"]["1"].is_null());
}

#[test]
fn spin_loop_aborts_before_start() {
    let sandbox = Sandbox::new("spin-abort-pre");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A" } ],
            "edges": [],
            "meta": {},
        }),
    );

    let abort = Arc::new(AtomicBool::new(true));
    let host = Arc::new(FakeSpinHost::new().with_abort_flag(Arc::clone(&abort)));
    let spin = SpinLoop::with_abort_flag(host.clone(), cwd.clone(), "s1", abort);
    assert_eq!(spin.run(), SpinOutcome::Aborted);
    assert!(host.prompts().is_empty());
}

#[test]
fn spin_loop_rejects_invalid_design() {
    let sandbox = Sandbox::new("spin-invalid");
    let cwd = cwd_of(&sandbox);
    write_spin(
        &sandbox,
        json!({
            "nodes": [ { "id": 1, "task": "A" }, { "id": 2, "task": "B" } ],
            "edges": [ { "from": 1, "to": 2 }, { "from": 2, "to": 1 } ],
            "meta": {},
        }),
    );

    let host = Arc::new(FakeSpinHost::new());
    let outcome = SpinLoop::new(host.clone(), cwd, "s1").run();
    assert!(matches!(outcome, SpinOutcome::Failed(_)));
    assert!(host.prompts().is_empty());
    // 校验失败发一条 message
    assert!(host.event_count("message") >= 1);
}

#[test]
fn spin_loop_rejects_missing_file() {
    let sandbox = Sandbox::new("spin-missing");
    let cwd = cwd_of(&sandbox);
    let host = Arc::new(FakeSpinHost::new());
    let outcome = SpinLoop::new(host.clone(), cwd, "s1").run();
    assert!(matches!(outcome, SpinOutcome::Failed(_)));
    assert!(host.prompts().is_empty());
}
