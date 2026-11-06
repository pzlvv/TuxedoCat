/**
 * 单测：会话落盘的单写者守卫（`docs/core/standalone-core.md` 第 4 节的 owner 表、
 * `docs/architecture/principles.md` 第 11 节）。
 *
 * 契约：会话数据（`meta.json` / `<sid>.jsonl` / 压缩归档 / `workspace.meta.json`）
 * 只有 Core 写。宿主侧只保留两条通路——`UiEvent` 提改动请求、`UiRequest` 读事实；
 * 因此宿主代码里不允许出现对会话目录的写 API（`appendFile` / `writeFile` /
 * `Files.write` 等），也不允许再调用 `updateToolUseMeta` 这类「宿主直写 JSONL」入口。
 *
 * 这条守卫锁的是一类静默失效：宿主与 Core 各自用**进程内**锁写同一个文件，跨进程
 * 没有互斥，行被撕开时两侧都看不出来（specs/defects/host-appends-session-jsonl.md）。
 *
 * 运行方式：npm run test:unit -- session-single-writer
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 被扫描的宿主侧落盘相关文件（相对仓库根的 POSIX 路径）。缺文件即失败。 */
const HOST_SESSION_FILES = [
  'src/shared/history/Conversation.ts',
  'src/shared/history/Config.ts',
  'src/shared/mcp/Config.ts',
  'src/host/ui/toolHandler.ts',
  'pycharm-plugin/src/main/kotlin/pycharm/host/ui/HostUi.kt',
];

/** 会话落盘的写 API（宿主侧一旦出现即视为越界） */
const FORBIDDEN_WRITE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'fs appendFile', pattern: /\bappendFile(Sync)?\s*\(/ },
  { name: 'fs writeFile', pattern: /\bwriteFile(Sync)?\s*\(/ },
  { name: 'fs createWriteStream', pattern: /\bcreateWriteStream\s*\(/ },
  { name: 'Kotlin Files.write', pattern: /\bFiles\.write\s*\(/ },
  { name: 'Kotlin Files.newOutputStream', pattern: /\bFiles\.newOutputStream\s*\(/ },
  { name: '宿主直写 _meta 入口', pattern: /\bupdateToolUseMeta\b/ },
  { name: '宿主直写 _meta（PyCharm）', pattern: /\bwriteToolMeta\b/ },
];

/** 允许保留的只读 / 非会话文件写入（行内含这些标记即跳过该行） */
const ALLOW_MARKERS = [
  // 配置 / 卸载记录等会话目录之外的文件，不属于会话落盘
  'workspace-state',
  'settings.json',
  'mcp.json',
];

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  for (const rel of HOST_SESSION_FILES) {
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full)) {
      check(`${rel} 存在`, false);
      continue;
    }
    const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 注释行不是可执行代码（说明性引用保留）
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (ALLOW_MARKERS.some((marker) => line.includes(marker))) continue;
      for (const { name, pattern } of FORBIDDEN_WRITE_PATTERNS) {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1} ${name} → ${trimmed}`);
      }
    }
    check(`${rel} 不含会话写入 API（命中 ${hits.length} 处）`, hits.length === 0);
    for (const hit of hits) console.log(`    ${hit}`);
  }

  finish();
}

runTests('session-single-writer', run);
