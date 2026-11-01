//! 分支命名（specs/037 FR-009）。
//!
//! 名字 = 绝区零角色官方英文名 + `-` + 3 位小写随机字母数字（如 `ellen-k3f`）。
//! git 分支名是 `tuxedo/<name>`；名字创建时定死，会话改名不跟随。
//!
//! 撞名重试在 [`crate::branch::worktree`] 的创建流程里：`git worktree add -b` 对已存在
//! 的分支报错，调用方据此换名再试（名字生成不含 git 探测——一份事实只有一个来源）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 分支名里的角色英文名常量表（绝区零角色官方英文简称，多字名转连字符）。
///
/// 命名只在创建分支对话时用一次，取值与顺序都不承载语义；表只增不减（改表会让既有
/// 分支名对不上「来源角色」，虽然没有代码依赖它）。
pub const BRANCH_ROLE_NAMES: [&str; 24] = [
    "anby",
    "nicole",
    "billy",
    "lycaon",
    "miyabi",
    "zhu-yuan",
    "qing-yi",
    "rina",
    "koleda",
    "ben",
    "soukaku",
    "corin",
    "anton",
    "grace",
    "piper",
    "lucy",
    "yanagi",
    "harumasa",
    "ju-fufu",
    "astra",
    "evelyn",
    "pulchra",
    "trigger",
    "seed",
];

/// git 分支命名空间前缀：`tuxedo/<name>` 就是成果出口（specs/037 FR-004）。
pub const BRANCH_NAMESPACE: &str = "tuxedo";

/// 随机后缀长度（小写字母 + 数字）
pub const SUFFIX_LEN: usize = 3;

static NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成一个分支名（`<角色名>-<3 位随机>`）。
///
/// 随机源是时间纳秒 + 进程内计数器：不需要密码学强度，只要进程内不重复、跨进程
/// 撞名概率低到可以靠 git 的「分支已存在」报错兜住（撞名换名重试）。
pub fn generate_name() -> String {
    generate_name_with(|count| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos() as u64)
            .unwrap_or(0);
        nanos.wrapping_add(count.wrapping_mul(0x9E37_79B9_7F4A_7C15))
    })
}

/// 可注入随机源的名字生成（单测用固定熵源验证格式与撞名重试）。
pub fn generate_name_with(mut entropy: impl FnMut(u64) -> u64) -> String {
    let count = NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    let raw = entropy(count);
    let index = (raw % BRANCH_ROLE_NAMES.len() as u64) as usize;
    let role = BRANCH_ROLE_NAMES[index];
    format!("{role}-{}", random_suffix(raw >> 7))
}

/// 由熵值导出 `SUFFIX_LEN` 位小写字母数字后缀
fn random_suffix(mut value: u64) -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(SUFFIX_LEN);
    for _ in 0..SUFFIX_LEN {
        out.push(ALPHABET[(value % 36) as usize] as char);
        value /= 36;
    }
    out
}

/// 名字 → git 分支名（`tuxedo/<name>`）
pub fn branch_ref(name: &str) -> String {
    format!("{BRANCH_NAMESPACE}/{name}")
}

/// 校验名字是否符合 FR-009 的格式（`^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$`）
///
/// 只在测试里当断言用：生产路径的名字由本模块生成，不需要二次校验（不引入
/// 「生成的能过、改过的不能过」的第二套规则）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_valid_name(name: &str) -> bool {
    let Some((role, suffix)) = name.rsplit_once('-') else {
        return false;
    };
    if suffix.len() != SUFFIX_LEN {
        return false;
    }
    if !suffix.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()) {
        return false;
    }
    !role.is_empty()
        && role.split('-').all(|word| {
            !word.is_empty() && word.bytes().all(|byte| byte.is_ascii_lowercase())
        })
}

#[cfg(test)]
#[path = "naming_tests.rs"]
mod tests;
