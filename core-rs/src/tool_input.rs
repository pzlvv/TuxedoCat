//! 工具入参的 schema 校验（Zod `inputSchema.safeParse` 口径）。
//!
//! 执行前先做 schema 校验，失败时产出 `InputValidationError: <zod issues JSON>` 并跳过该工具。
//! 这里逐字复刻
//! 7 个内置工具 schema 的校验结果：错误文案（`JSON.stringify(issues, null, 2)`）与
//! 校验通过后的规范化数据（`coerce` / `default` 的产物）都与 TS 一致。
//!
//! 复刻范围（对应 `src/core/tools/*/Types.ts` 与各工具内联 schema）：
//! - `z.strictObject`：多字段报 `unrecognized_keys`；
//! - `z.string()` / `.min(1, msg)`；
//! - `z.coerce.number().int().nonnegative()/.positive()`（含 NaN / Infinity / safeint 文案）；
//! - `z.coerce.boolean()`；
//! - `z.enum([...])`；
//! - `z.array(item)` + 非严格 `z.object` 的 Todo 项；
//! - Edit 的 `z.union([boolean, string.transform(...)]).optional().default(false)`。
//!
//! 只覆盖上述构造；不追求通用 Zod 运行时（其余工具/字段未迁入，见 TODO）。

use serde_json::{json, Map, Value};

/// JS `Number.MAX_SAFE_INTEGER`
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// 数值字段的取值范围约束（对应 `.nonnegative()` / `.positive()`）
#[derive(Clone, Copy)]
enum Range {
    NonNegative,
    Positive,
}

/// 单个字段的校验种类
enum Kind<'a> {
    /// 字符串；可选 `min`（长度下限 + 自定义错误文案）
    Str(Option<(usize, &'a str)>),
    /// `z.coerce.number().int()...`
    CoerceInt(Range),
    /// `z.coerce.boolean()`
    CoerceBool,
    /// `z.boolean()`（不做 coerce）
    Bool,
    /// `z.enum([...])`
    Enum(&'a [&'a str]),
    /// Edit 的 `replace_all`：`z.union([boolean, string.transform])`
    ReplaceAll,
    /// TodoWrite 的 `todos`：`z.array(z.object({...}))`
    TodoArray,
    /// AskUserQuestion 的 `questions`：`z.array(z.strictObject({...})).min(1).max(9)`
    QuestionArray,
    /// AskUserQuestion 单题的 `options`：`z.array(z.strictObject({...}))`
    OptionsArray,
}

struct Field<'a> {
    name: &'a str,
    required: bool,
    kind: Kind<'a>,
}

/// 工具入参 schema 校验。
///
/// - `Ok(value)`：校验通过后的规范化数据（含 coerce / default 产物）。
/// - `Err(message)`：zod `error.message`（issues 的 2 空格缩进 JSON 文本），
///   调用方拼成 `InputValidationError: {message}`。
///
/// 未迁入的工具（非 7 个内置工具）直接原样返回，交由 `is_known` / 权限层处理。
pub fn parse_input(tool: &str, input: &Value) -> Result<Value, String> {
    let result = match tool {
        "Read" => validate_object(input, &read_fields(), true, &[]),
        "Write" => validate_object(input, &write_fields(), true, &[]),
        "Edit" => validate_object(input, &edit_fields(), true, &[]),
        "Bash" => validate_object(input, &bash_fields(), true, &[]),
        "Glob" => validate_object(input, &glob_fields(), true, &[]),
        "Grep" => validate_object(input, &grep_fields(), true, &[]),
        "TodoWrite" => validate_object(input, &todo_fields(), true, &[]),
        "AskUserQuestion" => validate_object(input, &ask_user_fields(), true, &[]),
        "Agent" => validate_object(input, &agent_fields(), true, &[]),
        "Reply" => validate_object(input, &reply_fields(), true, &[]),
        _ => return Ok(input.clone()),
    };
    match result {
        Ok(value) => Ok(value),
        Err(issues) => Err(pretty_issues(&issues)),
    }
}

