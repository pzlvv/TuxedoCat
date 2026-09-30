use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use super::*;
use crate::test_support::{serial, Sandbox};

/// 与 Embedded 共用同一份对照表（`src/test/fixtures/skillsParity.json`）。
///
/// TS 侧断言「本表 == Embedded `frontmatterParser` / `variableResolver` /
/// `formatSkillListing`」；这里断言「Rust `skills::*` == 本表」。
const FIXTURE: &str = include_str!("../../src/test/fixtures/skillsParity.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("skillsParity.json 解析失败")
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().map(util::js_string).collect())
        .unwrap_or_default()
}

// ==================== 对照表 ====================

mod parity_tests {
    use super::*;

    #[test]
    fn frontmatter_parity() {
        let fixture = fixture();
        for case in fixture["frontmatter"].as_array().unwrap() {
            let content = case["content"].as_str().unwrap();
            let (frontmatter, body) = parse_frontmatter(content);
            let expected: Map<String, Value> =
                serde_json::from_value(case["frontmatter"].clone()).unwrap();
            assert_eq!(
                frontmatter, expected,
                "frontmatter 不一致，输入: {content:?}"
            );
            assert_eq!(
                body,
                case["body"].as_str().unwrap(),
                "正文不一致，输入: {content:?}"
            );
        }
    }

    #[test]
    fn skill_frontmatter_fields_parity() {
        let fixture = fixture();
        for case in fixture["fields"].as_array().unwrap() {
            let frontmatter: Map<String, Value> =
                serde_json::from_value(case["frontmatter"].clone()).unwrap();
            let markdown = case["markdown"].as_str().unwrap();
            let parsed = parse_skill_frontmatter_fields(&frontmatter, markdown, "Skill");
            let expected = &case["result"];

            assert_eq!(
                parsed.description,
                expected["description"].as_str().unwrap(),
                "description 不一致: {frontmatter:?}"
            );
            assert_eq!(
                parsed.has_user_specified_description,
                expected["hasUserSpecifiedDescription"].as_bool().unwrap()
            );
            assert_eq!(
                parsed.user_invocable,
                expected["userInvocable"].as_bool().unwrap()
            );
            assert_eq!(
                parsed.argument_names,
                string_list(&expected["argumentNames"]),
                "argumentNames 不一致: {frontmatter:?}"
            );
            assert_eq!(
                parsed.when_to_use,
                expected["whenToUse"].as_str().map(str::to_string)
            );
            assert_eq!(
                parsed.version,
                expected["version"].as_str().map(str::to_string)
            );
            assert_eq!(parsed.model, expected["model"].as_str().map(str::to_string));
            assert_eq!(
                parsed.display_name,
                expected["displayName"].as_str().map(str::to_string)
            );
            assert_eq!(
                parsed.paths,
                expected["paths"]
                    .as_array()
                    .map(|items| items.iter().map(util::js_string).collect::<Vec<_>>())
            );
        }
    }

    #[test]
    fn description_extraction_parity() {
        let fixture = fixture();
        for case in fixture["descriptions"].as_array().unwrap() {
            let markdown = case["markdown"].as_str().unwrap();
            assert_eq!(
                extract_description_from_markdown(markdown, "Skill"),
                case["result"].as_str().unwrap(),
                "描述提取不一致，输入: {markdown:?}"
            );
        }
    }

    #[test]
    fn skill_paths_parity() {
        let fixture = fixture();
        for case in fixture["paths"].as_array().unwrap() {
            let value = &case["value"];
            let expected = case["result"].as_array().map(|items| {
                items.iter().map(util::js_string).collect::<Vec<_>>()
            });
            assert_eq!(
                parse_skill_paths(Some(value)),
                expected,
                "paths 不一致，输入: {value:?}"
            );
        }
    }

    #[test]
    fn argument_names_parity() {
        let fixture = fixture();
        for case in fixture["argumentNames"].as_array().unwrap() {
            assert_eq!(
                parse_argument_names(Some(&case["value"])),
                string_list(&case["result"]),
                "argumentNames 不一致，输入: {:?}",
                case["value"]
            );
        }
    }

    #[test]
    fn boolean_frontmatter_parity() {
        let fixture = fixture();
        for case in fixture["booleans"].as_array().unwrap() {
            assert_eq!(
                parse_boolean_frontmatter(Some(&case["value"])),
                case["result"].as_bool().unwrap(),
                "布尔解析不一致，输入: {:?}",
                case["value"]
            );
        }
    }

