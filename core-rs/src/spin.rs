//! Spin Design 引擎。
//!
//! 模块划分：
//! - 类型：[`SpinNode`] / [`SpinEdge`] / [`SpinDesignIssue`] / [`SpinProjectState`]
//! - 引擎纯函数：[`read_spin_json`] / [`write_spin_json`] / [`topological_sort`] /
//!   [`get_next_node`] / [`compute_progress`] / [`build_run_prompt`] /
//!   [`substitute_spin_variables`] / [`validate_spin_design`] / [`detect_project_state`] /
//!   [`update_node_meta`]
//! - 验收判定：[`parse_accept`] / [`build_judge_prompts`] / [`judge_with_provider`]
//! - Runner：[`SUB_AGENT_REPLY_INSTRUCTION`] / [`sub_agent_description`]（真正起子代理由
//!   宿主的 [`SpinHost::run_sub_agent`] 承接，复用 `engine::create_sub_agent`）
//! - 主循环：[`SpinLoop`]
//!
//! **与引擎的边界**：`SpinLoop` 不依赖 `engine.rs` 的任何内部类型，全部交互收敛到
//! [`SpinHost`] trait（子代理执行 / 事件上报 / 中止查询 / 进度消息落库 / Skills 加载 /
//! 验收判定）。宿主把 `QueryEngine`（Rust 侧为 `engine::Core`）适配成该 trait 即可接线。
//!
//! **线程模型**：整仓是阻塞式多线程，没有 async 运行时。`SpinLoop::run` 在当前线程阻塞
//! 执行；`SpinLoop::spawn` 起独立线程，返回 [`SpinHandle`]，用 `Arc<AtomicBool>` 做 abort。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Map, Value};

use crate::config;
use crate::llm;
use crate::skills;
use crate::util;

// ==================== Types.ts ====================

/// `spin.json` 文件名
pub const SPIN_FILE: &str = "spin.json";

/// 内置变量名，不能作为用户变量（对齐 `RESERVED_BUILTIN_VARS`）
pub const RESERVED_BUILTIN_VARS: [&str; 2] = ["ROLLOUT_ID", "LINE"];

/// 单个节点的连续失败上限（对齐 `MAX_ATTEMPTS`）
pub const MAX_ATTEMPTS: u32 = 100;

/// 流程图中的单个节点（对齐 `SpinNode`）。
///
/// `x` / `y` / `fromSide` / `toSide` 等纯画布字段不参与执行，这里不解析；
/// 读写路径始终操作原始 JSON，因此这些字段在落盘时会原样保留。
#[derive(Clone, Debug, Default)]
pub struct SpinNode {
    pub id: i64,
    pub task: String,
    pub criteria: Vec<String>,
    /// `rollout` 执行次数原始值（`normalize_rollout_count` 消费），缺省为 `Null`
    pub rollout: Value,
    /// For Each 遍历的用户变量名（仅当 JSON 里是字符串时解析）
    pub for_each: Option<String>,
    /// 节点角色（画布元数据，不参与执行；只读写原始 JSON）
    #[allow(dead_code)]
    pub role: Option<String>,
    /// 该节点执行前需要依次加载的 Skill 名称列表
    pub skills: Vec<String>,
    /// 节点标题（仅用于画布展示，不参与执行）
    #[allow(dead_code)]
    pub title: Option<String>,
}

/// 节点间的连线（对齐 `SpinEdge`）
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpinEdge {
    pub from: i64,
    pub to: i64,
    pub from_side: Option<String>,
    pub to_side: Option<String>,
}

/// `spin.json` 结构问题分类（对齐 `SpinDesignIssue`）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpinDesignIssue {
    /// JSON / 节点数据非法
    Invalid,
    /// 存在空节点（无任务描述）
    EmptyNode,
    /// 不是有效的无环有向图（DAG）
    NotDag,
    /// 存在未赋值的用户变量
    VariableNoValue,
}

impl SpinDesignIssue {
    /// 对等测试断言用（生产路径未消费）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_str(self) -> &'static str {
        match self {
            SpinDesignIssue::Invalid => "invalid",
            SpinDesignIssue::EmptyNode => "empty-node",
            SpinDesignIssue::NotDag => "not-dag",
            SpinDesignIssue::VariableNoValue => "variable-no-value",
        }
    }
}

/// 自动检测出的项目状态（对齐 `SpinProjectState`）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpinProjectState {
    /// 不存在 spin.json
    Init,
    /// spin.json 存在且结构可执行
    Ready,
    /// JSON 非法或节点数据非法
    Invalid,
    /// 存在空节点
    EmptyNode,
    /// 不是有效的 DAG
    NotDag,
    /// 存在未赋值的用户变量
    VariableNoValue,
}

impl SpinProjectState {
    /// 数据契约里的稳定字符串（当前无调用方，保留以对齐 `SpinProjectState`）
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            SpinProjectState::Init => "init",
            SpinProjectState::Ready => "ready",
            SpinProjectState::Invalid => "invalid",
            SpinProjectState::EmptyNode => "empty-node",
            SpinProjectState::NotDag => "not-dag",
            SpinProjectState::VariableNoValue => "variable-no-value",
        }
    }
}

impl From<SpinDesignIssue> for SpinProjectState {
    fn from(issue: SpinDesignIssue) -> Self {
        match issue {
            SpinDesignIssue::Invalid => SpinProjectState::Invalid,
            SpinDesignIssue::EmptyNode => SpinProjectState::EmptyNode,
            SpinDesignIssue::NotDag => SpinProjectState::NotDag,
            SpinDesignIssue::VariableNoValue => SpinProjectState::VariableNoValue,
        }
    }
}

// ==================== Engine.ts ====================

/// `~/<CONFIG_DIR_NAME>/conversations/<encoded-workspace>/spin.json` 路径
///
/// 目录解析复用 `config::project_conversation_dir`。
pub fn spin_json_path(cwd: &str) -> Result<PathBuf, String> {
    Ok(config::project_conversation_dir(cwd)?.join(SPIN_FILE))
}

/// 读取 spin.json（解析失败 / 文件不存在都返回 `None`，对齐 `readSpinJson`）
pub fn read_spin_json(cwd: &str) -> Option<Value> {
    let path = spin_json_path(cwd).ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 节点执行状态（`meta[nodeId]`）
pub fn node_meta<'a>(config: &'a Value, node_id: i64) -> Option<&'a Value> {
    config.get("meta")?.get(node_id.to_string())
}