// ==================== schema 定义 ====================

fn read_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "file_path", required: true, kind: Kind::Str(None) },
        Field { name: "offset", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "limit", required: false, kind: Kind::CoerceInt(Range::Positive) },
        Field { name: "sheet", required: false, kind: Kind::Str(None) },
    ]
}

fn write_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "file_path", required: true, kind: Kind::Str(None) },
        Field { name: "content", required: true, kind: Kind::Str(None) },
    ]
}

fn edit_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "file_path", required: true, kind: Kind::Str(None) },
        Field { name: "old_string", required: true, kind: Kind::Str(None) },
        Field { name: "new_string", required: true, kind: Kind::Str(None) },
        Field { name: "replace_all", required: false, kind: Kind::ReplaceAll },
        Field { name: "offset", required: false, kind: Kind::CoerceInt(Range::Positive) },
        Field { name: "limit", required: false, kind: Kind::CoerceInt(Range::Positive) },
    ]
}

fn bash_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "command", required: true, kind: Kind::Str(None) },
        Field { name: "description", required: false, kind: Kind::Str(None) },
        Field { name: "cwd", required: false, kind: Kind::Str(None) },
        Field { name: "run_in_background", required: false, kind: Kind::CoerceBool },
    ]
}

fn glob_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "pattern", required: true, kind: Kind::Str(None) },
        Field { name: "path", required: false, kind: Kind::Str(None) },
    ]
}

fn grep_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "pattern", required: true, kind: Kind::Str(None) },
        Field { name: "path", required: false, kind: Kind::Str(None) },
        Field { name: "glob", required: false, kind: Kind::Str(None) },
        Field { name: "output_mode", required: false, kind: Kind::Enum(&["content", "files_with_matches", "count"]) },
        Field { name: "-B", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "-A", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "-C", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "context", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "-n", required: false, kind: Kind::CoerceBool },
        Field { name: "-i", required: false, kind: Kind::CoerceBool },
        Field { name: "type", required: false, kind: Kind::Str(None) },
        Field { name: "head_limit", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "offset", required: false, kind: Kind::CoerceInt(Range::NonNegative) },
        Field { name: "multiline", required: false, kind: Kind::CoerceBool },
    ]
}

fn todo_fields() -> Vec<Field<'static>> {
    vec![Field { name: "todos", required: true, kind: Kind::TodoArray }]
}

fn ask_user_fields() -> Vec<Field<'static>> {
    vec![Field { name: "questions", required: true, kind: Kind::QuestionArray }]
}

fn agent_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "prompt", required: true, kind: Kind::Str(None) },
        Field { name: "description", required: false, kind: Kind::Str(None) },
        // 合法名单单一落点在 `tools::SUB_AGENT_ROLES`（specs/020 FR-001）；
        // 多值后 zod 对齐文案走 `Invalid option: expected one of ...` 分支
        Field { name: "agentRole", required: true, kind: Kind::Enum(crate::tools::SUB_AGENT_ROLES) },
        // specs/023：目标工作区代理身份；缺省 = 当前策略。空串在 run_agent 里拒绝。
        Field { name: "target", required: false, kind: Kind::Str(None) },
    ]
}

fn reply_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "message", required: true, kind: Kind::Str(None) },
        Field { name: "targetSessionId", required: false, kind: Kind::Str(None) },
    ]
}

/// AskUserQuestion 单题：`z.strictObject({ id, question, header?, options?, multi_select? })`
fn question_item_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "id", required: true, kind: Kind::Str(None) },
        Field { name: "question", required: true, kind: Kind::Str(None) },
        Field { name: "header", required: false, kind: Kind::Str(None) },
        Field { name: "options", required: false, kind: Kind::OptionsArray },
        Field { name: "multi_select", required: false, kind: Kind::Bool },
    ]
}

