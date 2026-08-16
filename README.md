# Tuxedo Cat

Tuxedo Cat 是一个面向 VS Code 与 Electron 的 AI 助手，提供侧边栏对话、LLM 配置管理、流式响应、代码 diff 预览与桌面端集成能力。

## 功能特性

- VS Code 侧边栏 AI 助手（Webview）
- Electron 桌面端运行模式
- 多 LLM Provider 配置与模型管理
- 流式消息处理与对话会话管理
- 代码编辑/差异预览
- Monaco Editor 集成
- Mermaid 预览、Spin Design 等辅助视图

## 技术栈

- TypeScript
- VS Code Extension API
- Electron + electron-builder
- React + Vite
- Tailwind CSS
- Monaco Editor
- esbuild

## 目录结构

```text
.
├── assets/                 # 图标等静态资源
├── electron/               # Electron 桌面端代码
├── resources/              # 运行时二进制资源（Git LFS）
│   └── ripgrep/            # ripgrep 各平台可执行文件
├── scripts/                # 开发/打包辅助脚本
├── src/
│   ├── cli/                # CLI 入口
│   ├── config/             # 工程配置
│   ├── core/               # 核心对话/查询引擎
│   ├── host/               # UI Host 抽象
│   ├── test/               # 测试
│   ├── utils/              # 工具函数
│   ├── webview/            # VS Code Webview UI
│   └── VSCodeUI/           # VS Code UI 集成
├── .gitattributes          # Git LFS 配置
├── electron-builder.config.js
├── package.json
└── vite.config.ts
```

## 环境要求

- Node.js 18+
- npm 9+
- Git LFS（克隆后拉取 `resources/` 下的大文件）

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（VS Code 扩展）
npm run watch

# 类型检查与 lint
npm run check-types
npm run lint

# 运行测试
npm test

# 构建 VS Code 扩展
npm run build

# 构建 Electron 桌面应用
npm run build:all
```

## 打包

```bash
# 打包 VS Code 扩展
npm run package:ext

# 打包 Electron 桌面安装包
npm run package:app
```

## Git LFS

`resources/` 目录下的文件使用 Git LFS 管理。提交前请确保已安装并初始化 Git LFS：

```bash
git lfs install
git lfs ls-files
```

## License

[Apache-2.0](LICENSE)
