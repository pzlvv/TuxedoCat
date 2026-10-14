//! 通用小工具。

use std::borrow::Cow;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// Windows 上创建子进程时隐藏控制台窗口（`CREATE_NO_WINDOW`）。
///
/// 不加这个标志时，每次 spawn 控制台程序（git / bash / rg / cmd）都会闪出一个窗口；
/// Core 进程自身由宿主以 `windowsHide` 启动，但它的**子进程**需要各自带上标志。
pub fn hide_console(command: &mut Command) {
    hide_console_with(command, 0);
}

/// 隐藏子进程控制台窗口，并附加额外的 `creation_flags`（如脱离终端用的
/// `DETACHED_PROCESS` / `CREATE_NEW_PROCESS_GROUP`）。
///
/// `CommandExt::creation_flags` 是**覆盖**语义：额外标志位必须与 `CREATE_NO_WINDOW`
/// 一次给全，分成两次调用会互相清掉。
pub fn hide_console_with(command: &mut Command, extra_flags: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW | extra_flags);
    }
    #[cfg(not(windows))]
    {
        let _ = (command, extra_flags);
    }
}


/// 诊断输出（按行原子）：整行格式化后在 stderr 锁内一次 `write_all`。
///
/// 不能用 `eprintln!`：它按格式片段分多次 write，而 daemon 的 stderr 就是
/// `logs/core-daemon-<指纹>.log`（`spawn_daemon` 以追加模式重定向）——多客户端并发后多条
/// 服务线程同时诊断，半行会交错进日志。整行一次写入保证进程内不交错；追加
/// 模式（O_APPEND）保证每次 write 原子落到文件尾，多进程追加也不丢行
/// （`docs/core/core-remote.md` 第 2.5 节）。写失败只能放弃：诊断没有别的去处。
pub fn diag_line(line: &str) {
    use std::io::Write as _;
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(format!("{line}\n").as_bytes());
}

/// [`diag_line`] 的宏形式，用法与 `eprintln!` 相同。
macro_rules! diag {
    ($($arg:tt)+) => {
        $crate::util::diag_line(&format!($($arg)+))
    };
}
pub(crate) use diag;

/// 安装 panic 钩子：panic 信息与强制捕获的调用栈整块写 stderr。
///
/// daemon 的 stderr 就是 `logs/core-daemon-<指纹>.log`，stdio Core 的 stderr 由宿主
/// 收进诊断日志。不装钩子时默认钩子依赖 `RUST_BACKTRACE` 环境变量，两种运行方式都
/// 没人设它，异常退出只剩一行 panic 位置、没有栈。`force_capture` 无视环境变量；
/// release 构建不 strip 且保留行号表（`Cargo.toml` 的 `[profile.release]`），栈才能
/// 符号化。整块一次 `write_all`，多行栈不与其它诊断线程交错。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        use std::io::Write as _;
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(format!("[core] panic: {info}\n{backtrace}\n").as_bytes());
    }));
}

/// 在 [`install_panic_hook`] 之上加**直接落文件**：panic 整块（信息 + 栈）除 stderr 外
/// 追加写 `log_path`。
///
/// daemon 的 stderr 通常已被启动器（`spawn_daemon`）重定向到同一个日志文件，但被
/// 手动从终端拉起（`start-daemon` 直跑）时 stderr 是终端，崩溃一屏滚过就没了——
/// 钩子自己写文件是「daemon 崩溃必须留下 trace」的兜底路径。panic 发生在任意线程、
/// 钩子拿不到上下文，路径在安装时捕获进闭包；文件在 panic 时才打开（一次 append
/// 一次 write），打开失败只能放弃（stderr 里已有同一份内容）。
pub fn install_panic_hook_with_file(log_path: std::path::PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let block = format!("[core] panic: {info}\n{backtrace}\n");
        use std::io::Write as _;
        {
            let mut stderr = std::io::stderr().lock();
            let _ = stderr.write_all(block.as_bytes());
        }
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            let _ = file.write_all(block.as_bytes());
        }
    }));
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 短随机后缀（uuid 生成用）；不需要密码学强度，只要进程内不重复
pub fn random_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", nanos ^ (counter << 8), counter)
}