/// 找出「已命名但未赋值」的用户变量名（值为非字符串或 `trim()` 后为空）。
///
/// 对齐 `getVariablesWithoutValue`：跳过空键与内置变量；变量名非法或与内置变量
/// 冲突的情况由其他校验处理，这里只关注值缺失。
pub fn get_variables_without_value(config: &Value) -> Vec<String> {
    let Some(Value::Object(variables)) = config.get("variables") else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for (key, value) in variables {
        if key.is_empty() || RESERVED_BUILTIN_VARS.contains(&key.as_str()) {
            continue;
        }
        let has_value = value
            .as_str()
            .map(|text| !util::js_trim(text).is_empty())
            .unwrap_or(false);
        if !has_value {
            result.push(key.clone());
        }
    }
    result
}

/// 获取 spin.json 的结构问题类型（对齐 `getSpinDesignIssue`）。
///
/// 判定优先级：`invalid`（非对象）→ `empty-node`（nodes 缺失 / 空）→
/// 逐节点 `invalid` / `empty-node` → `variable-no-value` → `invalid`（edges 非数组）
/// → `not-dag`。
pub fn get_spin_design_issue(config: &Value) -> Option<SpinDesignIssue> {
    // JS `typeof [] === 'object'`：数组会通过第一层检查，随后因 nodes 缺失落到 empty-node
    if !config.is_object() && !config.is_array() {
        return Some(SpinDesignIssue::Invalid);
    }
    let Some(nodes) = config.get("nodes").and_then(Value::as_array) else {
        return Some(SpinDesignIssue::EmptyNode);
    };
    if nodes.is_empty() {
        return Some(SpinDesignIssue::EmptyNode);
    }
    for node in nodes {
        if !node.is_object() {
            return Some(SpinDesignIssue::Invalid);
        }
        if !node.get("id").map(Value::is_number).unwrap_or(false) {
            return Some(SpinDesignIssue::Invalid);
        }
        let task_ok = node
            .get("task")
            .and_then(Value::as_str)
            .map(|task| !util::js_trim(task).is_empty())
            .unwrap_or(false);
        if !task_ok {
            return Some(SpinDesignIssue::EmptyNode);
        }
    }
    if !get_variables_without_value(config).is_empty() {
        return Some(SpinDesignIssue::VariableNoValue);
    }
    if let Some(edges) = config.get("edges") {
        if !edges.is_array() {
            return Some(SpinDesignIssue::Invalid);
        }
    }
    let order = topological_sort(
        &parse_nodes(config.get("nodes")),
        &parse_edges(config.get("edges")),
    );
    if order.len() != nodes.len() {
        return Some(SpinDesignIssue::NotDag);
    }
    None
}

/// 校验 spin.json 是否可执行（对齐 `validateSpinDesign`）。
///
/// 返回的文案会进入会话历史（`push_message` 落盘），因此**一律英文**，
/// 不走本地化（落盘文本统一英文）。
///
/// @returns 错误信息；合法时返回 `None`
pub fn validate_spin_design(config: &Value) -> Option<String> {
    if !config.is_object() && !config.is_array() {
        return Some("spin.json is not a valid object.".to_string());
    }

    let Some(nodes) = config.get("nodes").and_then(Value::as_array) else {
        return Some("spin.json is missing the nodes array.".to_string());
    };
    if nodes.is_empty() {
        return Some("spin.json has no executable nodes.".to_string());
    }

    // 用户变量不能与内置变量冲突
    if let Some(Value::Object(variables)) = config.get("variables") {
        for key in variables.keys() {
            if RESERVED_BUILTIN_VARS.contains(&key.as_str()) {
                return Some(format!(
                    "Variable \"{key}\" conflicts with a built-in variable. Please rename it and retry."
                ));
            }
        }
    }

    // 变量必须已赋值，否则 ${KEY} 会被替换为空字符串
    let no_value_vars = get_variables_without_value(config);
    if !no_value_vars.is_empty() {
        let joined = no_value_vars.join(", ");
        return Some(format!(
            "Variables without a value ({joined}), please fill in their values in the variable list and retry."
        ));
    }

    for node in nodes {
        if !node.is_object() {
            return Some("spin.json contains an invalid node.".to_string());
        }
        let Some(id_value) = node.get("id") else {
            return Some("spin.json contains an invalid node.".to_string());
        };
        if !id_value.is_number() {
            return Some("spin.json contains an invalid node.".to_string());
        }
        let id_text = util::js_string(id_value);
        let task_ok = node
            .get("task")
            .and_then(Value::as_str)
            .map(|task| !util::js_trim(task).is_empty())
            .unwrap_or(false);
        if !task_ok {
            return Some(format!("Node {id_text} is missing a task description."));
        }
        let for_each_var = node
            .get("forEach")
            .and_then(Value::as_str)
            .map(util::js_trim)
            .unwrap_or("");
        if !for_each_var.is_empty() {
            let exists = config
                .get("variables")
                .and_then(Value::as_object)
                .map(|variables| variables.contains_key(for_each_var))
                .unwrap_or(false);
            if !exists {
                return Some(format!(
                    "Node {id_text}: For Each variable \"{for_each_var}\" does not exist."
                ));
            }
        }
    }

    if let Some(edges) = config.get("edges") {
        if !edges.is_array() {
            return Some("spin.json is missing the edges array.".to_string());
        }
    }

    let order = topological_sort(
        &parse_nodes(config.get("nodes")),
        &parse_edges(config.get("edges")),
    );
    if order.len() != nodes.len() {
        return Some(
            "The flow is not a valid directed acyclic graph (DAG), please check the edges and retry."
                .to_string(),
        );
    }

    None
}

/// 把原始 JSON 的 `nodes` 解析为 [`SpinNode`] 列表（非法项按缺省值处理）
pub fn parse_nodes(value: Option<&Value>) -> Vec<SpinNode> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items.iter().map(parse_node).collect()
}