    #[test]
    fn coerce_description_parity() {
        let fixture = fixture();
        for case in fixture["coerce"].as_array().unwrap() {
            assert_eq!(
                coerce_description_to_string(Some(&case["value"])),
                case["result"].as_str().map(str::to_string),
                "描述归一化不一致，输入: {:?}",
                case["value"]
            );
        }
    }

    /// 变量替换：`$ARGUMENTS` / `$0` / `${name}` / `$name\b`，以及 JS 替换串里的
    /// `$$` / `$&` 特殊模式（`args: "$& literal"` 那条是回归用例）。
    #[test]
    fn substitute_arguments_parity() {
        let fixture = fixture();
        for case in fixture["substituteArguments"].as_array().unwrap() {
            let content = case["content"].as_str().unwrap();
            let args = case["args"].as_str().unwrap();
            let arg_names = string_list(&case["argNames"]);
            assert_eq!(
                substitute_arguments(content, args, &arg_names),
                case["result"].as_str().unwrap(),
                "变量替换不一致，content={content:?} args={args:?} argNames={arg_names:?}"
            );
        }
    }

    #[test]
    fn positional_args_parity() {
        let fixture = fixture();
        for case in fixture["positional"].as_array().unwrap() {
            let args = case["args"].as_str().unwrap();
            let count = case["count"].as_u64().unwrap() as usize;
            assert_eq!(
                parse_positional_args(args, count),
                string_list(&case["result"]),
                "位置参数解析不一致，args={args:?} count={count}"
            );
        }
    }

    #[test]
    fn builtin_variables_parity() {
        let fixture = fixture();
        for case in fixture["builtinVariables"].as_array().unwrap() {
            let content = case["content"].as_str().unwrap();
            let skill_dir = case["skillDir"].as_str();
            let session_id = case["sessionId"].as_str();
            assert_eq!(
                substitute_builtin_variables(content, skill_dir, session_id),
                case["result"].as_str().unwrap(),
                "内置变量替换不一致，输入: {content:?}"
            );
        }
    }

    #[test]
    fn skill_listing_parity() {
        let fixture = fixture();
        for case in fixture["skillListing"].as_array().unwrap() {
            let skills: Vec<SkillCommand> = case["skills"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| SkillCommand {
                    name: item["name"].as_str().unwrap().to_string(),
                    description: item["description"].as_str().unwrap().to_string(),
                    aliases: Vec::new(),
                    arg_names: Vec::new(),
                    when_to_use: item["whenToUse"].as_str().map(str::to_string),
                    model: None,
                    user_invocable: item["userInvocable"].as_bool().unwrap(),
                    skill_root: None,
                    source: SkillSource::Bundled,
                    loaded_from: LoadedFrom::Bundled,
                    is_hidden: item["isHidden"].as_bool().unwrap(),
                    version: None,
                    get_prompt_for_command: Arc::new(|_| Vec::new()),
                })
                .collect();
            assert_eq!(
                format_skill_listing(&skills),
                case["result"].as_str().unwrap()
            );
        }
    }
}

// ==================== 单测（不依赖 Embedded） ====================

mod unit_tests {
    use super::*;

    #[test]
    fn available_skills_section_matches_environment_text() {
        let skills = vec![SkillCommand {
            name: "commit".to_string(),
            description: "Create a git commit".to_string(),
            aliases: Vec::new(),
            arg_names: Vec::new(),
            when_to_use: Some("When asked".to_string()),
            model: None,
            user_invocable: true,
            skill_root: None,
            source: SkillSource::Bundled,
            loaded_from: LoadedFrom::Bundled,
            is_hidden: false,
            version: None,
            get_prompt_for_command: Arc::new(|_| Vec::new()),
        }];
        let section = available_skills_section(&skills);
        assert!(section.starts_with("## Available Skills\n\n"));
        assert!(section.contains("- commit: Create a git commit - When asked"));
        assert!(section.contains("To invoke a skill, use the Skill tool"));
        // 无技能时返回空串（环境段不追加空区块）
        assert_eq!(available_skills_section(&[]), "");
    }

