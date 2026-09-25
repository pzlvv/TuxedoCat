/**
 * 单测：工作目录路径去重（同一目录的不同表示）。
 *
 * 验证 `src/host/workspacePaths.ts`：
 * - `normalizeWorkspacePath` 解析相对路径 / 去掉尾部分隔符；
 * - `sameWorkspace` 忽略尾部分隔符、分隔符风格、相对路径，Windows 上忽略大小写；
 * - `dedupeWorkspacePaths` 按去重键去重并保持顺序；
 * - `applyWorkspaceOrder` 校验并归一打开集合的完整排列（拖拽排序提交）；
 * - 目录不存在时 `workspaceKey` 退回 `path.resolve` 且不抛错。
 *
 * 运行方式：npm run test:all -- workspacePaths
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import {
  normalizeWorkspacePath,
  sameWorkspace,
  dedupeWorkspacePaths,
  workspaceKey,
  applyWorkspaceOrder,
  resetWorkspaceKeyCache,
} from '../host/workspacePaths';

runTests('workspacePaths', () => {
  const { check, finish } = createChecker();

  const root = makeTempDir('ws-paths');
  const proj = path.join(root, 'proj');
  const other = path.join(root, 'other');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  // 规范化
  check(
    'normalizeWorkspacePath 去掉尾部分隔符',
    normalizeWorkspacePath(proj + path.sep) === path.resolve(proj),
  );

  // 判等：尾部分隔符 / 分隔符风格 / 相对路径
  check('sameWorkspace 忽略尾部分隔符', sameWorkspace(proj, proj + path.sep) === true);
  check('sameWorkspace 忽略分隔符风格', sameWorkspace(proj, proj.replace(/\\/g, '/')) === true);
  check(
    'sameWorkspace 相对路径解析后相同',
    sameWorkspace(path.relative(process.cwd(), proj), proj) === true,
  );
  check('sameWorkspace 不同目录为假', sameWorkspace(proj, other) === false);
  check('sameWorkspace 空值为假', sameWorkspace(proj, undefined) === false && sameWorkspace('', proj) === false);

  // Windows 大小写不敏感（仅当路径为纯 ASCII 时才做大小写翻转，避免破坏非 ASCII 段）
  const isAsciiPath = [...proj].every((ch) => ch.charCodeAt(0) < 128);
  if (process.platform === 'win32' && isAsciiPath) {
    check('Windows 大小写不同视为同一目录', sameWorkspace(proj, proj.toUpperCase()) === true);
  }

  // 去重
  const deduped = dedupeWorkspacePaths([proj, proj + path.sep, proj.replace(/\\/g, '/'), other, other]);
  check('dedupeWorkspacePaths 去重不同表示', deduped.length === 2);
  check(
    'dedupeWorkspacePaths 保持输入顺序且输出规范化路径',
    deduped[0] === path.resolve(proj) && deduped[1] === path.resolve(other),
  );
  check('dedupeWorkspacePaths 跳过空串', dedupeWorkspacePaths(['', '  ']).length === 0);

  // 目录不存在：退回 resolve，不抛错
  const missing = path.join(root, 'does-not-exist');
  let missingKey = '';
  try {
    missingKey = workspaceKey(missing);
  } catch {
    missingKey = '<threw>';
  }
  check('目录不存在时 workspaceKey 不抛错且退回 resolve', missingKey === path.resolve(missing).toLowerCase() || missingKey === path.resolve(missing));
  check('目录不存在时 sameWorkspace 仍按 resolve 判等', sameWorkspace(missing, missing + path.sep) === true);

  // 缓存清空后结果稳定
  resetWorkspaceKeyCache();
  check('清缓存后 sameWorkspace 仍成立', sameWorkspace(proj, proj + path.sep) === true);

  // ── 拖拽排序：打开集合的完整排列校验 ──
  const third = path.join(root, 'third');
  fs.mkdirSync(third, { recursive: true });
  const current = [proj, other, third];

  const swapped = applyWorkspaceOrder(current, [third, proj, other]);
  check(
    'applyWorkspaceOrder 接受完整排列并返回新顺序',
    !!swapped && swapped[0] === path.resolve(third) && swapped[1] === path.resolve(proj) && swapped[2] === path.resolve(other),
  );
  // 传入不同表示（尾部分隔符）仍能定位到同一目录，输出取 current 中的表示
  const variant = applyWorkspaceOrder(current, [other + path.sep, third, proj]);
  check(
    'applyWorkspaceOrder 容忍不同表示并输出规范化路径',
    !!variant && variant[0] === path.resolve(other) && variant[1] === path.resolve(third),
  );
  check('applyWorkspaceOrder 长度不符返回 null', applyWorkspaceOrder(current, [proj, other]) === null);
  check(
    'applyWorkspaceOrder 含未知目录返回 null',
    applyWorkspaceOrder(current, [proj, other, path.join(root, 'unknown')]) === null,
  );
  check(
    'applyWorkspaceOrder 有重复返回 null',
    applyWorkspaceOrder(current, [proj, proj, third]) === null,
  );
  check(
    'applyWorkspaceOrder 顺序未变时原样返回',
    (() => {
      const same = applyWorkspaceOrder(current, [proj, other, third]);
      return !!same && same.every((p, i) => p === path.resolve(current[i]));
    })(),
  );

  finish();
});
