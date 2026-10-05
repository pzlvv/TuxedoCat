/**
 * MCP 启用列表的等价判定（顺序无关的集合比较）——唯一实现。
 *
 * 启用语义与顺序无关（core 落盘与面板展示的顺序都不保证一致）；此前宿主与
 * webview 各写了一份且语义相反（一份保序、一份无序），会让「宿主说变了、
 * webview 说没变」的「应用到当前对话」确认框判定组合出现。两侧都引用这一份。
 *
 * 纯函数、零依赖：webview bundle 可直接 import（不能落在 mcp/Config.ts——
 * 那边拖着 fs/promises 与 core 内部模块）。
 */

export function sameMcpEnabledList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const name of a) {
    if (!setB.has(name)) return false;
  }
  return true;
}
