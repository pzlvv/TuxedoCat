/**
 * MCP 对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/mcpParity.json`：
 * - 本文件断言「对照表 == Embedded 的 `mcp/Client.ts` / `mcp/Config.ts` /
 *   `mcp/McpTool.ts` 导出」；
 * - `core-rs/src/mcp_tests.rs` / `mcp_config_tests.rs` 断言「Rust `mcp::*` /
 *   `mcp_config::*` == 对照表」。
 *
 * 只覆盖**纯函数**：`tools/call` 结果展平、`tools/list` 分页与过滤、工具名拼接、
 * Windows 参数引号、传输类型判定、`mcp.json` 解析与启用状态合并。真正跑子进程 /
 * HTTP 的流程由 Rust 侧单测覆盖。
 *
 * 运行方式：npm run test:all -- mcp-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listMcpTools, normalizeMcpCallResult, quoteWindowsArg } from '../core/mcp/Client';
import type { McpCallResult, McpToolDefinition } from '../core/mcp/Client';
import { buildMcpToolName } from '../core/mcp/McpTool';
import { isRemoteServer, isRemoteType, readMcpServers } from '../core/mcp/Config';
import type { McpServerInfo } from '../core/webviewTypes';
import { createChecker, runTests } from './helpers/harness';
import { applyTestSettings } from './helpers/fixtures';

interface CallResultCase {
  name: string;
  result: unknown;
  text: string;
  isError: boolean;
}

interface ToolListCase {
  name: string;
  pages: unknown[];
  calls: Array<{ method: string; params: unknown }>;
  tools: McpToolDefinition[];
}

interface ConfigParseCase {
  name: string;
  mcpJson: unknown;
  settingsJson: unknown;
  servers: McpServerInfo[];
}

interface Fixture {
  callResults: CallResultCase[];
  toolLists: ToolListCase[];
  toolNames: Array<{ server: string; tool: string; result: string }>;
  quoteWindowsArgs: Array<{ input: string; result: string }>;
  isRemoteType: Array<{ type: string; result: boolean }>;
  isRemoteServer: Array<{ type: string; url: string; command: string[]; result: boolean }>;
  configParse: ConfigParseCase[];
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/mcpParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check('对照表非空', fixture.callResults.length > 0 && fixture.toolLists.length > 0);

  // ---- tools/call 结果展平 ----
  for (const item of fixture.callResults) {
    const normalized: McpCallResult = normalizeMcpCallResult(item.result);
    check(
      `normalizeMcpCallResult: ${item.name}`,
      normalized.text === item.text && normalized.isError === item.isError,
    );
  }

  // ---- tools/list 分页与过滤 ----
  for (const item of fixture.toolLists) {
    let index = 0;
    const calls: Array<{ method: string; params: unknown }> = [];
    const tools = await listMcpTools(async (method, params) => {
      calls.push({ method, params });
      return item.pages[index++] ?? {};
    });
    check(
      `listMcpTools 调用序列: ${item.name}`,
      JSON.stringify(calls) === JSON.stringify(item.calls),
    );
    check(
      `listMcpTools 结果: ${item.name}`,
      JSON.stringify(tools) === JSON.stringify(item.tools),
    );
  }

  // ---- 工具名拼接 ----
  for (const item of fixture.toolNames) {
    check(
      `buildMcpToolName: ${item.server} / ${item.tool}`,
      buildMcpToolName(item.server, item.tool) === item.result,
    );
  }

  // ---- Windows 参数引号 ----
  for (const item of fixture.quoteWindowsArgs) {
    check(
      `quoteWindowsArg: ${JSON.stringify(item.input)}`,
      quoteWindowsArg(item.input) === item.result,
    );
  }

  // ---- 传输类型判定 ----
  for (const item of fixture.isRemoteType) {
    check(`isRemoteType: ${item.type}`, isRemoteType(item.type) === item.result);
  }
  for (const item of fixture.isRemoteServer) {
    check(
      `isRemoteServer: ${item.type} / ${item.url} / ${JSON.stringify(item.command)}`,
      isRemoteServer({ type: item.type, url: item.url, command: item.command }) === item.result,
    );
  }

  // ---- mcp.json 解析 + 启用状态合并 ----
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-parity-test-'));
  const configDir = path.join(tempHome, '.tuxedo-cat');
  fs.mkdirSync(configDir, { recursive: true });
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    for (const item of fixture.configParse) {
      fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(item.mcpJson, null, 2));
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify(item.settingsJson, null, 2),
      );
      // 配置归 UI：core 侧从快照取值，测试注入与文件内容等价的快照
      applyTestSettings(item.settingsJson, item.mcpJson);
      const servers = await readMcpServers();
      check(
        `readMcpServers: ${item.name}`,
        JSON.stringify(servers) === JSON.stringify(item.servers),
      );
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  finish();
}

runTests('mcp-parity', run);
