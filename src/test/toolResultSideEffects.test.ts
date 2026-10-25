import {
  parseCreatedFilePath,
  resolveToolWorkspace,
} from '../../electron/toolResultSideEffects';
import { createChecker, runTests } from './helpers/harness';

/**
 * Write 工具结果的宿主侧旁路观察（`electron/toolResultSideEffects.ts`，纯函数）。
 *
 * 覆盖点（specs/030 FR-001）：
 * - `parseCreatedFilePath`：只认 Write + success + 首行 `Created file: ` 前缀
 *   （前缀契约由 `core-rs/src/tools_tests.rs` 锁定）；
 * - `resolveToolWorkspace`：相对路径按会话根展开、绝对路径包含判定、
 *   本地根大小写不敏感 / 远端根敏感、集合外与无会话根的相对路径返回 null。
 *
 * 运行方式：npm run test:all -- toolResultSideEffects
 */

runTests('toolResultSideEffects', () => {
  const { check, finish } = createChecker();

  check('只认 Write + success + Created 首行前缀',
    parseCreatedFilePath('Write', 'success', 'Created file: a.ts\nLines: 1\nBytes: 5') === 'a.ts'
    && parseCreatedFilePath('Write', 'success', 'Updated file: a.ts\nLines: 1\nBytes: 0') === null
    && parseCreatedFilePath('Edit', 'success', 'Edited file: a.md\nMade 1 replacement') === null
    && parseCreatedFilePath('Write', 'error', 'Write failed: boom') === null
    && parseCreatedFilePath('Bash', 'success', 'Created file: fake') === null
    && parseCreatedFilePath('Write', 'success', 'note: Created file: not-first-line') === null);

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
