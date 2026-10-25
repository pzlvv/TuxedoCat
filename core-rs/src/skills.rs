//! Skill 系统。
//!
//! 模块划分：
//! - [`parse_frontmatter`] / [`parse_skill_frontmatter_fields`]（frontmatter 解析）
//! - [`substitute_arguments`] / [`substitute_builtin_variables`]（变量替换）
//! - [`get_skill_dir_commands`] / [`get_all_skills`]（技能目录加载）
//! - [`register_bundled_skill`] / [`bundled_skills`]（内置技能）
//! - [`commit_skill_definition`]（`/commit`）
//!
//! 用户目录的解析口径：统一走
//! `config::config_home()`（`USERPROFILE` 优先），保证 skills 目录与
//! `settings.json` / `conversations/` 落在同一个 `~/.<configDir>` 下。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::config;
use crate::util;

// ==================== 类型 ====================

/// Skill 来源类型
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillSource {
    Bundled,
    Project,
    User,
    /// 策略管理来源（`<CONFIG_DIR_NAME>/skills/`）。目前只扫 user / project
    /// 两级，该来源保留在数据契约里。
    #[allow(dead_code)]
    Managed,
}

impl SkillSource {
    pub fn as_str(self) -> &'static str {
        match self {
            SkillSource::Bundled => "bundled",
            SkillSource::Project => "project",
            SkillSource::User => "user",
            SkillSource::Managed => "managed",
        }
    }
}

/// Skill 加载位置标记
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadedFrom {
    Skills,
    Bundled,
}

impl LoadedFrom {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            LoadedFrom::Skills => "skills",
            LoadedFrom::Bundled => "bundled",
        }
    }
}

/// 提示词工厂：按命令名产出 content block 数组
pub type PromptFactory = Arc<dyn Fn(&str) -> Vec<Value> + Send + Sync>;

/// Skill 命令对象：一个 Skill 在运行时的完整表现形态
#[derive(Clone)]
pub struct SkillCommand {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    /// 参数名称列表（当使用位置参数 `$0`, `$1` 时映射）。
    /// 运行时由 `get_prompt_for_command` 闭包消费，字段本身供对等测试断言。
    #[allow(dead_code)]
    pub arg_names: Vec<String>,
    pub when_to_use: Option<String>,
    /// 模型覆盖（如 `claude-sonnet-4-20250514`）。
    ///
    /// 目前不消费它（模型解析只看会话配置），
    /// 字段保留在数据契约里。
    #[allow(dead_code)]
    pub model: Option<String>,
    /// 用户是否可主动触发（`/skill` 命令）
    pub user_invocable: bool,
    /// Skill 文件所在目录路径
    pub skill_root: Option<String>,
    pub source: SkillSource,
    /// 加载位置标记（数据契约字段，供对等测试断言）
    #[allow(dead_code)]
    pub loaded_from: LoadedFrom,
    /// 模型是否可主动加载：`disable-model-invocation: true` 时置 false。
    ///
    /// 与 `user_invocable` 正交、互不推导——前者只决定「进不进模型名单、Skill 工具能否被
    /// 模型调用」，后者只决定「进不进斜杠菜单、`/name` 能否匹配」（ADR-0011）。
    pub model_invocable: bool,
    /// 版本号（仅由 frontmatter 解析出来，暂未消费）
    #[allow(dead_code)]
    pub version: Option<String>,
    pub get_prompt_for_command: PromptFactory,
}

impl SkillCommand {
    /// 取 Skill 的 Prompt 内容（内容块数组）
    pub fn prompt_for_command(&self, args: &str) -> Vec<Value> {
        (self.get_prompt_for_command)(args)
    }

    /// 名称或别名是否命中
    pub fn matches(&self, name: &str) -> bool {
        self.name == name || self.aliases.iter().any(|alias| alias == name)
    }
}

/// 注册内置 Skill 时需提供的定义
pub struct BundledSkillDefinition {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub when_to_use: Option<String>,
    pub model: Option<String>,
    pub user_invocable: Option<bool>,
    /// 模型侧调用开关（`true` = 只能由用户触发）；缺省 false
    pub disable_model_invocation: Option<bool>,
    /// 参考文件（key = 相对路径，value = 内容），首次调用时提取到磁盘
    pub files: Vec<(String, String)>,
    pub get_prompt_for_command: PromptFactory,
}

/// SKILL.md 解析结果
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedSkillFrontmatter {
    pub display_name: Option<String>,
    pub description: String,
    pub has_user_specified_description: bool,
    pub argument_names: Vec<String>,
    pub when_to_use: Option<String>,
    pub version: Option<String>,
    pub model: Option<String>,
    pub user_invocable: bool,
    /// 模型侧调用开关（frontmatter `disable-model-invocation`，缺省 false）
    pub disable_model_invocation: bool,
    pub paths: Option<Vec<String>>,
}

/// 创建 [`SkillCommand`] 所需的参数
pub struct CreateSkillCommandParams {
    pub skill_name: String,
    pub description: String,
    pub markdown_content: String,
    pub argument_names: Vec<String>,
    pub when_to_use: Option<String>,
    pub version: Option<String>,
    pub model: Option<String>,
    pub user_invocable: bool,
    /// 模型侧是否可加载（由 `disable_model_invocation` 取反传入）
    pub model_invocable: bool,
    pub source: SkillSource,
    pub base_dir: Option<String>,
    pub loaded_from: LoadedFrom,
}

