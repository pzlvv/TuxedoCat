---
status: 已修
---

# 缺陷：联网搜索关闭后 WebSearch / WebFetch 仍可用

关闭会话「联网搜索」后，两个工具只是不再注入工具清单；系统提示词的 `## Tool Details`
仍无条件包含两工具的完整用法说明，模型照提示词（或会话历史里的旧调用）发出 tool_use
即可真实执行成功——[web-search.md](../../docs/features/web-search.md) 场景声明的
「两个工具从模型工具清单消失，模型无从调用」后半句不成立。

## 现状

- 注入过滤本身生效：`run_query_loop` 组装工具清单时按生效联网搜索值剔除两工具
  （`core-rs/src/engine.rs` `run_query_loop`），有测试锁定（`engine_tests.rs`
  `web_tools_follow_the_web_search_flag`）。
- `tool_usage_section` 的 `## Tool Usage` 清单按过滤后列表生成，但 `## Tool Details`
  追加的是静态常量 `TOOL_DETAILS`（`core-rs/src/prompt.rs`），其中 `### WebSearch` /
  `### WebFetch` 两段不随清单消失——关闭后模型仍被完整告知两工具的参数、算子与
  使用时机（"Use this tool when the question needs current information"）。
- 工具执行入口无开关校验：`run_tool` 无条件分发两工具（`core-rs/src/tools.rs`），
  权限按只读放行（`core-rs/src/permission.rs`）。
- 复现路径：会话联网搜索关闭 → 请模型查时效性问题 → 模型发出 WebSearch / WebFetch
  调用并成功返回结果；RT-1 的关闭分支即此路径的自动化复现。

## 期望

（修复方向按用户裁决：提示词与工具清单随开关同步收敛；执行入口不加运行期闸门。）

- 关闭时两工具不出现在模型工具清单（现状已满足，保持）。
- `## Tool Details` 的 WebSearch / WebFetch 段跟随注入清单：工具不在清单里时对应
  段不出现在系统提示词；在清单里时逐字保持原文。
- 切换勾选后，下一轮请求起 system prompt 与工具清单同步反映新状态
  （提示词逐轮按过滤后清单重装，`run_query_loop` 已具备该时序）。
- 全量清单下 `tool_usage_section` 输出逐字节不变——对照表测试
  `prompt_tests.rs` `system_prompt_static_text_matches_the_shared_table` 必须保持绿。

## 不变量

- 注入过滤语义不变：生效值为 false 时剔除两工具，MCP 工具不受影响；minimal 预设
  仍只暴露 Bash / Edit（`docs/features/web-search.md` FR-004「仍受提示词模式白名单
  约束」）。
- 会话覆盖优先级不变：meta.json `context.webSearch` / 消息随带 / 配置事件 优先，
  缺省回 `settings.json` 的 `llm.webSearch`（FR-004）。
- 提示词分段顺序不变：AskUserQuestion 之后依次 WebSearch、WebFetch，Skill 段保持
  最后。
- 会话中途关开关下一轮请求生效、不追溯中止的语义不变（`docs/features/web-search.md`
  边界一节）。

## 回归测试

- **RT-1**：同一会话内切换勾选，断言下一轮请求的工具清单与 system prompt 同步变换——
  默认开时两工具在清单、`## WebSearch Tool` / `## WebFetch Tool` 在提示词；经
  `setWebSearch` 同路径的配置事件关闭后，下一轮两者都消失，`## Skill Tool` 等其余
  工具说明不受影响（落点：`core-rs/src/engine_tests.rs`
  `web_search_toggle_syncs_tool_list_and_prompt_details`）。
- **RT-2**：`tool_usage_section` 单元锁——全量清单输出含两段；剔除两工具后输出不含
  两段，其余工具说明与 Tool Usage bullet 原样（落点：`core-rs/src/prompt_tests.rs`
  `tool_usage_details_follow_the_injected_tool_list`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test web_search_toggle_syncs_tool_list_and_prompt_details` | 红 | RT-1 失败于断言「关：提示词不应再含 WebSearch 段」——关闭后第二轮请求的 system prompt 仍含 WebSearch 段 |
| 回归用例（修复前） | `cd core-rs && cargo test tool_usage_details_follow_the_injected_tool_list` | 红 | RT-2 失败于断言「剔除后不应再含 WebSearch 段」 |
| 回归用例（修复后） | `cd core-rs && cargo test web_search_toggle_syncs_tool_list_and_prompt_details` | 绿 | — |
| 回归用例（修复后） | `cd core-rs && cargo test tool_usage_details_follow_the_injected_tool_list` | 绿 | — |
| 既有回归（core 全量） | `cd core-rs && cargo test` | 绿 | 841 通过 / 0 失败；含逐字对照表 `system_prompt_static_text_matches_the_shared_table`（全量清单下 Tool Details 输出逐字节不变）与既有 `web_tools_follow_the_web_search_flag`（注入过滤不回归） |
| 既有回归（仓库全量） | `npm run build:core:host && npm run test:all` | 绿 | TS 侧 standalone 全组驱动新构建二进制；docsLint 缺陷规格闸门通过 |
