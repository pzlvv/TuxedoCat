/**
 * Core 实现的选择（见 docs/core/standalone-core.md 第 3 节）。
 *
 * 装配哪种 Core 由本模块唯一决定：
 * - `embedded`：`src/core` 的 TypeScript 实现，与 UI 同进程；
 * - `standalone`：`core-rs` 的 Rust 实现，独立进程，经帧通道通信。
 *
 * 默认取值为 `standalone`。开发与测试可用 `CORE_KIND_ENV` 覆盖为 `embedded`；
 * 非法取值直接抛错，不做静默回退。
 */

import { CORE_ENV_VAR } from '../config/project.js';

export type CoreKind = 'embedded' | 'standalone';

/**
 * 构建期注入的默认实现（esbuild `define`，值来自打包环境的 `CORE_KIND_ENV`）。
 *
 * 源码里不赋值：未注入（`tsc` 编译、单测、直接跑源码）时 `typeof` 为 `'undefined'`，
 * 回落到 `'standalone'`。打包时 `esbuild.js` / `electron/esbuild.js` 按变体注入字面量。
 * 符号名是纯内部约定，不带产品名（企业版改名不涉及）。
 */
declare const __CORE_KIND__: CoreKind | undefined;

/** 默认实现：未注入构建期取值时为 Standalone Core（Rust，独立进程） */
export const CORE_KIND: CoreKind =
  typeof __CORE_KIND__ === 'string' ? __CORE_KIND__ : 'standalone';

/** 覆盖变量名（`src/config/project.json` 的 `core.envVarSuffix`）：取值为 CoreKind 时生效 */
export const CORE_KIND_ENV = CORE_ENV_VAR;

/**
 * 解析当前应装配的 Core 实现。
 *
 * @param env 环境变量表，测试可注入；默认取 `process.env`
 */
export function resolveCoreKind(env: NodeJS.ProcessEnv = process.env): CoreKind {
  const raw = env[CORE_KIND_ENV];
  if (raw === undefined || raw === '') return CORE_KIND;
  if (raw === 'embedded' || raw === 'standalone') return raw;
  throw new Error(
    `Invalid ${CORE_KIND_ENV}="${raw}"; expected "embedded" or "standalone".`,
  );
}
