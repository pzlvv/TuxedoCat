/**
 * SystemEnvironment 缓存单测（按工作目录分桶 + 预热刷新）：
 * - 缓存键是工作目录：不同目录的条目互不命中，各自读到自己目录的技能清单；
 * - 命中同 cwd 的条目时复用旧快照；
 * - warmupSystemDynamicInfo 是刷新语义：丢弃该 cwd 的旧条目后重算。
 * 运行方式：npm run test:all -- system-environment
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir } from './helpers/fixtures';
import { runTests } from './helpers/harness';

/** 在工作目录下写一个项目级 Skill（<cwd>/.tuxedo-cat/skills/<name>/SKILL.md） */
function writeSkill(cwd: string, name: string): void {
  const dir = path.join(cwd, '.tuxedo-cat', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} 技能`, 'user-invocable: true', '---', '', `# ${name}`, ''].join('\n'),
    'utf-8',
  );
}

async function run(): Promise<void> {
  // 隔离 user 级技能目录：HOME / USERPROFILE 指向临时目录（loadSkillsDir 在调用时读取）
  const home = makeTempDir('sysenv-home');
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const { getSystemDynamicInfo, warmupSystemDynamicInfo } = await import('../core/prompt/SystemEnvironment');

    // 1. 按 cwd 分桶：各自拿到自己目录的技能清单
    const cwdA = makeTempDir('sysenv-a');
    const cwdB = makeTempDir('sysenv-b');
    writeSkill(cwdA, 'skill-a');
    writeSkill(cwdB, 'skill-b');

    const infoA = await getSystemDynamicInfo(cwdA);
    const infoB = await getSystemDynamicInfo(cwdB);
    assert.ok(infoA.availableSkills?.includes('skill-a'), 'cwdA 应包含 skill-a');
    assert.ok(!infoA.availableSkills?.includes('skill-b'), 'cwdA 不应包含 skill-b');
    assert.ok(infoB.availableSkills?.includes('skill-b'), 'cwdB 应包含 skill-b');
    assert.ok(!infoB.availableSkills?.includes('skill-a'), 'cwdB 不应包含 skill-a');

    // 2. 命中同 cwd 的条目时复用旧快照（新增技能后不预热仍读旧值）
    const cwdC = makeTempDir('sysenv-c');
    const before = await getSystemDynamicInfo(cwdC);
    assert.ok(!before.availableSkills?.includes('skill-c'), '预热前不应包含 skill-c');
    writeSkill(cwdC, 'skill-c');
    const cached = await getSystemDynamicInfo(cwdC);
    assert.ok(!cached.availableSkills?.includes('skill-c'), '命中缓存时应复用旧快照');

    // 3. 预热是刷新：重算该 cwd 的条目
    await warmupSystemDynamicInfo(cwdC);
    const refreshed = await getSystemDynamicInfo(cwdC);
    assert.ok(refreshed.availableSkills?.includes('skill-c'), '预热后应包含 skill-c');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  }
}

runTests('systemEnvironmentCache', run);