/// 把单个节点 JSON 解析为 [`SpinNode`]
pub fn parse_node(value: &Value) -> SpinNode {
    SpinNode {
        id: value.get("id").and_then(js_integer).unwrap_or(0),
        task: value
            .get("task")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        criteria: value
            .get("criteria")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(js_text).collect())
            .unwrap_or_default(),
        rollout: value.get("rollout").cloned().unwrap_or(Value::Null),
        for_each: value
            .get("forEach")
            .and_then(Value::as_str)
            .map(str::to_string),
        role: value.get("role").and_then(Value::as_str).map(str::to_string),
        skills: value
            .get("skills")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(js_text).collect())
            .unwrap_or_default(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// 把原始 JSON 的 `edges` 解析为 [`SpinEdge`] 列表。
///
/// 只有 `from` / `to` 都是数字的连线才会解析出来；是否落在 nodes 里由
/// [`topological_sort`] 自行过滤（对齐 TS 的 `idSet.has`）。
pub fn parse_edges(value: Option<&Value>) -> Vec<SpinEdge> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut edges = Vec::new();
    for item in items {
        let Some(from) = item.get("from").and_then(js_integer) else {
            continue;
        };
        let Some(to) = item.get("to").and_then(js_integer) else {
            continue;
        };
        edges.push(SpinEdge {
            from,
            to,
            from_side: item
                .get("fromSide")
                .and_then(Value::as_str)
                .map(str::to_string),
            to_side: item
                .get("toSide")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    edges
}

/// 对 nodes 做拓扑排序（Kahn），返回按执行顺序排列的 node id 列表。
///
/// 逐行对齐 `topologicalSort`：邻接表 / 入度按 node id 建表（重复 id 会重置），
/// 初始队列按 nodes 顺序入队，边只保留两端都在 nodes 里的。
pub fn topological_sort(nodes: &[SpinNode], edges: &[SpinEdge]) -> Vec<i64> {
    let mut id_set: Vec<i64> = Vec::new();
    for node in nodes {
        if !id_set.contains(&node.id) {
            id_set.push(node.id);
        }
    }

    let mut adj: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    let mut in_deg: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for node in nodes {
        adj.insert(node.id, Vec::new());
        in_deg.insert(node.id, 0);
    }
    for edge in edges {
        if !id_set.contains(&edge.from) || !id_set.contains(&edge.to) {
            continue;
        }
        adj.entry(edge.from).or_default().push(edge.to);
        *in_deg.entry(edge.to).or_insert(0) += 1;
    }

    let mut queue: Vec<i64> = Vec::new();
    for node in nodes {
        if in_deg.get(&node.id) == Some(&0) {
            queue.push(node.id);
        }
    }

    let mut sorted: Vec<i64> = Vec::new();
    while !queue.is_empty() {
        let id = queue.remove(0);
        sorted.push(id);
        for neighbor in adj.get(&id).cloned().unwrap_or_default() {
            let degree = in_deg.entry(neighbor).or_insert(0);
            *degree -= 1;
            if *degree == 0 {
                queue.push(neighbor);
            }
        }
    }

    sorted
}

/// 替换 Spin 变量引用（对齐 `substituteSpinVariables`）：
/// - `${KEY}` → `variables[KEY]`（KEY 为字母/数字/下划线组成的变量名）
/// - `$$` → 字面量 `$`（转义，且不会被当作变量前缀）
/// - 未匹配的 `${...}` 保持原样
pub fn substitute_spin_variables(text: &str, variables: Option<&Map<String, Value>>) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    // JS 用 '\u0000' 当哨兵：先保护 `$$`，替换完变量后把所有 `$` 与哨兵还原成 `$`
    const PLACEHOLDER: &str = "\u{0000}";
    let mut result = text.replace("$$", PLACEHOLDER);
    if let Some(variables) = variables {
        let mut keys: Vec<&String> = variables.keys().collect();
        // 长的键优先（稳定排序：等长时保持插入顺序）
        keys.sort_by(|a, b| b.len().cmp(&a.len()));
        for key in keys {
            if key.is_empty() || !is_valid_variable_name(key) {
                continue;
            }
            let value = match variables.get(key) {
                Some(Value::Null) | None => String::new(),
                Some(value) => util::js_string(value),
            };
            result = result.replace(&format!("${{{key}}}"), &value);
        }
    }
    result = result.replace('$', PLACEHOLDER);
    result.split(PLACEHOLDER).collect::<Vec<_>>().join("$")
}

/// 获取下一个未完成的节点（拓扑序中第一个未完成/未通过的）
pub fn get_next_node(config: &Value) -> Option<SpinNode> {
    let nodes = parse_nodes(config.get("nodes"));
    let edges = parse_edges(config.get("edges"));
    let order = topological_sort(&nodes, &edges);
    for id in order {
        // TS 是 `!meta || !meta.passed`（真值判定，不是严格的布尔判定）
        let passed = js_truthy(node_meta(config, id).and_then(|meta| meta.get("passed")));
        if !passed {
            return nodes.iter().find(|node| node.id == id).cloned();
        }
    }
    None
}

/// 规范化 rollout 执行次数：必须是 >=1 的整数，否则默认 1
pub fn normalize_rollout_count(value: &Value) -> i64 {
    match js_integer(value) {
        Some(value) if value >= 1 => value,
        _ => 1,
    }
}

/// 规范化已完成 rollout 数量：必须是 >=0 的整数，否则默认 0
pub fn normalize_rollout_passed(value: &Value) -> i64 {
    match js_integer(value) {
        Some(value) if value >= 0 => value,
        _ => 0,
    }
}

/// 将 For Each 变量值按行拆分（对齐 `splitForEachRows`）：
/// - 支持 CRLF / LF / CR 换行
/// - 每行 trim 后，空白行直接跳过，不参与迭代
pub fn split_for_each_rows(value: Option<&Value>) -> Vec<String> {
    let text = js_string_or_empty(value);
    let mut rows = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                rows.push(std::mem::take(&mut current));
            }
            '\n' => rows.push(std::mem::take(&mut current)),
            other => current.push(other),
        }
    }
    rows.push(current);
    rows.into_iter()
        .filter_map(|line| {
            let line = util::js_trim(&line);
            if line.is_empty() {
                None
            } else {
                Some(line.to_string())
            }
        })
        .collect()
}

/// 当前迭代信息（对齐 Loop.ts 的 row / rollout 计算）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpinProgress {
    pub rollout_count: i64,
    pub for_each_var: String,
    pub for_each_rows: Vec<String>,
    pub total_iterations: i64,
    pub completed_iterations: i64,
    pub current_row_index: i64,
    pub rollout_id: i64,
    pub current_row_value: String,
    pub iteration_label: String,
}