/// AskUserQuestion 选项项：`z.strictObject({ label: z.string(), description: z.string().optional() })`
fn choice_item_fields() -> Vec<Field<'static>> {
    vec![
        Field { name: "label", required: true, kind: Kind::Str(None) },
        Field { name: "description", required: false, kind: Kind::Str(None) },
    ]
}

// ==================== 通用对象校验 ====================

fn validate_object(
    input: &Value,
    fields: &[Field<'_>],
    strict: bool,
    base_path: &[Value],
) -> Result<Value, Vec<Value>> {
    let Value::Object(map) = input else {
        return Err(vec![invalid_type(
            "object",
            None,
            parsed_type(input),
            None,
            Value::Array(base_path.to_vec()),
        )]);
    };

    let mut issues: Vec<Value> = Vec::new();
    let mut out = Map::new();
    for field in fields {
        let path = path_with(base_path, field.name);
        match map.get(field.name) {
            None => {
                if field.required {
                    issues.push(missing_required_issue(&field.kind, path));
                } else if matches!(field.kind, Kind::ReplaceAll) {
                    // Edit 的 `replace_all` 带 `.default(false)`：缺省时补默认值
                    out.insert(field.name.to_string(), Value::Bool(false));
                }
            }
            Some(value) => match validate_kind(&field.kind, value, &path) {
                Ok(value) => {
                    out.insert(field.name.to_string(), value);
                }
                Err(mut errs) => issues.append(&mut errs),
            },
        }
    }

    if strict {
        let unknown: Vec<String> = map
            .keys()
            .filter(|key| !fields.iter().any(|field| field.name == key.as_str()))
            .cloned()
            .collect();
        if !unknown.is_empty() {
            issues.push(unrecognized_keys_issue(&unknown, base_path));
        }
    }

    if issues.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(issues)
    }
}

fn missing_required_issue(kind: &Kind<'_>, path: Value) -> Value {
    // 缺省的 `z.enum` 走的是 `invalid_value`（不是 `invalid_type`）：
    // `{ code: "invalid_value", values: [...], path, message: 'Invalid input: expected "Master"' }`
    if let Kind::Enum(values) = kind {
        return invalid_value_issue(values, path);
    }
    let expected = match kind {
        Kind::TodoArray | Kind::QuestionArray | Kind::OptionsArray => "array",
        Kind::Bool => "boolean",
        _ => "string",
    };
    invalid_type(expected, None, "undefined", None, path)
}

fn validate_kind(kind: &Kind<'_>, value: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    match kind {
        Kind::Str(min) => {
            let Value::String(text) = value else {
                return Err(vec![invalid_type(
                    "string",
                    None,
                    parsed_type(value),
                    None,
                    path.clone(),
                )]);
            };
            if let Some((minimum, message)) = min {
                if utf16_len(text) < *minimum {
                    return Err(vec![too_small_string(*minimum, message, path.clone())]);
                }
            }
            Ok(value.clone())
        }
        Kind::CoerceInt(range) => coerce_int(value, *range, path),
        Kind::CoerceBool => Ok(Value::Bool(js_truthy(value))),
        Kind::Bool => check_bool(value, path),
        Kind::Enum(values) => check_enum(value, values, path),
        Kind::ReplaceAll => check_replace_all(value, path),
        Kind::TodoArray => check_todos(value, path),
        Kind::QuestionArray => check_questions(value, path),
        Kind::OptionsArray => check_options(value, path),
    }
}

// ==================== 各类型校验 ====================

