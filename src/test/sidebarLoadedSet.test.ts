import * as fs from 'fs';
import * as path from 'path';
import { createLoadedSetTracker, normalizeLoadedSessions } from '../../electron/sidebarLoadedSet';
import { createChecker, runTests } from './helpers/harness';

/**
 * 侧栏「已打开」投影（绿点）不得被陈旧回包覆盖（
 * specs/defects/sidebar-loaded-set-overwritten-by-stale-refetch.md）。
 *
 * 缺陷形态：侧栏在 `sidebar:workspaces-changed` 里无条件清空这份投影，随后靠一次无版本号的
 * 异步重取补回；回包晚于更新的推送落地时，旧快照整体替换掉新事实，绿点永久消失。
 * 应有形态：loaded 的 owner 是 `ChatViewManager`（docs/architecture/contracts.md 第 4 节），
 * 侧栏只消费——不清空这份投影，且重取回包只在「发起后没有新推送」时才可应用。
 */

const SIDEBAR_SOURCE = path.join(__dirname, '../../..', 'electron', 'sidebar', 'main.ts');

function readSidebarSource(): string {
  return fs.readFileSync(SIDEBAR_SOURCE, 'utf8');
}

/** 取出 `onWorkspacesChanged` 回调的完整函数体（按花括号配对，取到回调闭合） */
function workspacesChangedBody(source: string): string | null {
  const start = source.indexOf('window.sidebarAPI.onWorkspacesChanged(');
  if (start < 0) return null;
  // 回调是最后一个注册，没有「下一个注册」可当右界；按花括号配对数出回调体，
  // 只数 `{` / `}` 对外层平衡够用（源码里没有同层字符串字面量跨行干扰）。
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

runTests('sidebarLoadedSet', async () => {
  const { check, finish } = createChecker();
  const source = readSidebarSource();
  const body = workspacesChangedBody(source);

  // ── RT-1：渲染层接线 —— 切工作区不再清空「已打开」投影 ──
  check('onWorkspacesChanged 回调可定位', body !== null);
  check(
    'RT-1 切工作区不清空 loadedSessions（投影只由 owner 推送 / 首播种替换）',
    body !== null && !/loadedSessions\s*=\s*new\s+Set\(\)/.test(body),
  );
  check(
    'RT-1 重取失败留日志（不静默吞错）',
    body !== null
      // 只看 getLoadedSessions 这一条链（到下一个取数调用为止）：后面的 getActiveSession
      // 有自己的 catch，不在本缺陷范围内，不能被当成它链上的静默
      && (() => {
        const from = body.indexOf('getLoadedSessions()');
        if (from < 0) return false;
        const next = body.indexOf('getActiveSession()', from);
        const chain = body.slice(from, next < 0 ? body.length : next);
        return chain.includes('reload loaded sessions failed') && !/\.catch\(\(\)\s*=>\s*undefined\)/.test(chain);
      })(),
  );
  check('RT-1 列表仍按目录重新拉取', body !== null && body.includes('getConversations()'));
  check('RT-1 目录代次仍会丢弃旧列表回包', body !== null && body.includes('listGeneration'));

  // ── RT-2：仲裁器语义 —— 陈旧回包被丢弃，无推送时回包正常应用 ──
  {
    // 发起重取后没有新推送：回包应当生效（补空档的正常路径）
    const t1 = createLoadedSetTracker();
    const tick1 = t1.beginRefetch();
    check('RT-2 无新推送时回包生效', t1.applyRefetch(tick1, ['s1']) === true);
    check('RT-2 生效后集合正确', [...t1.current()].join(',') === 's1');

    // 发起重取后来了新推送：回包是旧快照，必须丢弃
    const t2 = createLoadedSetTracker(['old']);
    const tick2 = t2.beginRefetch();
    t2.applyPush(['old', 'new']);          // 视图装载完成，owner 推出更新的事实
    check('RT-2 陈旧回包被丢弃', t2.applyRefetch(tick2, ['old']) === false);
    check(
      'RT-2 丢弃后新事实仍在（绿点不被抹掉）',
      [...t2.current()].sort().join(',') === 'new,old',
    );

    // 两次重取交叉：先发的那次回包，不得覆盖后发那次已应用的更新值
    const t3 = createLoadedSetTracker();
    const early = t3.beginRefetch();
    const late = t3.beginRefetch();
    check('RT-2 后发凭据生效', t3.applyRefetch(late, ['s2']) === true);
    check('RT-2 先发凭据随后到达被丢弃', t3.applyRefetch(early, ['s1']) === false);
    check('RT-2 最终值来自后发那次', [...t3.current()].join(',') === 's2');

    // 推送本身恒生效（owner 是唯一推进版本的来源）
    const t4 = createLoadedSetTracker();
    t4.applyPush(['a']);
    t4.applyPush([]);
    check('RT-2 推送可清空集合（关闭所有对话）', t4.current().size === 0);

    // 空 / 非法载荷按空集合归一，不抛错
    const t5 = createLoadedSetTracker();
    const tick5 = t5.beginRefetch();
    check('RT-2 非法回包归一为空集', t5.applyRefetch(tick5, 'not-an-array') === true && t5.current().size === 0);
    check('RT-2 normalize 过滤非字符串', normalizeLoadedSessions(['a', 1, null, 'b']).size === 2);
  }

  finish();
});