// ==================== JS 字符串工具 ====================

/// JS 正则 `\w` 的成员判定（`[A-Za-z0-9_]`，**不是** Unicode 字母）
fn is_regex_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// JS `String.prototype.replace(needle, replacement)`（全局、needle 为字面量）。
///
/// 关键点是**还原 JS 替换串的特殊模式**：`$$` → `$`、`$&` → 命中文本、
/// `` $` `` → 命中前的前缀、`$'` → 命中后的后缀。不还原的话，参数里带 `$&`
/// 这类字符时两侧产物会不同（JS 不会原样输出）。
fn js_replace_all(text: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find(needle) {
        let start = cursor + offset;
        let end = start + needle.len();
        out.push_str(&text[cursor..start]);
        out.push_str(&expand_js_replacement(
            replacement,
            needle,
            &text[..start],
            &text[end..],
        ));
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// `\$<name>\b`：字面量 `$name`，且其后必须紧跟单词边界
fn js_replace_dollar_name(text: &str, name: &str, replacement: &str) -> String {
    let needle = format!("${name}");
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find(&needle) {
        let start = cursor + offset;
        let end = start + needle.len();
        out.push_str(&text[cursor..start]);
        let next_is_word = text[end..]
            .chars()
            .next()
            .map(is_regex_word_char)
            .unwrap_or(false);
        if next_is_word {
            // `\b` 不成立：该位置不匹配，原样保留
            out.push_str(&needle);
        } else {
            out.push_str(&expand_js_replacement(
                replacement,
                &needle,
                &text[..start],
                &text[end..],
            ));
        }
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// 展开 JS 替换串里的 `$$` / `$&` / `` $` `` / `$'`。
///
/// `$n` / `$<name>` 在本模块用到的正则里都没有捕获组，按规范保持字面量。
fn expand_js_replacement(
    replacement: &str,
    matched: &str,
    prefix: &str,
    suffix: &str,
) -> String {
    let chars: Vec<char> = replacement.chars().collect();
    let mut out = String::with_capacity(replacement.len());
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] == '$' && index + 1 < chars.len() {
            match chars[index + 1] {
                '$' => {
                    out.push('$');
                    index += 2;
                    continue;
                }
                '&' => {
                    out.push_str(matched);
                    index += 2;
                    continue;
                }
                '`' => {
                    out.push_str(prefix);
                    index += 2;
                    continue;
                }
                '\'' => {
                    out.push_str(suffix);
                    index += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

// ==================== Frontmatter 解析 ====================

/// 解析 SKILL.md 中的 YAML frontmatter 头，返回 `(frontmatter, 正文)`
pub fn parse_frontmatter(content: &str) -> (Map<String, Value>, String) {
    let trimmed = util::js_trim_start(content);
    if !trimmed.starts_with("---") {
        return (Map::new(), trimmed.to_string());
    }

    // 找到第二个 `---`（从索引 3 之后开始找）
    let Some(relative) = trimmed[3..].find("---") else {
        return (Map::new(), trimmed.to_string());
    };
    let end_index = 3 + relative;

    let frontmatter_str = util::js_trim(&trimmed[3..end_index]).to_string();
    let body = util::js_trim_start(&trimmed[end_index + 3..]).to_string();

    (parse_yaml_lines(&frontmatter_str), body)
}

/// 解析简单的 YAML 键值对（只支持 SKILL.md 用到的子集：标量、数组、多行字符串）
fn parse_yaml_lines(yaml: &str) -> Map<String, Value> {
    let mut result = Map::new();
    let mut current_key: Option<String> = None;
    let mut current_array: Option<Vec<Value>> = None;
    let mut in_multiline = false;
    let mut multiline_key: Option<String> = None;
    let mut multiline_lines: Vec<String> = Vec::new();

    for raw_line in yaml.split('\n') {
        let line = util::js_trim_end(raw_line).to_string();

        // 多行字符串续行（以空格开头的缩进行，或空行）
        if in_multiline && multiline_key.is_some() {
            if line.starts_with(' ') || line.is_empty() {
                multiline_lines.push(line.clone());
                continue;
            }
            // 多行结束，保存
            result.insert(
                multiline_key.take().unwrap(),
                Value::String(util::js_trim(&multiline_lines.join("\n")).to_string()),
            );
            multiline_lines.clear();
            in_multiline = false;
        }

        // 数组项
        if current_key.is_some() && util::js_trim_start(&line).starts_with("- ") {
            let item = util::js_trim(&util::js_trim_start(&line)[2..]).to_string();
            current_array
                .get_or_insert_with(Vec::new)
                .push(Value::String(item));
            continue;
        }

        // 结束当前数组
        if let (Some(key), Some(array)) = (current_key.take(), current_array.take()) {
            result.insert(key, Value::Array(array));
        }

        // 跳过空行和注释
        let trimmed_line = util::js_trim(&line);
        if trimmed_line.is_empty() || trimmed_line.starts_with('#') {
            continue;
        }

        // 解析 key: value
        let Some(colon_index) = line.find(':') else {
            continue;
        };
        let key = util::js_trim(&line[..colon_index]).to_string();
        let value = util::js_trim(&line[colon_index + 1..]).to_string();
        if key.is_empty() {
            continue;
        }

        // 多行标记 `|`
        if value == "|" {
            in_multiline = true;
            multiline_key = Some(key);
            continue;
        }

        // 数组标记（`key:` 后无值）
        if value.is_empty() {
            current_key = Some(key);
            current_array = Some(Vec::new());
            continue;
        }

        result.insert(key, parse_yaml_value(&value));
    }

    // 清理
    if let (Some(key), Some(array)) = (current_key.take(), current_array.take()) {
        result.insert(key, Value::Array(array));
    }
    if in_multiline {
        if let Some(key) = multiline_key.take() {
            result.insert(
                key,
                Value::String(util::js_trim(&multiline_lines.join("\n")).to_string()),
            );
        }
    }

    result
}

/// 解析 YAML 标量值
fn parse_yaml_value(value: &str) -> Value {
    // 引号字符串
    let quoted = (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        || (value.starts_with('"') && value.ends_with('"') && value.len() >= 2);
    if quoted {
        return Value::String(value[1..value.len() - 1].to_string());
    }

    // 布尔值
    if value == "true" {
        return Value::Bool(true);
    }
    if value == "false" {
        return Value::Bool(false);
    }

    // 数字：`/^-?\d+(\.\d+)?$/`
    if is_yaml_number(value) {
        if value.contains('.') {
            if let Ok(number) = value.parse::<f64>() {
                // JS 只有 double：`parseFloat("1.0")` 就是 `1`，`JSON.stringify` 写 `1`
                // （不是 `1.0`）。整数值的浮点必须存成整数。
                if number.is_finite() && number.fract() == 0.0 && number.abs() <= i64::MAX as f64 {
                    return Value::Number((number as i64).into());
                }
                return serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .unwrap_or(Value::String(value.to_string()));
            }
        } else if let Ok(number) = value.parse::<i64>() {
            return Value::Number(number.into());
        } else if let Ok(number) = value.parse::<f64>() {
            // 超出 i64 的整数字面量：JS `parseInt` 返回 double
            if let Some(number) = serde_json::Number::from_f64(number) {
                return Value::Number(number);
            }
        }
    }

    // 空值
    if value == "~" || value == "null" {
        return Value::Null;
    }

    Value::String(value.to_string())
}

/// `/^-?\d+(\.\d+)?$/`
fn is_yaml_number(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() {
        return false;
    }
    let mut parts = digits.splitn(2, '.');
    let integer = parts.next().unwrap_or("");
    if integer.is_empty() || !integer.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(fraction) => {
            !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

/// 从 SKILL.md 内容中提取纯文本描述（第一段非空文本作为 fallback）
pub fn extract_description_from_markdown(markdown: &str, label: &str) -> String {
    let (_, content) = parse_frontmatter(markdown);
    for line in content.split('\n') {
        let trimmed = util::js_trim(line);
        if !trimmed.is_empty()
            && !trimmed.starts_with('#')
            && !trimmed.starts_with("```")
            && !trimmed.starts_with('-')
            && !trimmed.starts_with('>')
        {
            // 取前 150 个字符（JS `.length`，UTF-16 code unit）
            return if util::utf16_len(trimmed) > 150 {
                format!("{}...", util::utf16_take(trimmed, 147))
            } else {
                trimmed.to_string()
            };
        }
    }
    format!("{}: {}...", label, util::utf16_take(&content, 80))
}

/// 解析 frontmatter 中的 `paths` 字段。
/// 所有模式都是 `**` / `*`（匹配全部）时返回 `None`。
pub fn parse_skill_paths(paths_value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(items)) = paths_value else {
        return None;
    };
    if items.is_empty() {
        return None;
    }

    let patterns: Vec<String> = items
        .iter()
        .map(|item| util::js_string(item))
        // 对齐 `String(p).replace(/\*\*$/, '')`：只去掉**尾部的 `**`**，
        // `src/**` → `src/`（不是 `src`）、`**/*` 原样保留
        .map(|pattern| pattern.strip_suffix("**").unwrap_or(&pattern).to_string())
        .filter(|pattern| !pattern.is_empty())
        .collect();

    if patterns.is_empty() || patterns.iter().all(|p| p == "**" || p == "*") {
        return None;
    }
    Some(patterns)
}

/// 解析 frontmatter 中的 `arguments` 字段（支持字符串或字符串数组）
pub fn parse_argument_names(args: Option<&Value>) -> Vec<String> {
    match args {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(util::js_string).collect(),
        Some(value) => vec![util::js_string(value)],
    }
}

/// 解析布尔类型的 frontmatter 字段（默认 `true`）。
///
/// 只有布尔字面量与 `'true'` / `'yes'` / `'false'` / `'no'` 参与判定，
/// **其余一律 `true`**（默认为 true，
/// 数字 `0` 也是 `true`，不是按真值转换）。
pub fn parse_boolean_frontmatter(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(text)) => !matches!(text.as_str(), "false" | "no"),
        _ => true,
    }
}

/// 确保 description 为字符串（空串 / 非字符串返回 `None`）
pub fn coerce_description_to_string(description: Option<&Value>) -> Option<String> {
    match description {
        Some(Value::String(text)) if !util::js_trim(text).is_empty() => {
            Some(util::js_trim(text).to_string())
        }
        _ => None,
    }
}

/// 解析 SKILL.md 的所有 frontmatter 字段
pub fn parse_skill_frontmatter_fields(
    frontmatter: &Map<String, Value>,
    markdown_content: &str,
    description_fallback_label: &str,
) -> ParsedSkillFrontmatter {
    let validated_description = coerce_description_to_string(frontmatter.get("description"));
    let description = validated_description.clone().unwrap_or_else(|| {
        extract_description_from_markdown(markdown_content, description_fallback_label)
    });

    let user_invocable = match frontmatter.get("user-invocable") {
        None => true,
        Some(value) => parse_boolean_frontmatter(Some(value)),
    };
    // 与 `user-invocable` 相反方向：缺省 false（默认允许模型主动加载）
    let disable_model_invocation = match frontmatter.get("disable-model-invocation") {
        None => false,
        Some(value) => parse_boolean_frontmatter(Some(value)),
    };

    let model = match frontmatter.get("model") {
        Some(Value::String(text)) if text == "inherit" => None,
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };

    ParsedSkillFrontmatter {
        display_name: frontmatter.get("name").map(util::js_string),
        description,
        has_user_specified_description: validated_description.is_some(),
        argument_names: parse_argument_names(frontmatter.get("arguments")),
        when_to_use: frontmatter
            .get("when_to_use")
            .and_then(Value::as_str)
            .map(str::to_string),
        version: frontmatter
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        model,
        user_invocable,
        disable_model_invocation,
        paths: parse_skill_paths(frontmatter.get("paths")),
    }
}

// ==================== 变量替换 ====================

/// 在文本中替换位置参数（`$0`, `$1`, ... 与 `$ARGUMENTS`，以及命名参数）
pub fn substitute_arguments(content: &str, args: &str, arg_names: &[String]) -> String {
    let mut result = content.to_string();

    // `$ARGUMENTS` → 完整参数字符串
    if !args.is_empty() {
        result = js_replace_all(&result, "$ARGUMENTS", args);
    }

    // 位置参数 `$0`, `$1`, ...
    if !args.is_empty() && !arg_names.is_empty() {
        let arg_values = parse_positional_args(args, arg_names.len());
        for (index, value) in arg_values.iter().enumerate() {
            result = js_replace_all(&result, &format!("${index}"), value);
        }
    } else if !args.is_empty() {
        // 没有 argNames 时，`$0` 替换为完整参数
        result = js_replace_all(&result, "$0", args);
    }

    // 命名参数（`${argName}` 与 `$argName\b`）
    if !args.is_empty() && !arg_names.is_empty() {
        let arg_values = parse_positional_args(args, arg_names.len());
        for (index, name) in arg_names.iter().enumerate() {
            if name.is_empty() || index >= arg_values.len() {
                continue;
            }
            result = js_replace_all(&result, &format!("${{{name}}}"), &arg_values[index]);
            result = js_replace_dollar_name(&result, name, &arg_values[index]);
        }
    }

    result
}

/// 解析位置参数：按空格分割，支持引号包裹与反斜杠转义
pub fn parse_positional_args(args: &str, count: usize) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quote: Option<char> = None;
    let mut escape = false;

    for ch in args.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' {
            escape = true;
            continue;
        }
        if let Some(quote) = in_quote {
            if ch == quote {
                in_quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            in_quote = Some(ch);
            continue;
        }
        if ch == ' ' {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
                if result.len() >= count {
                    break;
                }
            }
            continue;
        }
        current.push(ch);
    }

    if !current.is_empty() {
        result.push(current);
    }

    // 补齐剩余参数为空字符串
    while result.len() < count {
        result.push(String::new());
    }

    result
}

/// 替换内置变量：`${SKILL_DIR}` → skill 所在目录、`${SESSION_ID}` → 当前会话 ID
pub fn substitute_builtin_variables(
    content: &str,
    skill_dir: Option<&str>,
    session_id: Option<&str>,
) -> String {
    let mut result = content.to_string();

    if let Some(dir) = skill_dir {
        // Windows 上统一成正斜杠
        let normalized = if cfg!(windows) {
            dir.replace('\\', "/")
        } else {
            dir.to_string()
        };
        result = js_replace_all(&result, "${SKILL_DIR}", &normalized);
    }

    if let Some(session_id) = session_id {
        result = js_replace_all(&result, "${SESSION_ID}", session_id);
    }

    result
}

/// 在 Prompt 内容前插入 Base directory 提示
pub fn prepend_base_dir(blocks: Vec<Value>, base_dir: &str) -> Vec<Value> {
    let prefix = format!("Base directory for this skill: {base_dir}\n\n");
    let mut iter = blocks.into_iter();
    let mut out: Vec<Value> = Vec::new();
    match iter.next() {
        Some(Value::Object(mut first)) if first.get("type").and_then(Value::as_str) == Some("text") => {
            let text = first
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            first.insert("text".to_string(), Value::String(format!("{prefix}{text}")));
            out.push(Value::Object(first));
            out.extend(iter);
        }
        Some(first) => {
            out.push(serde_json::json!({ "type": "text", "text": prefix }));
            out.push(first);
            out.extend(iter);
        }
        None => out.push(serde_json::json!({ "type": "text", "text": prefix })),
    }
    out
}

// ==================== 创建 SkillCommand ====================

/// 创建一个文件系统来源的 [`SkillCommand`]（对齐 `createSkillCommand`）
pub fn create_skill_command(params: CreateSkillCommandParams) -> SkillCommand {
    let CreateSkillCommandParams {
        skill_name,
        description,
        markdown_content,
        argument_names,
        when_to_use,
        version,
        model,
        user_invocable,
        model_invocable,
        source,
        base_dir,
        loaded_from,
    } = params;

    let prompt_content = match &base_dir {
        Some(dir) => format!("Base directory for this skill: {dir}\n\n{markdown_content}"),
        None => markdown_content.clone(),
    };
    let prompt_arguments = argument_names.clone();
    let prompt_base_dir = base_dir.clone();

    SkillCommand {
        name: skill_name,
        description,
        aliases: Vec::new(),
        arg_names: argument_names,
        when_to_use,
        model,
        user_invocable,
        skill_root: base_dir,
        source,
        loaded_from,
        model_invocable,
        version,
        get_prompt_for_command: Arc::new(move |args: &str| {
            let mut final_content =
                substitute_arguments(&prompt_content, args, &prompt_arguments);
            // sessionId 由 ToolUseContext 提供，不在这一层
            final_content =
                substitute_builtin_variables(&final_content, prompt_base_dir.as_deref(), None);
            vec![serde_json::json!({ "type": "text", "text": final_content })]
        }),
    }
}

// ==================== 内置 Skill 注册表 ====================

/// 内部注册表（对齐 `bundledSkills.ts` 的模块级数组）
static BUNDLED_SKILLS: Mutex<Vec<SkillCommand>> = Mutex::new(Vec::new());
/// 模块加载时的自动注册只跑一次（对齐 `initBuiltinSkills()` IIFE）
static INITIALIZED: AtomicBool = AtomicBool::new(false);
static INIT_LOCK: Mutex<()> = Mutex::new(());

/// 注册一个内置 Skill；与内置命令重名时**忽略**并记 WARNING
pub fn register_bundled_skill(definition: BundledSkillDefinition) {
    // 检查是否与内置命令冲突
    if crate::commands::check_skill_conflict(&definition.name, &definition.aliases) {
        eprintln!(
            "[core] bundledSkills: Skill \"{}\" will be IGNORED due to conflict with built-in command.",
            definition.name
        );
        return;
    }

    let user_invocable = definition.user_invocable.unwrap_or(true);
    let model_invocable = !definition.disable_model_invocation.unwrap_or(false);
    let mut skill_root: Option<String> = None;
    let mut get_prompt_for_command = definition.get_prompt_for_command;

    // 有参考文件时：首次调用提取到磁盘，并在内容前插入 base directory 提示
    if !definition.files.is_empty() {
        let extract_dir = bundled_skill_extract_dir(&definition.name);
        skill_root = extract_dir.clone();
        let inner = get_prompt_for_command;
        let name = definition.name.clone();
        let files = definition.files.clone();
        let once = Arc::new(Mutex::new(None::<Option<String>>));
        get_prompt_for_command = Arc::new(move |args: &str| {
            // 外层 `Option` 表示「是否已提取过」，内层是提取结果（`None` = 失败）
            let cached: Option<Option<String>> = {
                let mut guard = once.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(extract_bundled_skill_files(&name, &files));
                }
                guard.clone()
            };
            let blocks = inner(args);
            match cached.flatten() {
                Some(dir) => prepend_base_dir(blocks, &dir),
                None => blocks,
            }
        });
    }

    let command = SkillCommand {
        name: definition.name,
        description: definition.description,
        aliases: definition.aliases,
        arg_names: Vec::new(),
        when_to_use: definition.when_to_use,
        model: definition.model,
        user_invocable,
        skill_root,
        source: SkillSource::Bundled,
        loaded_from: LoadedFrom::Bundled,
        model_invocable,
        version: None,
        get_prompt_for_command,
    };

    BUNDLED_SKILLS.lock().unwrap().push(command);
}

/// 获取所有注册的内置 Skill（返回副本，防止外部修改）
pub fn bundled_skills() -> Vec<SkillCommand> {
    ensure_builtins();
    BUNDLED_SKILLS.lock().unwrap().clone()
}

/// 内置 Skill 参考文件的提取目录：`~/.<configDir>/.skills/<name>`
fn bundled_skill_extract_dir(skill_name: &str) -> Option<String> {
    config::config_home()
        .ok()
        .map(|home| home.join(".skills").join(skill_name).to_string_lossy().into_owned())
}

/// 提取内置 Skill 的参考文件到磁盘（首次调用时执行）
fn extract_bundled_skill_files(skill_name: &str, files: &[(String, String)]) -> Option<String> {
    let Some(dir) = bundled_skill_extract_dir(skill_name) else {
        eprintln!("[core] bundledSkills: cannot resolve extract dir for '{skill_name}'");
        return None;
    };
    match write_skill_files(Path::new(&dir), files) {
        Ok(()) => Some(dir),
        Err(error) => {
            eprintln!(
                "[core] bundledSkills: Failed to extract bundled skill '{skill_name}' to {dir}: {error}"
            );
            None
        }
    }
}

/// 按父目录分组写文件（每个目录只 mkdir 一次）
fn write_skill_files(dir: &Path, files: &[(String, String)]) -> Result<(), String> {
    let mut by_parent: Vec<(PathBuf, Vec<(PathBuf, String)>)> = Vec::new();
    for (rel_path, content) in files {
        let target = resolve_skill_file_path(dir, rel_path)?;
        let parent = target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dir.to_path_buf());
        match by_parent.iter_mut().find(|(path, _)| *path == parent) {
            Some((_, group)) => group.push((target, content.clone())),
            None => by_parent.push((parent, vec![(target, content.clone())])),
        }
    }

    for (parent, entries) in by_parent {
        std::fs::create_dir_all(&parent)
            .map_err(|err| format!("mkdir {} failed: {err}", parent.display()))?;
        for (path, content) in entries {
            safe_write_file(&path, &content)?;
        }
    }
    Ok(())
}

/// 安全写入文件：`O_EXCL`（不覆盖已存在文件）
fn safe_write_file(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(path)
        .map_err(|err| format!("create {} failed: {err}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|err| format!("write {} failed: {err}", path.display()))
}

/// 规范化并校验 Skill 相对路径（阻止 `..` 逃逸）
fn resolve_skill_file_path(base_dir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_path(rel_path);
    // `path.isAbsolute` 的 Node 口径：Windows 上 `/abs` 也算绝对路径
    // （`std::path::Path::is_absolute` 在 Windows 上只认盘符 / UNC）
    let escapes = crate::tools::is_absolute_like_node(rel_path)
        || normalized.split(['\\', '/']).any(|part| part == "..");
    if escapes {
        return Err(format!("Bundled skill file path escapes skill dir: {rel_path}"));
    }
    Ok(base_dir.join(normalized))
}

/// `path.normalize` 的近似实现：折叠 `.`、把 `\` 与 `/` 统一处理
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split(['\\', '/']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.push("..");
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

// ==================== 文件系统 Skill 加载 ====================

/// 内部类型：Skill 与文件路径的关联
struct SkillWithPath {
    skill: SkillCommand,
    file_path: String,
}

/// 一个技能发现根：`rank` 越小越优先。
struct SkillRoot {
    rank: u8,
    path: PathBuf,
    source: SkillSource,
}

/// 参与仲裁的技能：rank + 技能本体 + 来源（WARNING 要点名路径）。
struct RankedSkill {
    rank: u8,
    skill: SkillCommand,
    file_path: String,
}

// rank 表：项目级先于用户级；同层级内 `.agents`（跨工具共享）先于产品私有目录。
// 产品私有目录是兼容层，方向是逐步弱化（ADR-0011）。
const RANK_PROJECT_AGENTS: u8 = 10;
const RANK_PROJECT_PRODUCT: u8 = 20;
const RANK_USER_AGENTS: u8 = 30;
const RANK_USER_PRODUCT: u8 = 40;
const RANK_BUNDLED: u8 = 50;

/// 技能发现根，按 `rank` 升序。
///
/// `cwd` 为空（无会话上下文）时跳过项目级根：`Path::new("")` 会退化成相对路径，
/// 等于去扫 Core 进程自己的工作目录。
fn skill_roots(cwd: &str) -> Vec<SkillRoot> {
    let mut roots: Vec<SkillRoot> = Vec::new();
    if !cwd.is_empty() {
        let config_dir_name = config::host_environment()
            .map(|env| env.config_dir_name)
            .unwrap_or_else(|| config::DEFAULT_CONFIG_DIR_NAME.to_string());
        roots.push(SkillRoot {
            rank: RANK_PROJECT_AGENTS,
            path: Path::new(cwd).join(".agents").join("skills"),
            source: SkillSource::Project,
        });
        roots.push(SkillRoot {
            rank: RANK_PROJECT_PRODUCT,
            path: Path::new(cwd).join(&config_dir_name).join("skills"),
            source: SkillSource::Project,
        });
    }
    if let Ok(home) = config::home_dir() {
        roots.push(SkillRoot {
            rank: RANK_USER_AGENTS,
            path: home.join(".agents").join("skills"),
            source: SkillSource::User,
        });
    }
    if let Ok(config_home) = config::config_home() {
        roots.push(SkillRoot {
            rank: RANK_USER_PRODUCT,
            path: config_home.join("skills"),
            source: SkillSource::User,
        });
    }
    roots.sort_by_key(|root| root.rank);
    roots
}

/// 两个技能是否同名：name 或 alias 任一方向命中。
fn names_collide(a: &SkillCommand, b: &SkillCommand) -> bool {
    a.name == b.name
        || a.aliases.iter().any(|alias| alias == &b.name || b.aliases.contains(alias))
        || b.aliases.iter().any(|alias| alias == &a.name)
}

/// 同名仲裁：按 `rank` 升序保留第一个，其余丢弃并产出一条点名两条路径的 WARNING。
///
/// 抽成纯函数是为了让「谁赢、几条 WARNING」可单测（不必抓 stderr）。
fn arbitrate(mut candidates: Vec<RankedSkill>) -> (Vec<SkillCommand>, Vec<String>) {
    // 稳定排序：同 rank 内保持收集顺序（同一根内目录名唯一，正常不会撞）
    candidates.sort_by_key(|candidate| candidate.rank);
    let mut kept: Vec<RankedSkill> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for candidate in candidates {
        match kept
            .iter()
            .find(|winner| names_collide(&winner.skill, &candidate.skill))
        {
            None => {
                // 两个开关都关：用户调不到（不进菜单、`/name` 不匹配），模型也调不到
                // （不进名单、工具校验拒绝）。不是错误，但必须可诊断，否则「我明明放了这个技能」。
                if !candidate.skill.user_invocable && !candidate.skill.model_invocable {
                    warnings.push(format!(
                        "Skill '{}' at {} is unreachable (user-invocable: false + disable-model-invocation: true)",
                        candidate.skill.name, candidate.file_path
                    ));
                }
                kept.push(candidate)
            }
            Some(winner) => warnings.push(format!(
                "Skill '{}' at {} ignored (rank {}); using {} (rank {})",
                candidate.skill.name,
                candidate.file_path,
                candidate.rank,
                winner.file_path,
                winner.rank
            )),
        }
    }
    (kept.into_iter().map(|entry| entry.skill).collect(), warnings)
}

/// 同一物理文件经多个根可见（junction / symlink）时只保留第一个（rank 最小）。
///
/// 返回 `(保留的候选, 去重日志)`——去重不是同名冲突，日志走独立通道，不进 WARNING。
/// 输入是 `(realpath 结果, 候选)`：`None` 表示解析失败，按独立文件处理。
fn dedupe_by_file_identity(
    entries: Vec<(Option<String>, RankedSkill)>,
) -> (Vec<RankedSkill>, Vec<String>) {
    let mut kept: Vec<RankedSkill> = Vec::new();
    let mut logs: Vec<String> = Vec::new();
    let mut seen_files: Vec<(String, u8)> = Vec::new();
    for (file_id, candidate) in entries {
        if let Some(file_id) = &file_id {
            if let Some((_, rank)) = seen_files.iter().find(|(id, _)| id == file_id) {
                logs.push(format!(
                    "deduped '{}' ({} from {} is the same file already loaded at rank {})",
                    candidate.skill.name,
                    candidate.file_path,
                    candidate.skill.source.as_str(),
                    rank
                ));
                continue;
            }
            seen_files.push((file_id.clone(), candidate.rank));
        }
        kept.push(candidate);
    }
    (kept, logs)
}

/// 按 rank 升序扫全部文件系统根，并做 realpath 去重。
fn file_candidates(cwd: &str) -> Vec<RankedSkill> {
    let mut entries: Vec<(Option<String>, RankedSkill)> = Vec::new();
    for root in skill_roots(cwd) {
        for entry in load_skills_from_skills_dir(&root.path, root.source) {
            let file_id = get_file_identity(&entry.file_path);
            entries.push((
                file_id,
                RankedSkill {
                    rank: root.rank,
                    skill: entry.skill,
                    file_path: entry.file_path,
                },
            ));
        }
    }
    let (kept, logs) = dedupe_by_file_identity(entries);
    for log in logs {
        eprintln!("[core] skills: {log}");
    }
    kept
}

/// 从文件系统加载所有 Skill（四个根按 rank 合并 + realpath 去重 + 同名仲裁）。
///
/// 只给测试用的「文件系统视图」：宿主侧的斜杠菜单与模型名单都走 `get_all_skills`
/// （要带上 bundled 一起仲裁）。
#[cfg(test)]
pub fn get_skill_dir_commands(cwd: &str) -> Vec<SkillCommand> {
    let (kept, warnings) = arbitrate(file_candidates(cwd));
    for warning in warnings {
        eprintln!("[core] skills: {warning}");
    }
    kept
}

/// 获取全部可用 Skill（文件系统 + 内置，一起仲裁）
///
/// bundled 以 rank 50 参与同一个仲裁，所以「项目技能遮蔽内置同名技能」和「名单只留一条」
/// 是同一个机制的结果。
pub fn get_all_skills(cwd: &str) -> Vec<SkillCommand> {
    let mut candidates = file_candidates(cwd);
    for skill in bundled_skills() {
        candidates.push(RankedSkill {
            rank: RANK_BUNDLED,
            file_path: format!("bundled:{}", skill.name),
            skill,
        });
    }
    let (kept, warnings) = arbitrate(candidates);
    for warning in warnings {
        eprintln!("[core] skills: {warning}");
    }
    kept
}

/// 按名称 / 别名查找 Skill（对齐 `SkillTool.findSkill`：trim 后去掉**一个**前导 `/`）
pub fn find_skill(name: &str, cwd: &str) -> Option<SkillCommand> {
    let trimmed = util::js_trim(name);
    let trimmed = trimmed.strip_prefix('/').unwrap_or(trimmed);
    get_all_skills(cwd)
        .into_iter()
        .find(|skill| skill.matches(trimmed))
}

/// 从指定的 `<configDir>/skills/` 目录加载 Skill（只支持 `skill-name/SKILL.md`）
fn load_skills_from_skills_dir(base_path: &Path, source: SkillSource) -> Vec<SkillWithPath> {
    let Ok(entries) = std::fs::read_dir(base_path) else {
        // 目录不存在或不可访问，跳过
        return Vec::new();
    };

    let mut results: Vec<SkillWithPath> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // 只支持目录格式（符号链接由 `file_type` 跟随 `metadata` 判定）
        let is_dir = entry
            .metadata()
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        if !is_dir {
            continue;
        }

        let skill_dir_path = base_path.join(&name);
        let skill_file_path = skill_dir_path.join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&skill_file_path) else {
            // SKILL.md 不存在，跳过
            continue;
        };

        let (frontmatter, markdown_content) = parse_frontmatter(&content);
        let parsed = parse_skill_frontmatter_fields(&frontmatter, &markdown_content, "Skill");
        let skill_dir = skill_dir_path.to_string_lossy().into_owned();

        results.push(SkillWithPath {
            skill: create_skill_command(CreateSkillCommandParams {
                skill_name: name,
                description: parsed.description,
                markdown_content,
                argument_names: parsed.argument_names,
                when_to_use: parsed.when_to_use,
                version: parsed.version,
                model: parsed.model,
                user_invocable: parsed.user_invocable,
                model_invocable: !parsed.disable_model_invocation,
                source,
                base_dir: Some(skill_dir),
                loaded_from: LoadedFrom::Skills,
            }),
            file_path: skill_file_path.to_string_lossy().into_owned(),
        });
    }

    results
}

/// 获取文件的唯一标识（通过 realpath 解析符号链接）
fn get_file_identity(file_path: &str) -> Option<String> {
    std::fs::canonicalize(file_path)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

// ==================== 内置 Skill 定义 ====================

/// 内置 `commit` Skill（对齐 `bundled/commit.ts`）
pub fn commit_skill_definition() -> BundledSkillDefinition {
    BundledSkillDefinition {
        name: "commit".to_string(),
        description: "Create a git commit from staged and unstaged changes".to_string(),
        aliases: Vec::new(),
        when_to_use: Some(
            "Use this when the user asks you to commit changes or create a git commit".to_string(),
        ),
        model: None,
        user_invocable: None,
        disable_model_invocation: None,
        files: Vec::new(),
        get_prompt_for_command: Arc::new(|args: &str| {
            let mut content = COMMIT_SKILL_PROMPT.to_string();
            let trimmed_args = util::js_trim(args);
            if !trimmed_args.is_empty() {
                content.push_str(&format!(
                    "\n\n## Additional instructions from user\n\n{trimmed_args}"
                ));
            }
            vec![serde_json::json!({ "type": "text", "text": content })]
        }),
    }
}

/// `bundled/commit.ts::getPromptContent()` 的逐字文本
const COMMIT_SKILL_PROMPT: &str = r#"## Context

- Current git status: run `git status`
- Current git diff (staged and unstaged changes): run `git diff HEAD`
- Current branch: run `git branch --show-current`
- Recent commits: run `git log --oneline -10`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use `git commit --amend`, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like `git rebase -i` or `git add -i`) since they require interactive input which is not supported

## Your task

Based on the above changes, create a single git commit:

1. Use Bash tool to check git status and diff (as shown in the Context section above)
2. Analyze all changes and draft a commit message:
   - Look at the recent commits to follow this repository's commit message style
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.)
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

3. Stage relevant files and create the commit using heredoc syntax:
   ```
   git add <files>
   git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
   ```

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else."#;

// ==================== 初始化 ====================

/// 模块加载时的自动注册（对齐 `initBuiltinSkills()` IIFE）：
/// 先注册内置命令（`spin`，优先于 Skill），再注册内置 Skill（`commit`）。
pub fn ensure_builtins() {
    if INITIALIZED.load(Ordering::SeqCst) {
        return;
    }
    let _guard = INIT_LOCK.lock().unwrap();
    if INITIALIZED.load(Ordering::SeqCst) {
        return;
    }
    crate::commands::register_builtin_command(crate::commands::spin_command_definition());
    register_bundled_skill(commit_skill_definition());
    INITIALIZED.store(true, Ordering::SeqCst);
}

/// 仅测试用：清空两个注册表并允许重新初始化
#[cfg(test)]
pub fn reset_registries() {
    let _guard = INIT_LOCK.lock().unwrap();
    BUNDLED_SKILLS.lock().unwrap().clear();
    crate::commands::clear_builtin_commands();
    INITIALIZED.store(false, Ordering::SeqCst);
}

/// 技能清单文本（对齐 `formatSkillListing`）
pub fn format_skill_listing(skills: &[SkillCommand]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    // 只看模型侧开关：`user-invocable: false` 的技能对模型照常可见（ADR-0011）
    skills
        .iter()
        .filter(|skill| skill.model_invocable)
        .map(|skill| {
            let when_to_use = skill
                .when_to_use
                .as_deref()
                .map(|text| format!(" - {text}"))
                .unwrap_or_default();
            format!("- {}: {}{}", skill.name, skill.description, when_to_use)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 可用技能段（注入 system prompt；对齐 `SystemEnvironment.ts` 的内联文本）
pub fn available_skills_section(skills: &[SkillCommand]) -> String {
    let listing = format_skill_listing(skills);
    if listing.is_empty() {
        return String::new();
    }
    format!(
        "## Available Skills\n\n\
         You have access to the following skills. Use the Skill tool to invoke them.\n\n\
         {listing}\n\n\
         To invoke a skill, use the Skill tool with the skill name and optional arguments.\n\
         Example: `{{ \"skill\": \"commit\", \"args\": \"-m 'message'\" }}`"
    )
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