/// 计算节点当前的迭代进度（对齐 Loop.ts 326–352 行）。
///
/// For Each 优先级高于 rollout：每一行内先完成所有 rollout，再进入下一行。
/// 未配置 For Each 时按单行（`['']`）处理。
pub fn compute_progress(node: &SpinNode, config: &Value) -> SpinProgress {
    let rollout_count = normalize_rollout_count(&node.rollout);
    let for_each_var = node
        .for_each
        .as_deref()
        .map(util::js_trim)
        .unwrap_or("")
        .to_string();
    let for_each_rows = if for_each_var.is_empty() {
        vec![String::new()]
    } else {
        let value = config
            .get("variables")
            .and_then(Value::as_object)
            .and_then(|variables| variables.get(&for_each_var));
        split_for_each_rows(value)
    };
    let total_iterations = for_each_rows.len() as i64 * rollout_count;
    let completed_iterations = normalize_rollout_passed(
        node_meta(config, node.id)
            .and_then(|meta| meta.get("rolloutPassed"))
            .unwrap_or(&Value::Null),
    );
    let current_row_index = completed_iterations / rollout_count;
    let rollout_id = completed_iterations % rollout_count;
    let current_row_value = for_each_rows
        .get(current_row_index as usize)
        .cloned()
        .unwrap_or_default();
    let iteration_label = iteration_label(
        for_each_rows.len(),
        rollout_count,
        current_row_index,
        rollout_id,
    );
    SpinProgress {
        rollout_count,
        for_each_var,
        for_each_rows,
        total_iterations,
        completed_iterations,
        current_row_index,
        rollout_id,
        current_row_value,
        iteration_label,
    }
}

/// 迭代标签（对齐 Loop.ts 344–352 行）
pub fn iteration_label(
    rows_len: usize,
    rollout_count: i64,
    current_row_index: i64,
    rollout_id: i64,
) -> String {
    if rows_len > 1 && rollout_count > 1 {
        format!(
            " [row {}/{rows_len}, rollout {}/{}]",
            current_row_index + 1,
            rollout_id + 1,
            rollout_count
        )
    } else if rows_len > 1 {
        format!(" [row {}/{rows_len}]", current_row_index + 1)
    } else if rollout_count > 1 {
        format!(" [rollout {}/{}]", rollout_id + 1, rollout_count)
    } else {
        String::new()
    }
}

/// 构建 sub-agent prompt（对齐 `buildRunPrompt`）
pub fn build_run_prompt(
    node: &SpinNode,
    note: Option<&str>,
    skills_prompt: Option<&str>,
) -> String {
    let ac_list = node
        .criteria
        .iter()
        .map(|criteria| format!("- [ ] {criteria}"))
        .collect::<Vec<_>>()
        .join("\n");

    let previous_note_section = match note {
        Some(note) if !note.is_empty() => format!("\n### 上一轮反馈\n{note}\n"),
        _ => String::new(),
    };

    let skills_section = match skills_prompt {
        Some(prompt) if !util::js_trim(prompt).is_empty() => {
            format!("\n### 已加载的 Skills\n{prompt}\n")
        }
        _ => String::new(),
    };

    format!(
        "## 子任务: {task}\n\n\
         ### 验收条件\n\
         {ac_list}\n\
         {skills_section}\n\
         {previous_note_section}\n\
         ### 你的工作方式\n\n\
         1. 先阅读当前项目代码，了解现有结构\n\
         2. 实现该任务的所有功能\n\
         3. 确保所有验收条件都满足\n\n\
         ### 重要\n\n\
         - 只实现当前这一个子任务，不要做额外的功能\n\
         - 完成后用 `Reply` 工具发送执行反馈，针对每一条验收标准，描述下完成的程度，若未完成说明下遇到的问题。\n\
         - 如果遇到阻塞或未解决的问题，在反馈中说明原因\n\
         - Reply 消息中只包含反馈内容，不要包含其他文字或 markdown 标记",
        task = node.task,
    )
}

// ==================== 写入串行化 ====================

/// spin.json 写操作串行锁。
///
/// 写操作串行化：避免 SpinLoop 与
/// Spin Design webview 保存并发「读-改-写」时丢失更新（例如用户「清除结果」
/// 后被 Loop 回写覆盖），用进程级 `Mutex` 实现互斥。
static SPIN_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn spin_write_lock() -> MutexGuard<'static, ()> {
    SPIN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 写入 spin.json（串行化 + 先写临时文件再原子 rename，对齐 `writeSpinJson`）
#[cfg_attr(not(test), allow(dead_code))]
pub fn write_spin_json(cwd: &str, config: &Value) -> Result<(), String> {
    let _guard = spin_write_lock();
    write_spin_json_locked(cwd, config)
}



fn write_spin_json_locked(cwd: &str, config: &Value) -> Result<(), String> {
    // 确保项目对话目录存在（目录由 core 建；其中的 settings.json 由宿主写）
    let dir = config::ensure_project_conversation_dir(cwd)?;
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("serialize spin.json failed: {error}"))?;
    let path = dir.join(SPIN_FILE);
    let tmp_path = dir.join(format!("{SPIN_FILE}.{}.tmp", std::process::id()));
    if let Err(error) = std::fs::write(&tmp_path, content.as_bytes()) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("write {} failed: {error}", tmp_path.display()));
    }
    if let Err(error) = std::fs::rename(&tmp_path, &path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename {} failed: {error}", path.display()));
    }
    Ok(())
}

/// 更新某个节点的执行状态（串行化，避免并发读-改-写丢失更新）。
///
/// 合并语义逐行对齐 `updateNodeMeta`：保留 `prev` 的其它字段，覆盖
/// `passed` / `note`，最后铺 `extra`（`extra` 可覆盖前两者）。
///
/// @returns 是否写入成功
pub fn update_node_meta(
    cwd: &str,
    node_id: i64,
    passed: bool,
    note: Option<&str>,
    extra: Option<&Map<String, Value>>,
) -> bool {
    let _guard = spin_write_lock();
    let Some(mut config) = read_spin_json(cwd) else {
        return false;
    };
    if !config.is_object() {
        return false;
    }

    // `if (!config.meta) config.meta = {}`
    {
        let object = config.as_object_mut().unwrap();
        if !object.get("meta").map(Value::is_object).unwrap_or(false) {
            object.insert("meta".to_string(), Value::Object(Map::new()));
        }
    }

    let key = node_id.to_string();
    let mut merged = match config.get("meta").and_then(|meta| meta.get(&key)) {
        Some(Value::Object(prev)) => prev.clone(),
        _ => Map::new(),
    };
    merged.insert("passed".to_string(), Value::Bool(passed));
    merged.insert(
        "note".to_string(),
        Value::String(note.unwrap_or("").to_string()),
    );
    if let Some(extra) = extra {
        for (key, value) in extra {
            merged.insert(key.clone(), value.clone());
        }
    }

    match config.get_mut("meta").and_then(Value::as_object_mut) {
        Some(meta) => {
            meta.insert(key, Value::Object(merged));
        }
        None => return false,
    }

    write_spin_json_locked(cwd, &config).is_ok()
}

