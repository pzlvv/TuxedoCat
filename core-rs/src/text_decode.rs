//! 子进程输出 / 文件内容的文本解码（GBK 探测 + 分块不劈字）。
//!
//! Windows 上 `cmd.exe` / 部分命令行工具按**控制台代码页**输出（简体中文系统是 936
//! = GBK，繁体是 950，日文 932……），而工具结果要交给模型，必须是正确的 Unicode。
//! 直接 `String::from_utf8_lossy` 会把这些字节逐个变成 U+FFFD，用户看到的就是乱码。
//!
//! 两条判定：
//!
//! 1. **优先 UTF-8**：整体是合法 UTF-8 就按 UTF-8 解——绝大多数输出（Git Bash、Linux、
//!    显式 `chcp 65001`）走这条路，行为与改动前完全一致。
//! 2. **否则按控制台代码页解**：`encoding_rs` 的 GBK 解码器**同时**接受 GBK / GB18030 /
//!    GB2312 的编码（它是 GB18030 的超集实现），因此不需要按字节猜窄码表。显式 BOM 与
//!    已知宽码页（UTF-16）优先于这两条。
//!
//! 增量解码（[`OutputDecoder`]）服务前台管道：`read` 的 8 KiB 边界会把多字节字符劈成
//! 两半，逐块 `lossy` 会把它变成两个 U+FFFD。解码器把尾巴上的不完整序列留到下一块，
//! 只有流结束时才按最终整体判码页——中途的快照用「暂定宽松」解码出可读文本（进度显示
//! 只需要可读，不是最终结果）。

use encoding_rs::{Encoding, GBK, UTF_16BE, UTF_16LE, UTF_8};

/// 单次解码失败时是否需要「整体解码器」兜底（`encoding_rs` 的 `decode_without_bom_handling`
/// 返回 `(Cow, had_errors)`——有错就说明码页猜错了）。
fn decode_strict(bytes: &[u8], encoding: &'static Encoding) -> Option<String> {
    let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        None
    } else {
        Some(text.into_owned())
    }
}

/// 显式 BOM 的编码与长度（UTF-8 / UTF-16 LE / UTF-16 BE）
fn bom_encoding(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some((UTF_8, 3));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some((UTF_16LE, 2));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some((UTF_16BE, 2));
    }
    None
}

/// 字节 → 文本（整份内容）。判定顺序：显式 BOM → UTF-8 → GBK 系 → 宽松 UTF-8。
pub fn decode_bytes(bytes: &[u8]) -> String {
    if let Some((encoding, skip)) = bom_encoding(bytes) {
        if let Some(text) = decode_strict(&bytes[skip..], encoding) {
            return text;
        }
    }
    if let Some(text) = decode_strict(bytes, UTF_8) {
        return text;
    }
    if let Some(text) = decode_strict(bytes, GBK) {
        return text;
    }
    // 两条都不干净（混合编码 / 截断的流）：回到改动前的宽松 UTF-8，至少不丢可读部分
    String::from_utf8_lossy(bytes).into_owned()
}

/// 前缀里有多少字节是「不完整的多字节序列尾巴」——这些字节要留到下一块再解。
///
/// **必须先读首字节**：GBK 的次字节落在 `0x40..=0xFE`，其中 `0x81..=0xFE` 与 GBK 首字节
/// 同域、`0xC0..=0xDF` 又与 UTF-8 的双字节首字节同域，只看「尾巴上那一个字节」会把
/// `D6 D0` 的 `D0`（GBK 次字节）当成 UTF-8 首字节、把 `D6` 当成它的次字节，于是把一对
/// 完整的 GBK 字符永远憋在尾巴里。因此从**前**往后扫：遇到多字节首字节就按它的宽度判断
/// 是否完整，扫到不认识的单字节就跳过。
fn incomplete_tail_len(bytes: &[u8], encoding: &'static Encoding) -> usize {
    // 已知码页：GBK 系宽 1 / 2 字节，UTF-8 宽 1..=4 字节，各按自己的规则走
    if encoding == UTF_8 {
        return utf8_incomplete_tail(bytes);
    }
    // GBK：同样从前往后扫——`0xD0` 既可能是首字节、也可能是 `0xD6` 的次字节，
    // 只有按「首字节吃掉后面一个字节」走到底，才知道最后剩的是不是孤立首字节。
    let mut index = 0;
    while index < bytes.len() {
        let lead = bytes[index];
        if (0x81..=0xFE).contains(&lead) {
            if index + 1 >= bytes.len() {
                return 1;
            }
            index += 2;
            continue;
        }
        index += 1;
    }
    0
}

