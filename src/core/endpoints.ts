/**
 * 跨层共享的服务地址常量（`docs/webview-facts.md` 第 1 节）。
 *
 * 本模块只放**服务地址**，不放任何配置字段的默认值——「`settings.json` 缺字段时取什么值」
 * 由宿主的配置快照解析唯一决定（`settingsSnapshot.ts`），webview 不持有配置默认值。
 *
 * 注意：本模块必须保持**零依赖**（只导出字符串字面量）——webview 也要 import 它，
 * 任何传递依赖都会把 Node 专有代码带进 webview 构建。
 */

/**
 * DeepSeek 官方服务地址。
 *
 * 三重身份：设置面板「新增服务商」的预置地址、余额查询目标、服务商识别用的 hostname 基准。
 * 三者必须是同一个值，因此只在这里定义（`core/llm/config.ts` 只做转出）。
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
