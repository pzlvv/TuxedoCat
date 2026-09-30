//! LLM 全局配置的**保存**（对齐 Embedded `WebviewMessageHandler.handleSaveLLMConfig`
//! 里那段 `host.updateSettingsJson(mutator)`）。
//!
//! Embedded 下写 `settings.json` 是宿主能力（core 只读）；Standalone 下全局配置的
//! 唯一写入点是 Core（`docs/standalone-core.md` 第 8 节），因此这段 mutation 必须
//! 整体搬过来：它要读**磁盘上的旧值**（`llm.providers[key].modelConfigs`）才能保留
//! 用户手填的 context/output 限值，还要读内置模型注册表补齐缺失字段。
//!
//! 保存后返回宿主组装 webview 回复所需的「保存结果」（默认值 + provider 分组 +
//! 当前会话解析后的模型身份），宿主不再自己读盘。

use serde_json::{json, Map, Value};

use crate::{config, history, mcp_config, util};

/// 根据 base URL 计算 provider key（对齐 `providerKeyFromBaseURL`）。
///
/// 规则：取 URL 的 hostname（去掉端口与路径），例如
/// `https://opencode.ai/zen/go` → `opencode.ai`；不是合法 URL 时退化为
/// 「去协议后取第一个 `/` 之前的部分，再去掉端口」。
pub fn provider_key_from_base_url(base_url: &str) -> String {
    let trimmed = util::js_trim(base_url);
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(url) = reqwest::Url::parse(trimmed) {
        if let Some(host) = url.host_str() {
            if !host.is_empty() {
                return host.to_string();
            }
        }
    }
    fallback_provider_key(trimmed)
}

/// 非法 URL 的退化口径：去协议 → 取第一个 `/` 之前 → 去掉端口
fn fallback_provider_key(base_url: &str) -> String {
    let without_protocol = match base_url.find("://") {
        // `^[a-zA-Z][a-zA-Z0-9+.-]*://`：只在「协议名合法」时才算协议
        Some(index) => {
            let scheme = &base_url[..index];
            let valid = !scheme.is_empty()
                && scheme
                    .chars()
                    .next()
                    .map(|ch| ch.is_ascii_alphabetic())
                    .unwrap_or(false)
                && scheme
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'));
            if valid {
                &base_url[index + 3..]
            } else {
                base_url
            }
        }
        None => base_url,
    };
    let host = without_protocol.split('/').next().unwrap_or("");
    host.split(':').next().unwrap_or("").to_string()
}

/// 把任意输入规范化为合法的 `apiType`（非法值回退 `OpenAI`，对齐 `normalizeApiType`）
pub fn normalize_api_type(value: &Value) -> String {
    match value.as_str() {
        Some("Responses") => "Responses".to_string(),
        Some("Anthropic") => "Anthropic".to_string(),
        _ => "OpenAI".to_string(),
    }
}

/// 模型注册表的兜底参数（对齐 `FALLBACK_MODEL_PARAMS`）。
///
/// `src/core/utils/modelConfig.ts` 的 `MODEL_CONFIGS` 当前三条（`deepseek-flash` /
/// `deepseek-v4-flash` / `deepseek-v4-pro`）参数与兜底完全相同，因此这里直接用兜底
/// 常量。**注册表出现与兜底不同的条目时必须补一张同名表**（见 `DIFF.md` 第 3.4 节）。
pub const FALLBACK_CONTEXT_WINDOW: u64 = 1024 * 1024;
pub const FALLBACK_MAX_OUTPUT_TOKENS: u64 = 384 * 1024;

