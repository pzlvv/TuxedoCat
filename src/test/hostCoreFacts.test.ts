/**
 * 单测：宿主侧「core 事实」入口（`docs/standalone-core.md` 第 10 节）。
 *
 * M15 把以下事实从「宿主直接 import core 的状态函数」改为经 `coreFacts` 统一取数：
 * - MCP 面板列表（配置 + 会话启用状态 + 运行时状态）→ `requestMcpServers`
 * - 对话空间统计 → `requestConversationSpaces`
 * - 会话挂起持久化收尾 → `requestFlushSession`
 *
 * 本用例覆盖 Embedded 分支（Standalone 分支由帧通道用例覆盖）；
 * HOME / USERPROFILE 指向临时目录，避免污染真实用户目录。
 *
 * 运行方式：npm run test:all -- hostCoreFacts
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { applyTestSettings, makeTempDir, makeTestBus } from './helpers/fixtures';
import { setGlobalEventBus } from '../core/AssistantEventBus';
import { getConversationDir, setSessionWorkspace } from '../core/history/Config';
import { appendMessage } from '../core/history/Conversation';
import {
  loadConversationForHost,
  requestConversationSpaces,
  requestFlushSession,
  requestMcpServers,
  requestSkills,
} from '../host/coreFacts';

const home = makeTempDir('host-core-facts-home');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.TUXEDO_CAT_CORE = 'embedded';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ── 对话空间统计：只数会话 meta，空间清单（workspace.meta.json）不算会话 ──
  const project = path.join(home, 'workspace');
  const spaceDir = path.join(getConversationDir(), encodeURIComponent(project));
  fs.mkdirSync(path.join(spaceDir, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(spaceDir, 'workspace.meta.json'), JSON.stringify({ workspacePath: project }));
  fs.writeFileSync(path.join(spaceDir, 's1.meta.json'), '{}');
  fs.writeFileSync(path.join(spaceDir, 's1.jsonl'), '{"uuid":"u"}\n');
  fs.writeFileSync(path.join(spaceDir, 'tool-results', 't1.txt'), 'tool output');

  const spaces = await requestConversationSpaces('embedded');
  check('统计出一个对话空间', spaces.length === 1);
  const space = spaces[0];
  check('空间目录名正确', space?.dirName === encodeURIComponent(project));
  check('项目路径取自 workspace.meta.json', space?.projectPath === project);
  check('会话数只数 *.meta.json（不含空间清单）', space?.conversationCount === 1);
  check('文件数包含子目录文件', (space?.fileCount ?? 0) >= 3);
  check('字节数大于 0', (space?.sizeBytes ?? 0) > 0);

  // ── MCP 面板列表：快照里的定义 + 全局默认启用 + 运行时缺省值 ──
  applyTestSettings(
    { mcp: { enabled: ['alpha'] } },
    {
      mcp: {
        alpha: { type: 'local', command: ['npx', 'alpha'] },
        beta: { type: 'remote', url: 'https://beta.example' },
      },
    },
  );
  const servers = await requestMcpServers(undefined, 'embedded');
  check('列出两个 MCP server', servers.length === 2);
  const alpha = servers.find((server) => server.name === 'alpha');
  const beta = servers.find((server) => server.name === 'beta');
  check('全局默认启用列表生效', alpha?.enabled === true);
  check('未启用的 server 标记为 false', beta?.enabled === false);
  check('未连接时补 running=false', alpha?.running === false);
  check('未连接时补 toolCount=0', alpha?.toolCount === 0);
  check('未连接时补 error=null', alpha?.error === null);
  check('未连接时补 refCount=0', alpha?.refCount === 0);

  // ── 会话加载：消息 + 元数据 + 派生事实 ──
  // `appendMessage` 走总线广播列表变化：这里注册一个只记录的总线
  setGlobalEventBus(makeTestBus().bus);
  setSessionWorkspace('s-load', project);
  await appendMessage(
    {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'hello' },
    } as never,
    's-load',
  );
  const loaded = await loadConversationForHost('s-load', 'embedded');
  check('加载出会话消息', loaded.messages.length === 1);
  check('消息内容正确', (loaded.messages[0] as { uuid?: string } | undefined)?.uuid === 'u1');
  check('元数据带上标题', typeof loaded.metadata?.title === 'string' && loaded.metadata.title.length > 0);
  check('没有待执行工具', loaded.pendingToolUseIds.length === 0);
  check('没有压缩归档', loaded.hasCompactArchive === false);
  check('询问模式有权威取值或 null', loaded.agentMode === null || typeof loaded.agentMode === 'string');

  // ── 斜杠命令与技能列表：内置项 + 项目技能目录 ──
  const skillDir = path.join(project, '.tuxedo-cat', 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: demo skill\n---\nbody\n',
  );
  const skills = await requestSkills('s-load', 'embedded');
  check('列出内置命令', skills.some((skill) => skill.isBuiltin === true));
  check('列出内置技能', skills.some((skill) => skill.isBuiltin === false));
  check('列出项目技能', skills.some((skill) => skill.name === 'demo'));
  check('列表项字段完整', skills.every((skill) => !!skill.name && typeof skill.description === 'string'));

  // ── 会话挂起持久化收尾：会话不存在时也算完成 ──
  let flushed = false;
  try {
    await requestFlushSession('no-such-session', 'embedded');
    flushed = true;
  } catch {
    flushed = false;
  }
  check('flush 不存在的会话不抛错', flushed);

  finish();
}

runTests('hostCoreFacts', run);
