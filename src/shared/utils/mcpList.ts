/**
 * MCP 启用列表的等价判定（顺序无关的集合比较）——唯一实现。
 *
 * 启用语义与顺序无关（core 落盘与面板展示的顺序都不保证一致）；此前宿主与
 * webview 各写了一份且语义相反（一份保序、一份无序），会让「宿主说变了、
 * webview 说没变」的「应用到当前对话」确认框判定组合出现。两侧都引用这一份。
 *
 * 按**集合**判定而不是「长度相等 + 逐项包含」：`mcp.enabled` 来自用户手改的
 * `settings.json`（`resolveMcpEnabled` 只过滤非字符串、不去重），列表里出现重复项时
 * 后者会把 `[x, x]` 与 `[x, y]` 判成等价、把 `[x, x]` 与 `[x]` 判成不等价。
 *
 * 纯函数、零依赖：webview bundle 可直接 import（不能落在 mcp/Config.ts——
 * 那边拖着 fs/promises 与 core 内部模块）。
 */

export function sameMcpEnabledList(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const name of setA) {
    if (!setB.has(name)) return false;
  }
  return true;
}