/// 单个模型在 `modelConfigs` 里的配置（对齐 `normalizeModelTokenLimits`）。
///
/// 只有正数才视为「已存在」的限值；`apiType` 只接受显式来源（面板传值 > 已有值），
/// **不会**自动填充默认值——未配置 `apiType` 的模型要由「自动获取」探测后写入，
/// 否则探测会被跳过。
pub fn normalize_model_token_limits(
    models: &[String],
    existing: Option<&Value>,
    api_type_overrides: Option<&Value>,
) -> Value {
    let is_valid_limit = |value: Option<&Value>| -> Option<u64> {
        value
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && *number > 0.0)
            .map(|number| number as u64)
    };

    let mut result: Map<String, Value> = Map::new();

    // 1. 保留已有且合法的条目（含不在本次模型列表中的历史条目）
    if let Some(Value::Object(existing)) = existing {
        for (model, limits) in existing {
            let Some(limits) = limits.as_object() else {
                continue;
            };
            let mut entry = Map::new();
            if let Some(context) = is_valid_limit(limits.get("context")) {
                entry.insert("context".to_string(), json!(context));
            }
            if let Some(output) = is_valid_limit(limits.get("output")) {
                entry.insert("output".to_string(), json!(output));
            }
            if let Some(api_type) = limits.get("apiType") {
                entry.insert("apiType".to_string(), json!(normalize_api_type(api_type)));
            }
            if !entry.is_empty() {
                result.insert(model.clone(), Value::Object(entry));
            }
        }
    }

    // 2. 为本次模型列表里的每个模型补齐缺失的 context/output
    for raw_model in models {
        let model = util::js_trim(raw_model);
        if model.is_empty() {
            continue;
        }
        let mut entry = result
            .get(model)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if !entry.contains_key("context") {
            entry.insert("context".to_string(), json!(FALLBACK_CONTEXT_WINDOW));
        }
        if !entry.contains_key("output") {
            entry.insert("output".to_string(), json!(FALLBACK_MAX_OUTPUT_TOKENS));
        }
        // 面板传值优先于已有值
        if let Some(api_type) = api_type_overrides
            .and_then(Value::as_object)
            .and_then(|map| map.get(model))
        {
            entry.insert("apiType".to_string(), json!(normalize_api_type(api_type)));
        }
        result.insert(model.to_string(), Value::Object(entry));
    }

    Value::Object(result)
}

/// 规范化 provider 的 `models`：只留非空字符串、去重、保序（对齐 `normalizeProviderModels`）
fn normalize_models(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut models: Vec<String> = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            continue;
        };
        let trimmed = util::js_trim(text);
        if trimmed.is_empty() || models.iter().any(|existing| existing == trimmed) {
            continue;
        }
        models.push(trimmed.to_string());
    }
    models
}

