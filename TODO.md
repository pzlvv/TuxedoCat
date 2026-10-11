# TODO

只列**未完成**的活项。完成的项当场删除；里程碑与已完成工作的历史记录见
`docs/archive/`（git 历史即完整档案）。文档体系与「什么内容写到哪」见 `docs/README.md`。

## Web：流式期降级渲染

流式输出期间每个 delta 都让 `message.content` 变化，`src/webview/MessagesView.tsx` 的
`ReactMarkdown`（remark-gfm/math + rehype-raw/katex + Shiki）按整段重解析，主线程饱和会
推迟点击投递与「画面停住」的时刻（abort 响应时延的 UI 侧次因；Core 侧时延已修复）。

- [ ] 流式期降级渲染（纯文本 / 低频重解析 / 跳过 Shiki 增量重排），流结束再切回完整 markdown。

## 网络：host↔daemon 链路 TCP_NODELAY（可选）

- [ ] host↔daemon 链路设 `TCP_NODELAY`（远程 SSH 工作区收益更明显）。

## 文档：按需改进项（未排期）

- [ ] 用户文档最小集：安装与登录、配置服务商、常见问题、故障排查（按 Diátaxis 分
      tutorial / how-to）；`README.md` 收敛为门面 + 指向 `docs/`。新增 `docs/guide/` 并登记地图。
- [ ] 新鲜度机制：主题规格加 frontmatter（`owner` / `last_reviewed`）；脚本对比「文档最后修改」
      与「其引用源码路径的最后修改」，先只出报告、不进 CI 门禁。
- [ ] 文档站（可选）：VitePress / Docusaurus 渲染 `docs/`；`docs/README.md` 的地图可先改成相对链接表格。
- [ ] 嵌套 `AGENTS.md`（可选）：`core-rs/` 与 `src/webview/` 各放一份就近约定，根文件保持架构与铁律。

## 构建：Windows arm64 产物

- [ ] 产出 `resources/core/arm64-win32/`：交叉编译需要 LLVM/clang 与 ARM64 的 MSVC 链接器
      （`ring` 含 ARM64 汇编）；构建目标与产物目录已登记，矩阵一致性已由
      `src/test/corePlatformMatrix.test.ts` 锁定（[docs/standalone-core.md 第 4.3 节](docs/standalone-core.md#43-构建与目标平台)）。
