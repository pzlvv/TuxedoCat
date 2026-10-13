# 实施方案：Read 读 PNG 时剥离文本元数据块

技术路线：在两套 Core 的 Read 图片分支上，把「发出去的字节」从「文件原始字节」改为
「剥离 `tEXt` / `zTXt` / `iTXt` 后的字节」——剥离按 PNG 块边界整块移除，复用既有的
「逐块走 PNG」遍历（校验与剥离共用一份遍历，不复制结构解析）。两侧各新增一个纯函数
（TS `stripPngTextChunks` / Rust `strip_png_text_chunks`），由 Read 图片分支在
base64 编码前调用；剥离结果由新的共享对照表 `pngTextChunkStrip.json` 双侧锁定。
需求与验收见同目录 [spec.md](spec.md)。

## 技术方案

### PNG 块遍历：校验与剥离共用一份（两侧同构）

现状 `validatePng` / `validate_png` 已逐块走 PNG 并给出失败原因（`signature` /
`truncated` / `missing-end-marker` / `trailing-data` / `malformed`）。把这段遍历提成
一个内部函数，返回块边界列表或失败原因：

- TS：`imageValidation.ts` 内新增私有 `walkPngChunks(bytes)`，返回
  `{ chunks: { type, start, end }[] } | { failure: ImageValidationFailure }`
  （`end` 为块尾后一位，含长度 / 类型 / 数据 / CRC 四段）；`validatePng` 改为
  「签名检查 + `walkPngChunks` 的失败原因直通」，判定口径逐条不变。
- Rust：`tools.rs` 内新增 `png_chunk_bounds(bytes) -> Result<Vec<(usize, usize, [u8; 4])>, &'static str>`，
  `validate_png` 同样改为消费它；失败原因标识与现状逐字一致。

`imageValidation.json` 的既有用例（含 15 条错误路径）就是这次重构的回归网：对照表
一字不改、结论必须不变（spec 的 AC-7）。

### 剥离函数（两侧同构）

- TS：`export function stripPngTextChunks(bytes: Uint8Array): Uint8Array`
- Rust：`pub fn strip_png_text_chunks(bytes: &[u8]) -> Result<Vec<u8>, &'static str>`

语义：按遍历得到的块边界过滤，丢弃类型为 `tEXt` / `zTXt` / `iTXt`（ASCII 精确匹配、
大小写敏感）的块，其余块按原顺序、原字节拼接；不含这三类块时原样返回输入字节
（字节级相同，不做无意义重建）。前置条件是「字节已通过结构校验」——两套 Core 的
Read 分支都先校验后剥离；前置不成立时不静默降级：TS 抛错、Rust 返回 `Err` 由
`run_read` 转成与校验失败同形的工具错误（该分支按构造不可达）。

### Read 图片分支接线

- TS `Read.ts`：`validateImageBytes` 通过后，`mediaType === 'image/png'` 时以
  `stripPngTextChunks(imageBuffer)` 的结果做 `toString('base64')`，其余格式仍用原始
  buffer；`ReadOutput.image` 形态不变。
- Rust `run_read`：`image_validation_failure` 通过后，`media_type == "image/png"` 时
  用 `strip_png_text_chunks(&bytes)` 的结果做 `base64_encode`；`ToolOutcome::SuccessBlocks`
  的 image block 结构不变。

15MB 上限判定仍在剥离之前、按磁盘文件大小（Rust 现状用 `bytes.len()`，即文件长度），
口径不变。

### 对照表与测试

新增共享对照表 `src/test/fixtures/pngTextChunkStrip.json`（schema 与既有对照表同风格）：

```json
{
  "note": "……",
  "cases": [{ "name": "png-text-chunk", "why": "……", "hex": "<输入 PNG>", "expectedHex": "<剥离后 PNG>" }]
}
```

用例覆盖：无文本块（输入 == 期望）、`tEXt` / `zTXt` / `iTXt` 各一例、三类混合且连续
多块、文本块与非文本块（`gAMA` / `tRNS`）交错只剥文本块、文本块位于 IHDR 之前、
块类型为小写 `text`（非合法类型，原样保留）。用例 hex 用真实 CRC 的合法 PNG
（Node 侧算 CRC 生成，保证 fixture 本身是 provider 可解码的图片）。

消费方：

- TS 新增 `src/test/pngTextChunkStripParity.test.ts`：对照表逐例断言
  `stripPngTextChunks` == `expectedHex`；再用真实 `ReadTool.call` 端到端断言 image
  block 的 `data` == 期望字节的 base64（临时目录）、非 PNG（JPEG）载荷逐字节不变、
  读后磁盘文件内容与 mtime 不变。
- Rust `tools_tests.rs` 新增 `mod png_text_chunk_strip_parity_tests`（同一份对照表，
  `include_str!`）+ 一个 `run_read` 端到端用例（含文本块的 PNG → image block data 为
  剥离后字节的 base64）。