fn coerce_int(value: &Value, range: Range, path: &Value) -> Result<Value, Vec<Value>> {
    let number = js_number(value);
    if number.is_nan() {
        return Err(vec![invalid_type(
            "number",
            None,
            "NaN",
            Some("NaN"),
            path.clone(),
        )]);
    }
    if number.is_infinite() {
        // zod：message 用 `parsedType(input)`（Infinity 仍是 number），但 `received` 记 "Infinity"。
        let received = if number > 0.0 { "Infinity" } else { "-Infinity" };
        return Err(vec![invalid_type(
            "number",
            None,
            "number",
            Some(received),
            path.clone(),
        )]);
    }

    let mut issues: Vec<Value> = Vec::new();
    if number.fract() != 0.0 {
        // `.int()` 失败即中止后续 range 检查（zod 的 int 校验是 abort 型）
        return Err(vec![invalid_type(
            "int",
            Some("safeint"),
            "number",
            None,
            path.clone(),
        )]);
    }
    if number > MAX_SAFE_INTEGER {
        issues.push(too_big_int(MAX_SAFE_INTEGER as i64, path));
    } else if number < -MAX_SAFE_INTEGER {
        issues.push(too_small_int(-MAX_SAFE_INTEGER as i64, path));
    }
    match range {
        Range::NonNegative => {
            if number < 0.0 {
                issues.push(too_small_number(0, true, path));
            }
        }
        Range::Positive => {
            if number <= 0.0 {
                issues.push(too_small_number(0, false, path));
            }
        }
    }

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(Value::Number(serde_json::Number::from(number as i64)))
}

fn check_enum(value: &Value, values: &[&str], path: &Value) -> Result<Value, Vec<Value>> {
    if let Value::String(text) = value {
        if values.contains(&text.as_str()) {
            return Ok(value.clone());
        }
    }
    Err(vec![invalid_value_issue(values, path.clone())])
}

fn check_replace_all(value: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    match value {
        Value::Bool(_) => Ok(value.clone()),
        Value::String(text) => Ok(Value::Bool(resolve_replace_all_str(text))),
        other => Err(vec![invalid_union_issue(parsed_type(other), path.clone())]),
    }
}

fn check_todos(value: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    let Value::Array(items) = value else {
        return Err(vec![invalid_type(
            "array",
            None,
            parsed_type(value),
            None,
            path.clone(),
        )]);
    };
    let mut issues: Vec<Value> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let item_path = path_index(path, index);
        match validate_todo_item(item, &item_path) {
            Ok(value) => out.push(value),
            Err(mut errs) => issues.append(&mut errs),
        }
    }
    if issues.is_empty() {
        Ok(Value::Array(out))
    } else {
        Err(issues)
    }
}

/// `z.boolean()`：不做 coerce，只接受 JSON boolean。
fn check_bool(value: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    match value {
        Value::Bool(_) => Ok(value.clone()),
        _ => Err(vec![invalid_type(
            "boolean",
            None,
            parsed_type(value),
            None,
            path.clone(),
        )]),
    }
}

/// AskUserQuestion 的 `questions`：`z.array(z.strictObject({...})).min(1).max(9)`。
///
/// zod 先逐项校验（严格对象：多余字段报 `unrecognized_keys`），再检查数组长度上下限；
/// 因此长度越界时错误排在逐项错误之后（见 `toolInputValidation.json` 的用例）。
fn check_questions(value: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    let Value::Array(items) = value else {
        return Err(vec![invalid_type(
            "array",
            None,
            parsed_type(value),
            None,
            path.clone(),
        )]);
    };
    let fields = question_item_fields();
    let mut issues: Vec<Value> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let mut item_base: Vec<Value> = path.as_array().cloned().unwrap_or_default();
        item_base.push(Value::Number(serde_json::Number::from(index as u64)));
        match validate_object(item, &fields, true, &item_base) {
            Ok(value) => out.push(value),
            Err(mut errs) => issues.append(&mut errs),
        }
    }
    if items.is_empty() {
        issues.push(too_small_array(1, path.clone()));
    } else if items.len() > 9 {
        issues.push(too_big_array(9, path.clone()));
    }
    let mut ids = std::collections::HashSet::new();
    for item in &out {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            if !ids.insert(id.to_string()) {
                issues.push(custom_issue(
                    path.clone(),
                    "Question ids must be unique within one call",
                ));
            }
        }
    }
    if issues.is_empty() {
        Ok(Value::Array(out))
    } else {
        Err(issues)
    }
}