/// 自动检测项目状态（对齐 `detectProjectState`）：
/// - 文件不存在 → `init`
/// - JSON 非法或其它读取错误 → `invalid`
/// - 否则按 [`get_spin_design_issue`] 收敛到 `ready` 或该 issue
pub fn detect_project_state(cwd: &str) -> SpinProjectState {
    let path = match spin_json_path(cwd) {
        Ok(path) => path,
        Err(_) => return SpinProjectState::Invalid,
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return if error.kind() == std::io::ErrorKind::NotFound {
                SpinProjectState::Init
            } else {
                SpinProjectState::Invalid
            };
        }
    };
    let Ok(config) = serde_json::from_str::<Value>(&content) else {
        return SpinProjectState::Invalid;
    };
    match get_spin_design_issue(&config) {
        Some(issue) => SpinProjectState::from(issue),
        None => SpinProjectState::Ready,
    }
}

/// 依次加载节点勾选的 Skill，并拼接为 Prompt 片段（对齐 `loadNodeSkillsPrompt`）
pub fn load_node_skills_prompt(names: &[String], cwd: &str, session_id: &str) -> String {
    if names.is_empty() {
        return String::new();
    }

    let skills = skills::get_all_skills(cwd);
    let mut parts: Vec<String> = Vec::new();

    for name in names {
        let Some(skill) = skills.iter().find(|skill| skill.matches(name)) else {
            eprintln!("[core] SpinLoop: Skill '{name}' not found, skipping");
            continue;
        };

        let blocks = skill.prompt_for_command("");
        let text = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let final_content = skills::substitute_builtin_variables(
            &text,
            skill.skill_root.as_deref(),
            Some(session_id),
        );
        parts.push(format!("### {name}\n{final_content}"));
    }

    parts.join("\n\n")
}

// ==================== SpinJudger.ts ====================

/// SpinJudger 单次判断结果（对齐 `SpinJudgerResult`）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpinJudgerResult {
    pub accept: bool,
    pub raw_reply: String,
}

/// 构建验收判定的 system / user prompt（对齐 `SpinJudger.judge` 的提示词拼装）
pub fn build_judge_prompts(task: &str, criteria: &[String], reply: &str) -> (String, String) {
    let criteria_list = criteria
        .iter()
        .enumerate()
        .map(|(index, criteria)| format!("{}. {criteria}", index + 1))
        .collect::<Vec<_>>()
        .join("\n");

    let system_prompt = "你是一个严格的任务验收评审员。你的任务是根据验收标准判断子任务是否通过。\n只返回 JSON 格式：{\"accept\": true/false}\n不允许包含其他说明文字。".to_string();

    let user_prompt = format!(
        "子任务\"{task}\"已完成，以下是执行反馈：\n\n{reply}\n\n验收标准：\n{criteria_list}\n\n请根据验收标准判断是否通过。只返回JSON格式：{{\"accept\": true/false}}"
    );

    (system_prompt, user_prompt)
}

/// 从 LLM 回复中解析 `accept` 布尔值（对齐 `parseAccept`）。
///
/// 容错顺序（与 TS 完全一致）：
/// 1. 整段按 JSON 解析：是对象且有布尔 `accept` → 用它；否则直接 `false`（**不再兜底**）；
/// 2. JSON 解析失败时，提取第一个 `{...}` 块再解析；
/// 3. 仍失败时，把非字母字符去掉并转小写，恰为 `true` / `false` 才认。
pub fn parse_accept(text: &str) -> bool {
    let cleaned = util::js_trim(text);

    match serde_json::from_str::<Value>(cleaned) {
        Ok(parsed) => {
            if let Some(accept) = parsed.get("accept").and_then(Value::as_bool) {
                return accept;
            }
            return false;
        }
        Err(_) => {
            if let Some(block) = extract_json_block(cleaned) {
                if let Ok(parsed) = serde_json::from_str::<Value>(block) {
                    if let Some(accept) = parsed.get("accept").and_then(Value::as_bool) {
                        return accept;
                    }
                }
            }
        }
    }

    let letters: String = cleaned
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>()
        .to_lowercase();
    if letters == "true" {
        return true;
    }
    if letters == "false" {
        return false;
    }
    false
}

/// 用给定 LLM 配置做一次验收判定（对齐 `SpinJudger.judge`）。
///
/// `provider` 为 `None`（无可用 LLM 配置）时返回 `{accept:false, raw_reply:"(LLM call failed)"}`。
pub fn judge_with_provider(
    provider: Option<&config::ProviderConfig>,
    task: &str,
    criteria: &[String],
    reply: &str,
) -> SpinJudgerResult {
    let Some(provider) = provider else {
        return SpinJudgerResult {
            accept: false,
            raw_reply: "(LLM call failed)".to_string(),
        };
    };

    let (system_prompt, user_prompt) = build_judge_prompts(task, criteria, reply);
    let cancel = AtomicBool::new(false);
    let request = llm::LlmRequest {
        provider,
        system_prompt: &system_prompt,
        messages: &[json!({ "role": "user", "content": user_prompt })],
        tools: &[],
        session_id: "spin-judger",
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms: llm::DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: llm::DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };

    let mut raw_reply = String::new();
    let result = llm::stream(&request, &mut |event| match event {
        llm::LlmEvent::TextDelta(delta) => raw_reply.push_str(&delta),
        // `assistant` 事件用最后一个 text block **覆盖**累积文本
        llm::LlmEvent::AuthoritativeBlocks(blocks) => {
            if let Some(text) = blocks.iter().rev().find_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            }) {
                raw_reply = text.to_string();
            }
        }
        _ => {}
    });

    if let Err(error) = result {
        eprintln!("[core] SpinJudger: LLM judgment failed: {error}, defaulting to false");
        return SpinJudgerResult {
            accept: false,
            raw_reply: "(LLM call failed)".to_string(),
        };
    }

    let accept = parse_accept(&raw_reply);
    eprintln!(
        "[core] SpinJudger: Task \"{}...\" judged: {} | rawReply=\"{}\"",
        util::truncate_chars(task, 40),
        accept,
        util::truncate_chars(&raw_reply, 80)
    );
    SpinJudgerResult { accept, raw_reply }
}

