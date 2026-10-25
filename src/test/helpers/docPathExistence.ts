import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * 「按设计不入库、本机自备」的路径判定
 * （`specs/defects/docs-lint-flags-gitignored-paths.md`）。
 *
 * 仓库里有几份**故意 gitignore** 的文件：`e2e/environments.json` 含 SSH 凭证，每台机器自己
 * 从 `e2e/environments.example.json` 复制一份。入库文档在行内代码里引用它们是正当的，但这类
 * 路径在干净克隆与 CI 上必然不存在——存在性检查若只看本机文件系统，「红不红」就取决于这台
 * 机器有没有准备凭证，与仓库内容无关。
 *
 * 判据取 `.gitignore`（唯一来源），不另维护白名单：被 gitignore 覆盖的路径缺失是常态，
 * 没被覆盖的路径仍然必须存在（拼错照旧报错）。
 */

/** 仓库根：编译产物在 `out/src/test/helpers/`，往上四层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** 一次运行里同一路径会被多个文档引用，判定结果缓存住（每次判定要起一个 git 进程） */
const cache = new Map<string, boolean>();

/**
 * 路径是否被 `.gitignore` 覆盖。
 *
 * `git check-ignore` 的退出码就是答案：0 命中规则、1 未命中、其余（不在仓库里 / git 不可用）
 * 按「不是本机专属」处理——**失败关闭**，宁可让检查多报，也不让豁免退化成静默放行。
 */
export function isLocalOnlyPath(relPath: string): boolean {
  const cached = cache.get(relPath);
  if (cached !== undefined) return cached;
  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const localOnly = result.status === 0;
  cache.set(relPath, localOnly);
  return localOnly;
}