/// 单题的 `options`：空数组合法（等价于省略），非空时 1–9；同题 label 必须唯一。
fn check_options(value: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    let Value::Array(items) = value else {
        return Err(vec![invalid_type(
            "array",
            None,
            parsed_type(value),
            None,
            path.clone(),
        )]);
    };
    let fields = choice_item_fields();
    let mut issues: Vec<Value> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let mut item_base: Vec<Value> = path.as_array().cloned().unwrap_or_default();
        item_base.push(Value::Number(serde_json::Number::from(index as u64)));
        match validate_object(item, &fields, true, &item_base) {
            Ok(value) => out.push(value),
            Err(mut errs) => issues.append(&mut errs),
        }
    }
    if !items.is_empty() && items.len() > 9 {
        issues.push(too_big_array(9, path.clone()));
    }
    let mut labels = std::collections::HashSet::new();
    for item in &out {
        if let Some(label) = item.get("label").and_then(Value::as_str) {
            if !labels.insert(label.to_string()) {
                issues.push(custom_issue(
                    path.clone(),
                    "Option labels must be unique within one question",
                ));
            }
        }
    }
    if issues.is_empty() {
        Ok(Value::Array(out))
    } else {
        Err(issues)
    }
}

fn custom_issue(path: Value, message: &str) -> Value {
    issue(vec![
        ("code", json!("custom")),
        ("path", path),
        ("message", json!(message)),
    ])
}

/// 非严格 `z.object({ content, status, activeForm })`（多余字段被忽略）
fn validate_todo_item(item: &Value, path: &Value) -> Result<Value, Vec<Value>> {
    let Value::Object(map) = item else {
        return Err(vec![invalid_type(
            "object",
            None,
            parsed_type(item),
            None,
            path.clone(),
        )]);
    };
    let mut issues: Vec<Value> = Vec::new();
    let mut out = Map::new();

    // content：必填 string().min(1, 'Content cannot be empty')
    let content_path = path_push(path, "content");
    match map.get("content") {
        None => issues.push(invalid_type("string", None, "undefined", None, content_path)),
        Some(value) => match validate_kind(&Kind::Str(Some((1, "Content cannot be empty"))), value, &content_path) {
            Ok(value) => {
                out.insert("content".to_string(), value);
            }
            Err(mut errs) => issues.append(&mut errs),
        },
    }

    // status：可选 enum，默认 'pending'
    let status_path = path_push(path, "status");
    match map.get("status") {
        None => {
            out.insert("status".to_string(), json!("pending"));
        }
        Some(value) => {
            match check_enum(value, &["pending", "in_progress", "completed"], &status_path) {
                Ok(value) => {
                    out.insert("status".to_string(), value);
                }
                Err(mut errs) => issues.append(&mut errs),
            }
        }
    }

    // activeForm：必填 string().min(1, 'Active form cannot be empty')
    let active_path = path_push(path, "activeForm");
    match map.get("activeForm") {
        None => issues.push(invalid_type("string", None, "undefined", None, active_path)),
        Some(value) => {
            match validate_kind(&Kind::Str(Some((1, "Active form cannot be empty"))), value, &active_path) {
                Ok(value) => {
                    out.insert("activeForm".to_string(), value);
                }
                Err(mut errs) => issues.append(&mut errs),
            }
        }
    }

    if issues.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(issues)
    }
}

// ==================== JS 语义辅助 ====================

fn parsed_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// JS `Boolean(value)`
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `Number(value)`
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number_from_str(text),
        Value::Array(items) => js_number_from_str(&js_array_string(items)),
        Value::Object(_) => f64::NAN,
    }
}

/// JS `String(array)`：各元素 `String()` 后用 `,` 连接（null/undefined 变空串）
fn js_array_string(items: &[Value]) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            Value::Bool(value) => value.to_string(),
            Value::Number(number) => number.to_string(),
            Value::String(text) => text.clone(),
            Value::Array(inner) => js_array_string(inner),
            Value::Object(_) => "[object Object]".to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// JS `Number(string)`：空白/空串为 0，支持 Infinity 与 0x/0b/0o，非法为 NaN。
