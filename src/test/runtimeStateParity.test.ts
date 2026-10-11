/**
 * `SessionRuntimeState` 字段集合 parity（`src/test/fixtures/runtimeStateParity.json`）。
 *
 * 快照字段没有任何跨端类型共享：TS 接口（`src/core/AssistantEventBus.ts`）、Rust 手写
 * JSON（`core-rs/src/engine.rs` 的 `runtime_state_json`）、webview 投影
 * （`src/webview/types.ts`）各自维护——`parentSessionId` 同时漏登三份文档就是这类漂移
 * 的实例。fixture 锁三方：字段集合改动时，本测试与 Rust `main_tests` 的对应用例同时失败。
 *
 * webview 侧不 import 类型（webview 目录有独立 tsconfig / DOM lib，进编译图会互相污染），
 * 从源码文本提取接口字段做对照。
 *
 * 运行方式：npm run test:all -- runtime-state-parity
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionRuntimeState } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface RuntimeStateFixture {
  fields: string[];
  /** webview 投影不带的字段（`sessionId` 由 wire 信封携带，不进投影对象） */
  webviewOmitted: string[];
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'src/test/fixtures/runtimeStateParity.json'), 'utf-8'),
) as RuntimeStateFixture;

/** 从 `src/webview/types.ts` 的 `SessionRuntimeState` 接口提取字段名 */
function webviewProjectionFields(): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/types.ts'), 'utf-8');
  const block = src.match(/export interface SessionRuntimeState \{([\s\S]*?)\n\}/);
  assert.ok(block, 'src/webview/types.ts 缺少 SessionRuntimeState 接口');
  const names = [...block[1].matchAll(/^\s+([a-zA-Z0-9_]+)\s*[(:;]/gm)].map((m) => m[1] ?? '');
  assert.ok(names.length > 0, 'SessionRuntimeState 接口未解析出字段');
  return names;
}

function run(): void {
  const { check, finish } = createChecker();

  // core 接口：Record<keyof T> 让 probe 的键集与接口精确相等（多 / 少字段都编译报错）
  const coreProbe: Record<keyof SessionRuntimeState, unknown> = {
    sessionId: 's',
    idle: false,
    waiting: false,
    queryRunning: false,
    compacting: false,
    backgroundRunning: false,
    subAgentRunning: false,
    parentSessionId: null,
  };
  assert.deepEqual(Object.keys(coreProbe).sort(), [...fixture.fields].sort());
  check('fixture.fields 与 core SessionRuntimeState 接口一致', true);

  // webview 投影：= fields − webviewOmitted
  const expectedWebview = fixture.fields.filter((f) => !fixture.webviewOmitted.includes(f));
  assert.deepEqual(webviewProjectionFields().sort(), expectedWebview.sort());
  check('webview 投影键集 = fields − webviewOmitted', true);

  finish();
}

runTests('runtimeStateParity', run);