    #[test]
    fn commit_skill_prompt_and_args() {
        let definition = commit_skill_definition();
        assert_eq!(definition.name, "commit");
        let blocks = (definition.get_prompt_for_command)("");
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.starts_with("## Context\n\n- Current git status: run `git status`"));
        assert!(text.ends_with("Do not use any other tools or do anything else."));

        let with_args = (commit_skill_definition().get_prompt_for_command)("  -m 'Fix bug'  ");
        let text = with_args[0]["text"].as_str().unwrap();
        assert!(text.ends_with("## Additional instructions from user\n\n-m 'Fix bug'"));

        // 纯空白参数不追加
        let blank = (commit_skill_definition().get_prompt_for_command)("   ");
        assert!(!blank[0]["text"].as_str().unwrap().contains("Additional instructions"));
    }

    #[test]
    fn create_skill_command_prepends_base_dir_and_substitutes() {
        let command = create_skill_command(CreateSkillCommandParams {
            skill_name: "review".to_string(),
            description: "Review code".to_string(),
            markdown_content: "Review $ARGUMENTS in ${SKILL_DIR}".to_string(),
            argument_names: vec!["target".to_string()],
            when_to_use: None,
            version: None,
            model: None,
            user_invocable: true,
            source: SkillSource::Project,
            base_dir: Some("/tmp/skills/review".to_string()),
            loaded_from: LoadedFrom::Skills,
        });
        assert_eq!(command.name, "review");
        assert_eq!(command.source, SkillSource::Project);
        assert_eq!(command.loaded_from, LoadedFrom::Skills);
        assert_eq!(command.skill_root.as_deref(), Some("/tmp/skills/review"));
        assert!(!command.is_hidden);

        let blocks = command.prompt_for_command("main.rs");
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.starts_with("Base directory for this skill: /tmp/skills/review\n\n"));
        // `${SKILL_DIR}` 由 createSkillCommand 一层替换（sessionId 留到工具层）
        assert!(text.contains("Review main.rs in /tmp/skills/review"));
    }

    #[test]
    fn non_user_invocable_skill_is_hidden() {
        let command = create_skill_command(CreateSkillCommandParams {
            skill_name: "internal".to_string(),
            description: "Internal".to_string(),
            markdown_content: "Body".to_string(),
            argument_names: Vec::new(),
            when_to_use: None,
            version: None,
            model: None,
            user_invocable: false,
            source: SkillSource::User,
            base_dir: None,
            loaded_from: LoadedFrom::Skills,
        });
        assert!(command.is_hidden);
        assert_eq!(format_skill_listing(&[command]), "");
    }

    #[test]
    fn resolve_skill_file_path_rejects_escapes() {
        let base = Path::new("/tmp/skill");
        assert!(resolve_skill_file_path(base, "refs/a.md").is_ok());
        assert!(resolve_skill_file_path(base, "refs/../a.md").is_err());
        assert!(resolve_skill_file_path(base, "..\\evil.md").is_err());
        assert!(resolve_skill_file_path(base, "/abs.md").is_err());
    }

    #[test]
    fn bundled_skill_registers_and_ignores_command_conflicts() {
        let _guard = serial();
        reset_registries();

        // `commit` 与内置命令 `spin` / `sprint` 不冲突 → 正常注册
        ensure_builtins();
        let names: Vec<String> = bundled_skills().iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["commit".to_string()]);

        // 与内置命令同名 → 忽略
        register_bundled_skill(BundledSkillDefinition {
            name: "spin".to_string(),
            description: "conflicting".to_string(),
            aliases: Vec::new(),
            when_to_use: None,
            model: None,
            user_invocable: None,
            files: Vec::new(),
            get_prompt_for_command: Arc::new(|_| Vec::new()),
        });
        assert_eq!(bundled_skills().len(), 1);

        // 别名冲突同样忽略
        register_bundled_skill(BundledSkillDefinition {
            name: "not-spin".to_string(),
            description: "conflicting by alias".to_string(),
            aliases: vec!["sprint".to_string()],
            when_to_use: None,
            model: None,
            user_invocable: None,
            files: Vec::new(),
            get_prompt_for_command: Arc::new(|_| Vec::new()),
        });
        assert_eq!(bundled_skills().len(), 1);

        reset_registries();
    }

    #[test]
    fn bundled_skill_extracts_files_on_first_prompt() {
        // `Sandbox::new` 自带串行锁并写好了宿主环境（含 configDirName）
        let _sandbox = Sandbox::new("skills-extract");
        reset_registries();

        register_bundled_skill(BundledSkillDefinition {
            name: "with-files".to_string(),
            description: "has reference files".to_string(),
            aliases: Vec::new(),
            when_to_use: None,
            model: None,
            user_invocable: None,
            files: vec![
                ("refs/guide.md".to_string(), "guide body".to_string()),
                ("top.md".to_string(), "top body".to_string()),
            ],
            get_prompt_for_command: Arc::new(|_| vec![json!({ "type": "text", "text": "Body" })]),
        });

        let skill = bundled_skills()
            .into_iter()
            .find(|skill| skill.name == "with-files")
            .expect("skill 未注册");

        let extract_dir = skill.skill_root.clone().expect("应给出提取目录");
        assert!(extract_dir.ends_with("with-files"));
        assert!(!Path::new(&extract_dir).exists(), "首次调用前不应提取");

        let blocks = skill.prompt_for_command("");
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(
            text.starts_with(&format!("Base directory for this skill: {extract_dir}\n\nBody")),
            "实际: {text:?}"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&extract_dir).join("refs/guide.md")).unwrap(),
            "guide body"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&extract_dir).join("top.md")).unwrap(),
            "top body"
        );

        // 二次调用复用同一目录（`O_EXCL` 保证不覆盖，也不报错）
        let again = skill.prompt_for_command("");
        assert!(again[0]["text"].as_str().unwrap().contains("Body"));

        reset_registries();
    }

    #[test]
    fn loads_skills_from_config_dir() {
        let sandbox = Sandbox::new("skills-dir");
        reset_registries();

        // 用户级 `<configHome>/skills/<name>/SKILL.md`
        let user_skill_dir = sandbox.home.join(&sandbox.config_dir_name).join("skills").join("user-skill");
        std::fs::create_dir_all(&user_skill_dir).unwrap();
        std::fs::write(
            user_skill_dir.join("SKILL.md"),
            "---\ndescription: User level skill\nwhen_to_use: When user asks\n---\n\nBody line\n",
        )
        .unwrap();

        // 项目级 `<cwd>/<configDir>/skills/<name>/SKILL.md`
        let project_dir = sandbox.root.join("project");
        let project_skill_dir = project_dir
            .join(&sandbox.config_dir_name)
            .join("skills")
            .join("proj-skill");
        std::fs::create_dir_all(&project_skill_dir).unwrap();
        std::fs::write(
            project_skill_dir.join("SKILL.md"),
            "Project body only\n",
        )
        .unwrap();

        // 没有 SKILL.md 的目录被跳过；非目录项被跳过
        std::fs::create_dir_all(sandbox.home.join(&sandbox.config_dir_name).join("skills").join("empty")).unwrap();
        std::fs::write(
            sandbox.home.join(&sandbox.config_dir_name).join("skills").join("loose.md"),
            "not a dir",
        )
        .unwrap();

        let skills = get_skill_dir_commands(&project_dir.to_string_lossy());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["user-skill", "proj-skill"], "user 在前、project 在后");

        let user_skill = &skills[0];
        assert_eq!(user_skill.source, SkillSource::User);
        assert_eq!(user_skill.description, "User level skill");
        assert_eq!(user_skill.when_to_use.as_deref(), Some("When user asks"));
        assert_eq!(user_skill.arg_names, Vec::<String>::new());

        let project_skill = &skills[1];
        assert_eq!(project_skill.source, SkillSource::Project);
        // 无 description → 从正文首段提取
        assert_eq!(project_skill.description, "Project body only");

        // `get_all_skills` = 内置 + 文件系统
        let all = get_all_skills(&project_dir.to_string_lossy());
        let all_names: Vec<&str> = all.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(all_names, vec!["commit", "user-skill", "proj-skill"]);

        // 按名称 / 别名 / 前导 `/` 查找
        assert!(find_skill("commit", ".").is_some());
        assert!(find_skill("/commit", ".").is_some());
        assert!(find_skill("  commit  ", ".").is_some());
        assert!(find_skill("//commit", ".").is_none(), "只去掉一个前导 /");
        assert!(find_skill("nope", ".").is_none());

        reset_registries();
    }
}
