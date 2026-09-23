/**
 * electron-builder 统一配置（npm run package:app）
 * 工程变量统一取自 project.config.cjs / src/config/project.json
 */
const project = require('./project.config.cjs');

module.exports = {
  appId: project.appId,
  productName: project.productName,
  directories: {
    output: project.resolve('release'),
  },
  // 运行时全部由 esbuild/vite 打包，不需要 node_modules
  files: [
    'dist-electron/**/*',
    'dist/**/*',
    'assets/**/*',
    'package.json',
    '!node_modules/**',
  ],
  // 打包后的 app 入口指向 Electron 主进程
  extraMetadata: {
    main: project.build.electronMainOut,
  },
  // 代码打进 asar（更小更安全）；ripgrep/pandoc 等外部可执行文件
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
