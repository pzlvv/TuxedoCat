/**
 * Spin 设计器数据面单测（specs/015）。
 *
 * 锁住三件事：
 * - 宿主侧只发 `UiRequest.spinDesignRequested` / `spinDesignSaveRequested`，不读本地磁盘；
 * - 读取 / 保存结果与失败结果原样透传；
 * - `/spin` 的存在性判断来自 Core 结果，而不是宿主本地 `fs`。
 *
 * 运行方式：npm run test:all -- spinDesignCore
 */

import * as fs from 'fs';
import * as path from 'path';

import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import { createTestBus } from './helpers/testBus';
import {
  resetGlobalEventBus,
  setGlobalEventBus,
  type SpinDesignReadResult,
  type SpinDesignSaveResult,
  type UiRequest,
  type UiRequestHandlers,
} from '../shared/AssistantEventBus';
import { requestSpinDesign, saveSpinDesign } from '../host/coreFacts';
import { shouldOpenSpinDesign } from '../shared/history/spinCommand';
import { planSpinDesignSessionSwitch } from '../host/spinDesignSession';
import { getSpinDesignHtml } from '../host/ui/spinDesignHtml';
import { CONFIG_DIR_NAME } from '../config/project';
import type { SpinDesign } from '../shared/spin/Types';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const bus = createTestBus();
  const sent: UiRequest[] = [];
  let readResult: SpinDesignReadResult = { status: 'ok', data: null, skills: [] };
  let saveResult: SpinDesignSaveResult = { status: 'ok' };
  const handlers: UiRequestHandlers = {
    conversationListRequested: async () => [],
    smartNamingRequested: async () => ({ title: '' }),
    balanceRequested: async () => null,
    compactArchiveRequested: async () => null,
    mcpServersRequested: async () => [],
    conversationSpacesRequested: async () => [],
    flushSessionRequested: async () => null,
    sessionTodosRequested: async () => [],
    conversationLoadRequested: async () => ({
      messages: [],
      metadata: null,
      pendingToolUseIds: [],
      hasCompactArchive: false,
      agentMode: null,
      workMode: 'normal' as const,
    }),
    skillsRequested: async () => ({ skills: [] }),
    spinDesignRequested: async (req) => {
      sent.push(req);
      return readResult;
    },
    spinDesignSaveRequested: async (req) => {
      sent.push(req);
      return saveResult;
    },
    watchWorkspaceFileRequested: async () => ({ ok: true }),
    unwatchWorkspaceFileRequested: async () => null,
  };
  bus.onUiRequests(handlers);
  setGlobalEventBus(bus);

  try {
    // ---------- 读取：按 sessionId 路由 ----------
    const read = await requestSpinDesign('s1');
    const readReq = sent.at(-1) as { type?: string; sessionId?: string };
    check(
      '读取走 spinDesignRequested 且带 sessionId',
      read.status === 'ok' && readReq.type === 'spinDesignRequested' && readReq.sessionId === 's1',
    );
    check('无设计文件时返回 data: null', read.status === 'ok' && read.data === null);

    // ---------- 保存：按 sessionId + data 路由 ----------
    const design: SpinDesign = { nodes: [], edges: [], meta: {} };
    const saved = await saveSpinDesign('s1', design);
    const saveReq = sent.at(-1) as { type?: string; sessionId?: string; data?: SpinDesign };
    check(
      '保存走 spinDesignSaveRequested 且带 sessionId / data',
      saved.status === 'ok' &&
        saveReq.type === 'spinDesignSaveRequested' &&
        saveReq.sessionId === 's1' &&
        JSON.stringify(saveReq.data) === JSON.stringify(design),
    );

    // ---------- 失败结果原样透传 ----------
    readResult = { status: 'error', message: 'read boom' };
    const readErr = await requestSpinDesign('s1');
    check('读取失败结果原样返回', readErr.status === 'error' && readErr.message === 'read boom');

    saveResult = { status: 'error', message: 'write boom' };
    const saveErr = await saveSpinDesign('s1', design);
    check('保存失败结果原样返回', saveErr.status === 'error' && saveErr.message === 'write boom');

    // ---------- /spin 存在性判断来自 Core 结果 ----------
    check('无设计文件 → 打开设计器', shouldOpenSpinDesign({ status: 'ok', data: null, skills: [] }));
    check(
      '有设计文件 → 不打开设计器',
      !shouldOpenSpinDesign({ status: 'ok', data: design, skills: [] }),
    );
    check(
      '读取失败 → 不当作没有设计',
      !shouldOpenSpinDesign({ status: 'error', message: 'boom' }),
    );

    // ---------- 会话切换：先读后绑、失败保持原绑定 ----------
    let readCalls = 0;
    const readOk = async (id: string): Promise<SpinDesignReadResult> => {
      readCalls++;
      return { status: 'ok', data: { nodes: [], edges: [], meta: {}, variables: { from: id } }, skills: [] };
    };
    const sameSession = await planSpinDesignSessionSwitch('s1', 's1', readOk);
    check('同会话不触发读取', sameSession.kind === 'unchanged' && readCalls === 0);
    const noSession = await planSpinDesignSessionSwitch('s1', null, readOk);
    check('null 会话不切换', noSession.kind === 'unchanged' && readCalls === 0);
    const switched = await planSpinDesignSessionSwitch('s1', 's2', readOk);
    check(
      '异会话先读成功再切绑定',
      switched.kind === 'switch' &&
        switched.sessionId === 's2' &&
        switched.read.status === 'ok' &&
        readCalls === 1,
    );
    const failedRead = await planSpinDesignSessionSwitch('s1', 's2', async () => ({
      status: 'error',
      message: 'boom',
    }));
    check('读取失败保持原绑定', failedRead.kind === 'error' && failedRead.message === 'boom');
    const rejectedRead = await planSpinDesignSessionSwitch('s1', 's2', async () => {
      throw new Error('offline');
    });
    check(
      '请求 reject 保持原绑定',
      rejectedRead.kind === 'error' && rejectedRead.message.includes('offline'),
    );

    // ---------- 宿主保存不落本地盘 ----------
    const tempHome = makeTempDir('spin-design-host');
    const previousProfile = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    process.env.USERPROFILE = tempHome;
    process.env.HOME = tempHome;
    saveResult = { status: 'ok' };
    try {
      await saveSpinDesign('s1', design);
      const conversations = path.join(tempHome, CONFIG_DIR_NAME, 'conversations');
      check('宿主保存不在本地创建 conversations 目录', !fs.existsSync(conversations));
    } finally {
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    // ---------- 设计器 HTML：错误消息与保存闸门 ----------
    const html = getSpinDesignHtml(null, false, 'en', 'en-US', 'en', [], false);
    check('设计器 HTML 处理 spinDesignError', html.includes("msg.type === 'spinDesignError'"));
    check('设计器 HTML 初始禁止保存', html.includes('var __spinCanSave = false;'));
    check('设计器 HTML 含未读取提示', html.includes('Design not loaded yet; cannot save'));
    const errorStart = html.indexOf("msg.type === 'spinDesignError'");
    const errorEnd = html.indexOf("else if (msg.type === 'spinDesignData')", errorStart);
    const errorHandler = errorStart >= 0 && errorEnd > errorStart
      ? html.slice(errorStart, errorEnd)
      : '';
    check(
      '错误提示不清空画布',
      errorStart >= 0 && errorEnd > errorStart && !errorHandler.includes('renderAll'),
    );
    const enabledHtml = getSpinDesignHtml(null, false, 'en', 'en-US', 'en', [], true);
    check('可保存时初始允许保存', enabledHtml.includes('var __spinCanSave = true;'));
  } finally {
    resetGlobalEventBus();
  }

  finish();
}

runTests('spinDesignCore', run);
