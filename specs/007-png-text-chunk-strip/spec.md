---
status: 实施中
---

# 改动规格：Read 读 PNG 时剥离文本元数据块

Read 工具读 `.png` 图片时，发给 LLM 的 image content block 由「文件原始字节的 base64」
改为「剥离文本元数据块（`tEXt` / `zTXt` / `iTXt`）后的 PNG 字节的 base64」：这三类块
只承载作者、生成软件、提示词等文本信息，对模型看图没有价值，却可能让载荷膨胀到数百 KB。
改动落在两套 Core 的 Read 图片路径（Embedded `src/core/tools/read/` 与 Standalone
`core-rs/src/tools.rs`），其余读取行为（文本 / xlsx / 非 PNG 图片 / 错误文案 / 大小上限）
不变，磁盘文件不被改写。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/core-parity.md](../../docs/core/core-parity.md#4-已由对照表锁定的对等面) | 4. 已由对照表锁定的对等面 | 修改 | 登记「PNG 文本块剥离」这一对等面：两侧对同一 PNG 产出同一载荷，由共享对照表锁定（落在 `src/test/fixtures/` 的图片对照表） |

## 用户场景与验收标准

- 场景 1：PNG 带文本元数据
  - **AC-1**（FR-001）：GIVEN 一个结构合法且含 `tEXt`、`zTXt`、`iTXt` 各一块的 PNG WHEN Read 读取该文件 THEN 返回的 image block 的 base64 解码后不含这三类块，其余块（含签名与 IEND）与磁盘文件逐字节相同
  - **AC-2**（FR-001）：GIVEN 一个在 IHDR 之后任意位置含多块（含连续多块）文本元数据的 PNG WHEN Read 读取 THEN 所有文本元数据块都被剥离
  - **AC-3**（FR-001）：GIVEN 一个不含文本元数据块的 PNG WHEN Read 读取 THEN 载荷与磁盘文件逐字节相同
- 场景 2：剥离结果的形态
  - **AC-4**（FR-002）：GIVEN 任意含文本元数据块的 PNG WHEN 剥离后逐块解析 THEN 块长度自洽、以长度为 0 的 IEND 收尾、末尾无多余字节（即仍通过既有的「魔数 + 结构完整性」校验）
- 场景 3：范围之外
  - **AC-5**（FR-003）：GIVEN 一个 JPEG / GIF / WebP / BMP 图片（含 EXIF / XMP / 注释等元数据）WHEN Read 读取 THEN 载荷与磁盘文件逐字节相同
  - **AC-6**（FR-003）：GIVEN 任意 PNG（含文本元数据块）WHEN Read 读取 THEN 磁盘文件内容与修改时间不变
  - **AC-7**（FR-003）：GIVEN 一个结构校验会失败的 PNG（签名不符 / 截断 / IEND 后有多余字节）WHEN Read 读取 THEN 报错文案与现状逐字相同，且不产出 image block
- 场景 4：双端一致
  - **AC-8**（FR-004）：GIVEN 同一份含文本元数据块的 PNG WHEN Embedded 与 Standalone 各自读取 THEN 两侧 image block 的 `data`（base64）逐字节相同

## 功能需求

### FR-001：剥离 PNG 文本元数据块

Read 判定文件为 `.png`（`media_type` 为 `image/png`）并读出字节后，发给 LLM 的载荷由
「原始文件字节」改为「剥离文本元数据块后的 PNG 字节」。剥离对象是 PNG 规范里的三类文本块
`tEXt` / `zTXt` / `iTXt`：连同块头（长度 + 类型）与 CRC 整块移除，不解析块内容（`zTXt` 的
zlib 压缩体不解压）。块类型按 ASCII 精确匹配（大小写敏感），剥离与块出现的位置、数量无关；
不含这三类块的文件载荷不变。剥离只作用于发给 LLM 的内存载荷，磁盘文件不改写。

### FR-002：剥离结果仍是结构自洽的 PNG

剥离只整块移除，不重写保留块的字节：签名、IHDR、IDAT、IEND 及所有非文本块的内容与相对
顺序不变，保留块的 CRC 因此仍然有效。剥离后的字节仍满足既有的「签名 + 逐块长度自洽 +
长度为 0 的 IEND 收尾 + 末尾无多余字节」结构约束，可直接作为 image block 发送（像素解码与
CRC 校验仍归 provider，不重复实现）。被丢弃的块按 PNG 规范都是不影响像素的文本注释，
剥离不改变图片的渲染结果。

### FR-003：剥离范围之外的行为保持现状

- 非 PNG 图片（JPEG / GIF / WebP / BMP）的载荷原样发送，其内部元数据（EXIF / XMP /
  注释等）不做处理。
- 磁盘文件只读：不写回、不改文件内容与修改时间。
- 既有的「魔数 + 结构完整性」校验与 15MB 上限判定口径不变：校验先于剥离，失败仍报与现状
  逐字相同的错误消息，不产出 image block。
- 文本 / xlsx / 二进制拒绝等其余读取路径不受影响。

### FR-004：两侧 Core 同语义

Embedded 与 Standalone 对同一份 PNG 输入产出逐字节相同的载荷（剥离同一组块），由共享
对照表锁定（[docs/core/core-parity.md 第 4 节](../../docs/core/core-parity.md#4-已由对照表锁定的对等面)）。

## 边界与错误路径

- 不含文本块：载荷与文件字节相同（不产生空改写）。
- 文本块位于 IHDR 之前（不符合 PNG 推荐顺序但结构自洽）：仍按块类型剥离；本次不新增顺序校验。
- 文本块长度字段超出实际字节数：既有结构校验先报 `truncated`，剥离不发生。
- IEND 之后有多余字节：既有校验报 `trailing-data`，剥离不发生。
- 剥离后只剩签名 + IHDR + IEND（文件本就没有 IDAT）：不新增校验、照原样发送，由 provider
  报错——与现状「校验不管像素数据」的口径一致。
- 块类型大小写不同（如 `text`）：不是合法 PNG 块类型，不剥离、原样保留。
- 超过 15MB 的 PNG：仍按磁盘文件大小报 `Image file too large to read`（剥离在大小判定之后，
  判定口径不变）。

## 非目标

- 不剥离非文本块（`eXIf` / `iCCP` / `gAMA` / `sRGB` / `tIME` / `pHYs` / APNG 的 `acTL` 等）：
  本次范围由评审裁定为三类文本块；若实测非文本块体积成为问题，去向
  [TODO.md](../../TODO.md)（另开 spec 时按同一口径登记对照表与两侧实现）。
- 不改其他图片格式的元数据（JPEG 的 APPn / EXIF、WebP 的 XMP、GIF 的注释扩展块）。
- 不做像素解码、重编码或 CRC 校验。
- 不做磁盘文件的元数据清理（不写回文件）。
- 不改粘贴图片路径（US-6 的剪贴板图片经 `src/core/utils/contentBlocks.ts` 的 data URL 直接
  进消息，不经 Read 工具）：去向 [TODO.md](../../TODO.md)（若需要，另开 spec 按同一剥离口径处理）。
- 不新增用户可见提示 / 日志（剥离静默发生，工具结果仍是单个 image block）。

## 对需求基线的影响

无新增 US。改动落在 Core 内部「发给 LLM 的图片载荷」上：Read 的图片结果仍是一个 image
content block（[docs/features/user-stories.md](../../docs/features/user-stories.md#us-28-工具执行与结果回填)
的「工具结果回填」语义不变），无新增交互、无 UI 呈现变化，故不登记 e2e 用例；覆盖由两侧
对照表 parity 用例与 Read 工具端到端用例承担。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/core/tools/read/` 的 PNG 文本块剥离与 `core-rs/src/tools.rs` 的 Read 图片分支 | `src/test/imageValidationParity.test.ts`、`core-rs/src/tools_tests.rs`（对照表驱动） | 自动 |
| FR-002 | 同上（整块移除，保留块字节不变） | 同上（剥离结果再走一次既有结构校验） | 自动 |
| FR-003 | 同上（剥离只在 `image/png` 分支内发生） | 同上（非 PNG 载荷逐字节断言 + 既有错误文案用例不改） | 自动 |
| FR-004 | 共享对照表（`src/test/fixtures/` 的图片对照表） | 两侧对照表用例（TS / Rust 同表） | 自动 |

## 待澄清

（无——丢弃范围已由评审裁定为 `tEXt` / `zTXt` / `iTXt` 三类；范围之外的方向已在「非目标」
注明去向。若评审改范围，直接修订 FR-001 后进 plan。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
- 偏差：
- 未做：