fn js_number_from_str(text: &str) -> f64 {
    // JS `Number(string)` 去的是 ECMAScript 空白（含 U+FEFF、不含 U+0085）
    let trimmed = crate::util::js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(rest) = strip_prefix_ci(trimmed, "0x") {
        return parse_radix(rest, 16);
    }
    if let Some(rest) = strip_prefix_ci(trimmed, "0b") {
        return parse_radix(rest, 2);
    }
    if let Some(rest) = strip_prefix_ci(trimmed, "0o") {
        return parse_radix(rest, 8);
    }
    if is_js_decimal(trimmed) {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&text[prefix.len()..])
    } else {
        None
    }
}

fn parse_radix(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value: f64 = 0.0;
    for ch in digits.chars() {
        let Some(digit) = ch.to_digit(radix) else {
            return f64::NAN;
        };
        value = value * radix as f64 + digit as f64;
    }
    value
}

/// JS 十进制字面量（Number() 接受的字符串形态，不含 hex/oct/bin 前缀）
fn is_js_decimal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
        index += 1;
    }
    let mut digits_before = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        digits_before += 1;
        index += 1;
    }
    let mut digits_after = 0;
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            digits_after += 1;
            index += 1;
        }
    }
    if digits_before == 0 && digits_after == 0 {
        return false;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let mut exponent_digits = 0;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            exponent_digits += 1;
            index += 1;
        }
        if exponent_digits == 0 {
            return false;
        }
    }
    index == bytes.len()
}

/// Edit `replace_all` 的字符串感知转换（对齐 schema 里的 `transform`）
fn resolve_replace_all_str(text: &str) -> bool {
    text != "false" && !crate::util::js_trim(text).is_empty()
}

// ==================== issue 构造（字段顺序与 zod 一致） ====================

fn path_with(base: &[Value], key: &str) -> Value {
    let mut path = base.to_vec();
    path.push(Value::String(key.to_string()));
    Value::Array(path)
}

fn path_push(base: &Value, key: &str) -> Value {
    let mut path = base.as_array().cloned().unwrap_or_default();
    path.push(Value::String(key.to_string()));
    Value::Array(path)
}

fn path_index(base: &Value, index: usize) -> Value {
    let mut path = base.as_array().cloned().unwrap_or_default();
    path.push(Value::Number(serde_json::Number::from(index as u64)));
    Value::Array(path)
}

