import {
  parseToolMutation,
  resolveToolWorkspace,
} from '../../electron/toolResultSideEffects';
import { createChecker, runTests } from './helpers/harness';

/**
 * Edit / Write 工具结果的宿主侧旁路观察（`electron/toolResultSideEffects.ts`，纯函数）。
 *
 * 覆盖点（specs/030 FR-001 / FR-003，US-61）：
 * - `parseToolMutation`：Edit / Write + success 的三类首行前缀（`Created` / `Updated` /
 *   `Edited file:`，契约由 `core-rs/src/tools_tests.rs` 锁定），create 与 modify 的
 *   判别（create 才连树刷新）；失败结果与非工具输出返回 null；
 * - `resolveToolWorkspace`：相对路径按会话根展开、绝对路径包含判定、
 *   本地根大小写不敏感 / 远端根敏感、集合外与无会话根的相对路径返回 null。
 *
 * 运行方式：npm run test:all -- toolResultSideEffects
 */

runTests('toolResultSideEffects', () => {
  const { check, finish } = createChecker();

  check('Write 新建 → create',
    parseToolMutation('Write', 'success', 'Created file: a.ts\nLines: 1\nBytes: 5')
      ?.path === 'a.ts' && parseToolMutation('Write', 'success', 'Created file: a.ts\nLines: 1\nBytes: 5')?.kind === 'create');

  check('Write 覆盖 → modify（树结构没变）',
    parseToolMutation('Write', 'success', 'Updated file: a.ts\nLines: 1\nBytes: 0')
      ?.path === 'a.ts' && parseToolMutation('Write', 'success', 'Updated file: a.ts\nLines: 1\nBytes: 0')?.kind === 'modify');

  check('Edit → modify',
    parseToolMutation('Edit', 'success', 'Edited file: a.md\nMade 1 replacement\nEdited line 1\nLines: 2 (+1, -1)')
      ?.path === 'a.md' && parseToolMutation('Edit', 'success', 'Edited file: a.md\nMade 1 replacement\nEdited line 1\nLines: 2 (+1, -1)')?.kind === 'modify');

  check('失败结果 / 其它工具 / 非首行前缀 / 未知形态返回 null',
    parseToolMutation('Write', 'error', 'Write failed: boom') === null
    && parseToolMutation('Edit', 'error', 'Edit: write failed: boom') === null
    && parseToolMutation('Bash', 'success', 'Created file: fake') === null
    && parseToolMutation('Read', 'success', 'Edited file: fake') === null
    && parseToolMutation('Write', 'success', 'note: Created file: not-first-line') === null
    && parseToolMutation('Write', 'success', 'Lines: 1') === null);

  const local = { root: 'D:\\git\\demo', remote: false };
  const remote = { root: '/srv/app', remote: true };
  const roots = [local, remote];

  check('绝对路径包含判定（分隔符混合、本地大小写不敏感）',
    resolveToolWorkspace('D:/git/demo/src/a.ts', null, roots) === local
    && resolveToolWorkspace('d:\\GIT\\Demo\\a.ts', null, roots) === local
    && resolveToolWorkspace('D:\\git\\other\\a.ts', null, roots) === null);

  check('相对路径按会话根展开；无会话根的相对路径与空路径返回 null',
    resolveToolWorkspace('src/a.ts', 'D:\\git\\demo', roots) === local
    && resolveToolWorkspace('src\\a.ts', 'D:/git/demo/', roots) === local
    && resolveToolWorkspace('src/a.ts', null, roots) === null
    && resolveToolWorkspace('  ', 'D:\\git\\demo', roots) === null);

  check('远端根 POSIX 大小写敏感',
    resolveToolWorkspace('/srv/app/docs/x.md', null, roots) === remote
    && resolveToolWorkspace('/srv/App/docs/x.md', null, roots) === null);

  check('路径两端引号剥除',
    resolveToolWorkspace('"src/a.ts"', 'D:\\git\\demo', roots) === local);

  finish();
});
