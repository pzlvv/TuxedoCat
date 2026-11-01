/**
 * 单测：MCP 启用列表的等价判定（`src/shared/utils/mcpList.ts`）。
 *
 * 该模块的契约是「**顺序无关的集合比较**」：启用语义与顺序无关，落盘与面板展示的顺序
 * 都不保证一致。实现必须按集合判定——列表里出现重复项（用户手改 `settings.json` 的
 * `mcp.enabled`，`resolveMcpEnabled` 只过滤非字符串、不去重）时，按「长度相等 + 每个元素
 * 都在对方里」判定会把 `[x, x]` 与 `[x, y]` 判成等价、把 `[x, x]` 与 `[x]` 判成不等价。
 *
 * 两个消费方（`WebviewMessageHandler` 的 `mcpDefaultEnabledChanged`、
 * webview「应用到当前对话」确认框）都按这个布尔决定「默认列表是否变了 / 是否要弹框」，
 * 判错的表现是**漏弹或错弹确认框**，且当前对话在用户不知情时保留另一份列表。
 *
 * 运行方式：npm run test:unit -- mcpList
 */

import { sameMcpEnabledList } from '../shared/utils/mcpList';
import { createChecker, runTests } from './helpers/harness';

function run(): void {
  const { check, finish } = createChecker();

  // ---------- 顺序无关 ----------

  check('顺序不同但集合相同 → 等价', sameMcpEnabledList(['a', 'b'], ['b', 'a']));
  check('相同顺序 → 等价', sameMcpEnabledList(['a', 'b'], ['a', 'b']));

  // ---------- 空列表 ----------

  check('两个空列表 → 等价', sameMcpEnabledList([], []));
  check('空与非空 → 不等价', !sameMcpEnabledList([], ['a']));
  check('非空与空 → 不等价', !sameMcpEnabledList(['a'], []));

  // ---------- 集合差异 ----------

  check('多一项 → 不等价', !sameMcpEnabledList(['a'], ['a', 'b']));
  check('换一项 → 不等价', !sameMcpEnabledList(['a', 'b'], ['b', 'c']));

  // ---------- 重复项：按集合语义判定 ----------

  check('一侧重复、集合相同 → 等价', sameMcpEnabledList(['x', 'x'], ['x']));
  check('两侧重复写法不同、集合相同 → 等价', sameMcpEnabledList(['x', 'y', 'x'], ['y', 'x']));
  check('一侧重复且集合不同 → 不等价', !sameMcpEnabledList(['x', 'x'], ['x', 'y']));
  check('长度相同但集合不同（重复掩盖差异）→ 不等价', !sameMcpEnabledList(['x', 'x'], ['y', 'y']));

  finish();
}

runTests('mcpList', run);
