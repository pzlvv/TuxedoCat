//! `config` 的单元测试：配置目录、settings.json、工作目录表、provider 解析。

use super::*;
use crate::test_support::Sandbox;
use serde_json::json;

#[test]
fn encode_uri_component_keeps_unreserved_and_escapes_rest() {
    assert_eq!(encode_uri_component("abcXYZ019"), "abcXYZ019");
    assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    assert_eq!(encode_uri_component(r"D:\git\TuxedoCat"), "D%3A%5Cgit%5CTuxedoCat");
    assert_eq!(encode_uri_component("a b"), "a%20b");
    assert_eq!(encode_uri_component("中文"), "%E4%B8%AD%E6%96%87");
}

#[test]
fn decode_project_dir_name_round_trips_percent_encoding() {
    assert_eq!(
        decode_project_dir_name("D%3A%5Cgit%5CTuxedoCat").as_deref(),
        Some(r"D:\git\TuxedoCat")
    );
    assert_eq!(
        decode_project_dir_name("%E4%B8%AD%E6%96%87").as_deref(),
        Some("中文")
    );
    assert_eq!(decode_project_dir_name("a%20b").as_deref(), Some("a b"));
    // 非法转义（`decodeURIComponent` 会抛错）：返回 None
    assert_eq!(decode_project_dir_name("bad%ZZ"), None);
    assert_eq!(decode_project_dir_name("trunc%2"), None);
}

#[test]
fn ensure_project_conversation_dir_announces_once_and_backfills() {
    // 对齐 Embedded `ensureProjectConversationDir` → `notifyProjectConversationDirReady`：
    // 每个项目对话目录只上报一次（`ensuredProjectDirs` 缓存），宿主据此写目录里的
    // settings.json；`ensureConfigDirs` 还会为已存在的旧目录补上报一次。
    // 注：`Sandbox::new` 内部已持有 `serial()` 锁，这里不能再取（不可重入）。
    let sandbox = Sandbox::new("config-dir-ready");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let announced: std::sync::Arc<Mutex<Vec<(String, String)>>> =
        std::sync::Arc::new(Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&announced);
    set_project_dir_ready_sink(std::sync::Arc::new(move |dir, workspace| {
        sink.lock().unwrap().push((dir, workspace));
    }));

    let hits = || -> Vec<(String, String)> {
        announced
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, workspace)| workspace == &project)
            .cloned()
            .collect()
    };

    // 同一目录 ensure 两次只上报一次
    ensure_project_conversation_dir(&project).unwrap();
    ensure_project_conversation_dir(&project).unwrap();
    let first = hits();
    assert_eq!(first.len(), 1, "got {first:?}");
    assert!(!first[0].0.is_empty());

    // 目录名可反解成原始项目路径（宿主 settings.json 的记录口径）
    let dir_name = std::path::Path::new(&first[0].0)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert_eq!(decode_project_dir_name(&dir_name).as_deref(), Some(project.as_str()));

    // 模拟「目录是旧版本留下的」：清掉已上报集合后 backfill 应补上报一次
    *ANNOUNCED_PROJECT_DIRS.lock().unwrap() = None;
    ensure_config_dirs().unwrap();
    assert_eq!(hits().len(), 2, "backfill 未补上报");

    // 清掉出口，避免影响后续测试
    *PROJECT_DIR_READY_SINK.lock().unwrap() = None;
    *ANNOUNCED_PROJECT_DIRS.lock().unwrap() = None;
}

#[test]
fn host_environment_round_trips() {
    let sandbox = Sandbox::new("config-host-env");
    let env = host_environment().expect("host env");
    assert_eq!(env.locale, "zh-CN");
    assert_eq!(env.config_dir_name, sandbox.config_dir_name);
    assert!(!env.log_to_console);
    assert!(extension_path().is_ok());
}

#[test]
fn config_home_and_conversations_root_live_under_home() {
    let sandbox = Sandbox::new("config-home");
    assert_eq!(config_home().unwrap(), sandbox.home.join(&sandbox.config_dir_name));
    assert_eq!(
        conversations_root().unwrap(),
        sandbox.home.join(&sandbox.config_dir_name).join("conversations")
    );
    ensure_config_dirs().unwrap();
    assert!(conversations_root().unwrap().is_dir());
}

