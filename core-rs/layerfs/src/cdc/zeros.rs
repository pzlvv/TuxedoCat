//! 冻结扫描器中的零洞处理：保持两种边界对齐。
//!
//! 一个最大块清掉前导非零字节；其后只剩零的扫描器状态每 32768 字节重复一次，
//! 包括奇数挂起字节与哈希。与上游 v1.1.0 `file/cdc/zeros.rs` 一致。

use super::gear::{CdcCounters, ChunkScanner, MAXIMUM_CHUNK_BYTES};
use crate::error::{ContentError, ContentResult};

impl ChunkScanner {
    /// 处理一个零洞：满 interior 零块以重复计数交给回调，返回实际扫描的零字节数。
    pub fn zeros(
        &mut self,
        length: u64,
        counters: &mut CdcCounters,
        on_chunks: &mut impl FnMut(&[u8], u64) -> ContentResult<()>,
    ) -> ContentResult<u64> {
        let zeros = [0; MAXIMUM_CHUNK_BYTES];
        let head = length.min(MAXIMUM_CHUNK_BYTES as u64);
        self.consume(
            &zeros[..head as usize],
            &mut |chunk| on_chunks(chunk, 1),
            counters,
        )?;
        let remaining = length - head;
        let repeats = remaining / MAXIMUM_CHUNK_BYTES as u64;
        if repeats != 0 {
            on_chunks(&zeros, repeats)?;
            counters.chunks_emitted = counters
                .chunks_emitted
                .checked_add(repeats)
                .ok_or(ContentError::LengthOverflow)?;
        }
        let tail = remaining % MAXIMUM_CHUNK_BYTES as u64;
        if tail != 0 {
            self.consume(
                &zeros[..tail as usize],
                &mut |chunk| on_chunks(chunk, 1),
                counters,
            )?;
        }
        Ok(head + tail)
    }
}
