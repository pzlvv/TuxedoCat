import { buildDiffResult, resolveDiffView } from '../../electron/monacoDiff';
import { resolveInitialView } from '../../electron/fileOpen';
import { createChecker, runTests } from './helpers/harness';

/**
 * 变更视图的两侧组装与初始视图判定（specs/040 FR-001 / FR-003）。
 *
 * 覆盖点：
 * - `buildDiffResult`：有 HEAD / 无 HEAD（新增）、两侧相同（空态）、错误态；
 * - `resolveDiffView`：按钮不可用时恒落全文；
 * - `resolveInitialView`：来源 × 是否新增的六个组合（spec FR-003 映射表）。
 *
 * 运行方式：npm run test:unit -- monaco-diff
 */

runTests('monacoDiff', async () => {
  const { check, finish } = createChecker();

  // ---------- 两侧组装 ----------
  const changed = buildDiffResult('old\n', 'new\n');
  check('有 HEAD 版本且不同：给出两侧原文',
    changed.kind === 'diff' && changed.payload.before === 'old\n' && changed.payload.after === 'new\n');

  const clean = buildDiffResult('same\n', 'same\n');
  check('两侧相同：空态（不是空白的 diff）', clean.kind === 'empty');

  const created = buildDiffResult(null, 'hello\n');
  check('无 HEAD 版本：原始侧为空串，仍走 diff 分支',
    created.kind === 'diff' && created.payload.before === '' && created.payload.after === 'hello\n');

  check('两侧都是空串：空态',
    buildDiffResult(null, '').kind === 'empty');

  // ---------- 应答 → 渲染分支 ----------
  check('按钮不可用（虚拟文档）恒落全文', resolveDiffView(false, changed) === 'view');
  check('有变更 → diff', resolveDiffView(true, changed) === 'diff');
  check('无变更 → empty', resolveDiffView(true, clean) === 'empty');
  check('错误 → error',
    resolveDiffView(true, { kind: 'error', message: 'boom' }) === 'error');

  // ---------- 初始视图（spec FR-003 映射表） ----------
  check('文件树 + 新增 → 全文', resolveInitialView('tree', true) === 'full');
  check('文件树 + 非新增 → 全文（AC-7）', resolveInitialView('tree', false) === 'full');
  check('变更视图 + 新增 → 全文（AC-5）', resolveInitialView('changes', true) === 'full');
  check('变更视图 + 非新增 → 变更（AC-6）', resolveInitialView('changes', false) === 'changes');
  check('工具链接 + 新增 → 全文', resolveInitialView('toolLink', true) === 'full');
  check('工具链接 + 非新增 → 变更', resolveInitialView('toolLink', false) === 'changes');

  finish();
});
