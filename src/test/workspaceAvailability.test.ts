/**
 * 工作区连接状态机的时序不变量（`electron/workspaceAvailability.ts`）。
 *
 * 背景（实测回归）：启动恢复的远程工作区连不上时，标签页黄点（connecting）一直
 * 挂到用户点击标签页才变红点（unavailable）。根因是两条失败信号的到达顺序不定：
 * - Connection 建链失败的 lost 信号先到 → 标红推送带着 connecting 旧态（黄）；
 * - 可达性探测失败后到 → 同键重复标记被去重守卫拦下，不再刷新。
 * 本组用例锁定：任何一条信号先到、任何重复标记次数，状态都落定为 unavailable
 * 且建链中已被清掉；曾就绪过的键不被建连失败否定。
 *
 * 运行方式：npm run test:all -- workspace-availability
 */

import * as assert from 'assert';
import { createChecker, runTests } from './helpers/harness';
import { WorkspaceAvailabilityState } from '../../electron/workspaceAvailability';

const KEY = 'ssh//e2e@127.0.0.1:22/home/proj';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ── 场景 1：lost 信号先到（Connection 建链失败），探测 3 秒后才失败 ──
  // 启动恢复：远程项先进入建链中（黄点）
  const lostFirst = new WorkspaceAvailabilityState();
  lostFirst.markConnecting(KEY);
  check('启动恢复的远程项处于建链中', lostFirst.availabilityOf(KEY) === 'connecting');
  // lost 先到：落定不可用，建链中必须被清掉（否则标红推送仍是黄）
  const marked = lostFirst.markUnavailable(KEY);
  check('lost 到达时新标记成立（执行标红副作用）', marked === true);
  check('落定不可用即清除建链中：状态为 unavailable', lostFirst.availabilityOf(KEY) === 'unavailable');
  // 探测失败后到：同键重复标记，状态不再变化（副作用不重复），但状态保持红
  check('探测失败后到：重复标记返回 false', lostFirst.markUnavailable(KEY) === false);
  check('重复标记后状态保持 unavailable', lostFirst.availabilityOf(KEY) === 'unavailable');

  // ── 场景 2：探测失败先到，lost 信号后到（顺序对称） ──
  const probeFirst = new WorkspaceAvailabilityState();
  probeFirst.markConnecting(KEY);
  check('探测先失败：新标记成立', probeFirst.markUnavailable(KEY) === true);
  check('探测先失败：状态为 unavailable', probeFirst.availabilityOf(KEY) === 'unavailable');
  check('lost 后到：重复标记返回 false', probeFirst.markUnavailable(KEY) === false);
  check('lost 后到：状态保持 unavailable', probeFirst.availabilityOf(KEY) === 'unavailable');

  // ── 场景 3：Connection 曾就绪过（探测与建链竞态的输家不否定赢家） ──
  const readyWins = new WorkspaceAvailabilityState();
  readyWins.markConnecting(KEY);
  readyWins.markReady(KEY);
  check('曾就绪时建连失败不标红', readyWins.markUnavailable(KEY) === false);
  check('曾就绪时建链中仍被清除：状态回到 available', readyWins.availabilityOf(KEY) === 'available');

  // ── 场景 4：探测成功恢复（lost 已先标红时撤销判定并补建 Connection） ──
  const recovered = new WorkspaceAvailabilityState();
  recovered.markConnecting(KEY);
  recovered.markUnavailable(KEY);
  check('探测成功前已标红', recovered.availabilityOf(KEY) === 'unavailable');
  check('探测成功：撤销不可用判定返回 true（需补建 Connection）', recovered.revokeUnavailable(KEY) === true);
  check('撤销后状态为 available', recovered.availabilityOf(KEY) === 'available');
  check('未标红时撤销返回 false', recovered.revokeUnavailable(KEY) === false);

  // ── 场景 5：重新连接（占位页按钮）：黄点遮蔽红点，失败回到红点 ──
  const reconnect = new WorkspaceAvailabilityState();
  reconnect.markUnavailable(KEY);
  reconnect.markConnecting(KEY);
  check('重新连接期间建链中遮蔽不可用（黄点）', reconnect.availabilityOf(KEY) === 'connecting');
  reconnect.clearConnecting(KEY);
  check('重连失败回到红点', reconnect.availabilityOf(KEY) === 'unavailable');

  // ── 场景 6：启动期判定与丢弃 ──
  const startup = new WorkspaceAvailabilityState();
  check('本地目录缺失：直接标红（无建链中前置）', startup.markUnavailable(KEY) === true);
  startup.clearAll(KEY);
  check('关闭标签页丢弃判定后回到 available', startup.availabilityOf(KEY) === 'available');
  check('丢弃后可重新判定', startup.markUnavailable(KEY) === true);

  // ── 场景 7：运行期致命（远程 daemon / 链路死亡）：曾就绪过也要标红 ──
  // markUnavailable 的就绪豁免只服务「探测与建链竞态」：远程运行期 lost 不可自动
  // 恢复（重启策略在 daemon 手里），必须撤销豁免落成 unavailable
  const runtimeFatal = new WorkspaceAvailabilityState();
  runtimeFatal.markReady(KEY);
  check('曾就绪过的运行期致命：撤销豁免并标红', runtimeFatal.markRuntimeFatal(KEY) === true);
  check('运行期致命后状态为 unavailable', runtimeFatal.availabilityOf(KEY) === 'unavailable');
  check('运行期致命重复标记返回 false（副作用不重复）', runtimeFatal.markRuntimeFatal(KEY) === false);
  // 建链中 + 运行期致命：与 markUnavailable 同口径，落定时清掉建链中
  const fatalWhileConnecting = new WorkspaceAvailabilityState();
  fatalWhileConnecting.markConnecting(KEY);
  fatalWhileConnecting.markReady(KEY);
  check('建链中收到运行期致命：标红并清掉黄点', fatalWhileConnecting.markRuntimeFatal(KEY) === true);
  check('运行期致命落定后状态为 unavailable', fatalWhileConnecting.availabilityOf(KEY) === 'unavailable');

  // 可建 Connection 的口径：只排除不可用，建链中的项同样要建（建链正是它的目的）
  const connectable = new WorkspaceAvailabilityState();
  connectable.markConnecting(KEY);
  check('建链中的项可建 Connection', connectable.isAvailable(KEY) === true);
  connectable.markUnavailable(KEY);
  check('不可用的项不建 Connection', connectable.isAvailable(KEY) === false);

  assert.ok(true);
  finish();
}

runTests('workspaceAvailability', run);
