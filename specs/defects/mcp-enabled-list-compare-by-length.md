---
status: 已修
---

# 缺陷：MCP 启用列表等价判定按长度比较，重复项导致确认框漏弹 / 错弹

`src/shared/utils/mcpList.ts` 的 `sameMcpEnabledList` 契约是「**顺序无关的集合比较**」，
实现却是「长度相等 + 每个元素都在对方里」的**多重集**比较：`a` 里有重复项时，长度相同
但集合不同的两份列表被判成等价；一侧有重复、另一侧是去重后的同一集合时又被判成不等价。

两个消费方都按这个布尔决定「默认列表是否变了 / 要不要弹『应用到当前对话』确认框」：
`WebviewMessageHandler` 的 `mcpDefaultEnabledChanged` 与 webview 的 `sameMcpList`。
判错的后果是**当前对话的 MCP 启用在用户不知情时与默认列表分叉**（该弹框没弹），
或用户改的只是一处重复写法却被追问「要不要应用」（错弹）。

重复项不是臆想：`mcp.enabled` 来自用户手改的 `settings.json`
（`resolveMcpEnabled` 只做 `typeof name === 'string'` 过滤、不去重），写入侧
`mcpDefaultsMutator` 才去重，因此手改与旧版本落盘都能留下重复项。

## 现状

- `sameMcpEnabledList`：
  `if (a.length !== b.length) return false;` 然后逐项查 `Set(b)`。
- 复现（Linux，仓库根）：

  ```
  node -e "const {sameMcpEnabledList}=require('./out/src/shared/utils/mcpList.js');
           console.log(sameMcpEnabledList(['x','x'], ['x','y']));   // 期望 false
           console.log(sameMcpEnabledList(['x','x'], ['x']));      // 期望 true"
  ```

  实测输出 `true` 与 `false`，两条都与契约（集合语义）相反。
- 列表来自两处：`beforeSnapshot.mcp.enabled`（写盘前快照）与
  `readMcpServers` 的 `servers.filter(enabled).map(name)`（server 定义去重后的名字）。
  两侧的去重程度不同，正是重复项会出现的位置。

## 期望

1. **按集合判定**：`new Set(a)` 与 `new Set(b)` 大小相等，且 `a` 的每个元素都在 `b` 里。
   顺序无关、重复项不影响结论。
2. **判错的两个方向都修正**：`[x, x]` 与 `[x]` 等价；`[x, x]` 与 `[x, y]` 不等价。
3. **既有语义不变**：空列表等价、空与非空不等价、顺序不同等价、集合不同不等价。

## 不变量

- 函数签名不变（`readonly string[]` 进、`boolean` 出），两侧消费方不改调用形态。
- 纯函数、零依赖（webview bundle 可直接 import）。
- 顺序无关语义保留：`['a','b']` 与 `['b','a']` 等价。
- 空列表语义保留：`[]` 与 `[]` 等价，`[]` 与 `['a']` 不等价。

## 回归测试

- **RT-1**：一侧重复、集合相同 → 等价（修复前红）。（落点：`src/test/mcpList.test.ts` 的
  「一侧重复、集合相同 → 等价」）
- **RT-2**：两侧重复写法不同、集合相同 → 等价（修复前红）。（落点：同上
  「两侧重复写法不同、集合相同 → 等价」）
- **RT-3**：一侧重复且集合不同 → 不等价（修复前红）。（落点：同上
  「一侧重复且集合不同 → 不等价」）
- **RT-4**：既有语义组（顺序 / 空列表 / 集合差异 / 长度相同但集合不同）逐条不变。
  （落点：同上其余断言）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- mcpList` | 红 | 3 项断言失败：一侧重复时等价性两向都判错 |
| 回归用例（修复后） | `npm run test:unit -- mcpList` | 绿 | 11 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测（含 hostSettings / preferenceDialog 等 MCP 相关链路） |
| 静态检查 | `npm run check-types` + `npm run lint` | 绿 | — |
