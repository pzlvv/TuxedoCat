---
status: 已修
---

# 缺陷：Core 构建的 C 工具链判据要本机装着 zig 才能算出来

`scripts/build-core.mjs` 的 `crossToolchainEnv(triple, hostPlatform, hostArch)` 是「某个目标
要注入哪些 `CC` / `CFLAGS` / `AR`」的判据函数：它按入参决定走本机 cc、`zig cc` 还是交给
`cargo xwin`。但这个判据内部会探测本机 zig，缺了直接 `process.exit(1)`——于是「判据是什么」
取决于这台机器装没装 zig，任何想驱动这条判据的调用方（首当其冲是单测）在没装 zig 的机器上
都拿不到结果。

CI 的 `smoke / tests` 因此有 9 条与本次改动无关的断言恒红：runner 上没装 zig，
`crossToolchainEnv('aarch64-pc-windows-msvc', 'win32')` 在探测处退出，探针进程没走到打印
就结束，`RT-3` 的 arm64 环境、`RT-2` 的 xwin 调用形态等全部判成缺失。本地装了 zig 的开发机
上这些断言全绿——红绿取决于本机工具链，而不是代码是否符合
[standalone-core.md 第 3.3 节](../../docs/core/standalone-core.md#33-构建与目标平台)。

## 现状

`scripts/build-core.mjs`：

```js 示意
export function crossToolchainEnv(triple, hostPlatform = process.platform, hostArch = process.arch) {
  // … 判定该目标要不要交叉工具链
  const zig = requireZig(triple);          // ← 内部 spawnSync(zig, ['version'])，缺了 exit(1)
  return { [`CC_${key}`]: `${zig} cc`, … };
}

/** 按需探测 zig，缺了直接报错（不静默降级到「试试看系统 cc」） */
function requireZig(triple) {
  const zig = process.env.ZIG || 'zig';
  const probe = spawnSync(zig, ['version'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) process.exit(1);
  return zig;
}
```

复现（任意没装 zig 的机器，或把 `ZIG` 指到不存在的路径）：

```bash
ZIG=/nonexistent/zig node --input-type=module --eval "
  const m = await import('./scripts/build-core.mjs');
  console.log(JSON.stringify(m.crossToolchainEnv('aarch64-pc-windows-msvc', 'win32')));
"
# → [build-core] 构建 aarch64-pc-windows-msvc 需要 zig… 找不到 `…/zig`，exit 1，无 stdout
```

CI 侧证据（run 43065014730 的 `tests` job，`npm run test:unit`）：

```
── coreBuildToolchain ──────────────────────────────────────────
FAIL build-core.mjs 可加载并给出构建判据
     [build-core] 构建 aarch64-pc-windows-msvc 需要 zig（…）：找不到 `zig`。…
FAIL RT-1：Windows 宿主上 x64 msvc 目标不带 xwin 子命令
FAIL RT-2：非 Windows 宿主上 x64 msvc 目标经 cargo xwin
FAIL RT-3：Windows 宿主上 arm64 目标的 CC 是 zig cc
FAIL Linux musl 目标仍注入 zig cc + zig ar
… 存在失败（2 通过 / 9 失败）
```

同样的失败在三条车道各自复现（`fix/user-message-scroll-to-bottom`、`047-compact-archive-generations`、
`feat/sidebar-files-mode-switch`），只要那一轮的 apt 步骤过得去就会露出来——此前它被
apt 的源解析故障挡在后面（见 `ci/apt-install-retry`）。

## 期望

1. **判据是纯函数**：`crossToolchainEnv(triple, hostPlatform, hostArch)` 只按入参算出该注入
   哪些环境变量，结果不取决于本机有没有装 zig，也不改动进程退出码。缺 zig 时它照样给出
   `zig cc` / `zig ar` 判据（这是「该目标要什么」，不是「本机有什么」）。
2. **缺工具链仍在构建入口报错**：`buildTarget` 真去构建、且该目标确实要 zig 时，探测失败
   照旧给出安装指引并非零退出——「不静默降级」这条不变。
3. **判据只有一份**：「该目标要不要 zig」的判定在判据函数与构建入口之间同源，不各写一套
   （避免改一处忘另一处，退回「要 zig 却用本机 cc 编」）。

## 不变量

1. [standalone-core.md 第 3.3 节](../../docs/core/standalone-core.md#33-构建与目标平台)的工具链结论不变：Linux musl / gnu 交叉用
   `zig cc` + `zig ar`（gnu 链接经 `zigLinkerWrapper`）；Windows 宿主的 arm64 msvc 用
   `zig cc` 且不注入 `AR`；Windows 宿主 x64 与非 Windows 宿主的全部 msvc 目标不注入 C 工具链。
2. `cargoInvocation` 的 xwin 判据（宿主平台维度）不变。
3. 构建指纹口径不变：`computeFingerprint` 的输入集与算法版本不动
   （[standalone-core.md 第 3.4 节](../../docs/core/standalone-core.md#34-构建指纹)）。
4. 缺 zig 时的构建失败照旧如实报错、非零退出，不产出半成品。
5. Dockerfile 里 `ZIG=/opt/zig-msvc/zig` 的包装仍然生效（脚本注入的 `CC` 取的是 `ZIG` 的值）。

## 回归测试

- **RT-1**：`ZIG` 指向不存在的路径时，`crossToolchainEnv` 仍能算出判据且进程正常退出（探针
  退出码 0、字段齐全）。（落点：`src/test/coreBuildToolchain.test.ts` 的
  「缺失 zig 时判据仍可计算」）
- **RT-2**：同一无 zig 环境下，Windows 宿主 arm64 目标仍给出 `zig cc` + `:: --target=aarch64-windows-msvc`，
  Linux musl 目标仍给出 `zig cc` + `zig ar`。（落点：`src/test/coreBuildToolchain.test.ts`
  的「缺失 zig 时 arm64 判据不依赖本机安装」）
- **RT-3**：缺失 zig 仍然拦得住构建——`buildTarget` 的入口守卫在该目标需要 zig 时报错退出，
  不静默用本机 cc 编。（落点：`src/test/coreBuildToolchain.test.ts` 的
  「缺失 zig 时构建入口仍报错」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- core-build-toolchain` | 红 | 3 项红：RT-1 探针在 `requireZig` 处 exit 1、stdout 为空；RT-2 arm64 / musl 交叉两项拿不到 `zig cc` 判据。RT-3 已绿（守卫已存在，修复中不得丢） |
| 回归用例（修复后） | `npm run test:unit -- core-build-toolchain` | 绿 | 16 项全过：既有 11 项 + 新增 RT-1 / RT-2（三项）/ RT-3 |
| 既有回归 | `npm run test:unit -- core-fingerprint core-platform-matrix` | 绿 | 84 项全过，指纹口径与平台矩阵未受影响 |
| 判据矩阵（修复后） | `ZIG=/nonexistent/zig node --input-type=module -e '…crossToolchainEnv…'` | 绿 | 六个组合与修复前逐项一致：win arm64 给 `zig cc` 无 `AR`、win x64 空、linux 宿主上的 msvc 空、linux musl 同架构空、交叉给 `zig cc` + `zig ar`、gnu 另加 `ZIG_CC_TARGET` 与 linker |
| 真实构建（Linux musl） | `PATH=<cargo> ZIG=<zig> node scripts/build-core.mjs --target x86_64-unknown-linux-musl` | 绿 | 产物落位 `resources/core/x64-linux/` + 指纹 + 内置 rg / fd；宿主为 Windows，走的是 zig 交叉路径 |
| 缺 zig 的构建入口 | `ZIG=/nonexistent/zig node scripts/build-core.mjs --target aarch64-unknown-linux-musl` | 绿 | exit 1，报错含安装指引，未进入 cargo（不静默降级） |
| 全量单测 | `npm run test:unit` | 绿 | 106 通过 / 0 失败 / 2 跳过（`sidebarDocViewGit`、`sidebarFiles` 缺环境前置，与本缺陷无关） |
| 类型检查 | `npm run check-types` | 绿 | — |
| 代码风格 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | — |
