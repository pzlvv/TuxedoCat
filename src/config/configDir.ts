/**
 * 家目录 / 全局配置目录的**唯一解析点**。
 *
 * 同一台机器上会有多个进程读同一份配置（宿主 `SettingsStore`、宿主 `Logger`、
 * Standalone Core），如果各自用不同口径解析家目录，就会读到不同文件：
 * - `os.homedir()` 在 Windows 上取 `USERPROFILE`（缺失时回落到系统 API）；
 * - 有的模块写的是 `process.env.HOME || process.env.USERPROFILE`（HOME 优先）；
 * - Rust Core 用的是 `USERPROFILE` → `HOME`（`core-rs/src/config.rs` 的 `home_dir()`）。
 *
 * 口径分叉的后果很隐蔽：日志写在一处、配置读在另一处，表现成「设置没被读到」。
 * 因此这里统一为 **`USERPROFILE` → `HOME` → `os.homedir()`**，与 Core 侧完全一致；
 * 需要家目录 / 配置目录的代码一律走本模块，不再各自 `os.homedir()` 或读环境变量。
 */

import { homedir } from 'os';
import { join } from 'path';
import { CONFIG_DIR_NAME } from './project.js';

/**
 * 家目录：`USERPROFILE` → `HOME` → 系统 API。
 *
 * 与 `core-rs/src/config.rs` 的 `home_dir()` 同序，保证宿主与 Core 落在同一目录。
 * Windows 上 `USERPROFILE` 恒存在，`HOME` 只在 `USERPROFILE` 缺失时才用，
 * 避免 Git Bash 注入的 POSIX 风格 `HOME`（如 `/c/Users/xxx`）被 `path.join` 拼坏。
 */
export function resolveHomeDir(): string {
  const profile = process.env.USERPROFILE;
  if (profile) return profile;
  const home = process.env.HOME;
  if (home) return home;
  return homedir();
}

/** 全局配置目录：`<home>/<CONFIG_DIR_NAME>` */
export function resolveConfigDir(): string {
  return join(resolveHomeDir(), CONFIG_DIR_NAME);
}