/// UTF-8 形态的尾巴长度：从前往后扫，最后停在「首字节声明的宽度还没到齐」的位置。
fn utf8_incomplete_tail(bytes: &[u8]) -> usize {
    let mut index = 0;
    while index < bytes.len() {
        let lead = bytes[index];
        let width = match lead {
            0x00..=0x7F => 1,
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            // 孤立续字节 / 非法首字节：宽度未知，当作单字节跳过（最终整体判定兜底）
            _ => 1,
        };
        let available = bytes.len() - index;
        if available < width {
            // 只把「确实是多字节首字节且后续字节都还是续字节」的残段留下
            if width > 1 && bytes[index + 1..].iter().all(|byte| (0x80..=0xBF).contains(byte)) {
                return available;
            }
            return 0;
        }
        index += width;
    }
    0
}

/// 前台管道的增量解码器：把字节流解成文本，跨块不劈字。
///
/// 判定在**流结束时**做（[`Self::finish`]）：只有那时才知道整条流是不是合法 UTF-8。
/// 中途的快照（[`Self::pending_text`]）用「暂定宽松」——已经确定是 UTF-8 就用 UTF-8，
/// 否则先按 GBK 系试一次（不乱码的常见情形），都不行才 lossy。
pub struct OutputDecoder {
    /// 还没解出文本的字节尾巴（不完整的多字节序列）
    tail: Vec<u8>,
    /// 已解出的文本（逐块累积；`finish` 用原始字节重解，不依赖它）
    text: String,
    /// 到目前为止判定出的码页：`None` = 还没有足够证据（按 UTF-8 试）
    encoding: Option<&'static Encoding>,
}

impl Default for OutputDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputDecoder {
    pub fn new() -> Self {
        Self {
            tail: Vec::new(),
            text: String::new(),
            encoding: None,
        }
    }

    /// 喂一块字节；返回这一块新解出的文本（可能为空：整块都是不完整序列）。
    pub fn push(&mut self, chunk: &[u8]) -> String {
        let mut buffer = std::mem::take(&mut self.tail);
        buffer.extend_from_slice(chunk);
        // 码页一旦判定为 GBK 就不再改判；未判定时按 UTF-8 的宽度边界切
        // （GBK 的「末尾剩一个首字节」在两种规则下都是留 1 字节，见 incomplete_tail_len）
        let encoding = self.encoding.unwrap_or(UTF_8);
        let keep = incomplete_tail_len(&buffer, encoding);
        let body_len = buffer.len() - keep;
        let body = &buffer[..body_len];
        let body_text = self.decode_chunk(body);
        self.tail = buffer[body_len..].to_vec();
        self.text.push_str(&body_text);
        body_text
    }

    /// 流结束：按最终整体判定解完整条流（BOM → UTF-8 → GBK 系 → 宽松 UTF-8）。
    ///
    /// 判定必须作用在**原始字节**上：中途逐块解时还不知道整条流是什么码页，只有收尾
    /// 才有完整证据。整条流是合法 UTF-8 时结果与逐块解一致，GBK 流则在这里一次解对。
    pub fn finish(self, raw: &[u8]) -> String {
        decode_bytes(raw)
    }

    /// 解一块**已知完整**的字节（不含被劈开的多字节尾巴）。
    fn decode_chunk(&mut self, body: &[u8]) -> String {
        // 已判定为 GBK：后续块一律按 GBK 解（一行命令的输出不会中途换码页）
        if self.encoding == Some(GBK) {
            if let Some(text) = decode_strict(body, GBK) {
                return text;
            }
            return String::from_utf8_lossy(body).into_owned();
        }
        // 先试 UTF-8 严格：合法就说明这条流（至少到目前为止）是 UTF-8
        if let Some(text) = decode_strict(body, UTF_8) {
            self.encoding = Some(UTF_8);
            return text;
        }
        // 不合法：按 GBK 系解（中文系统上 cmd / 老工具的主形态），解得出即锁定码页
        if let Some(text) = decode_strict(body, GBK) {
            self.encoding = Some(GBK);
            return text;
        }
        // 两种都不干净：宽松 UTF-8（与改动前一致）
        String::from_utf8_lossy(body).into_owned()
    }
}

#[cfg(test)]
#[path = "text_decode_tests.rs"]
mod tests;
