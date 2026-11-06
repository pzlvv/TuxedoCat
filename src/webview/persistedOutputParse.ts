/**
 * `<persisted-output>` 预览消息的解析（纯函数，`docs/hosts/webview-ui.md` 的工具卡片段）。
 *
 * 格式由工具层生成，TS 与 Rust 两侧同口径（`buildLargeToolResultMessage` /
 * `core-rs/src/tools.rs` 的 `build_large_tool_result_message`）：
 *
 * ```
 * <persisted-output>
 * Output too large (XXKB). Full output saved to: /path/to/file
 *
 * Preview (first 2K + last 2K):
 * ...前 2K...
 * ... (N chars omitted) ...
 * ...后 2K...
 * </persisted-output>
 * ```
 *
 * 本模块零依赖：webview bundle 直接 import，单测也直接 import（与 `readFileCard.ts`
 * 同模式——组件只渲染结果，派生是纯函数）。
 */

/** 解析结果；`null` = 不是持久化输出（缺完整标签对） */
export interface ParsedPersistedOutput {
  isPersisted: boolean;
  /** 完整输出的大小（字节）；表头解析不出时为 0 */
  originalSize: number;
  /** 完整输出落盘的文件路径；解析不出时为空串 */
  filePath: string;
  /** 预览正文（表头之后、收尾标签之前的全部内容） */
  preview: string;
}

const PERSISTED_TAG = '<persisted-output>';
const CLOSING_TAG = '</persisted-output>';

/** 表头行：`Preview (first 2K + last 2K):`（两段大小由工具层按上限写入） */
const PREVIEW_HEADER = /^Preview \(first \d+K \+ last \d+K\):$/;

/**
 * 解析持久化输出标签。
 *
 * 定位必须按**行**而不是「第一个命中的子串」：路径与正文都来自工具输出，
 * 完全可能包含 `Preview` 这个词或两个标签的字面量（例如 `cat` 本仓库的
 * `persistedOutputParse.ts`），按子串定位会从错误位置切开预览
 * （specs/defects/persisted-output-preview-anchored-on-first-marker.md）。
 */
export function parsePersistedOutput(output: string): ParsedPersistedOutput | null {
  const startIdx = output.indexOf(PERSISTED_TAG);
  // 收尾标签取**最后一次**出现：正文里的同名字面量不能提前结束消息
  const endIdx = output.lastIndexOf(CLOSING_TAG);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }

  const body = output.slice(startIdx + PERSISTED_TAG.length, endIdx).trim();

  // 解析文件路径
  // 格式: "Output too large (XXKB). Full output saved to: /path/to/file"
  const filePathMatch = body.match(/Full output saved to: (.+)$/m);
  const sizeMatch = body.match(/Output too large \((\d+)KB\)/);

  // 预览正文紧跟在表头行的下一行；按整行匹配，路径或正文里的同名单词不算表头
  let preview = '';
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!PREVIEW_HEADER.test(lines[i].trimEnd())) continue;
    preview = lines.slice(i + 1).join('\n').trimEnd();
    break;
  }

  return {
    isPersisted: true,
    originalSize: sizeMatch ? parseInt(sizeMatch[1], 10) * 1024 : 0,
    filePath: filePathMatch ? filePathMatch[1] : '',
    preview,
  };
}

/**
 * 检查内容是否为持久化输出消息。
 *
 * 只认完整标签对：命令回显里出现单个同名标签时不能误判成持久化输出。
 */
export function isPersistedOutput(content: string): boolean {
  const start = content.indexOf(PERSISTED_TAG);
  if (start === -1) return false;
  return content.lastIndexOf(CLOSING_TAG) > start;
}
