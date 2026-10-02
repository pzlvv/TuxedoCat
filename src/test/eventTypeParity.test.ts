/**
 * 事件词汇对照：CoreEvent / CoreRequest / UiEvent / UiRequest 的 type 全表
 * 与 `fixtures/eventTypesParity.json` 逐一对齐（Rust 侧 main_tests 读同一张表）。
 *
 * 两层锁：
 * - 编译期：`satisfies` + `Exclude<...> extends never` 穷尽检查——联合新增成员而
 *   本表未补时编译报错；
 * - 运行期：本表与 fixture 的集合相等——两侧（TS / Rust）改词汇表必须同步 fixture。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { CoreEvent, CoreRequest, UiEvent, UiRequest } from '../core/AssistantEventBus';
import { runTests } from './helpers/harness';

const CORE_EVENT_TYPES = [
  'coreReady',
  'message',
  'streamMessage',
  'streamEnd',
  'toolCall',
  'toolResult',
  'toolArgsUpdated',
  'toolProgress',
  'aiBegin',
  'aiEnd',
  'messagesReplaced',
  'queryBegin',
  'queryEnd',
  'titleChanged',
  'sessionCreated',
  'conversationListChanged',
  'sessionRuntimeChanged',
  'spinDesignDataChanged',
  'highlightLanguagesUsed',
  'compactBegin',
  'compactEnd',
  'commandDispatched',
  'sessionConfigChanged',
  'log',
  'notice',
] as const satisfies readonly CoreEvent['type'][];
// 穷尽检查：联合里有而数组没有的成员会在这里产生编译错误
type ExhaustiveCoreEvents = Exclude<CoreEvent['type'], (typeof CORE_EVENT_TYPES)[number]> extends never ? true : ['CoreEvent 缺成员'];
const _EXHAUSTIVE_CORE_EVENTS: ExhaustiveCoreEvents = true;
void _EXHAUSTIVE_CORE_EVENTS;

const CORE_REQUEST_TYPES = [
  'toolPermissionRequested',
  'userChoice',
] as const satisfies readonly CoreRequest['type'][];
type ExhaustiveCoreRequests = Exclude<CoreRequest['type'], (typeof CORE_REQUEST_TYPES)[number]> extends never ? true : ['CoreRequest 缺成员'];
const _EXHAUSTIVE_CORE_REQUESTS: ExhaustiveCoreRequests = true;
void _EXHAUSTIVE_CORE_REQUESTS;

const UI_EVENT_TYPES = [
  'userMessageSubmitted',
  'abortRequested',
  'compactRequested',
  'conversationStarted',
  'conversationOpened',
  'conversationClosed',
  'conversationRenamed',
  'conversationDeleted',
  'conversationContextUpdated',
  'conversationSpaceCleared',
  'modelChanged',
  'thinkingEffortChanged',
  'promptModeChanged',
  'agentModeChanged',
  'webSearchChanged',
  'mcpEnabledChanged',
  'editRolledBack',
  'hostEnvironmentProvided',
  'userChoicePendingChanged',
  'sessionWorkspaceAssigned',
] as const satisfies readonly UiEvent['type'][];
type ExhaustiveUiEvents = Exclude<UiEvent['type'], (typeof UI_EVENT_TYPES)[number]> extends never ? true : ['UiEvent 缺成员'];
const _EXHAUSTIVE_UI_EVENTS: ExhaustiveUiEvents = true;
void _EXHAUSTIVE_UI_EVENTS;

const UI_REQUEST_TYPES = [
  'conversationListRequested',
  'smartNamingRequested',
  'balanceRequested',
  'compactArchiveRequested',
  'mcpServersRequested',
  'conversationSpacesRequested',
  'flushSessionRequested',
  'conversationLoadRequested',
  'skillsRequested',
] as const satisfies readonly UiRequest['type'][];
type ExhaustiveUiRequests = Exclude<UiRequest['type'], (typeof UI_REQUEST_TYPES)[number]> extends never ? true : ['UiRequest 缺成员'];
const _EXHAUSTIVE_UI_REQUESTS: ExhaustiveUiRequests = true;
void _EXHAUSTIVE_UI_REQUESTS;

async function run(): Promise<void> {
  const fixturePath = path.resolve(__dirname, '../../../src/test/fixtures/eventTypesParity.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
    coreEvents: string[];
    coreRequests: string[];
    uiEvents: string[];
    uiRequests: string[];
  };

  const check = (label: string, ours: readonly string[], theirs: string[]): void => {
    const missing = theirs.filter((t) => !ours.includes(t));
    const extra = ours.filter((t) => !theirs.includes(t));
    assert.deepStrictEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${label} 与 fixture 不一致（missing=${missing}, extra=${extra}）`,
    );
  };

  check('CoreEvent', CORE_EVENT_TYPES, fixture.coreEvents);
  check('CoreRequest', CORE_REQUEST_TYPES, fixture.coreRequests);
  check('UiEvent', UI_EVENT_TYPES, fixture.uiEvents);
  check('UiRequest', UI_REQUEST_TYPES, fixture.uiRequests);
}

runTests('eventTypeParity', run);
