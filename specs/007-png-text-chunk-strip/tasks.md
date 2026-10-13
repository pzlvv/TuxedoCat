# 任务分解：Read 读 PNG 时剥离文本元数据块

执行顺序：先落两侧的块遍历与剥离实现（T001 TS、T005 Rust，两侧互不依赖；T003 对照表
可同时进行），再接线与单测（T002、T004、T006），最后文档同步与全量验证（T007–T008）。
需求与验收见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-002、FR-003）：`src/core/tools/read/imageValidation.ts` 提取私有 `walkPngChunks`（返回块边界列表或失败原因），`validatePng` 改为消费它（判定口径与失败原因逐条不变），新增导出 `stripPngTextChunks(bytes)`（按块边界整块丢弃 `tEXt` / `zTXt` / `iTXt`，无文本块时原样返回；前置条件不成立抛错），模块头注释补剥离职责；依赖：—；完成判据：`npm run test:all -- image-validation-parity` 全绿（既有对照表结论一字不变）且 `npm run check-types` 0 错
- [x] **T002**（FR-001、FR-003）：`src/core/tools/read/Read.ts` 图片分支接线——`validateImageBytes` 通过后，`image/png` 用 `stripPngTextChunks(imageBuffer)` 的结果做 base64，其余格式仍用原始 buffer；`ReadOutput.image` 与 15MB 判定口径不变，头部注释补一句；依赖：T001；完成判据：`npm run test:all -- png-text-chunk-strip`（T004 用例）全绿
- [x] **T003**（FR-001、FR-002、FR-004）：新增 `src/test/fixtures/pngTextChunkStrip.json`（schema：`{ note, cases: [{ name, why, hex, expectedHex }] }`）——覆盖无文本块（输入 == 期望）、`tEXt` / `zTXt` / `iTXt` 各一例、三类混合且连续多块、与非文本块（`gAMA` / `tRNS`）交错只剥文本块、文本块位于 IHDR 之前、块类型小写 `text` 原样保留；用例 hex 用真实 CRC 的合法 PNG；依赖：—；完成判据：JSON 合法且被 T004 / T006 双侧逐例消费通过
- [x] **T004**（FR-001、FR-002、FR-003、FR-004）：新增 `src/test/pngTextChunkStripParity.test.ts`——①对照表逐例断言 `stripPngTextChunks` == `expectedHex`；②真实 `ReadTool.call` 端到端：含文本块的 PNG 的 image block `data` == 期望字节 base64（临时目录）；③JPEG 载荷逐字节不变；④读后磁盘文件内容与 mtime 不变；依赖：T002、T003；完成判据：`npm run test:all -- png-text-chunk-strip` 全绿
- [x] **T005**（FR-001、FR-002、FR-003）：`core-rs/src/tools.rs` 提取 `png_chunk_bounds`（`validate_png` 改为消费，失败原因标识逐条不变），新增 `strip_png_text_chunks(bytes) -> Result<Vec<u8>, &'static str>`，`run_read` 在 `base64_encode` 前对 `image/png` 调用（`Err` 走与校验失败同形的工具错误）；依赖：—；完成判据：`npm run test:core` 全绿（既有 image 校验用例不变）
- [x] **T006**（FR-001、FR-002、FR-004）：`core-rs/src/tools_tests.rs` 新增 `mod png_text_chunk_strip_parity_tests`（`include_str!` 同一份对照表，逐例断言剥离结果）与端到端用例 `read_strips_png_text_chunks`（含文本块的 PNG → image block `data` 为剥离后字节的 base64）；依赖：T003、T005；完成判据：`npm run test:core` 全绿
- [x] **T007**（FR-003）：文档同步——[docs/core/core-parity.md 第 4 节](../../docs/core/core-parity.md#4-已由对照表锁定的对等面)对照表新增 `pngTextChunkStrip.json` 行（Embedded `tools/read/imageValidation.ts` 的 `stripPngTextChunks` ↔ Standalone `tools::strip_png_text_chunks`）；依赖：T003；完成判据：`npm run test:all -- docs-lint` 全绿
- [x] **T008**（FR-001、FR-002、FR-003、FR-004）：全量验证——`npm run check-types` 0 错、`npm run lint` 干净、先 `npm run build:core:host` 再 `npm run test:all` 全过（真实双端 parity 未 skip）、`npm run test:core` 全绿；依赖：T004、T006、T007；完成判据：四项命令退出码 0，提交信息按仓库口径留痕
