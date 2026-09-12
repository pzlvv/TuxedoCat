/**
 * MEMTEST 桩：替代 rehype-katex（连带 katex 主包）。
 * 目的：测量 KaTeX 在 webview 中的内存占用。
 */
export default function rehypeKatexStub() {
  return (tree) => tree;
}