fn issue(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// `z` 的 `invalid_type`：`{ expected, [format], code, [received], path, message }`
fn invalid_type(
    expected: &str,
    format: Option<&str>,
    received_message: &str,
    received_field: Option<&str>,
    path: Value,
) -> Value {
    let message = format!("Invalid input: expected {expected}, received {received_message}");
    let mut entries: Vec<(&str, Value)> = vec![("expected", json!(expected))];
    if let Some(format) = format {
        entries.push(("format", json!(format)));
    }
    entries.push(("code", json!("invalid_type")));
    if let Some(received) = received_field {
        entries.push(("received", json!(received)));
    }
    entries.push(("path", path));
    entries.push(("message", json!(message)));
    issue(entries)
}

fn too_small_number(minimum: i64, inclusive: bool, path: &Value) -> Value {
    let message = if inclusive {
        format!("Too small: expected number to be >={minimum}")
    } else {
        format!("Too small: expected number to be >{minimum}")
    };
    issue(vec![
        ("origin", json!("number")),
        ("code", json!("too_small")),
        ("minimum", json!(minimum)),
        ("inclusive", json!(inclusive)),
        ("path", path.clone()),
        ("message", json!(message)),
    ])
}

fn too_small_int(minimum: i64, path: &Value) -> Value {
    issue(vec![
        ("code", json!("too_small")),
        ("minimum", json!(minimum)),
        ("note", json!("Integers must be within the safe integer range.")),
        ("origin", json!("int")),
        ("inclusive", json!(true)),
        ("path", path.clone()),
        ("message", json!(format!("Too small: expected int to be >={minimum}"))),
    ])
}

fn too_big_int(maximum: i64, path: &Value) -> Value {
    issue(vec![
        ("code", json!("too_big")),
        ("maximum", json!(maximum)),
        ("note", json!("Integers must be within the safe integer range.")),
        ("origin", json!("int")),
        ("inclusive", json!(true)),
        ("path", path.clone()),
        ("message", json!(format!("Too big: expected int to be <={maximum}"))),
    ])
}

fn too_small_string(minimum: usize, message: &str, path: Value) -> Value {
    issue(vec![
        ("origin", json!("string")),
        ("code", json!("too_small")),
        ("minimum", json!(minimum)),
        ("inclusive", json!(true)),
        ("path", path),
        ("message", json!(message)),
    ])
}

/// `z.array(...).min(n)`：`{ origin: "array", code: "too_small", minimum, inclusive, path, message }`
fn too_small_array(minimum: usize, path: Value) -> Value {
    issue(vec![
        ("origin", json!("array")),
        ("code", json!("too_small")),
        ("minimum", json!(minimum)),
        ("inclusive", json!(true)),
        ("path", path),
        ("message", json!(format!("Too small: expected array to have >={minimum} items"))),
    ])
}

/// `z.array(...).max(n)`：`{ origin: "array", code: "too_big", maximum, inclusive, path, message }`
fn too_big_array(maximum: usize, path: Value) -> Value {
    issue(vec![
        ("origin", json!("array")),
        ("code", json!("too_big")),
        ("maximum", json!(maximum)),
        ("inclusive", json!(true)),
        ("path", path),
        ("message", json!(format!("Too big: expected array to have <={maximum} items"))),
    ])
}

/// `z.enum` 的 `invalid_value` issue。
///
/// zod 对**单值** enum（`z.enum(['Master'])`）走字面量分支：文案是
/// `Invalid input: expected "Master"`；多值 enum 才是
/// `Invalid option: expected one of "a"|"b"`。两种情况的 issue 形状相同
/// （`code` / `values` / `path` / `message`），只有 message 不同。
fn invalid_value_issue(values: &[&str], path: Value) -> Value {
    let joined = values
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join("|");
    let message = if values.len() == 1 {
        format!("Invalid input: expected {joined}")
    } else {
        format!("Invalid option: expected one of {joined}")
    };
    issue(vec![
        ("code", json!("invalid_value")),
        ("values", json!(values)),
        ("path", path),
        ("message", json!(message)),
    ])
}

fn invalid_union_issue(received: &str, path: Value) -> Value {
    let boolean_error = invalid_type("boolean", None, received, None, json!([]));
    let string_error = invalid_type("string", None, received, None, json!([]));
    issue(vec![
        ("code", json!("invalid_union")),
        ("errors", json!([[boolean_error], [string_error]])),
        ("path", path),
        ("message", json!("Invalid input")),
    ])
}

fn unrecognized_keys_issue(keys: &[String], base_path: &[Value]) -> Value {
    let message = if keys.len() == 1 {
        format!("Unrecognized key: \"{}\"", keys[0])
    } else {
        let list = keys
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!("Unrecognized keys: {list}")
    };
    issue(vec![
        ("code", json!("unrecognized_keys")),
        ("keys", json!(keys)),
        ("path", Value::Array(base_path.to_vec())),
        ("message", json!(message)),
    ])
}

/// 与 `JSON.stringify(issues, null, 2)` 一致（serde_json 的 pretty 缩进同为 2 空格）
fn pretty_issues(issues: &[Value]) -> String {
    serde_json::to_string_pretty(&Value::Array(issues.to_vec())).unwrap_or_else(|_| "[]".to_string())
}
