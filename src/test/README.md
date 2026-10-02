# 测试指南

## 三条车道

| 车道 | 命令 | 目录 | 进程模型 |
| --- | --- | --- | --- |
| 单元测试 | `npm run test:all` | `src/test/*.test.ts` | 每个文件一个**独立 node 进程** |
| 场景测试 | `npm run test:all`（同一车道） | `src/test/scenario*.test.ts` | 同上，LLM 走脚本注入 |
| 宿主集成 | `npm test`（`vscode-test`） | `src/test/vscodeHost/**/*.test.ts` | 真实 VS Code 扩展宿主 |

**为什么单元测试不进宿主**：`src/test/*.test.ts` 里大量用例会注册全局单例
（`setGlobalEventBus`、`setSessionWorkspace`、`sessionRuntime`、`SubAgentRegistry`…）。
宿主进程里扩展本体已经激活过一遍，这些单例已被占用，两者撞在同一进程里会直接互相污染——
例如 `setGlobalEventBus` 重复注册是**抛错**语义，测试当场就挂。所以：

- 纯逻辑单测只跑独立进程（快、无副作用、CI 友好）；
- 只有「必须验证真实 VS Code API / manifest 接线」的东西才放 `vscodeHost/`。

`npm test` 因此只覆盖 `vscodeHost/`，这是有意的，不是配置漏了。

## 场景测试

单测断言单个行为（直接调 `runTools` / `flushQueuedMessagesIntoContext` 这类 core 内部函数）；
场景测试把一条 `userMessageSubmitted` 走完整条管线，断言**事件序列、LLM 上下文、
会话落盘**三者的一致性。文件命名 `scenario*.test.ts`，与单测同车道运行。

- LLM 经 `setCallLlmOverride`（`src/core/llm/index.ts`）注入按场景编排的脚本
  （`helpers/scenario.ts` 的 `createScriptedLlm` / `textRound` / `toolUseRound` /
  `abortedRound`），不发网络请求；脚本耗尽后再有 LLM 调用直接抛错。
- `helpers/scenario.ts` 的 `startScenario()` 负责全部接线：HOME 指向临时目录、
  独立总线 + 时间线记录、按真实 bootstrap 顺序 `initializeCoreEvents` →
  `hostEnvironmentProvided`、会话工作区、LLM 注入。**测试结束必须 `close()`**。
- 现有场景：`scenarioToolRoundtrip`（工具调用全链路）、`scenarioPermissionDenied`
  （权限拒绝后管线闭合）、`scenarioAbort`（中止回显 + 引擎复用）。

两套 Core（Embedded TS / Standalone Rust）的场景级 parity 还没建：场景脚本目前
只驱动 Embedded 侧，core-rs 侧的同类场景在 `core-rs/src/engine_tests.rs` 各自维护。

## 常用命令

```bash
npm run test:all                        # 全部单测（先 tsc 编译再逐个跑）
npm run test:all -- edit-diff bus       # 只跑名字匹配的（camelCase / kebab-case 都认）
npm run test:coverage                   # c8 覆盖率（文本 + html，产物在 coverage/）
npm test                                # 宿主冒烟（会先跑 check-types + esbuild + lint）

node scripts/run-tests.mjs --list       # 只列出会被跑的用例
node scripts/run-tests.mjs --bail       # 首个失败即停
node scripts/run-tests.mjs --help
```

`test:all` 会先执行 `tsc -p tsconfig.test.json`（编译到 `out/`，已被 gitignore）。
`scripts/run-tests.mjs` 从**源码**目录发现用例，所以新增文件只要放对位置就会自动被跑到——
如果加了文件却忘了编译，runner 会直接报缺编译产物，而不是静默跳过。

## 目录结构

```
src/test/
├── *.test.ts          # 纯逻辑单测 + 场景测试（scenario*.test.ts）；runner 只收集这一层
├── helpers/
│   ├── harness.ts     # createChecker / runTests / runCases（断言计数与执行入口）
│   ├── fixtures.ts    # makeTestBus / createTestHost / makeTempDir
│   └── scenario.ts    # startScenario / createScriptedLlm（场景级测试，见上节）
├── vscodeHost/        # 需要真实 VS Code 宿主，走 npm test
└── memtest/           # Playwright 渲染 / 内存 / 性能 harness，手动跑（见其 README）
```

## 写一个新单测

```ts
/**
 * <这个文件守护什么回归：写清"如果坏了会怎样"，而不是复述断言>
 *
 * 运行方式：npm run test:all -- my-feature
 */

import * as assert from 'assert';
import { createChecker, runTests } from './helpers/harness';
import { makeTestBus, makeTempDir } from './helpers/fixtures';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const { bus } = makeTestBus();          // 需要发事件 / 收事件时用
  const home = makeTempDir('my-feature'); // 需要临时目录时用（退出时自动清理）

  assert.strictEqual(2 + 2, 4, '断言直接抛错即可');
  check('一句可读的结论', true);

  finish();                                // 打印汇总；有失败即抛错
}

runTests('myFeature', run);
```

要点：

- **不要**在模块顶层裸调 `void run();`。游离 promise 的失败没人等，异步 I/O 的断言可能
  在进程退出前都没跑完，失败会被静默吞掉。用 `runTests` / `runCases`。
- **不要**再手抄 `CoreEventHandlers`（23 个字段）/ `UIHost`（19 个成员）/ `check` 计数器——
  用 `helpers/`。这些契约每加一个成员就要改 N 个文件的时代已经过去了。
- 表驱动用例用 `runCases(name, CASES)`：mocha 下每条 case 是独立用例，失败定位到条。
- 头部注释的 `运行方式：` 行统一写 `npm run test:all -- <kebab-case 文件名>`。
- 不放真实网络请求（`core/llm/httpDispatcher.ts` 是现成的注入点，换成桩）；
  不依赖真实时钟（`core/llm/streamTimeout.ts` 的用例是现成范式）。
- 临时目录走 `makeTempDir()`，不要写进仓库，也不要拼 `Date.now()` 自己造名字（会撞）。
- 老文件里的 `if (typeof globalThis.suite === 'function')` 分支由 `runTests` / `runCases`
  统一处理，新文件不需要自己判断 runner。

## 覆盖率

`npm run test:coverage` 用 c8 收集（`out/` 的 sourceMap 会映射回 `src/**`），
报告只有**被加载过的文件**。它的用途是找「一行都没测」的模块来排优先级，
不是拿来卡门槛的指标。

## 还没覆盖的地方

`src/webview/`（React 那侧）目前没有任何自动化测试——它跑在 Vite/DOM 环境，
和这里的 CommonJS + node 链路不同，需要单独的 Vitest + jsdom 工程。
`src/test/memtest/` 那套 Playwright harness 是它的临时替代，只做渲染/内存回归。


## 场景级 e2e（Playwright，独立车道）

`e2e/` 下还有一层 Playwright 场景级测试（webview UI 级 + Electron 整应用），
需求基线为 `docs/user-stories.md`，与本车道互不依赖，运行方式见 `e2e/README.md`
（`npm run test:e2e`）。