#[test]
fn project_conversation_dir_encodes_the_path() {
    let _sandbox = Sandbox::new("config-project-dir");
    let dir = project_conversation_dir(r"D:\repo\demo").unwrap();
    assert_eq!(dir.file_name().unwrap(), "D%3A%5Crepo%5Cdemo");
    assert!(dir.starts_with(conversations_root().unwrap()));
    let created = ensure_project_conversation_dir(r"D:\repo\demo").unwrap();
    assert!(created.is_dir());
}

#[test]
fn project_conversation_dir_hashes_overlong_names() {
    let _sandbox = Sandbox::new("config-project-long");
    let long = format!("D:\\{}\\verylongsegment", "x".repeat(300));
    let dir = project_conversation_dir(&long).unwrap();
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    assert!(name.len() <= 255, "name too long: {}", name.len());
    // `<sha256 前 16 位 hex>_<末级目录编码前 32 字符>`
    let (hash, tail) = name.split_once('_').unwrap();
    assert_eq!(hash.len(), 16);
    assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(tail, "verylongsegment");
    // 同一路径稳定，不同路径不碰撞
    assert_eq!(project_conversation_dir(&long).unwrap(), dir);
    assert_ne!(project_conversation_dir(&format!("{long}2")).unwrap(), dir);
}

#[test]
fn workspace_resolution_prefers_session_then_active() {
    let sandbox = Sandbox::new("config-workspace");
    assert!(project_root("s1").is_err(), "no workspace configured yet");

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    set_active_workspace(Some(workspace.clone()));
    assert_eq!(project_root("s1").unwrap(), workspace);

    set_session_workspace("s1", Some("D:/other".to_string()));
    assert_eq!(session_workspace("s1").as_deref(), Some("D:/other"));
    assert_eq!(project_root("s1").unwrap(), "D:/other");
    // 其它会话仍回退到活动工作目录
    assert_eq!(project_root("s2").unwrap(), workspace);

    set_session_workspace("s1", None);
    assert!(session_workspace("s1").is_none());
    assert_eq!(project_root("s1").unwrap(), workspace);
}

#[test]
fn empty_workspace_values_are_treated_as_absent() {
    let sandbox = Sandbox::new("config-workspace-empty");
    set_active_workspace(Some(String::new()));
    assert!(project_root("s1").is_err());

    set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    set_session_workspace("s1", Some(String::new()));
    assert!(session_workspace("s1").is_none());

    set_active_workspace(None);
    assert!(project_root("s1").is_err());
}

#[test]
fn settings_json_is_empty_object_when_file_missing() {
    let _sandbox = Sandbox::new("config-settings-missing");
    assert_eq!(settings_json(), json!({}));
    assert_eq!(default_agent_mode(), "risk");
    assert!(default_model().is_none());
}

#[test]
fn settings_json_reads_and_caches_then_reset_reloads() {
    let sandbox = Sandbox::new("config-settings-cache");
    sandbox.write_settings(json!({ "defaultAgentMode": "manual", "defaultModel": "gpt-x" }));
    assert_eq!(settings_json()["defaultAgentMode"], "manual");
    assert_eq!(default_agent_mode(), "manual");
    assert_eq!(default_model().as_deref(), Some("gpt-x"));

    // 直接改盘上的文件不会立刻生效（有缓存）
    std::fs::write(settings_path().unwrap(), json!({ "defaultAgentMode": "auto" }).to_string())
        .unwrap();
    assert_eq!(default_agent_mode(), "manual");

    reset_settings_cache();
    assert_eq!(default_agent_mode(), "auto");
}

#[test]
fn invalid_settings_json_falls_back_to_null() {
    let sandbox = Sandbox::new("config-settings-invalid");
    sandbox.write_settings(json!({ "defaultAgentMode": "manual" }));
    std::fs::write(settings_path().unwrap(), "{ not json").unwrap();
    reset_settings_cache();
    assert_eq!(settings_json(), json!({}));
    assert_eq!(default_agent_mode(), "risk");
}

