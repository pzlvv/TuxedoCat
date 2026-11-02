//! 冻结 CDC 分块：GEAR 扫描器、零游程特例与 profile 身份。

mod gear;
mod zeros;

pub use gear::{
    cut_candidates, profile_id, CdcCounters, ChunkScanner, FastCdc, GEAR, LARGE_MASK,
    MAXIMUM_CHUNK_BYTES, MINIMUM_CHUNK_BYTES, NORMALIZATION_SHIFT, PROFILE_SEED,
    SHIFTED_LARGE_MASK, SHIFTED_SMALL_MASK, SMALL_MASK, TARGET_CHUNK_BYTES,
};

#[cfg(test)]
#[path = "cdc_tests.rs"]
mod tests;