/// `<prefix>_<millis>_<suffix>`
pub fn unique_id(prefix: &str) -> String {
    format!("{prefix}_{}_{}", now_millis(), random_suffix())
}

/// 宽松读取文本文件：无效 UTF-8 字节替换为 U+FFFD，不因内容报错。
///
/// 对齐 Node `readFile(path, 'utf8')` 的宽松解码（WHATWG 口径，Rust
/// `from_utf8_lossy` 同策略）：会话数据（`.jsonl` / `.meta.json`）由多进程共写，
/// 异常退出可能留下半截多字节序列；`read_to_string` 的严格校验会让**整个文件**
/// 读取失败、整个会话被当成空，而 Embedded 侧同等场景只损失一个替换字符。
/// 文件不存在等 I/O 错误仍然照常返回 `Err`。
pub fn read_to_string_lossy(path: &std::path::Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// JS `String.prototype.length`：UTF-16 code unit 数。
///
/// Embedded 全部用 JS 的 `.length` / `.slice` / `.substring`（按 UTF-16 code unit），
/// 对 BMP 字符与「字符数」一致，对代理对（emoji / 生僻字）则是 2。这里按同一口径
/// 计数，避免含 emoji 的工具输出在两侧触发不同的裁剪阈值。
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// 取前 `limit` 个 UTF-16 code unit（对齐 JS `substring(0, limit)`）。
///
/// JS 可能在代理对中间切开产生孤立代理项，Rust 的 `String` 无法表达，因此这里
/// 在字符边界处截断（返回值 ≤ limit 个 code unit）。
pub fn utf16_take(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if used + width > limit {
            break;
        }
        used += width;
        out.push(ch);
    }
    out
}

/// 取尾部 `limit` 个 UTF-16 code unit（对齐 JS `slice(length - limit)`）。
pub fn utf16_tail(text: &str, limit: usize) -> String {
    let total = utf16_len(text);
    if total <= limit {
        return text.to_string();
    }
    let skip = total - limit;
    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if used < skip {
            used += width;
            continue;
        }
        out.push(ch);
    }
    out
}

/// 按 UTF-16 code unit 截断（对齐 JS `substring(0, limit)`；不含省略标记）
pub fn truncate_chars(text: &str, limit: usize) -> String {
    if utf16_len(text) <= limit {
        return text.to_string();
    }
    utf16_take(text, limit)
}

