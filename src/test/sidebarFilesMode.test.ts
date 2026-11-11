import * as fs from 'fs';
import * as path from 'path';
import {
  emptyTextForMode,
  modeForScope,
  needsGitSentinel,
  parseStoredModes,
  scopeForMode,
  shouldWatchGitSentinel,
  toggleFilesMode,
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
 * - `toggleFilesMode` 的三态转移（AC-2：点当前模式回目录树、点另一模式直接切）；
 * - 空态文案按 scope 分叉（FR-002）；
 * - 磁盘 git 哨兵的开关（specs/047 FR-003）：Overlay 来源不挂，且模式与来源两条件缺一不可。
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

  // ---------- 三态转移（AC-2） ----------
  check('tree 点 doc → doc', toggleFilesMode('tree', 'doc') === 'doc');
  check('tree 点 changes → changes', toggleFilesMode('tree', 'changes') === 'changes');
  check('doc 再点 doc → tree', toggleFilesMode('doc', 'doc') === 'tree');
  check('doc 点 changes → changes（直接切换，不轮转）', toggleFilesMode('doc', 'changes') === 'changes');
  check('changes 点 doc → doc', toggleFilesMode('changes', 'doc') === 'doc');
  check('changes 再点 changes → tree', toggleFilesMode('changes', 'changes') === 'tree');

  // ---------- 哨兵挂摘（specs/030 FR-003 / specs/041 FR-004） ----------
  check('目录树不挂 git 哨兵', needsGitSentinel('tree') === false);
  check('文档视图挂哨兵', needsGitSentinel('doc') === true);
  check('全部变更复用同一个哨兵', needsGitSentinel('changes') === true);

  // ---------- 空态文案（FR-002） ----------
  check('doc 空态点名 Markdown', emptyTextForMode('doc') === '没有变更的 Markdown 文档');
  check('changes 空态不点名 Markdown', emptyTextForMode('changes') === '没有变更的文件');

  // ── 磁盘 git 哨兵只在「模式依赖 git 且来源是磁盘」时挂（specs/047 FR-003） ──
  for (const mode of ['doc', 'changes'] as const) {
    check(`${mode} + 磁盘来源 → 挂哨兵`, shouldWatchGitSentinel(mode, null) === true);
    check(`${mode} + Overlay 来源 → 不挂哨兵（HEAD 在视图里）`,
      shouldWatchGitSentinel(mode, 'sess-1') === false);
  }
  check('目录树恒不挂哨兵', shouldWatchGitSentinel('tree', null) === false);
  check('目录树 + Overlay 来源也不挂', shouldWatchGitSentinel('tree', 'sess-1') === false);

  // 接线：主进程的 mode-watch 分支必须调用判定（判定写好没人调 = 失效推送永远按老口径挂）
  {
    const mainSource = fs.readFileSync(path.join(__dirname, '../../..', 'electron', 'main.ts'), 'utf8');
    const match = /ipcMain\.on\('sidebar:files-mode-watch'[\s\S]*?\n  \}\);/.exec(mainSource);
    check('sidebar:files-mode-watch 分支可定位', match !== null);
    check('分支调用 shouldWatchGitSentinel 决定哨兵开关',
      match !== null && match[0].includes('shouldWatchGitSentinel('));
    check('分支把 overlaySessionId 传给判定',
      match !== null && match[0].includes('p.overlaySessionId'));
  }

  finish();
});