- 既有 `read_returns_images_as_base64`（Rust）与 `imageValidationParity.test.ts`（TS）
  的合法 PNG 不含文本块，断言不变、继续通过——顺带锁定「无文本块时载荷不变」。
- 新测试文件由 `scripts/run-tests.mjs` 自动发现，不需要挂 npm 脚本。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/core/tools/read/imageValidation.ts` | 修改（提 `walkPngChunks`、新增 `stripPngTextChunks`、模块头注释补剥离职责） | 新增导出函数，无契约成员变化 |
| `src/core/tools/read/Read.ts` | 修改（图片分支 base64 前剥离，仅 `image/png`；头部注释补一句） | `ReadOutput.image` 形态不变 |
| `core-rs/src/tools.rs` | 修改（提 `png_chunk_bounds`、新增 `strip_png_text_chunks`、`run_read` 接线） | 无 |
| `src/test/fixtures/pngTextChunkStrip.json` | 新增 | 测试对照表 |
| `src/test/pngTextChunkStripParity.test.ts` | 新增 | — |
| `core-rs/src/tools_tests.rs` | 修改（新增 parity mod + 端到端用例） | — |
| `docs/core/core-parity.md` | 修改（[第 4 节](../../docs/core/core-parity.md#4-已由对照表锁定的对等面)对照表新增一行） | parity 基线 |

不新增 / 不修改任何事件类型、wire 帧、UI 契约成员与落盘格式；`imageValidation.json`
的 schema 与用例一字不改。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在
      `src/core/tools/read/` 与 `core-rs/src/tools.rs` 内部，不 import host / 宿主 API、
      无宿主嗅探、无 `host.kind` 分支；host 与 webview 完全不参与。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      不过度 fallback——前置条件不成立时抛错 / 返回 `Err`，不静默发回原始字节；
      契约成员全必选——`ReadOutput.image` 与 image block 结构不变，无新增可选成员；
      一份事实一个写入点——「发给 LLM 的载荷」唯一写入点是 Read 图片分支，PNG 块遍历
      唯一实现由校验与剥离共用（不复制第二份结构解析）；默认值单源——不涉及新默认值；
      预览单实现——不涉及渲染。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：TS 与 Rust 同步
      实现同一剥离语义（三类块、精确匹配、整块移除、无块时字节不变），新增共享对照表
      `pngTextChunkStrip.json` 且两侧都有消费者（TS 新测试 / Rust 新 mod），
      [docs/core/core-parity.md 第 4 节](../../docs/core/core-parity.md#4-已由对照表锁定的对等面)补该行；
      既有 `imageValidation.json` 两侧消费不变。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：本次受影响的 as-built
      规格只有 [docs/core/core-parity.md 第 4 节](../../docs/core/core-parity.md#4-已由对照表锁定的对等面)
      （对照表清单），随实施同提交；
      不新增文档、不改 `docs/README.md` 地图；`npm run test:all -- docs-lint` 绿。

## 被否决的替代方案

1. **只丢 `zTXt`（严格按字面）**——否决：`tEXt` / `zTXt` / `iTXt` 是同一类文本注释的
   三种编码，只丢一类会让「同样体量的元数据照样发出」，收益减半且语义不齐；范围由
   评审裁定为三类（spec FR-001）。
2. **丢掉全部非关键块（ancillary 全清）**——否决：会连带丢掉影响渲染的块（`tRNS` 透明、
   `gAMA` / `sRGB` / `iCCP` 色彩、APNG 的 `acTL` / `fcTL` / `fdAT` 动画），改变图片呈现，
   风险与收益不对称（多省的只是非文本块）。
3. **解码像素后重编码 PNG**——否决：引入图像编解码依赖与 CPU 成本，重编码可能改变
   像素 / 色彩空间；且像素解码与 CRC 校验是 provider 的职责，Core 重复实现等于第二份
   事实。整块移除在字节层是安全的。
4. **剥离另写一套块遍历（不与校验共用）**——否决：两份 PNG 结构遍历必然漂移（同一
   事实一个写入点），校验与剥离对「块边界」的判断必须同源。
5. **在 base64 之后做字符串处理**——否决：base64 载荷无法按块边界切分，剥离只能在
   二进制层做。
6. **剥离放到 host / UI 层（发送前过滤）**——否决：违反分层（host 不得改写 Core 事实），
   且 Standalone Core 没有该层；Core 是载荷的唯一写入点。
7. **把剥离结果并入校验函数返回**——否决：校验结论与载荷变换是两个职责，混在一起会
   让 `imageValidation.json` 的 `expected` 语义变形；保持校验表不变、另立剥离表。
8. **就地清理磁盘文件上的元数据**——否决：Read 是只读工具，写回会改用户文件、破坏
   mtime、与权限模型冲突；spec 的 FR-003 明确磁盘文件不变。