/// 截断字节长度，保留 UTF-8 边界（保留给测试与后续工具输出上限使用）
#[allow(dead_code)]
pub fn truncate_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// JS 正则 `\s` / `String.prototype.trim` 的空白集合
/// （ECMAScript WhiteSpace + LineTerminator）。
///
/// 不能直接用 Rust 的 `char::is_whitespace()`（Unicode White_Space）：Rust 含
/// U+0085（NEL）却不含 U+FEFF（ZWNBSP），而 JS 恰好相反。凡是要与 TS 逐字对齐的
/// trim / 分词 / 正则都必须用这一套口径。
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// JS `String.prototype.trim`
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// JS `String.prototype.trimStart`
pub fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// JS `String.prototype.trimEnd`
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// JS `Number.prototype.toString()` 口径的数字字符串化。
///
/// serde_json 的 `Number` 把 JSON 文本里的 `1.0` / `1e2` 解析成 `Float`，其 `Display`
/// 会输出 `1.0` / `100.0`；JS 只有 double，`String(1.0)` 是 `1`。整数值的浮点必须
/// 走 `ryu_js`（ECMAScript 数字格式化），否则 `js_string` / `js_json_stringify`
/// 会与 TS 逐字不一致。
pub fn js_number_string(number: &serde_json::Number) -> String {
    if let Some(unsigned) = number.as_u64() {
        return unsigned.to_string();
    }
    if let Some(signed) = number.as_i64() {
        return signed.to_string();
    }
    let float = number.as_f64().unwrap_or(f64::NAN);
    if !float.is_finite() {
        // serde_json 表示不了 NaN / Infinity（`from_f64` 直接返回 None），这里只是
        // 防御性兜底：按 JS `String()` 口径给出 "NaN" / "Infinity"。
        return if float.is_nan() {
            "NaN".to_string()
        } else if float > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(float).to_string()
}

/// JS `JSON.stringify` 口径的序列化。
///
/// 与 `serde_json::to_string` 的差异只在数字：JS 对整数值的浮点（`1.0`）输出 `1`，
/// serde_json 输出 `1.0`（见 [`js_number_string`]）。
/// 帧 / MCP JSON-RPC / LLM 请求体等要与 TS 逐字对齐的载荷都用它。
pub fn js_json_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => js_number_string(number),
        Value::String(text) => {
            serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(js_json_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => format!(
            "{{{}}}",
            object
                .iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    format!("{key}:{}", js_json_stringify(value))
                })
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

/// JS `String(value)`：模板字面量插值 / 字符串拼接时用的字符串化口径。
///
/// 与 JSON 序列化不同：对象是 `[object Object]`、数组是元素按 `,` 拼接、
/// `null` 是 `"null"`、布尔是 `"true"` / `"false"`。
///
/// 数组元素走 `Array.prototype.join` 的规则：`null`（以及 JS 的 `undefined`）
/// 在该位置变成**空串**（`String([1, null, 2]) === '1,,2'`），不是 `null` 字面量。
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => js_number_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS `Number.prototype.toFixed(1)`：保留 1 位小数，`.5` 远离零进位。
///
/// 不能直接用 Rust 的 `{:.1}`（「四舍六入五成双」，`1.25` → `1.2`，而 JS 给 `1.3`），
/// 也不能用 `(value * 10.0).round()`（乘法再引入一次舍入，`1.15` 会从 `1.1` 变成
/// `1.2`）。这里取 double 的**精确十进制展开**（二进制浮点的十进制展开必然终止），
/// 再看第一位小数之后的余数是否 ≥ 0.5：取 20 位足以判定——区间内的 ULP 远大于
/// 1e-20，非精确落在 `x.x5` 上的值其差至少在 1e-16 量级。
///
/// 文件大小（`formatFileSize`）与后台任务时长（`formatDuration`）等展示文案用。
pub fn js_to_fixed_1(value: f64) -> String {
    if !value.is_finite() {
        return if value.is_nan() {
            "NaN".to_string()
        } else if value > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    // `x >= 1e21` 时 JS `toFixed` 直接返回 `ToString(x)`（指数形式），不走定点
    if value.abs() >= 1e21 {
        let mut buffer = ryu_js::Buffer::new();
        return buffer.format_finite(value).to_string();
    }
    let negative = value < 0.0;
    let text = format!("{:.20}", value.abs());
    let (int_text, frac_text) = text.split_once('.').unwrap_or((text.as_str(), ""));
    let mut whole: u128 = int_text.parse().unwrap_or(0);
    let mut tenths: u128 = frac_text
        .as_bytes()
        .first()
        .map(|b| u128::from(b - b'0'))
        .unwrap_or(0);
    // 第二位小数 ≥ 5 即进位（`> 5` 是上舍，`== 5` 是远离零的平局进位）
    let round_up = frac_text
        .as_bytes()
        .get(1)
        .map(|b| b - b'0' >= 5)
        .unwrap_or(false);
    if round_up {
        tenths += 1;
        if tenths == 10 {
            tenths = 0;
            whole += 1;
        }
    }
    let sign = if negative { "-" } else { "" };
    format!("{sign}{whole}.{tenths}")
}

/// 工具结果上限：前 `head` + 后 `tail`，中间省略。
///
/// 与 Embedded 的 `generateHeadTailPreview`（`src/core/tools/toolResultStorage.ts`）
/// 逐 code unit 对齐：长度按 **UTF-16 code unit**（JS `.length`，不是字节数）计算，
/// 省略标记为 `\n... (N chars omitted) ...\n`。
pub fn clamp_output(text: &str, head: usize, tail: usize) -> String {
    let total = utf16_len(text);
    if total <= head + tail {
        return text.to_string();
    }
    let head_text = utf16_take(text, head);
    let tail_text = utf16_tail(text, tail);
    // 省略数按**实际**切下的长度算：代理对跨在边界上时会被整对丢掉（少取 1 个
    // code unit），用请求值算出来的省略数会多 1。Embedded 的
    // `generateHeadTailPreview` 同样按对齐后的边界计数，两侧必须一致。
    let omitted = total - utf16_len(&head_text) - utf16_len(&tail_text);
    format!("{head_text}\n... ({omitted} chars omitted) ...\n{tail_text}")
}

// ==================== JSON 文本里的孤立代理项 ====================

/// 修复 JSON 文本里的孤立代理项转义（`\ude00` → U+FFFD）。
///
/// 背景：宿主（Embedded Core / TS）用 `JSON.stringify` 序列化，遇到**孤立代理项**
/// 会写成 `"\ude00"`——语法合法，但语义上是非法 Unicode。serde_json 是严格解析器，
/// 读到直接报错；而宿主写入的会话历史（`.jsonl` / `.meta.json`）与帧通道都可能带
/// 这种文本，于是整行 / 整帧被丢掉（`history.rs` 里的 `.ok()` 会静默降级）。
///
/// 事故来源：宿主按 UTF-16 code unit 截断「前 2K + 后 2K」预览时把 emoji 代理对切成了
/// 两半。宿主侧已修（按代理对边界对齐），这里再兜一层，保证**旧数据仍可读**。
/// 单张内联图片的 token 成本估算（与 `tokenEstimate.ts` 的 `IMAGE_TOKEN_ESTIMATE`
/// 及 ResponsesApi 的口径一致）。
pub const IMAGE_TOKEN_ESTIMATE: u64 = 1_500;

/// 判断是否为中日韩 / 全角字符（对齐 `tokenEstimate.ts` 的 `isCjkCode`，
/// 按 UTF-16 code unit 判断；代理对会被拆成两个非 CJK 单元）。
fn is_cjk_code(code: u32) -> bool {
    (0x3040..=0x30ff).contains(&code)   // 平假名 / 片假名
        || (0x3400..=0x4dbf).contains(&code) // 汉字扩展 A
        || (0x4e00..=0x9fff).contains(&code) // 常用汉字
        || (0xf900..=0xfaff).contains(&code) // 兼容汉字
        || (0xff00..=0xffef).contains(&code) // 全角字符
        || (0x3000..=0x303f).contains(&code) // CJK 标点
}

/// 估算一段文本的 token 数（偏保守，可能高于真实值）。
///
/// 逐字对齐 `tokenEstimate.ts` 的 `estimateTextTokens`：CJK / 全角按 1.2 计，
/// 其余按 3 字符 / token 计，最后 `Math.ceil`。
pub fn estimate_text_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let mut cjk: u64 = 0;
    let mut total: u64 = 0;
    for unit in text.encode_utf16() {
        total += 1;
        if is_cjk_code(unit as u32) {
            cjk += 1;
        }
    }
    let other = total - cjk;
    (cjk as f64 * 1.2 + other as f64 / 3.0).ceil() as u64
}

/// 估算一次 LLM 请求的输入 token 数（消息 + system prompt + 工具 schema）。
///
/// 对齐 `tokenEstimate.ts` 的 `estimateRequestTokens`：内联 base64 图片先替换成
/// 占位符再统计长度，最后按固定成本补回，避免 base64 长度把估算值抬到远高于真实
/// token 的水平。
pub fn estimate_request_tokens(messages: Option<&Value>, system_prompt: &str, tools: Option<&Value>) -> u64 {
    let mut image_count: u64 = 0;
    // 与 `JSON.stringify` 逐字对齐（数字走 JS 口径，见 `js_number_string`）；
    // 长度由 `estimate_text_tokens` 按 UTF-16 code unit 统计。
    let messages_json = match messages {
        Some(value) => js_json_stringify(&replace_inline_images(value, &mut image_count)),
        None => String::new(),
    };
    let tools_json = match tools {
        Some(value) => js_json_stringify(value),
        None => String::new(),
    };
    estimate_text_tokens(&format!("{messages_json}{system_prompt}{tools_json}"))
        + image_count * IMAGE_TOKEN_ESTIMATE
}

/// 递归复制 JSON，同时把内联 base64 图片替换成占位符（对齐
/// `estimateRequestTokens` 里 `JSON.stringify` 的 replacer）。
fn replace_inline_images(value: &Value, image_count: &mut u64) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| replace_inline_images(item, image_count))
                .collect(),
        ),
        Value::Object(map) => {
            // replacer 里的 `this.type === 'base64'` 指的是持有 `data` 键的对象。
            let holder_is_base64 = map.get("type").and_then(Value::as_str) == Some("base64");
            let mut out = Map::new();
            for (key, item) in map {
                if key == "image_url" {
                    if let Value::String(text) = item {
                        if text.starts_with("data:") {
                            *image_count += 1;
                            out.insert(key.clone(), Value::String("data:image/omitted;base64,".to_string()));
                            continue;
                        }
                    }
                }
                if key == "data" {
                    if let Value::String(text) = item {
                        if utf16_len(text) > 1024 && holder_is_base64 {
                            *image_count += 1;
                            out.insert(key.clone(), Value::String(String::new()));
                            continue;
                        }
                    }
                }
                out.insert(key.clone(), replace_inline_images(item, image_count));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

///
/// 没有需要修复的内容时返回借用，不产生拷贝。
pub fn sanitize_json_surrogates(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut out: Option<String> = None;
    let mut copied_to = 0usize;
    let mut i = 0usize;

    while i + 5 < bytes.len() {
        if bytes[i] != b'\\' || bytes[i + 1] != b'u' {
            i += 1;
            continue;
        }
        // `\u` 前面连续的反斜杠有偶数个时，这个反斜杠才是转义起点；
        // 奇数个说明它自身被转义了（`\\ude00` 是字面量文本，不能动）。
        let mut preceding_backslashes = 0usize;
        let mut cursor = i;
        while cursor > 0 && bytes[cursor - 1] == b'\\' {
            preceding_backslashes += 1;
            cursor -= 1;
        }
        if preceding_backslashes % 2 == 1 {
            i += 2;
            continue;
        }

        let Some(code) = hex4(&bytes[i + 2..i + 6]) else {
            i += 2;
            continue;
        };
        if !(0xD800..=0xDFFF).contains(&code) {
            i += 6;
            continue;
        }
        // 合法代理对（高位转义紧跟低位转义）原样保留
        let is_pair = (0xD800..=0xDBFF).contains(&code)
            && i + 12 <= bytes.len()
            && bytes[i + 6] == b'\\'
            && bytes[i + 7] == b'u'
            && matches!(hex4(&bytes[i + 8..i + 12]), Some(low) if (0xDC00..=0xDFFF).contains(&low));
        if is_pair {
            i += 12;
            continue;
        }

        let buffer = out.get_or_insert_with(String::new);
        buffer.push_str(&text[copied_to..i]);
        buffer.push('\u{FFFD}');
        copied_to = i + 6;
        i += 6;
    }

    match out {
        Some(mut buffer) => {
            buffer.push_str(&text[copied_to..]);
            Cow::Owned(buffer)
        }
        None => Cow::Borrowed(text),
    }
}

/// 4 位十六进制（只接受 ASCII hex，非 hex 或长度不符返回 None）
fn hex4(bytes: &[u8]) -> Option<u32> {
    if bytes.len() != 4 {
        return None;
    }
    let mut value = 0u32;
    for &byte in bytes {
        let digit = (byte as char).to_digit(16)?;
        value = value * 16 + digit;
    }
    Some(value)
}

#[cfg(test)]
#[path = "util_tests.rs"]
mod tests;