// ==================== Runner.ts ====================

/// Spin 子代理的 Reply 指令（对齐 Runner.ts 的子代理 `## Communication` 前缀段）。
///
/// 注意：Rust 侧 `engine::create_sub_agent` 固定用通用的
/// `prompt::sub_agent_communication_section`，宿主若要注入这段 JSON 指令，可把它拼到
/// [`SpinHost::run_sub_agent`] 收到的 prompt 前，或覆盖子会话的 system prompt。
#[allow(dead_code)]
pub const SUB_AGENT_REPLY_INSTRUCTION: &str = "\n## Communication\nWhen you complete your task, use the **Reply** tool to send a JSON result to the conversation that created you.\n\nThe JSON format must be:\n```json\n{\"passes\": true/false, \"note\": \"brief summary of the result\"}\n```\n\n- `passes`: `true` for success, `false` for failure\n- `note`: brief explanation of what was accomplished or why it failed\n- Do not include any other text in the Reply message, only the JSON object without markdown formatting";

/// 子代理标题（对齐 `[Spin] Node {id}: {task}`）
///
/// 子代理创建入口尚未消费（见 [`SUB_AGENT_REPLY_INSTRUCTION`] 的说明）。
#[allow(dead_code)]
pub fn sub_agent_title(node: &SpinNode) -> String {
    format!("[Spin] Node {}: {}", node.id, node.task)
}

/// 子代理描述（对齐 `Task {seq}{label} - {task}`）
pub fn sub_agent_description(sequence: usize, iteration_label: &str, task: &str) -> String {
    format!("Task {sequence}{iteration_label} - {task}")
}

// ==================== Loop.ts ====================

/// 子代理执行请求（`SpinHost::run_sub_agent` 的入参）
#[derive(Clone, Debug)]
pub struct SpinSubAgentRequest {
    /// 子代理 prompt（[`build_run_prompt`] 的结果）
    pub prompt: String,
    /// 已做变量替换的节点（`task` / `criteria` 为替换后的值）
    pub node: SpinNode,
    /// 拓扑序号（从 1 开始）
    pub sequence: usize,
    /// 迭代标签（` [row 1/2, rollout 1/3]` 之类，可能为空）
    pub iteration_label: String,
}

/// SpinLoop 与引擎之间的回调边界。
///
/// 宿主（`engine::Core` 的适配层）只需实现这几个方法即可接线；`judge` /
/// `load_skills_prompt` / `push_message` / `provider` 都有默认实现，可按需覆盖。
pub trait SpinHost: Send + Sync {
    /// 起一个子代理执行 `request.prompt`，**阻塞等待**它的 Reply 内容。
    ///
    /// 对齐 `createSubAgent` + `waitForAgentReply`：
    /// - `Ok(reply)`：拿到 Reply（即使内容是 `Error: ...` 也照常返回，参与验收判定）；
    /// - `Err(_)`：执行被中止（对齐 `waitForAgentReply` 返回 `null`）→ 主循环停止。
    fn run_sub_agent(&self, request: SpinSubAgentRequest) -> Result<String, String>;

    /// 上报一条 CoreEvent（`spinDesignDataChanged` / `message` 等）
    fn emit_event(&self, event: Value);

    /// 用户是否已中止（父会话或当前子代理）
    fn is_aborted(&self) -> bool;

    /// 把一条 spin 进度消息交给宿主。
    ///
    /// 默认实现只发一条 `message` CoreEvent；宿主覆盖时应同时把消息追加到会话
    /// （对齐 TS 的 `engine.mutableMessages.push` + `appendMessage` 持久化）。
    fn push_message(&self, session_id: &str, role: &str, content: &str) {
        self.emit_transient_message(session_id, role, content);
    }

    /// 只上报一条瞬时 `message` CoreEvent，**不落盘**。
    ///
    /// 描述状态的通知（如「全部任务已完成」）不进会话历史：TS 侧对应
    /// `emitToUi` 而不 push `mutableMessages`，两边行为一致。
    fn emit_transient_message(&self, session_id: &str, role: &str, content: &str) {
        self.emit_event(json!({
            "type": "message",
            "sessionId": session_id,
            "data": { "role": role, "content": content },
        }));
    }

    /// 上报一条瞬时提示（键 + 参数，`docs/architecture/core-ui-separation.md` 第 4.9 节）。
    ///
    /// Core 不拼文案：只给键与参数，翻译与呈现由 UI 承担；提示不进会话历史。
    fn emit_notice(&self, session_id: &str, key: &str, params: Value, level: &str) {
        self.emit_event(json!({
            "type": "notice",
            "sessionId": session_id,
            "key": key,
            "params": params,
            "level": level,
        }));
    }

    /// 加载节点勾选的 Skills，拼成 prompt 片段（对齐 `loadNodeSkillsPrompt`）
    fn load_skills_prompt(&self, names: &[String], cwd: &str, session_id: &str) -> String {
        load_node_skills_prompt(names, cwd, session_id)
    }

    /// 验收判定（对齐 `SpinJudger.judge`）。默认用 [`SpinHost::provider`] 调 LLM。
    fn judge(&self, task: &str, criteria: &[String], reply: &str) -> SpinJudgerResult {
        judge_with_provider(self.provider().as_ref(), task, criteria, reply)
    }

    /// 验收判定使用的 LLM 配置。
    ///
    /// 默认取 `settings.json` 的 active provider（对齐 TS `callLLM` 不传
    /// `modelConfig` 时的口径）；宿主可覆盖为「会话实际生效的模型配置」。
    fn provider(&self) -> Option<config::ProviderConfig> {
        config::resolve_provider(None, None).ok()
    }
}

/// Spin 主循环的结束原因
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpinOutcome {
    /// 所有节点已完成
    Completed,
    /// 某节点连续失败达到上限，主动停止整个 Spin
    Stopped,
    /// 用户中止
    Aborted,
    /// 读取 / 校验 spin.json 失败，拒绝启动
    Failed(String),
}

