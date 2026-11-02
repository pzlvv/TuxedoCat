//! `text_decode` 的对等测试：码页判定、增量不劈字、宽松兜底。

use super::*;

/// GBK 编码的「中文测试」：`中文` = D6 D0 CE C4，`测试` = B2 E2 CA D4
const GBK_CHINESE: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];

#[test]
fn utf8_bytes_decode_unchanged() {
    let text = "普通 UTF-8 输出 ✅";
    assert_eq!(decode_bytes(text.as_bytes()), text);
}

#[test]
fn gbk_bytes_decode_to_chinese_not_replacement_chars() {
    // 回归基线：改动前 `String::from_utf8_lossy` 会把每个字节变成 U+FFFD
    let lossy = String::from_utf8_lossy(GBK_CHINESE).to_string();
    assert!(lossy.contains('\u{FFFD}'), "前提：GBK 字节不是合法 UTF-8");
    assert_eq!(decode_bytes(GBK_CHINESE), "中文测试");
}

#[test]
fn explicit_utf8_bom_is_stripped() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("带 BOM".as_bytes());
    assert_eq!(decode_bytes(&bytes), "带 BOM");
}

#[test]
fn utf16_bom_decodes() {
    let mut le = vec![0xFF, 0xFE];
    for unit in "宽字符".encode_utf16() {
        le.extend_from_slice(&unit.to_le_bytes());
    }
    assert_eq!(decode_bytes(&le), "宽字符");

    let mut be = vec![0xFE, 0xFF];
    for unit in "宽字符".encode_utf16() {
        be.extend_from_slice(&unit.to_be_bytes());
    }
    assert_eq!(decode_bytes(&be), "宽字符");
}

#[test]
fn ascii_only_is_utf8() {
    assert_eq!(decode_bytes(b"hello\nworld\n"), "hello\nworld\n");
}

#[test]
fn undecodable_bytes_fall_back_to_lossy() {
    // 半截 UTF-8 首字节 + 孤立续字节：GBK 也解不干净 → 宽松 UTF-8 兜底（不 panic、有内容）
    let bytes = &[0xE4, 0xB8, 0xFF, 0xFF];
    let text = decode_bytes(bytes);
    assert!(!text.is_empty());
}

#[test]
fn incremental_decode_does_not_split_multibyte_chars() {
    // 把「中文测试」的 GBK 字节按 1 字节一块喂进去：逐块 lossy 会产生 8 个 U+FFFD
    let mut decoder = OutputDecoder::new();
    let mut pieces = String::new();
    for byte in GBK_CHINESE {
        pieces.push_str(&decoder.push(&[*byte]));
    }
    assert!(!pieces.contains('\u{FFFD}'), "分块解码劈了字: {pieces:?}");
    assert_eq!(decoder.finish(GBK_CHINESE), "中文测试");
}

#[test]
fn incremental_decode_handles_utf8_split_across_chunks() {
    let text = "a中b✅c";
    let bytes = text.as_bytes();
    // 按每 2 字节一块切（必然劈开 3 / 4 字节序列）
    let mut decoder = OutputDecoder::new();
    let mut pieces = String::new();
    for chunk in bytes.chunks(2) {
        pieces.push_str(&decoder.push(chunk));
    }
    assert!(!pieces.contains('\u{FFFD}'), "分块解码劈了字: {pieces:?}");
    assert_eq!(decoder.finish(bytes), text);
}

#[test]
fn incomplete_tail_len_keeps_only_partial_sequences() {
    // 完整 UTF-8「中」= E4 B8 AD
    assert_eq!(incomplete_tail_len(&[b'a', 0xE4, 0xB8], UTF_8), 2);
    assert_eq!(incomplete_tail_len(&[b'a', 0xE4, 0xB8, 0xAD], UTF_8), 0);
    // 纯 ASCII 没有要留的尾巴
    assert_eq!(incomplete_tail_len(b"plain", UTF_8), 0);
    // GBK：末尾剩一个首字节就留 1 字节；完整的双字节不留
    assert_eq!(incomplete_tail_len(&[0xD6, 0xD0], GBK), 0);
    assert_eq!(incomplete_tail_len(&[0xD6], GBK), 1);
}

#[test]
fn gbk_with_utf8_looking_ascii_prefix_still_decodes() {
    // 真实输出的常见形态：ASCII 表头 + GBK 正文
    let mut bytes = b"Name: ".to_vec();
    bytes.extend_from_slice(GBK_CHINESE);
    assert_eq!(decode_bytes(&bytes), "Name: 中文测试");
}
