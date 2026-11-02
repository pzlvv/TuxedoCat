//! 冻结 CDC 的测试：上游 v1.1.0 对照向量（profile 身份、分块边界、零游程）。

use std::io::Cursor;

use super::*;

/// 上游 v1.1.0：冻结 CDC profile 身份。
const CDC_PROFILE_ID_HEX: &str = "09002d304e6872b322b31ae8e316db1d06b748fac8dd5ee3472bef6002aa0116";
/// 上游 v1.1.0：xorshift64*（种子 0x243F6A8885A308D3）1 MiB 输入的分块长度序列。
const SCAN_1MIB_LENGTHS: &[usize] = &[
    22635, 19642, 17406, 17221, 9221, 17441, 19636, 16604, 18971, 18066, 17793, 16403, 8611, 16304,
    19739, 17715, 17065, 21587, 20992, 17037, 22053, 18854, 16936, 18545, 16768, 16547, 19096,
    19141, 17864, 22110, 14660, 21625, 16816, 22371, 16860, 23483, 18700, 17091, 16930, 9135,
    17236, 18727, 16538, 27900, 10686, 13252, 21608, 23203, 18823, 19975, 20198, 17704, 18870,
    16506, 18557, 23227, 18508, 10942, 442,
];
/// 上游 v1.1.0：100_000 个零字节的分块长度序列（零状态每 32768 字节重复）。
const SCAN_ZEROS_LENGTHS: &[usize] = &[32768, 32768, 32768, 1696];

fn xorshift_input(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x243F_6A88_85A3_08D3;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let x = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

fn scan_lengths(bytes: &[u8]) -> Vec<usize> {
    let mut lengths = Vec::new();
    FastCdc::new()
        .scan(Cursor::new(bytes), |chunk| {
            lengths.push(chunk.len());
            Ok(())
        })
        .expect("scan");
    lengths
}

#[test]
fn constants_match_frozen_upstream_profile() {
    assert_eq!(MINIMUM_CHUNK_BYTES, 8192);
    assert_eq!(TARGET_CHUNK_BYTES, 16384);
    assert_eq!(MAXIMUM_CHUNK_BYTES, 32768);
    assert_eq!(NORMALIZATION_SHIFT, 2);
    assert_eq!(PROFILE_SEED, 0);
    assert_eq!(SMALL_MASK, 0x0000_d903_0353_7000);
    assert_eq!(LARGE_MASK, 0x0000_d901_0353_0000);
    assert_eq!(SHIFTED_SMALL_MASK, 0x0001_b206_06a6_e000);
    assert_eq!(SHIFTED_LARGE_MASK, 0x0001_b202_06a6_0000);
    // GEAR 表身份随表走：上游同一张表的 profile_id。
    assert_eq!(hex(&profile_id()), CDC_PROFILE_ID_HEX);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn chunk_boundaries_match_upstream_bytes() {
    // 1 MiB 确定性输入。
    let input = xorshift_input(1024 * 1024);
    let lengths = scan_lengths(&input);
    assert_eq!(lengths.len(), SCAN_1MIB_LENGTHS.len());
    assert_eq!(lengths, SCAN_1MIB_LENGTHS.to_vec());
    assert_eq!(lengths.iter().sum::<usize>(), input.len());
    // 块长都落在 8 KiB..=32 KiB，末块除外。
    for length in &lengths[..lengths.len() - 1] {
        assert!((MINIMUM_CHUNK_BYTES..=MAXIMUM_CHUNK_BYTES).contains(length));
    }
    assert_eq!(*lengths.last().expect("chunks"), 442);
    // 小输入单块。
    assert_eq!(scan_lengths(&xorshift_input(5000)), vec![5000]);
}

#[test]
fn zero_runs_match_upstream_repeat_blocks() {
    let lengths = scan_lengths(&vec![0_u8; 100_000]);
    assert_eq!(lengths, SCAN_ZEROS_LENGTHS.to_vec());
}

#[test]
fn zero_hole_path_matches_plain_scan_boundaries() {
    // 同一稳定字节流：数据 4096 字节 + 零洞 100_000 + 数据 4096 字节。
    let data_a = xorshift_input(4096);
    let data_b = xorshift_input(8192)[4096..].to_vec();
    let flat = [data_a.as_slice(), &[0_u8; 100_000], data_b.as_slice()].concat();
    let expected = scan_lengths(&flat);

    // 洞走 ChunkScanner::zeros 重复块特例，数据走 consume，衔接处保持对齐。
    let mut scanner = ChunkScanner::new();
    let mut counters = CdcCounters::default();
    let mut lengths = Vec::new();
    scanner
        .consume(
            &data_a,
            &mut |chunk| {
                lengths.push(chunk.len());
                Ok(())
            },
            &mut counters,
        )
        .expect("consume");
    let scanned = scanner
        .zeros(100_000, &mut counters, &mut |chunk, repeat| {
            for _ in 0..repeat {
                lengths.push(chunk.len());
            }
            Ok(())
        })
        .expect("zeros");
    // 返回值是「实际扫描的零字节数」：首尾两段（中间的重复段不扫，只计数）。
    assert_eq!(scanned, 32_768 + 100_000 % 32_768);
    scanner
        .consume(
            &data_b,
            &mut |chunk| {
                lengths.push(chunk.len());
                Ok(())
            },
            &mut counters,
        )
        .expect("consume");
    scanner
        .finish(
            &mut |chunk| {
                lengths.push(chunk.len());
                Ok(())
            },
            &mut counters,
        )
        .expect("finish");
    assert_eq!(lengths, expected);
    // bytes_scanned 只由 FastCdc::scan 包装层累计（上游同语义），ChunkScanner 不动它。
    assert_eq!(counters.chunks_emitted as usize, lengths.len());
}

#[test]
fn cut_candidates_cover_real_boundaries() {
    // cut_candidates 的两套对齐各自上报；真实扫描的每个边界（≥64 字节前导的）都应
    // 出现在其一（候选是提示，覆盖是必要非充分条件）。
    let input = xorshift_input(64 * 1024);
    let mut candidates = std::collections::BTreeSet::new();
    cut_candidates(&input, &mut |position| {
        candidates.insert(position);
    });
    let odd = {
        let mut odd_input = Vec::with_capacity(input.len() + 1);
        odd_input.push(0);
        odd_input.extend_from_slice(&input);
        let mut positions = std::collections::BTreeSet::new();
        cut_candidates(&odd_input, &mut |position| {
            positions.insert(position);
        });
        positions
            .into_iter()
            .map(|position| position + 1)
            .collect::<std::collections::BTreeSet<_>>()
    };
    let mut covered = candidates;
    for position in odd {
        covered.insert(position);
    }
    let mut scanner = ChunkScanner::new();
    let mut counters = CdcCounters::default();
    let mut offset = 0_usize;
    scanner
        .consume(
            &input,
            &mut |chunk| {
                offset += chunk.len();
                if offset < input.len() {
                    assert!(covered.contains(&offset), "boundary {offset} not hinted");
                }
                Ok(())
            },
            &mut counters,
        )
        .expect("scan");
    scanner
        .finish(&mut |_| Ok(()), &mut counters)
        .expect("finish");
}