/// Spin Design 主循环（对齐 `spinLoop`）
pub struct SpinLoop {
    host: Arc<dyn SpinHost>,
    cwd: String,
    session_id: String,
    abort: Arc<AtomicBool>,
    max_attempts: u32,
}

impl SpinLoop {
    /// 新建主循环（内部自建 abort 标志）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(
        host: Arc<dyn SpinHost>,
        cwd: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self::with_abort_flag(host, cwd, session_id, Arc::new(AtomicBool::new(false)))
    }

    /// 用调用方提供的 abort 标志新建主循环（宿主可让子代理等待逻辑共用同一标志）
    pub fn with_abort_flag(
        host: Arc<dyn SpinHost>,
        cwd: impl Into<String>,
        session_id: impl Into<String>,
        abort: Arc<AtomicBool>,
    ) -> Self {
        Self {
            host,
            cwd: cwd.into(),
            session_id: session_id.into(),
            abort,
            max_attempts: MAX_ATTEMPTS,
        }
    }

    /// 覆盖连续失败上限（默认 [`MAX_ATTEMPTS`]，主要供测试用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set_max_attempts(&mut self, max_attempts: u32) {
        self.max_attempts = max_attempts;
    }

    /// 在**当前线程**跑主循环（阻塞）
    pub fn run(&self) -> SpinOutcome {
        let mut current_node_id: Option<i64> = None;
        let mut attempts: u32 = 0;

        loop {
            // 用户中止后立即停止主循环，不再读取/执行后续节点
            if self.is_aborted() {
                return SpinOutcome::Aborted;
            }

            // 1. 读取 spin.json，获取下一个未完成的节点
            let Some(config) = read_spin_json(&self.cwd) else {
                // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
                let message = "Cannot read spin.json: file is missing or invalid JSON.".to_string();
                self.host.push_message(&self.session_id, "user", &message);
                return SpinOutcome::Failed(message);
            };

            if let Some(error) = validate_spin_design(&config) {
                self.host.push_message(&self.session_id, "user", &error);
                return SpinOutcome::Failed(error);
            }

            let Some(next) = get_next_node(&config) else {
                // 瞬时状态通知：只上报、不落盘（对齐 TS 侧只 emitToUi 的写法）。
                // 文案键化，翻译在 UI（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
                self.host.emit_notice(
                    &self.session_id,
                    crate::core_text::SPIN_ALL_COMPLETED,
                    json!({}),
                    "info",
                );
                return SpinOutcome::Completed;
            };

            // 拓扑序号
            let nodes = parse_nodes(config.get("nodes"));
            let edges = parse_edges(config.get("edges"));
            let order = topological_sort(&nodes, &edges);
            let current_seq = order
                .iter()
                .position(|id| *id == next.id)
                .map(|index| index + 1)
                .unwrap_or(0);

            let progress = compute_progress(&next, &config);
            if progress.completed_iterations >= progress.total_iterations {
                // 数据异常兜底；For Each 变量没有可遍历行时也直接完成该节点
                if !progress.for_each_var.is_empty() && progress.for_each_rows.is_empty() {
                    eprintln!(
                        "[core] SpinLoop: Task {current_seq}: For Each variable \"{}\" has no rows, marking as passed",
                        progress.for_each_var
                    );
                }
                let extra = rollout_passed_extra(progress.total_iterations);
                update_node_meta(&self.cwd, next.id, true, Some(""), Some(&extra));
                self.refresh_designer();
                continue;
            }

            // 重置或递增尝试计数
            if current_node_id != Some(next.id) {
                current_node_id = Some(next.id);
                attempts = 0;
            }

            if attempts >= self.max_attempts {
                // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
                let stop_message = format!(
                    "Task {current_seq} failed after {} attempts, stopping the entire Spin mode",
                    self.max_attempts
                );
                self.host.push_message(&self.session_id, "user", &stop_message);
                update_node_meta(
                    &self.cwd,
                    next.id,
                    false,
                    Some(&format!("failed after {} attempts", self.max_attempts)),
                    None,
                );
                return SpinOutcome::Stopped;
            }

            attempts += 1;

            // 获取之前的 note（如果有）；同一节点失败重试时作为上一轮反馈
            let prev_note = node_meta(&config, next.id)
                .and_then(|meta| meta.get("note"))
                .and_then(Value::as_str)
                .filter(|note| !note.is_empty())
                .map(str::to_string);

            let skills_prompt =
                self.host
                    .load_skills_prompt(&next.skills, &self.cwd, &self.session_id);

            // 解析用户变量，并注入内置变量 ${ROLLOUT_ID} / ${LINE}；
            // For Each 生效时，用当前行覆盖被遍历的变量
            let spin_variables = spin_variables_for(&config, &progress);
            let resolved_task = substitute_spin_variables(&next.task, Some(&spin_variables));

            // rollout > 1 或填写 For Each 时验收标准不可用：不注入 prompt，也不进行结果验收
            let use_criteria = progress.rollout_count <= 1 && progress.for_each_var.is_empty();
            let resolved_criteria: Vec<String> = if use_criteria {
                next.criteria
                    .iter()
                    .map(|criteria| substitute_spin_variables(criteria, Some(&spin_variables)))
                    .filter(|criteria| !util::js_trim(criteria).is_empty())
                    .collect()
            } else {
                Vec::new()
            };

            // 没有验收条件时不会重试，因此不展示 [attempt/MAX_ATTEMPTS]
            let has_acceptance_criteria = !resolved_criteria.is_empty();
            let attempt_prefix = if has_acceptance_criteria {
                format!("[{attempts}/{}]", self.max_attempts)
            } else {
                String::new()
            };
            let attempt_suffix = if has_acceptance_criteria {
                format!(" ({attempts}/{})", self.max_attempts)
            } else {
                String::new()
            };

            let mut resolved_node = next.clone();
            resolved_node.task = resolved_task.clone();
            resolved_node.criteria = resolved_criteria.clone();
            let node_prompt = build_run_prompt(
                &resolved_node,
                prev_note.as_deref(),
                Some(&skills_prompt),
            );

            eprintln!(
                "[core] SpinLoop: Executing Task {current_seq}{} - {resolved_task}{attempt_suffix}",
                progress.iteration_label
            );

            // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
            let start_message = format!(
                "{attempt_prefix}{} Starting: Task {current_seq} - {resolved_task}",
                progress.iteration_label
            );
            self.host.push_message(&self.session_id, "user", &start_message);

            // 执行子代理
            let request = SpinSubAgentRequest {
                prompt: node_prompt,
                node: resolved_node,
                sequence: current_seq,
                iteration_label: progress.iteration_label.clone(),
            };
            let reply = match self.host.run_sub_agent(request) {
                Ok(reply) => reply,
                Err(error) => {
                    if self.is_aborted() {
                        return SpinOutcome::Aborted;
                    }
                    // 非中止的失败：与 TS 把异常转成 `Error: ${err}` 一致，作为反馈参与判定
                    format!("Error: {error}")
                }
            };

            // 判断是否通过；没有验收标准时直接通过，不调用 LLM 评审
            let accept = if resolved_criteria.is_empty() {
                true
            } else {
                // 先将 sub-agent 的 note 写入 meta（暂标记为未通过，等 LLM 判断）
                update_node_meta(&self.cwd, next.id, false, Some(&reply), None);
                self.host
                    .judge(&resolved_task, &resolved_criteria, &reply)
                    .accept
            };

            // 更新最终结果到 meta：只有最后一个迭代通过时才把节点标记为完成；
            // 中间的迭代通过后清空 note，避免把上一次成功反馈当作下一次迭代的“上一轮反馈”
            let next_completed = if accept {
                progress.completed_iterations + 1
            } else {
                progress.completed_iterations
            };
            let node_passed = accept && next_completed >= progress.total_iterations;
            let meta_note = if accept && !node_passed {
                ""
            } else {
                reply.as_str()
            };
            let extra = rollout_passed_extra(next_completed);
            update_node_meta(
                &self.cwd,
                next.id,
                node_passed,
                Some(meta_note),
                Some(&extra),
            );

            // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
            let result_message = format!(
                "{attempt_prefix}{} {}: Task {current_seq} - {resolved_task}",
                progress.iteration_label,
                if accept { "Passed" } else { "Failed" }
            );
            self.host
                .push_message(&self.session_id, "user", &result_message);

            // 本节点已完成：立刻刷新设计器页面
            if node_passed {
                self.refresh_designer();
            }

            if !accept {
                continue; // 重试当前 rollout
            }

            attempts = 0;
        }
    }

    /// 起一个独立线程跑主循环，返回可 abort / join 的句柄
    ///
    /// 宿主目前固定在当前线程同步跑 [`SpinLoop::run`]，该入口暂未接入。
    #[allow(dead_code)]
    pub fn spawn(self) -> SpinHandle {
        let abort = Arc::clone(&self.abort);
        let join = std::thread::spawn(move || self.run());
        SpinHandle { abort, join }
    }

    fn is_aborted(&self) -> bool {
        self.abort.load(Ordering::Relaxed) || self.host.is_aborted()
    }

    /// 刷新已打开的 Spin 设计器（`spinDesignDataChanged`）
    fn refresh_designer(&self) {
        self.host
            .emit_event(json!({ "type": "spinDesignDataChanged" }));
    }
}