/// provider 的默认模型（`defaultModel`，缺失时取 `models[0]`）
fn provider_default_model(provider: &Value) -> String {
    if let Some(default_model) = provider.get("defaultModel").and_then(Value::as_str) {
        if !default_model.is_empty() {
            return default_model.to_string();
        }
    }
    provider
        .get("models")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 有效的 active provider key（provider 不存在或没有 baseURL 时返回空串）
fn active_provider_key(cfg: &Value) -> String {
    let Some(raw) = cfg
        .get("llm")
        .and_then(|llm| llm.get("activeProvider"))
        .and_then(Value::as_str)
    else {
        return String::new();
    };
    let has_base_url = cfg
        .get("llm")
        .and_then(|llm| llm.get("providers"))
        .and_then(|providers| providers.get(raw))
        .and_then(|provider| provider.get("baseURL"))
        .map(|value| value.is_string())
        .unwrap_or(false);
    if has_base_url {
        raw.to_string()
    } else {
        String::new()
    }
}

/// 解析模型身份（对齐 `resolveModelRef`）：provider 不存在 → 回落 active provider；
/// 模型不在该 provider 的列表里 → 用该 provider 的默认模型（再不行取第一个）。
pub fn resolve_model_ref(cfg: &Value, provider: &str, model: &str) -> Option<(String, String)> {
    let active_key = active_provider_key(cfg);
    let active_ref = if active_key.is_empty() {
        None
    } else {
        let default_model = cfg
            .get("llm")
            .and_then(|llm| llm.get("providers"))
            .and_then(|providers| providers.get(&active_key))
            .map(provider_default_model)
            .unwrap_or_default();
        Some((active_key.clone(), default_model))
    };

    if provider.is_empty() && model.is_empty() {
        return active_ref;
    }

    let provider_value = cfg
        .get("llm")
        .and_then(|llm| llm.get("providers"))
        .and_then(|providers| providers.get(provider));
    let Some(provider_value) = provider_value else {
        return active_ref;
    };
    if !provider_value
        .get("baseURL")
        .map(Value::is_string)
        .unwrap_or(false)
    {
        return active_ref;
    }

    let models = normalize_models(provider_value.get("models"));
    if models.is_empty() {
        let fallback = if model.is_empty() {
            provider_default_model(provider_value)
        } else {
            model.to_string()
        };
        return Some((provider.to_string(), fallback));
    }
    if !model.is_empty() && models.iter().any(|existing| existing == model) {
        return Some((provider.to_string(), model.to_string()));
    }
    let default_model = provider_default_model(provider_value);
    let chosen = if !default_model.is_empty() {
        default_model
    } else {
        models.first().cloned().unwrap_or_default()
    };
    Some((provider.to_string(), chosen))
}

/// `UiRequest.llmConfigSaveRequested`：把设置面板的保存载荷落进全局 `settings.json`。
///
/// 返回宿主组装 `llmConfigSaved` / `setModels` 所需的事实：
/// 保存后的默认值、provider 分组、以及**当前会话**解析后的模型身份
/// （解析结果与旧身份不同时会同步写进会话 `meta.json`）。
pub fn apply_llm_config_save(payload: &Value) -> Result<Value, String> {
    let mut cfg = config::settings_json_uncached();
    if !cfg.is_object() {
        cfg = json!({});
    }

    let string_field = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_string);
    let save_providers = payload
        .get("saveProviders")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // ---- 1. provider 表 ----
    if save_providers {
        let providers = payload.get("providers").and_then(Value::as_array);
        if let Some(providers) = providers.filter(|items| !items.is_empty()) {
            let mut providers_map: Map<String, Value> = Map::new();
            for provider in providers {
                // `p.baseURL.trim()` / `p.apiKey.trim()`：JS 空白口径
                let base_url = provider
                    .get("baseURL")
                    .and_then(Value::as_str)
                    .map(util::js_trim)
                    .unwrap_or("");
                let api_key = provider
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(util::js_trim)
                    .unwrap_or("");
                // 缺 baseURL 或 apiKey 的条目整条跳过（对齐 TS 的 `continue`）
                if base_url.is_empty() || api_key.is_empty() {
                    continue;
                }
                let key = provider_key_from_base_url(&base_url);
                if key.is_empty() {
                    continue;
                }
                let models = normalize_models(provider.get("models"));
                let old_model_configs = cfg
                    .get("llm")
                    .and_then(|llm| llm.get("providers"))
                    .and_then(|map| map.get(&key))
                    .and_then(|old| old.get("modelConfigs"))
                    .cloned();
                let model_configs = normalize_model_token_limits(
                    &models,
                    old_model_configs.as_ref(),
                    provider.get("modelApiTypes"),
                );
                let mut entry = Map::new();
                entry.insert("baseURL".to_string(), json!(base_url));
                entry.insert("apiKey".to_string(), json!(api_key));
                entry.insert("models".to_string(), json!(models));
                entry.insert("modelConfigs".to_string(), model_configs);
                if let Some(default_model) = provider
                    .get("defaultModel")
                    .and_then(Value::as_str)
                    .map(util::js_trim)
                    .filter(|value| !value.is_empty())
                {
                    entry.insert("defaultModel".to_string(), json!(default_model));
                }
                providers_map.insert(key, Value::Object(entry));
            }
            if !providers_map.is_empty() {
                let requested = payload
                    .get("activeProvider")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let active_key = if !requested.is_empty() && providers_map.contains_key(requested) {
                    requested.to_string()
                } else {
                    providers_map.keys().next().cloned().unwrap_or_default()
                };
                let llm = cfg
                    .as_object_mut()
                    .expect("checked above")
                    .entry("llm".to_string())
                    .or_insert_with(|| json!({}));
                if !llm.is_object() {
                    *llm = json!({});
                }
                llm["providers"] = Value::Object(providers_map);
                llm["activeProvider"] = json!(active_key);
            }
        }
    }

    // ---- 2. 无论是否改了 provider，都补齐所有 provider 的 context/output ----
    if let Some(providers) = cfg
        .get_mut("llm")
        .and_then(|llm| llm.get_mut("providers"))
        .and_then(Value::as_object_mut)
    {
        let keys: Vec<String> = providers.keys().cloned().collect();
        for key in keys {
            let Some(provider) = providers.get_mut(&key).and_then(Value::as_object_mut) else {
                continue;
            };
            let models = normalize_models(provider.get("models"));
            let existing = provider.get("modelConfigs").cloned();
            let next = normalize_model_token_limits(&models, existing.as_ref(), None);
            provider.insert("modelConfigs".to_string(), next);
        }
    }

    // ---- 3. 顶层默认值（只在变化时写）----
    let llm_object = cfg
        .as_object_mut()
        .expect("checked above")
        .entry("llm".to_string())
        .or_insert_with(|| json!({}));
    if !llm_object.is_object() {
        *llm_object = json!({});
    }
    if let Some(web_search) = payload.get("webSearch").and_then(Value::as_bool) {
        if llm_object.get("webSearch").and_then(Value::as_bool) != Some(web_search) {
            llm_object["webSearch"] = json!(web_search);
        }
    }
    if let Some(effort) = string_field("thinkingEffort").filter(|value| !value.is_empty()) {
        if llm_object.get("thinking_effort").and_then(Value::as_str) != Some(effort.as_str()) {
            llm_object["thinking_effort"] = json!(effort);
        }
    }
    if let Some(mode) = string_field("defaultAgentMode").filter(|value| !value.is_empty()) {
        if cfg.get("defaultAgentMode").and_then(Value::as_str) != Some(mode.as_str()) {
            cfg["defaultAgentMode"] = json!(mode);
        }
    }
    if let Some(mode) = string_field("defaultPromptMode")
        .filter(|value| matches!(value.as_str(), "normal" | "minimal" | "mixed"))
    {
        if cfg.get("defaultPromptMode").and_then(Value::as_str) != Some(mode.as_str()) {
            cfg["defaultPromptMode"] = json!(mode);
        }
    }
    if let Some(language) = string_field("language")
        .filter(|value| matches!(value.as_str(), "auto" | "zh" | "en"))
    {
        if cfg.get("uiLanguage").and_then(Value::as_str) != Some(language.as_str()) {
            if language == "auto" {
                // auto 是默认值：显式配置过才需要删掉
                if let Some(object) = cfg.as_object_mut() {
                    if object.contains_key("uiLanguage") {
                        object.remove("uiLanguage");
                    }
                }
            } else {
                cfg["uiLanguage"] = json!(language);
            }
        }
    }

    // ---- 4. MCP 默认启用列表（设置面板「默认配置」）----
    if let Some(servers) = payload.get("mcpServers").and_then(Value::as_array) {
        let names: Vec<String> = servers
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        mcp_config::apply_mcp_defaults(&mut cfg, &names);
    }

    config::replace_settings_json(&cfg)?;

    // 语言设置变了就重新收敛 core locale（对齐 Embedded 保存配置后的
    // `setCoreUiLanguage`）；MCP 默认列表变了就让所有已注册会话重同步连接。
    if let Some(language) = cfg
        .get("uiLanguage")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("language")
                .and_then(Value::as_str)
                .filter(|value| *value == "auto")
                .map(str::to_string)
        })
    {
        crate::i18n::set_core_ui_language(&language);
    }
    if payload.get("mcpServers").is_some() {
        crate::mcp::sync_all_sessions();
    }

    // ---- 5. 组装保存结果 ----
    let llm = cfg.get("llm").cloned().unwrap_or_else(|| json!({}));
    let active_provider = active_provider_key(&cfg);
    let default_model = if active_provider.is_empty() {
        String::new()
    } else {
        llm.get("providers")
            .and_then(|providers| providers.get(&active_provider))
            .map(provider_default_model)
            .unwrap_or_default()
    };
    let mut groups: Vec<Value> = Vec::new();
    if let Some(providers) = llm.get("providers").and_then(Value::as_object) {
        for (key, provider) in providers {
            groups.push(json!({ "key": key, "models": normalize_models(provider.get("models")) }));
        }
    }

    // 当前会话的模型身份：provider 或模型失效时解析出可用身份并写回会话
    let session_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != "undefined")
        .map(str::to_string);
    let requested_provider = payload
        .get("currentProvider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let requested_model = payload
        .get("currentModel")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (active_model, active_model_provider) = match &session_id {
        Some(session_id) => {
            let stored = if !requested_provider.is_empty() || !requested_model.is_empty() {
                Some((requested_provider.clone(), requested_model.clone()))
            } else {
                // webview 没回传时读会话 meta.json 里保存的模型身份
                let (provider, model) = history::model_ref_of_session(
                    session_id,
                    &history::project_of_session(session_id).unwrap_or_default(),
                );
                provider.map(|provider| (provider, model.unwrap_or_default()))
            };
            let resolved = match &stored {
                Some((provider, model)) => resolve_model_ref(&cfg, provider, model),
                None => resolve_model_ref(&cfg, "", ""),
            };
            if let Some((provider, model)) = &resolved {
                if let Some(stored) = &stored {
                    if stored.0 != *provider || stored.1 != *model {
                        if let Ok(project) = config::project_root(session_id) {
                            let _ = history::update_context(
                                session_id,
                                &project,
                                &[
                                    json!({ "key": "model", "value": model }),
                                    json!({ "key": "provider", "value": provider }),
                                ],
                            );
                        }
                    }
                }
                (model.clone(), provider.clone())
            } else {
                (String::new(), String::new())
            }
        }
        None => (String::new(), String::new()),
    };

    Ok(json!({
        "model": default_model,
        "modelProvider": active_provider,
        "activeProvider": active_provider,
        "thinkingEffort": llm
            .get("thinking_effort")
            .and_then(Value::as_str)
            .unwrap_or("off"),
        "agentMode": cfg
            .get("defaultAgentMode")
            .and_then(Value::as_str)
            .unwrap_or("risk"),
        "promptMode": cfg
            .get("defaultPromptMode")
            .and_then(Value::as_str)
            .unwrap_or("normal"),
        "webSearch": llm.get("webSearch").and_then(Value::as_bool).unwrap_or(true),
        "providers": groups,
        "activeModel": active_model,
        "activeModelProvider": active_model_provider,
    }))
}

#[cfg(test)]
#[path = "llm_config_tests.rs"]
mod tests;
