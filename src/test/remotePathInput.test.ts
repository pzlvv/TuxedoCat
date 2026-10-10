/**
 * 单测：路径输入框的拆分（`electron/remoteWorkspace/pathInput.ts`）。
 *
 * 拆分决定「路径补全」怎么工作：拆出目录 + 最后一段过滤词。
 * 这里锁住分隔符风格（`/` 与 `\`）、末尾分隔符（整级）、盘符无分隔符等边界。
 *
 * 运行方式：npm run test:all -- remotePathInput
 */

import { createChecker, runTests } from './helpers/harness';
import {
  completePathInput,
  ensureTrailingSeparator,
  sameDirectory,
  splitPathInput,
  trimTrailingSeparators,
  typedDirectory,
} from '../../electron/remoteWorkspace/pathInput';

runTests('remotePathInput', () => {
  const { check, finish } = createChecker();

  const posixPartial = splitPathInput('/workspace/a');
  check('posix 部分名：目录是父目录', posixPartial.dir === '/workspace/');
  check('posix 部分名：过滤词是最后一段', posixPartial.prefix === 'a');

  const posixWhole = splitPathInput('/workspace/');
  check('末尾分隔符：列它自己', posixWhole.dir === '/workspace/' && posixWhole.prefix === '');

  const posixTop = splitPathInput('/workspace');
  check('第一级：目录是根', posixTop.dir === '/' && posixTop.prefix === 'workspace');

  const win = splitPathInput('C:\\Users\\dev');
  check('windows 分隔符：目录是父目录', win.dir === 'C:\\Users\\');
  check('windows 分隔符：过滤词是最后一段', win.prefix === 'dev');

  const drive = splitPathInput('C:');
  check('盘符没有分隔符：目录为空（调用方放弃过滤回退）', drive.dir === '' && drive.prefix === 'C:');

  const relative = splitPathInput('a');
  check('没有分隔符：目录为空', relative.dir === '' && relative.prefix === 'a');

  const mixed = splitPathInput('/workspace/a/b');
  check('多级：只按最后一个分隔符拆', mixed.dir === '/workspace/a/' && mixed.prefix === 'b');

  const empty = splitPathInput('');
  check('空串：目录与过滤词都是空', empty.dir === '' && empty.prefix === '');

  // 尾分隔符归一：显示的目录始终以 `/` 结尾（点击候选自动补上）
  check('普通目录补尾分隔符', ensureTrailingSeparator('/home/dev') === '/home/dev/');
  check('根路径保持原样', ensureTrailingSeparator('/') === '/');
  check('已带尾分隔符不重复补', ensureTrailingSeparator('/home/dev/') === '/home/dev/');
  check('windows 尾分隔符也认可（不重复补）', ensureTrailingSeparator('C:\\Users') === 'C:\\Users/');
  check('windows 尾反斜杠保持原样', ensureTrailingSeparator('C:\\Users\\') === 'C:\\Users\\');
  check('空串保持原样', ensureTrailingSeparator('') === '');

  // 同目录判定：只忽略末尾分隔符差异（选择器据此判断「路径框指向的是不是当前列出的目录」）
  check('去尾分隔符', trimTrailingSeparators('/home/dev/') === '/home/dev');
  check('根保留成 /', trimTrailingSeparators('/') === '/');
  check('windows 尾反斜杠也去掉', trimTrailingSeparators('C:\\Users\\') === 'C:\\Users');
  check('无尾分隔符不动', trimTrailingSeparators('/home/dev') === '/home/dev');
  check('尾分隔符差异算同一目录', sameDirectory('/home/dev/', '/home/dev'));
  check('反斜杠尾分隔符也算同一目录', sameDirectory('C:\\Users\\', 'C:\\Users'));
  check('不同目录不算同一目录', !sameDirectory('/home/dev/', '/home/dev2/'));
  check('父目录与子目录不算同一目录', !sameDirectory('/home/dev/', '/home/dev/x/'));

  // 路径框指向的目录：末尾带分隔符是它自己，否则是父目录；整串没分隔符时按整串算
  check('指向的目录：带尾分隔符是它自己', typedDirectory('/home/dev/') === '/home/dev/');
  check('指向的目录：不带尾分隔符是父目录', typedDirectory('/home/dev') === '/home/');
  check('指向的目录：没有分隔符时按整串算', typedDirectory('C:') === 'C:');
  check('指向的目录：空串', typedDirectory('') === '');

  // 补全：未补全时写选中项；已指向选中项时补尾分隔符（表示「这一级敲完了」）
  check('补全：前缀补成选中项', completePathInput('/home/de', '/home/dev') === '/home/dev');
  check('补全：已到选中项时补尾分隔符', completePathInput('/home/dev', '/home/dev') === '/home/dev/');
  check('补全：带尾分隔符时保持', completePathInput('/home/dev/', '/home/dev') === '/home/dev/');
  check('补全：windows 反斜杠同样处理', completePathInput('C:\\Users', 'C:\\Users') === 'C:\\Users/');

  finish();
});