/// [`SpinLoop::spawn`] 返回的句柄（线程化执行入口暂未接入，见该函数说明）
#[cfg_attr(not(test), allow(dead_code))]
pub struct SpinHandle {
    abort: Arc<AtomicBool>,
    join: std::thread::JoinHandle<SpinOutcome>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl SpinHandle {
    /// 请求中止（主循环会在下一个检查点退出）
    pub fn abort(&self) {
        self.abort.store(true, Ordering::Relaxed);
    }

    /// 阻塞等待主循环结束
    pub fn join(self) -> SpinOutcome {
        self.join
            .join()
            .unwrap_or_else(|_| SpinOutcome::Failed("spin loop thread panicked".to_string()))
    }
}

/// 构造带 `rolloutPassed` 的 meta extra
fn rollout_passed_extra(value: i64) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("rolloutPassed".to_string(), json!(value));
    extra
}

/// 构造替换用的变量表：用户变量 + 内置变量 + For Each 当前行覆盖
fn spin_variables_for(config: &Value, progress: &SpinProgress) -> Map<String, Value> {
    let mut variables = config
        .get("variables")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    variables.insert(
        "ROLLOUT_ID".to_string(),
        Value::String(progress.rollout_id.to_string()),
    );
    variables.insert(
        "LINE".to_string(),
        Value::String(if progress.for_each_var.is_empty() {
            String::new()
        } else {
            progress.current_row_value.clone()
        }),
    );
    if !progress.for_each_var.is_empty() {
        variables.insert(
            progress.for_each_var.clone(),
            Value::String(progress.current_row_value.clone()),
        );
    }
    variables
}

// ==================== 工具函数 ====================

/// JS 数值字面量（含 `3.0`）→ 整数；非数字 / 非整数 / 非有限值返回 `None`
fn js_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    Some(number as i64)
}

/// JS `String(value)`（用于 criteria / skills 等元素；null 已在调用处排除）
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => util::js_string(other),
    }
}

/// JS 真值判定（`!value` 的反面）：`0` / `NaN` / `''` / `null` / `undefined` 为假
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => {
            number.as_f64().map(|value| value != 0.0).unwrap_or(true)
        }
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// JS `String(value ?? '')`：`null` / 缺省都当空串
fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => util::js_string(value),
    }
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`
fn is_valid_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// 提取第一个 `{...}` 块（对齐 `/\{(?:[^{}]|"[^"]*")*\}/`）。
///
/// TS 正则里 `[^{}]` 会先匹配到引号，`"[^"]*"` 分支永远不可达，因此等价于
/// 「第一个不嵌套 `{}` 的 `{...}`」；字符串内部出现 `}` 也会提前截断（与 TS 一致）。
fn extract_json_block(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'{' {
            let start = index;
            let mut cursor = index + 1;
            let mut end: Option<usize> = None;
            while cursor < bytes.len() {
                match bytes[cursor] {
                    b'}' => {
                        end = Some(cursor);
                        break;
                    }
                    b'{' => break,
                    _ => cursor += 1,
                }
            }
            if let Some(end) = end {
                return Some(&text[start..=end]);
            }
            index = cursor;
            continue;
        }
        index += 1;
    }
    None
}

#[cfg(test)]
#[path = "spin_tests.rs"]
mod tests;
