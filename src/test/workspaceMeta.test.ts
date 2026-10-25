import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectDirCandidates } from '../../src/shared/history/Config';
import {
  parseModifiedDocs,
  readRemoteModifiedDocs,
  type RemoteMetaAccess,
} from '../../src/shared/workspaceMeta';
import { createChecker, runTests } from './helpers/harness';

/**
 * `workspace.meta.json` 宿主侧只读库（`src/shared/workspaceMeta.ts`）。
 *
 * 编码候选与 `core-rs/src/config_tests.rs` 用同一组路径样例断言同一批字面量
 * （落盘格式双侧一致的对照表）；读取逻辑经注入的远端访问口在临时目录上端到端驱动
 * （本地 `readModifiedDocs` 只是它的薄包装，不在单测里碰真实的用户配置目录）。
 *
 * 运行方式：npm run test:all -- workspaceMeta
 */

runTests('workspaceMeta', async () => {
  const { check, finish } = createChecker();

  // —— 编码对照（与 config_tests.rs 同一样本；平台各测各的形态） ——
  if (process.platform === 'win32') {
    check('对照表（win32）：编码字面量与 core-rs 一致',
      JSON.stringify(projectDirCandidates('D:\\git\\demo')) === JSON.stringify(['D%3A%5Cgit%5Cdemo'])
      && JSON.stringify(projectDirCandidates('D:/git/demo'))
        === JSON.stringify(['D%3A%5Cgit%5Cdemo', 'D%3A%2Fgit%2Fdemo'])
      && projectDirCandidates('中文').join() === encodeURIComponent('中文'));
  } else {
    check('对照表（posix）：编码字面量与 core-rs 一致',
      projectDirCandidates('/home/u/proj').join() === encodeURIComponent('/home/u/proj')
      && projectDirCandidates('中文').join() === encodeURIComponent('中文'));
  }

  // —— 解析 ——
  check('parseModifiedDocs：null / 缺字段为空数组，合法内容原样返回',
    parseModifiedDocs(null, 'm').length === 0
    && parseModifiedDocs(JSON.stringify({ workspacePath: 'x' }), 'm').length === 0
    && parseModifiedDocs(JSON.stringify({ modifiedDocs: ['a.md', 'd/b.md'] }), 'm').join('|') === 'a.md|d/b.md');

  check('parseModifiedDocs：损坏（非法 JSON / 字段形态不对）抛错',
    (() => {
      try {
        parseModifiedDocs('{ not json', 'm');
        return false;
      } catch {
        /* 预期抛错 */
      }
      try {
        parseModifiedDocs(JSON.stringify({ modifiedDocs: 'a.md' }), 'm');
        return false;
      } catch {
        /* 预期抛错 */
      }
      return true;
    })());

  // —— 远端读取（注入 fs 访问口，临时目录当「远端」） ——
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-meta-test-'));
  try {
    const configDirName = '.test-core';
    const projectPath = '/home/user/proj';
    const projectDir = path.join(
      home, configDirName, 'conversations', projectDirCandidates(projectPath, { posix: true })[0],
    );
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'workspace.meta.json'),
      JSON.stringify({ workspacePath: projectPath, modifiedDocs: ['a.md', 'docs/b.md'] }, null, 2),
    );

    const access: RemoteMetaAccess = {
      homeDir: async () => home,
      readFile: async (remotePath) => {
        try {
          return await fs.promises.readFile(
            remotePath.split('/').join(path.sep) === remotePath ? remotePath : path.join(...remotePath.split('/')),
            'utf8',
          );
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return null;
          throw err;
        }
      },
      stat: async (remotePath) => {
        try {
          await fs.promises.stat(path.join(...remotePath.split('/')));
          return true;
        } catch {
          return false;
        }
      },
    };

    const docs = await readRemoteModifiedDocs(access, configDirName, projectPath);
    check('远端读取：候选目录命中并返回 modifiedDocs',
      docs.join('|') === 'a.md|docs/b.md');

    const empty = await readRemoteModifiedDocs(access, configDirName, '/home/user/never-opened');
    check('远端读取：没有对话空间目录的工作区返回空数组', empty.length === 0);

    fs.writeFileSync(
      path.join(projectDir, 'workspace.meta.json'),
      '{ broken',
    );
    let corruptThrown = false;
    try {
      await readRemoteModifiedDocs(access, configDirName, projectPath);
    } catch {
      corruptThrown = true;
    }
    check('远端读取：损坏清单抛错（错误态，不静默当空）', corruptThrown);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  finish();
});