#[test]
fn empty_default_model_is_ignored() {
    let sandbox = Sandbox::new("config-default-model");
    sandbox.write_settings(json!({ "defaultModel": "" }));
    assert!(default_model().is_none());
}

#[test]
fn normalize_workspace_trims_trailing_separators() {
    assert_eq!(normalize_workspace(r"D:\repo\"), r"D:\repo");
    assert_eq!(normalize_workspace("D:/repo//"), "D:/repo");
    assert_eq!(normalize_workspace("D:/repo"), "D:/repo");
    // 只有分隔符时保持原样，避免归一化成空串
    assert_eq!(normalize_workspace("   "), "   ");
    assert_eq!(normalize_workspace(""), "");
}

fn provider_settings() -> Value {
    json!({
        "llm": {
            "maxTokens": 2048,
            "activeProvider": "main",
            "providers": {
                "main": {
                    "baseURL": "https://api.example.com/v1/",
                    "apiKey": "sk-main",
                    "defaultModel": "model-a",
                    "modelConfigs": {
                        "model-a": { "apiType": "Anthropic", "output": 1024 }
                    }
                },
                "backup": {
                    "baseURL": "https://backup.example.com",
                    "apiKey": "sk-backup",
                    "models": ["model-b"]
                }
            }
        }
    })
}

#[test]
fn resolve_provider_uses_active_provider_and_model_config() {
    let sandbox = Sandbox::new("config-provider-active");
    sandbox.write_settings(provider_settings());
    let provider = resolve_provider(None, None).unwrap();
    assert_eq!(provider.base_url, "https://api.example.com/v1");
    assert_eq!(provider.api_key, "sk-main");
    assert_eq!(provider.model, "model-a");
    assert_eq!(provider.api_type, "Anthropic");
    assert_eq!(provider.max_tokens, 1024);
    assert_eq!(provider.thinking_budget_tokens, DEFAULT_THINKING_BUDGET);
    assert_eq!(provider.thinking_effort, "high");
    assert!(provider.web_search);
}

#[test]
fn resolve_provider_honours_overrides_and_falls_back_to_models_list() {
    let sandbox = Sandbox::new("config-provider-override");
    sandbox.write_settings(provider_settings());

    let provider = resolve_provider(Some("backup"), Some("model-b")).unwrap();
    assert_eq!(provider.base_url, "https://backup.example.com");
    assert_eq!(provider.model, "model-b");
    // 没有 modelConfigs → apiType 默认 OpenAI，maxTokens 取 llm.maxTokens
    assert_eq!(provider.api_type, "OpenAI");
    assert_eq!(provider.max_tokens, 2048);

    // model_override 是空白时回落到 provider 的 models[0]
    let provider = resolve_provider(Some("backup"), Some("   ")).unwrap();
    assert_eq!(provider.model, "model-b");

    // JS 空白口径（对齐 `modelRef.ts` 的 `model.trim()`）：U+FEFF 视为空白 → 回落；
    // U+0085 不视为空白 → 原样作为模型名。
    let provider = resolve_provider(Some("backup"), Some("\u{FEFF}")).unwrap();
    assert_eq!(provider.model, "model-b");
    let provider = resolve_provider(Some("backup"), Some("\u{0085}")).unwrap();
    assert_eq!(provider.model, "\u{0085}");

    // provider_override 是空串时回落 activeProvider
    let provider = resolve_provider(Some(""), None).unwrap();
    assert_eq!(provider.model, "model-a");
}

#[test]
fn resolve_provider_reports_missing_configuration() {
    let sandbox = Sandbox::new("config-provider-missing");
    // 「没有可用 provider」与「provider 没有 apiKey」在 Embedded 里落到同一条文案：
    // `getConfig` 在没有有效 activeProvider 时回退到空 apiKey 的兜底配置，
    // 最终抛的都是「API Key 未配置」（逐字对齐 `llm/config.ts`）。
    let api_key_message = format!(
        "API Key 未配置，无法调用 LLM。\n请在「设置 → LLM 配置」中填写 API Key，\n或编辑 ~/{}/settings.json 中对应 provider 的 apiKey 字段。",
        sandbox.config_dir_name
    );
    sandbox.write_settings(json!({}));
    assert_eq!(resolve_provider(None, None).unwrap_err(), api_key_message);

    sandbox.write_settings(json!({ "llm": { "activeProvider": "ghost" } }));
    assert_eq!(resolve_provider(None, None).unwrap_err(), api_key_message);

    // activeProvider 指向的 provider 缺 baseURL：Embedded 视作「没有有效 provider」
    sandbox.write_settings(json!({ "llm": { "activeProvider": "p", "providers": { "p": {} } } }));
    assert_eq!(resolve_provider(None, None).unwrap_err(), api_key_message);

    // 会话显式指定 provider 时走 `getConfigForProvider`，那条路径不做回退、直接报错
    assert_eq!(
        resolve_provider(Some("p"), None).unwrap_err(),
        "provider \"p\" 不存在或未配置 baseURL"
    );
    assert_eq!(
        resolve_provider(Some("ghost"), None).unwrap_err(),
        "provider \"ghost\" 不存在或未配置 baseURL"
    );

    // provider 有 baseURL 但没配模型：Embedded 允许 `model` 为空串（由服务端报错），
    // 这里同样不单独报「没有模型」，最终仍落到 API Key 文案（apiKey 未配置）。
    sandbox.write_settings(json!({ "llm": { "activeProvider": "p",
        "providers": { "p": { "baseURL": "https://x" } } } }));
    assert_eq!(resolve_provider(None, None).unwrap_err(), api_key_message);

    sandbox.write_settings(json!({ "llm": { "activeProvider": "p",
        "providers": { "p": { "baseURL": "https://x", "defaultModel": "m" } } } }));
    assert_eq!(resolve_provider(None, None).unwrap_err(), api_key_message);
}

/// provider 有 baseURL 与 apiKey、但没有任何模型来源时，模型解析为空串且**不**报错
/// （对齐 `getConfig`：`llm.model || provider.defaultModel || provider.models[0] || ''`）。
#[test]
fn resolve_provider_allows_an_empty_model_like_embedded() {
    let sandbox = Sandbox::new("config-provider-empty-model");
    sandbox.write_settings(json!({ "llm": { "activeProvider": "p",
        "providers": { "p": { "baseURL": "https://x", "apiKey": "sk" } } } }));
    let provider = resolve_provider(None, None).unwrap();
    assert_eq!(provider.model, "");
    assert_eq!(provider.base_url, "https://x");
    assert_eq!(provider.api_key, "sk");
    assert_eq!(provider.api_type, "OpenAI");
}

/// `llm.model`（顶层遗留字段）优先于 provider 的默认模型，但只在没有会话级
/// provider 覆盖时生效（对齐 `getDefaultConfig` 与 `getConfigForProvider` 的分叉）。
#[test]
fn resolve_provider_prefers_the_legacy_top_level_model() {
    let sandbox = Sandbox::new("config-provider-legacy-model");
    sandbox.write_settings(json!({ "llm": {
        "model": "legacy-model",
        "activeProvider": "p",
        "providers": { "p": {
            "baseURL": "https://x",
            "apiKey": "sk",
            "defaultModel": "provider-default",
            "models": ["m1"]
        } }
    } }));
    assert_eq!(resolve_provider(None, None).unwrap().model, "legacy-model");
    // 会话级 provider 覆盖时忽略 llm.model，用 provider 的默认模型
    assert_eq!(
        resolve_provider(Some("p"), None).unwrap().model,
        "provider-default"
    );
    // 会话级 model 覆盖仍然最高优先级
    assert_eq!(
        resolve_provider(Some("p"), Some("session-model")).unwrap().model,
        "session-model"
    );
}

#[test]
fn resolve_provider_defaults_max_tokens_and_thinking_flags() {
    let sandbox = Sandbox::new("config-provider-defaults");
    sandbox.write_settings(json!({
        "llm": {
            "activeProvider": "p",
            "thinking_budget_tokens": 512,
            "thinking_effort": "off",
            "webSearch": false,
            "providers": { "p": {
                "baseURL": "https://x", "apiKey": "k", "defaultModel": "m"
            } }
        }
    }));
    let provider = resolve_provider(None, None).unwrap();
    assert_eq!(provider.max_tokens, DEFAULT_MAX_TOKENS);
    // settings 里的 `thinking_budget_tokens` 只进日志：请求体的预算恒取模型注册表的
    // 192K（对齐 `RealApi` 的 `thinkingTokenBudget ?? getModelConfig(...).thinking_token_budget`，
    // 而 Query 从不传 `thinkingTokenBudget`）。
    assert_eq!(provider.thinking_budget_tokens, DEFAULT_THINKING_BUDGET);
    assert_eq!(provider.thinking_effort, "off");
    assert!(!provider.web_search);
}

#[test]
fn config_accessors_fail_before_host_environment_arrives() {
    // 这里要验证「宿主环境尚未下发」的分支，因此不能借用沙箱
    let _guard = crate::test_support::serial();
    let previous = host_environment();
    *HOST_ENV.lock().unwrap() = None;

    assert!(config_home().is_err());
    assert!(extension_path().is_err());
    assert!(conversations_root().is_err());
    assert!(settings_path().is_err());
    assert_eq!(settings_json(), json!({}));
    assert_eq!(default_agent_mode(), "risk");
    assert!(ensure_config_dirs().is_err());
    assert!(project_conversation_dir("D:/repo").is_err());

    if let Some(previous) = previous {
        set_host_environment(previous);
    }
}

#[test]
fn home_dir_prefers_userprofile_then_home() {
    let _guard = crate::test_support::serial();
    let previous_profile = std::env::var("USERPROFILE").ok();
    let previous_home = std::env::var("HOME").ok();

    std::env::set_var("USERPROFILE", r"C:\Users\primary");
    assert_eq!(home_dir().unwrap(), PathBuf::from(r"C:\Users\primary"));

    std::env::set_var("USERPROFILE", "");
    std::env::set_var("HOME", "/home/secondary");
    assert_eq!(home_dir().unwrap(), PathBuf::from("/home/secondary"));

    std::env::remove_var("USERPROFILE");
    std::env::remove_var("HOME");
    assert!(home_dir().unwrap_err().contains("home directory"));

    match previous_profile {
        Some(value) => std::env::set_var("USERPROFILE", value),
        None => std::env::remove_var("USERPROFILE"),
    }
    match previous_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
}

// ==================== settings.json 写入 ====================

#[test]
fn merge_json_patch_follows_rfc7386() {
    // 对象递归合并；`null` 删除该键；数组整体替换
    let mut target = json!({ "a": { "b": 1, "c": 2 }, "d": [1, 2], "e": "x" });
    merge_json_patch(&mut target, &json!({ "a": { "b": 9, "z": 3 }, "d": [3], "e": null }));
    assert_eq!(target, json!({ "a": { "b": 9, "c": 2, "z": 3 }, "d": [3] }));

    // 数组不做元素级合并
    let mut target = json!({ "list": [1, 2, 3] });
    merge_json_patch(&mut target, &json!({ "list": [9] }));
    assert_eq!(target, json!({ "list": [9] }));

    // 目标侧不是对象时整体替换
    let mut target = json!({ "a": 1 });
    merge_json_patch(&mut target, &json!({ "a": { "nested": true } }));
    assert_eq!(target, json!({ "a": { "nested": true } }));

    // 目标本身不是对象：按空对象起底
    let mut target = json!([1, 2]);
    merge_json_patch(&mut target, &json!({ "a": 1 }));
    assert_eq!(target, json!({ "a": 1 }));
}

#[test]
fn update_settings_json_merges_and_resets_the_cache() {
    let sandbox = Sandbox::new("config-settings-write");
    sandbox.write_settings(json!({ "llm": { "webSearch": true }, "uiLanguage": "zh" }));

    // 预热读缓存
    assert_eq!(settings_json()["uiLanguage"], "zh");

    let changed = update_settings_json(&json!({
        "llm": { "webSearch": false, "thinking_effort": "high" },
        "defaultAgentMode": "auto",
    }))
    .unwrap();
    assert!(changed);

    // 补丁合并进已有字段，未触及的字段保留
    assert_eq!(
        sandbox.read_settings(),
        json!({
            "llm": { "webSearch": false, "thinking_effort": "high" },
            "uiLanguage": "zh",
            "defaultAgentMode": "auto",
        })
    );
    // 写盘后读缓存已失效：`settings_json()` 立刻拿到新值
    assert_eq!(settings_json()["llm"]["webSearch"].as_bool(), Some(false));
    assert_eq!(settings_json()["llm"]["thinking_effort"], "high");
}

#[test]
fn update_settings_json_skips_a_no_op_patch() {
    let _sandbox = Sandbox::new("config-settings-noop");
    let path = settings_path().unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // 故意写一份紧凑格式：若发生重写，格式会变成 pretty（2 空格缩进）
    std::fs::write(&path, "{\"uiLanguage\":\"zh\"}").unwrap();
    reset_settings_cache();

    assert!(!update_settings_json(&json!({ "uiLanguage": "zh" })).unwrap());
    assert!(!update_settings_json(&json!({})).unwrap());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"uiLanguage\":\"zh\"}");

    // 缺失文件 + 空补丁：不创建文件
    let empty = std::env::temp_dir().join("standalone-core-no-settings.json");
    let _ = std::fs::remove_file(&empty);
}

#[test]
fn merge_highlight_languages_dedupes_and_caps() {
    let sandbox = Sandbox::new("config-highlight-languages");
    assert!(merge_highlight_languages(&["ts".to_string(), "tsx".to_string()]).unwrap());
    assert_eq!(sandbox.read_settings()["highlightLanguages"], json!(["ts", "tsx"]));

    // 已记录过的语言不重复写入
    assert!(!merge_highlight_languages(&["ts".to_string()]).unwrap());
    assert_eq!(sandbox.read_settings()["highlightLanguages"], json!(["ts", "tsx"]));

    // 空串（假值）跳过
    assert!(!merge_highlight_languages(&["".to_string()]).unwrap());

    // 超过上限（60）时丢弃最早记录
    let many: Vec<String> = (0..70).map(|index| format!("lang{index}")).collect();
    assert!(merge_highlight_languages(&many).unwrap());
    let settings = sandbox.read_settings();
    let list = settings["highlightLanguages"].as_array().unwrap();
    assert_eq!(list.len(), 60);
    assert_eq!(list.first().unwrap(), "lang10");
    assert_eq!(list.last().unwrap(), "lang69");
}

#[test]
fn write_project_settings_is_idempotent_and_readable() {
    let sandbox = Sandbox::new("config-project-settings");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let dir = project_conversation_dir(&project).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");

    write_project_settings(&dir, &project).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.starts_with("{\n  \"workspacePath\""), "got {text}");
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({ "workspacePath": project })
    );

    // 幂等：workspacePath 未变化时不重写（紧凑格式原样保留）
    std::fs::write(&path, "{\"workspacePath\":\"x\"}").unwrap();
    write_project_settings(&dir, "x").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"workspacePath\":\"x\"}");

    // 反查
    assert_eq!(project_settings_workspace_path(&dir).as_deref(), Some("x"));
    assert_eq!(
        project_settings_workspace_path(std::path::Path::new("no-such-dir")),
        None
    );

    // 文件内容不是对象（数组）时按空对象重建（对齐 Embedded 的 `!Array.isArray` 判定）
    std::fs::write(&path, "[1,2]").unwrap();
    write_project_settings(&dir, "y").unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).unwrap(),
        json!({ "workspacePath": "y" })
    );
}

#[test]
fn ensure_project_conversation_dir_writes_the_manifest() {
    // Standalone 下项目清单由 Core 写（`docs/standalone-core.md` 第 8 节）
    let sandbox = Sandbox::new("config-dir-manifest");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let dir = ensure_project_conversation_dir(&project).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &std::fs::read_to_string(dir.join("settings.json")).unwrap()
        )
        .unwrap(),
        json!({ "workspacePath": project })
    );
}
