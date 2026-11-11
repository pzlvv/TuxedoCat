import {
  emptyTextForMode,
  FILES_MODE_ORDER,
  modeForScope,
  needsGitSentinel,
  parseStoredModes,
  scopeForMode,
  stepFilesMode,
} from '../../electron/sidebarFilesMode';
import { pathspecFor } from '../../electron/sidebarDocView';
import { createChecker, runTests } from './helpers/harness';

/**
 * 侧栏文件浏览器的三态模式（`electron/sidebarFilesMode.ts`，specs/041 FR-001）。
 *
 * 覆盖点：
 * - `parseStoredModes` 的旧布尔兼容（specs/030 的存储形态迁移，AC-3 的持久化前提）
 *   与损坏值的丢弃；
 * - `scopeForMode` / `modeForScope` 的双向映射，与 `pathspecFor` 的判别值闭合；
 * - 分段 switch 的顺序与方向键步进（`stepFilesMode`，US-63：单选框语义，左环绕）；
 * - 空态文案按 scope 分叉（FR-002）。
 *
 * 运行方式：npm run test:unit -- sidebar-files-mode
 */

runTests('sidebarFilesMode', async () => {
  const { check, finish } = createChecker();

  // ---------- 旧键兼容（specs/030 → specs/041 的升级路径） ----------
  {
    const legacy = JSON.stringify({ ws1: true, ws2: false });
    const parsed = parseStoredModes(null, legacy);
    check('旧布尔 true 迁移为 doc', parsed.ws1 === 'doc');
    check('旧布尔 false 迁移为 tree', parsed.ws2 === 'tree');
  }
  {
    // 新键有值时以新键为准，旧键不参与（旧键只在全新键缺失时兜底）
    const modes = JSON.stringify({ ws1: 'changes' });
    const legacy = JSON.stringify({ ws1: true, ws2: true });
    const parsed = parseStoredModes(modes, legacy);
    check('新键优先于旧键', parsed.ws1 === 'changes');
    check('新键存在时不回退旧键的其它工作区', parsed.ws2 === undefined);
  }
  {
    const parsed = parseStoredModes('{}', JSON.stringify({ ws1: true }));
    check('新键是空表时回退旧键', parsed.ws1 === 'doc');
  }
  {
    const parsed = parseStoredModes(JSON.stringify({ ws1: 'bogus', ws2: 'tree' }), null);
    check('非法模式值被丢弃', parsed.ws1 === undefined);
    check('合法模式值保留', parsed.ws2 === 'tree');
  }
  {
    check('损坏的新键不抛错且回退旧键', parseStoredModes('{not json', JSON.stringify({ ws1: true })).ws1 === 'doc');
    check('两边都损坏时返回空表', Object.keys(parseStoredModes('{bad', '[1,2]')).length === 0);
    check('数组形式的存储被拒绝', Object.keys(parseStoredModes('[1,2]', null)).length === 0);
    check('全部缺失时返回空表', Object.keys(parseStoredModes(null, null)).length === 0);
  }

  // ---------- 模式 ↔ 取数范围 ----------
  check('tree 不取数', scopeForMode('tree') === null);
  check('doc 模式的 scope 是 doc', scopeForMode('doc') === 'doc');
  check('changes 模式的 scope 是 all', scopeForMode('changes') === 'all');
  check('scope doc 回到 doc 模式', modeForScope('doc') === 'doc');
  check('scope all 回到 changes 模式', modeForScope('all') === 'changes');

  // 判别值闭合：模式的 scope 决定 pathspec，两处不各写一份（specs/041 FR-002）
  check('doc 模式限定 Markdown', JSON.stringify(pathspecFor('doc')) === JSON.stringify(['*.md', '*.markdown']));
  check('all 模式不带 pathspec', pathspecFor('all').length === 0);

  // ---------- 分段 switch（US-63）：顺序与方向键步进 ----------
  // 显示顺序必须与 index.html 里三段的 DOM 顺序一致（全部 / 差异 / 文档）
  check('三段顺序是 全部 → 差异 → 文档', JSON.stringify(FILES_MODE_ORDER) === JSON.stringify(['tree', 'changes', 'doc']));
  check('三段覆盖三种模式且不重复', new Set(FILES_MODE_ORDER).size === 3);

  // 方向键在组内环绕：右移一格、右移走到头回到第一段、左移从第一段绕到最后
  check('tree 右移 → changes', stepFilesMode('tree', 1) === 'changes');
  check('changes 右移 → doc', stepFilesMode('changes', 1) === 'doc');
  check('doc 右移环绕回 tree', stepFilesMode('doc', 1) === 'tree');
  check('tree 左移环绕到 doc', stepFilesMode('tree', -1) === 'doc');
  check('doc 左移 → changes', stepFilesMode('doc', -1) === 'changes');
  check('changes 左移 → tree', stepFilesMode('changes', -1) === 'tree');
  // 步进后的值必须仍是合法模式（判别联合闭合：不会步进出一个第四态）
  for (const mode of FILES_MODE_ORDER) {
    check(`${mode} 左右步进都落在三段内`, FILES_MODE_ORDER.includes(stepFilesMode(mode, 1)) && FILES_MODE_ORDER.includes(stepFilesMode(mode, -1)));
  }

  // ---------- 哨兵挂摘（specs/030 FR-003 / specs/041 FR-004） ----------
  check('目录树不挂 git 哨兵', needsGitSentinel('tree') === false);
  check('文档视图挂哨兵', needsGitSentinel('doc') === true);
  check('全部变更复用同一个哨兵', needsGitSentinel('changes') === true);

  // ---------- 空态文案（FR-002） ----------
  check('doc 空态点名 Markdown', emptyTextForMode('doc') === '没有变更的 Markdown 文档');
  check('changes 空态不点名 Markdown', emptyTextForMode('changes') === '没有变更的文件');

  finish();
});
