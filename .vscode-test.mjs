import { defineConfig } from '@vscode/test-cli';

/**
 * `npm test`（`vscode-test`）的运行配置。
 *
 * 只收集 `src/test/vscodeHost/` —— 需要真实 VS Code 宿主的集成测试。
 *
 * 为什么不把全部测试都挂到这里：`src/test/*.test.ts` 里的纯逻辑单测会注册全局单例
 * （`setGlobalEventBus`、`setProjectRootProvider`、`sessionRuntime`），而宿主进程里
 * 扩展本体已经激活过一遍，两者会撞在同一个进程里（`setGlobalEventBus` 重复注册直接抛错）。
 * 那些用例的正确跑道是 `npm run test:unit`（每个文件独立 node 进程）。
 * 详见 src/test/README.md。
 */
export default defineConfig({
  files: 'out/src/test/vscodeHost/**/*.test.js',
  mocha: {
    // 测试文件用的是 mocha 的 tdd 接口（suite / test），不是默认的 bdd。
    ui: 'tdd',
    // 扩展宿主冷启动 + 工作区扫描，比纯单测慢得多
    timeout: 60000,
  },
});
