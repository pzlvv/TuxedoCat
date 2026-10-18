/**
 * electron-builder 统一配置（npm run package:app）
 * 工程变量统一取自 project.config.cjs / src/config/project.json
 */
const fs = require('fs');
const path = require('path');
const project = require('./project.config.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// 修复：NSIS 安装包在 ARM64 目标上静默丢文件
//
// 背景：electron-builder 打包 app-<arch>.7z 用的是它自己下载的 7-Zip 24.09
// （app-builder-lib/out/toolsets/7zip.js 的 getPath7za()）。7-Zip 会按扩展名给
// .exe/.dll 自动套 BCJ 过滤器，而 24.09 认识 ARM64，于是 ARM64 的 PE 文件被压成
// "ARM64 LZMA2"。安装时负责解压的 nsis7z 插件（nsis-resources 3.4.1，2019-03-24，
// 7-Zip 19.00 代码）没有 ARM64 过滤器，这些条目解压报 Unsupported Method；
// 而 NSIS 脚本没有检查 Nsis7z::Extract 的返回值，安装照样"成功"——
// 结果就是 arm64 包丢掉 <product-name>.exe 和全部 ARM64 dll，程序无法启动。
//
// 修法：把打包用的 7za 固定为 7zip-bin@5.2.0 里的 7-Zip（win-x64 是 21.07，
// win-arm64 是 21.02 alpha）。这是最后一个不认识 ARM64 过滤器的版本：它只会给
// PE 文件套 BCJ/BCJ2，产出的 7z 能被 nsis7z 正常解压（代价是安装包大约 +9%）。
// 注意 7zip-bin 必须锁死在 5.2.0，更新的版本会带回同样的 bug；
// scripts/verify-nsis-payload.mjs 会在打包后用同一个 7-Zip 校验产物，防止回归。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析固定版本的 7za。
 *
 * Windows 上一律用 x64 版（21.07，ARM64 机器靠系统自带的 x64 模拟运行）：
 * win-arm64 那个是 21.02 alpha，而且不套用任何过滤器，会让 x64 安装包凭空大 11%
 * （x64 的 PE 文件失去 BCJ2 的收益）。统一用 x64 版还能保证换构建机不改变产物。
 */
function resolvePinned7za() {
  const { path7za } = require('7zip-bin');
  if (process.platform !== 'win32') {
    return path7za;
  }
  const x64 = path.join(path.dirname(require.resolve('7zip-bin')), 'win', 'x64', '7za.exe');
  return fs.existsSync(x64) ? x64 : path7za;
}

if (!process.env.ELECTRON_BUILDER_7ZIP_PATH) {
  try {
    process.env.ELECTRON_BUILDER_7ZIP_PATH = resolvePinned7za();
  } catch {
    console.warn(
      '[electron-builder] 未安装 7zip-bin，将使用 electron-builder 自带的 7-Zip：' +
        'ARM64 目标的安装包可能静默丢失 ARM64 可执行文件。'
    );
  }
}

module.exports = {
  appId: project.appId,
  productName: project.productName,
  directories: {
    // 产物落 release/
    output: project.releaseDir,
  },
  // 运行时全部由 esbuild/vite 打包，不需要 node_modules
  files: [
    'dist-electron/**/*',
    'dist/**/*',
    'assets/**/*',
    // Electron 宿主专属的运行时资源（托盘提示音）：不放 assets/ 是因为它是
    // vite 侧栏 / 标题栏构建的 publicDir，会被复制进每份前端产物
    'electron/assets/**/*',
    'package.json',
    '!node_modules/**',
  ],
  // 打包后的 app 入口指向 Electron 主进程
  extraMetadata: {
    main: project.build.electronMainOut,
  },
  // 代码打进 asar（更小更安全）；ripgrep 等外部可执行文件
  // 必须真实存在于磁盘，通过 asarUnpack 解包到 app.asar.unpacked，
  // Electron 会自动把 app.asar 内的路径重定向到解包后的真实路径
  asar: true,
  asarUnpack: [
    'dist/resources/**',
  ],
  win: {
    icon: project.resolve('assets/logo.png'),
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64'],
      },
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: project.productName,
    // buildUniversalInstaller: false —— 只产出分架构安装包（-x64 / -arm64），
    // 不再额外产出一个内嵌双架构的通用包（约 227MB）。
    // 该开关为 false 时，${arch} 必须保留在 artifactName 中，否则两个架构同名覆盖
    // （见 app-builder-lib/out/targets/nsis/NsisTarget.js 的 shouldBuildUniversalInstaller）
    buildUniversalInstaller: false,
    artifactName: '${productName}-${version}-setup-${arch}.${ext}',
  },
  electronLanguages: ['zh-CN', 'en-US'],
};
