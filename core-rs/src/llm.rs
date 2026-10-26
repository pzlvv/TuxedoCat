//! LLM 客户端：OpenAI Chat Completions 与 Anthropic Messages 的流式调用。
//!
//! 内部消息一律用 Anthropic 风格 content blocks 表示；
//! OpenAI 协议在请求前做一次转换。
//!
//! 超时与重试：整体请求 600s 由 reqwest 承担；网络错误 / 502、503 与「无内容且无
//! 结束原因」按 `MAX_RETRIES=3`、`RETRY_DELAY_MS=1000` 重试；退化重复按
//! `DEFAULT_MAX_REPETITION_RETRIES=1` 重试（对齐 `shared.ts` / `OpenAiApi.ts` /
//! `RealApi.ts`）。请求发送（等待响应头）、流式读取与重试等待都按
//! `CANCEL_POLL_SLICE_MS` 切片查 `cancel`，abort 在切片粒度内被响应；首字节
//! 看门狗从请求发出时刻起算，覆盖「连响应头都不回」的网关。

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::config::ProviderConfig;
use crate::util::sanitize_json_surrogates;

/// 重试延迟（ms）与最大重试次数（对齐 `shared.ts` 的 `RETRY_DELAY_MS` / `MAX_RETRIES`）
pub(crate) const RETRY_DELAY_MS: u64 = 1000;
pub(crate) const MAX_RETRIES: u32 = 3;

/// 取消轮询切片（ms）：`read_sse` 的阻塞等待与重试延迟都切成该粒度，每片之间查
/// 一次 `cancel`。abort 的响应上限由此决定（50ms 量级），不取决于下一个 SSE
/// 事件的到达时间，也不叠加在超时 / 重试等待上。
pub(crate) const CANCEL_POLL_SLICE_MS: u64 = 50;

/// 流式看门狗（对齐 `streamTimeout.ts`）：
/// - 首字节超时：从发起请求到收到**首个有效事件**（心跳 `ping` / SSE 注释不算）；
/// - 空闲超时：两个有效事件之间的最大间隔；
/// - 超时重试独立预算，默认只重试一次（首字节最长要等 5 分钟，沿用 3 次用户最坏等 20 分钟）。
pub const DEFAULT_FIRST_BYTE_TIMEOUT_MS: u64 = 300_000;
pub const DEFAULT_STREAM_IDLE_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_TIMEOUT_RETRIES: u32 = 1;

/// 可重试的 HTTP 状态码（对齐 `shared.ts` 的 `isRetryableStatus`：仅 502 / 503）
pub(crate) fn is_retryable_status(status: u16) -> bool {
    status == 502 || status == 503
}

/// 一次流式请求的失败分类：决定走哪条重试预算（对齐三个适配器的重试分支）。
pub(crate) enum StreamFailure {
    /// 网络错误 / 502、503 / 「无内容且无结束原因」——共用 `MAX_RETRIES` 预算
    Retryable(String),
    /// 流式看门狗超时——独立预算 `DEFAULT_MAX_TIMEOUT_RETRIES`
    Timeout(String),
    /// 退化重复——独立预算 `DEFAULT_MAX_REPETITION_RETRIES`
    Repetition(String),
    /// 其它错误，直接抛出
    Fatal(String),
}

impl StreamFailure {
    /// 测试用：取出错误文案
    #[cfg(test)]
    fn message(self) -> String {
        match self {
            StreamFailure::Retryable(message)
            | StreamFailure::Timeout(message)
            | StreamFailure::Repetition(message)
            | StreamFailure::Fatal(message) => message,
        }
    }
}

/// 可中断的延迟等待（重试间隔）。
///
/// 分片 sleep，每片之间查一次 `cancel`：等待期间置位取消时提前返回 `true`，
/// 调用方随即走「用户中断」收尾——重试等待不再给 abort 时延整段叠加
/// `RETRY_DELAY_MS`。
fn sleep_ms_interruptible(delay_ms: u64, cancel: &AtomicBool) -> bool {
    let mut remaining = delay_ms;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return true;
        }
        if remaining == 0 {
            return false;
        }
        let slice = remaining.min(CANCEL_POLL_SLICE_MS);
        std::thread::sleep(Duration::from_millis(slice));
        remaining -= slice;
    }
}

/// 取消（abort）时返回给上层的错误文案：引擎按 `cancel` 判定「用户中断」收尾，
/// 不把这条文案当作 LLM 故障回显。
const LLM_ABORTED_MESSAGE: &str = "LLM request aborted";

/// 首字节超时文案（send 阶段与 `read_sse` 共用，逐字对齐 `LLMStreamTimeoutError`）。
fn first_byte_timeout_message(timeout_ms: u64) -> String {
    let seconds = (timeout_ms as f64 / 1000.0).round() as u64;
    format!("LLM 流式响应超时：{seconds}s 内未收到任何有效输出事件")
}

/// 发送请求，并在等待响应头期间按切片响应取消与首字节超时。
///
/// `reqwest::blocking` 的 `send()` 一旦阻塞就无法从外部打断（只能等客户端整体
/// 超时，默认 600s），与 `read_sse` 同一套做法：`send()` 放独立线程，主线程按
/// `CANCEL_POLL_SLICE_MS` 切片等待结果——
/// - 取消置位 → 立刻以「用户中断」返回，不再等响应头；
/// - 首字节 deadline 到期 → 按 `StreamFailure::Timeout` 上报，交给看门狗重试预算
///   （看门狗从请求发出开始计时，覆盖「连响应头都不回」的网关）。
///
/// 返回响应头与本次尝试的首字节 deadline：deadline 从「请求发出」起算，继续交给
/// `read_sse`，使首字节超时覆盖「响应头 + 首个有效事件」整段。
pub(crate) fn send_cancellable(
    client: reqwest::blocking::Client,
    request: reqwest::blocking::Request,
    cancel: &AtomicBool,
    first_byte_timeout_ms: u64,
) -> Result<(reqwest::blocking::Response, Instant), StreamFailure> {
    let deadline = Instant::now() + Duration::from_millis(first_byte_timeout_ms);
    let (sender, receiver) = std::sync::mpsc::channel();
    // 取消 / 超时后接收端被丢弃：响应到达时发送失败，响应体自然析构、连接归还。
    std::thread::spawn(move || {
        let _ = sender.send(client.execute(request));
    });
    loop {
        // 先查取消、再看超时（与 `read_sse` 同一顺序）：两者同时成立按「用户中断」收尾
        if cancel.load(Ordering::Relaxed) {
            return Err(StreamFailure::Fatal(LLM_ABORTED_MESSAGE.to_string()));
        }
        if Instant::now() >= deadline {
            return Err(StreamFailure::Timeout(first_byte_timeout_message(
                first_byte_timeout_ms,
            )));
        }
        match receiver.recv_timeout(Duration::from_millis(CANCEL_POLL_SLICE_MS)) {
            Ok(Ok(response)) => return Ok((response, deadline)),
            Ok(Err(err)) => {
                // 与请求失败同时到达的取消优先，不能把用户中断回显成网络错误。
                if cancel.load(Ordering::Relaxed) {
                    return Err(StreamFailure::Fatal(LLM_ABORTED_MESSAGE.to_string()));
                }
                return Err(StreamFailure::Retryable(format!("request failed: {err}")));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // 发送线程 panic（未预期）：按网络错误处理，与 reqwest send 失败同口径
                return Err(StreamFailure::Retryable(
                    "request failed: send thread panicked".to_string(),
                ));
            }
        }
    }
}

/// token 用量
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

impl Usage {
    /// 持久化到 assistant message 的 usage（对齐 `buildAssistantMessageFromBlocks`）。
    ///
    /// usage 恒存在且**恒带四个键**
    /// （`extractUsageFields` 用 `|| 0` 兜底，流结束时还有 `{0,0,0,0}` 兜底），
    /// 因此缺失的 cache 字段要补 0 而不是省略键。
    pub fn message_usage(&self) -> Value {
        let mut map = Map::new();
        map.insert("input_tokens".to_string(), json!(self.input_tokens));
        map.insert("output_tokens".to_string(), json!(self.output_tokens));
        map.insert(
            "cache_read_input_tokens".to_string(),
            json!(self.cache_read_input_tokens.unwrap_or(0)),
        );
        map.insert(
            "cache_creation_input_tokens".to_string(),
            json!(self.cache_creation_input_tokens.unwrap_or(0)),
        );
        Value::Object(map)
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("input_tokens".to_string(), json!(self.input_tokens));
        map.insert("output_tokens".to_string(), json!(self.output_tokens));
        // usage 恒带 cache 两键（缺省 0），`streamEnd` 事件逐字带上；这里补 0 而不是省略，
        // 否则 WebView 的缓存命中率 / 上下文统计拿到的字段集合不完整。
        map.insert(
            "cache_read_input_tokens".to_string(),
            json!(self.cache_read_input_tokens.unwrap_or(0)),
        );
        map.insert(
            "cache_creation_input_tokens".to_string(),
            json!(self.cache_creation_input_tokens.unwrap_or(0)),
        );
        // reasoning_tokens 只有服务端确实返回时才带（`typeof reasoningTokens === 'number'`）
        if let Some(value) = self.reasoning_tokens {
            map.insert("reasoning_tokens".to_string(), json!(value));
        }
        Value::Object(map)
    }
}

/// 内容块类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Thinking,
    Text,
    ToolUse,
}

/// 流式增量事件
#[derive(Debug, Clone)]
pub enum LlmEvent {
    /// 内容块开始。
    ///
    /// 引擎靠它在每个块开始时分配**块级** `streamId`（`blk_*`），
    /// 并重置该角色的流式累积文本，因此同一个块内的 `streamMessage` / `streamEnd`
    /// 共用同一个 `streamId`，不同块（Responses API 的「思考→文字→搜索→…」）
    /// 之间互不覆盖。
    BlockStart(BlockKind),
    /// 内容块结束。
    ///
    /// 引擎据此立刻补一条 **`usage` 缺省**的 `streamEnd`，把对应流式消息标记为
    /// 完成（`isStreaming=false`），token 统计仍由随后的 `message_delta` 统一更新。
    BlockStop,
    /// 流接近结束。
    ///
    /// 引擎据此补一条**带 `usage`** 的 `streamEnd`（每个有内容的角色一条；纯
    /// tool_use 轮次补一条 `accumulated` 为空的 assistant 事件，把 usage 带给 UI）。
    MessageDelta,
    ThinkingDelta(String),
    /// Anthropic 扩展思考在 `content_block_start` 里直接给出的初始签名。
    ///
    /// `content_block_start` 分支会读取
    /// `content_block.signature` 并写入 thinking block；部分网关只在这一帧给完整
    /// 签名、不再发 `signature_delta`。这里用「设置」语义（覆盖已有值），
    /// `signature_delta` 仍用追加语义。
    ThinkingSignatureStart(String),
    /// Anthropic 扩展思考的签名增量；历史 thinking block 必须原样带回 signature，
    /// 否则启用思考 + 工具调用时下一轮请求会被 API 拒绝。
    ThinkingSignatureDelta(String),
    TextDelta(String),
    /// 工具调用开始。`input` 是 `content_block_start` 自带的初始入参
    /// （`input: block.input || {}`）；没有后续
    /// `input_json_delta` 时它就是最终入参。
    ToolUseStart {
        id: String,
        name: String,
        input: Value,
    },
    ToolUseInputDelta(String),
    Usage(Usage),
    StopReason(String),
    /// 丢弃本次尝试已产生的全部输出（退化重复被检出、即将重试时发出）。
    /// 重试后收到新的 `block_start` 时重置累积文本。
    Reset,
    /// 服务端在终止事件里给出的**权威**输出块（对齐 `syncContentBlocksFromOutput`）。
    ///
    /// Responses API 可能只发终止事件、不发 `*_delta`（或 delta 丢失），此时以
    /// `response.output` 为准重建内容块；引擎据此**整体替换**本轮累积的
    /// text / thinking / tool_use。
    AuthoritativeBlocks(Vec<Value>),
}

pub struct LlmRequest<'a> {
    pub provider: &'a ProviderConfig,
    pub system_prompt: &'a str,
    pub messages: &'a [Value],
    pub tools: &'a [Value],
    pub session_id: &'a str,
    pub thinking_enabled: bool,
    pub cancel: &'a AtomicBool,
    /// 首字节超时（ms）；引擎用 `DEFAULT_FIRST_BYTE_TIMEOUT_MS`，测试可调小
    pub first_byte_timeout_ms: u64,
    /// 流空闲超时（ms）；引擎用 `DEFAULT_STREAM_IDLE_TIMEOUT_MS`，测试可调小
    pub idle_timeout_ms: u64,
}

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("build http client failed: {err}"))
}

/// 按 api_type 选出流式实现（单点分发：新增 provider 只改这里）。
///
/// 统一签名以适配 `stream_openai` 的重试状态参数；不使用这两个参数的实现经
/// 闭包转发忽略（分发批据：
/// Anthropic Messages / OpenAI Responses / 其余按 Chat Completions 兼容兜底）。
fn stream_fn(
    api_type: &str,
) -> fn(&LlmRequest, &mut dyn FnMut(LlmEvent), &mut u32, &mut bool) -> Result<(), StreamFailure> {
    match api_type {
        "Anthropic" => |req, emit, _, _| stream_anthropic(req, emit),
        // OpenAI Responses API（`POST {baseURL}/v1/responses`）
        "Responses" => |req, emit, _, _| crate::responses::stream_responses(req, emit),
        _ => stream_openai,
    }
}

/// 发起一次流式请求；每个增量经 `emit` 回调。
///
/// 重试口径：
/// - 网络错误 / 502、503 / 「无内容且无结束原因」：`retry_count < MAX_RETRIES`，间隔 `RETRY_DELAY_MS`
/// - 流式看门狗超时：独立预算 `DEFAULT_MAX_TIMEOUT_RETRIES`，重试前发 `Reset` 丢弃本轮输出
/// - 退化重复：独立预算 `DEFAULT_MAX_REPETITION_RETRIES`，重试前发 `Reset` 丢弃本轮输出
pub fn stream(req: &LlmRequest, emit: &mut dyn FnMut(LlmEvent)) -> Result<(), String> {
    // 非多模态模型：请求出口过滤全部图片（`specs/012-multimodal-model-filter`）。
    // 预扫描零克隆：历史里没有图片直接透传；有图片才在副本上过滤，入参
    // `req.messages` 不改写。单点在协议分发之前，三个协议实现拿到的都已无
    // 图片块；重试循环复用同一份过滤结果，不做每尝试重算。
    let filtered;
    let filtered_req;
    let req: &LlmRequest = if req.provider.multimodal || !has_images(req.messages) {
        req
    } else {
        filtered = strip_images(req.messages);
        filtered_req = LlmRequest { messages: &filtered, ..*req };
        &filtered_req
    };
    // 网络 / 重复重试共用的次数（对齐 `executeRequest(retryCount)`）
    let mut retry_count: u32 = 0;
    // 退化重复重试计数（与网络错误分开计数，对齐 `repetitionRetryCount`）
    let mut repetition_retries: u32 = 0;
    // 看门狗超时重试计数（与网络错误分开计数，对齐 `timeoutRetryCount`）
    let mut timeout_retries: u32 = 0;
    // 是否在 Chat Completions 请求里带 `stream_options.include_usage`。
    // 服务商拒绝后置 false，并在**本次调用内**的后续重试里持续省略
    // （对齐 `OpenAiApi` 闭包变量 `includeStreamUsage`）。
    let mut include_stream_usage = true;
    loop {
        // 用户已请求取消（abort）：不再发起新的请求 / 重试，直接把失败交给上层。
        // 上层（`engine::run_query_loop`）据 `cancel` 走「用户中断」收尾，不当作
        // LLM 故障回显。
        if req.cancel.load(Ordering::Relaxed) {
            return Err(LLM_ABORTED_MESSAGE.to_string());
        }
        let outcome = stream_fn(req.provider.api_type.as_str())(
            req,
            emit,
            &mut retry_count,
            &mut include_stream_usage,
        );
        match outcome {
            Ok(()) => return Ok(()),
            Err(StreamFailure::Repetition(message)) => {
                if repetition_retries < DEFAULT_MAX_REPETITION_RETRIES {
                    repetition_retries += 1;
                    retry_count += 1;
                    eprintln!(
                        "[core] {message}，丢弃本次响应并重试 ({repetition_retries}/{DEFAULT_MAX_REPETITION_RETRIES})，{RETRY_DELAY_MS}ms 后开始..."
                    );
                    // 丢弃本次尝试已产生的全部输出
                    emit(LlmEvent::Reset);
                    sleep_ms_interruptible(RETRY_DELAY_MS, req.cancel);
                    continue;
                }
                return Err(message);
            }
            Err(StreamFailure::Retryable(message)) => {
                if retry_count < MAX_RETRIES {
                    retry_count += 1;
                    eprintln!(
                        "[core] LLM request retry ({retry_count}/{MAX_RETRIES}) after {RETRY_DELAY_MS}ms: {message}"
                    );
                    // 每次尝试都从零开始累积（重试即重建，
                    // `block_start` 时重置累积文本）。
                    // 网络错误可能发生在已收到部分增量之后，必须丢弃本轮输出。
                    emit(LlmEvent::Reset);
                    sleep_ms_interruptible(RETRY_DELAY_MS, req.cancel);
                    continue;
                }
                return Err(message);
            }
            Err(StreamFailure::Timeout(message)) => {
                // 对齐 `OpenAiApi` / `RealApi` 的看门狗分支：独立预算（默认 1 次），
                // 重试前丢弃本轮已产生的输出。
                if timeout_retries < DEFAULT_MAX_TIMEOUT_RETRIES {
                    timeout_retries += 1;
                    retry_count += 1;
                    eprintln!(
                        "[core] {message}，丢弃本次响应并重试 ({timeout_retries}/{DEFAULT_MAX_TIMEOUT_RETRIES})，{RETRY_DELAY_MS}ms 后开始..."
                    );
                    emit(LlmEvent::Reset);
                    sleep_ms_interruptible(RETRY_DELAY_MS, req.cancel);
                    continue;
                }
                return Err(message);
            }
            Err(StreamFailure::Fatal(message)) => return Err(message),
        }
    }
}

// ==================== URL ====================

fn join_url(base: &str, suffix: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), suffix)
}

/// base 的路径末段是否为版本段（`/v1`、`/v4`、`/v12` 等，对齐 `joinV1Path` 的正则）。
///
/// 带版本段的 base 不再补 `/v1`：智谱的 baseURL 是 `https://open.bigmodel.cn/api/paas/v4`，
/// 补 `/v1` 会打到不存在的路径；按数字匹配让未来的 `/v5`、`/v6` 同样成立。
pub(crate) fn base_has_version_segment(base: &str) -> bool {
    let Some((_, segment)) = base.rsplit_once('/') else {
        return false;
    };
    let Some(digits) = segment.strip_prefix('v') else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// `{base}/v1/chat/completions`；base 已带版本段时用 `{base}/chat/completions`
fn chat_completions_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base_has_version_segment(base) {
        join_url(base, "/chat/completions")
    } else {
        join_url(base, "/v1/chat/completions")
    }
}

/// `{base}/v1/messages`；base 已带版本段时用 `{base}/messages`
fn messages_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base_has_version_segment(base) {
        join_url(base, "/messages")
    } else {
        join_url(base, "/v1/messages")
    }
}

// ==================== SSE ====================

/// 逐行读取 SSE，把每个 `data:` 载荷交给 `on_data`，并带流式看门狗（对齐 `streamTimeout.ts`）。
///
/// 阻塞读取放在独立线程，主线程只做切片等待：`recv_timeout` 每次最多等
/// `CANCEL_POLL_SLICE_MS`，每片回来都查一次 `cancel`，看门狗用 deadline 自行累计
/// （首个**有效事件**前用 `send_cancellable` 从请求发出时刻算起的
/// `first_byte_deadline`，之后每收到有效事件把 deadline 重置为
/// `now + idle_timeout_ms`）。这样单次等待不再等于整个超时窗口：流停滞时
/// abort 也能在切片粒度内被响应，而不是等满 `idle_timeout_ms`。
///
/// `on_data` 返回该帧是否算「有效进展」：Anthropic 的 `ping` / 未知事件不算，
/// OpenAI 能解析出 JSON 的数据帧都算（SSE 注释行在进入 `on_data` 前就被丢弃）。
pub(crate) fn read_sse(
    response: reqwest::blocking::Response,
    cancel: &AtomicBool,
    first_byte_deadline: Instant,
    first_byte_timeout_ms: u64,
    idle_timeout_ms: u64,
    on_data: &mut dyn FnMut(&str) -> Result<bool, StreamFailure>,
) -> Result<(), StreamFailure> {
    // 读取线程只负责按行搬运；超时/取消时主线程丢弃接收端即可，
    // 线程会在下一次读取返回（或 reqwest 整体超时）后自然退出。
    let (sender, receiver) = std::sync::mpsc::channel::<Result<String, String>>();
    let stopped = std::sync::Arc::new(AtomicBool::new(false));
    let reader_stopped = std::sync::Arc::clone(&stopped);
    std::thread::spawn(move || {
        let reader = BufReader::new(response);
        for line in reader.lines() {
            if reader_stopped.load(Ordering::Relaxed) {
                return;
            }
            match line {
                Ok(line) => {
                    if sender.send(Ok(line)).is_err() {
                        return;
                    }
                }
                Err(err) => {
                    let _ = sender.send(Err(err.to_string()));
                    return;
                }
            }
        }
    });

    let mut saw_progress = false;
    // 首字节 deadline 从「请求发出」起算（send_cancellable 计算），而不是从收到
    // 响应头起算：网关完全不回响应头时，计时必须在 send 阶段就已经在走。
    let mut deadline = first_byte_deadline;
    loop {
        // 先查取消、再看超时：两者同时成立按「用户中断」收尾，不上报 Timeout
        // 。
        if cancel.load(Ordering::Relaxed) {
            stopped.store(true, Ordering::Relaxed);
            return Ok(());
        }
        if Instant::now() >= deadline {
            stopped.store(true, Ordering::Relaxed);
            let message = if saw_progress {
                let seconds = (idle_timeout_ms as f64 / 1000.0).round() as u64;
                format!("LLM 流式响应超时：连续 {seconds}s 无新的输出事件（流已停滞）")
            } else {
                first_byte_timeout_message(first_byte_timeout_ms)
            };
            return Err(StreamFailure::Timeout(message));
        }
        match receiver.recv_timeout(Duration::from_millis(CANCEL_POLL_SLICE_MS)) {
            Ok(Ok(line)) => {
                // 对齐 `parseSSELines`：先对整行做 **JS** 空白 trim，再要求 `data:`
                // 前缀（TS 的 `line.trim().startsWith('data:')` 允许前导空白），
                // 载荷同样按 JS 空白 trim。
                let line = crate::util::js_trim(&line);
                if line.is_empty() {
                    continue;
                }
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = crate::util::js_trim(payload);
                if payload.is_empty() {
                    continue;
                }
                if payload == "[DONE]" {
                    stopped.store(true, Ordering::Relaxed);
                    return Ok(());
                }
                if on_data(payload)? {
                    saw_progress = true;
                    deadline = Instant::now() + Duration::from_millis(idle_timeout_ms);
                }
            }
            Ok(Err(err)) => {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(());
                }
                return Err(StreamFailure::Retryable(format!("read stream failed: {err}")));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 切片内没有新帧：回到循环顶查 cancel 与看门狗 deadline
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

/// 读取错误响应体，用于错误提示（完整正文，不截断）。
///
/// 读取同样按 `CANCEL_POLL_SLICE_MS` 切片查 `cancel`：网关回了错误响应头却挂着
/// 正文不发时，abort 不能在这里再等满 reqwest 的整体超时。取消时返回「用户中断」
/// 错误，由上层按取消收尾（不再展示 API 错误）。
pub(crate) fn error_body(
    response: reqwest::blocking::Response,
    cancel: &AtomicBool,
) -> Result<String, StreamFailure> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(response.text().unwrap_or_default());
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(StreamFailure::Fatal(LLM_ABORTED_MESSAGE.to_string()));
        }
        match receiver.recv_timeout(Duration::from_millis(CANCEL_POLL_SLICE_MS)) {
            Ok(body) => return Ok(body),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            // 读取线程结束但没送出正文（未预期）：与 `response.text()` 失败同口径，返回空串
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(String::new()),
        }
    }
}

/// HTTP 错误文案（逐字对齐 `RealApi.ts` / `OpenAiApi.ts` 的
/// `API request failed: ${status} ${statusText}\n${errorText}`）。
pub(crate) fn api_error_message(status: reqwest::StatusCode, detail: &str) -> String {
    match status.canonical_reason() {
        Some(reason) => format!("API request failed: {} {reason}\n{detail}", status.as_u16()),
        None => format!("API request failed: {}\n{detail}", status.as_u16()),
    }
}

// ==================== Anthropic ====================

fn stream_anthropic(
    req: &LlmRequest,
    emit: &mut dyn FnMut(LlmEvent),
) -> Result<(), StreamFailure> {
    let provider = req.provider;
    let mut body = Map::new();
    body.insert("model".to_string(), json!(provider.model));
    body.insert("max_tokens".to_string(), json!(provider.max_tokens));
    body.insert("stream".to_string(), json!(true));
    body.insert("temperature".to_string(), json!(1.0));
    body.insert("top_p".to_string(), json!(0.95));
    body.insert(
        "messages".to_string(),
        // tool_use 的非法 JSON 入参归一为对象：Anthropic 协议的 input 字段要求对象，
        // 原样字符串会让整轮请求 400 并毒化此后的每一轮（见 engine.rs 的
        // `sanitize_anthropic_messages`）。
        Value::Array(crate::engine::sanitize_anthropic_messages(req.messages)),
    );
    if !req.system_prompt.is_empty() {
        body.insert("system".to_string(), json!(req.system_prompt));
    }
    if !req.tools.is_empty() {
        body.insert("tools".to_string(), Value::Array(req.tools.to_vec()));
    }
    // 思考开启时用 `chat_template_kwargs`
    // （reasoning_effort + thinking:true），仅在预算 > 0 时附 `thinking_token_budget`；
    // 关闭时显式 `thinking = { type: 'disabled' }`。
    if req.thinking_enabled {
        body.insert(
            "chat_template_kwargs".to_string(),
            json!({ "reasoning_effort": provider.thinking_effort, "thinking": true }),
        );
        if provider.thinking_budget_tokens > 0 {
            body.insert(
                "thinking_token_budget".to_string(),
                json!(provider.thinking_budget_tokens),
            );
        }
    } else {
        body.insert("thinking".to_string(), json!({ "type": "disabled" }));
    }

    let client = http_client().map_err(StreamFailure::Fatal)?;
    let request = client
        .post(messages_url(&provider.base_url))
        .header("Content-Type", "application/json")
        // 同时携带两种认证方式以兼容不同网关
        .header("x-api-key", &provider.api_key)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .header("anthropic-version", "2023-06-01")
        .header("x-session-id", req.session_id)
        // 用 JS `JSON.stringify` 口径序列化：
        // serde_json 会把 `1.0` 写成 `1.0`，JS 写 `1`，逐字对齐请求体。
        .body(crate::util::js_json_stringify(&Value::Object(body)))
        .build()
        .map_err(|err| StreamFailure::Fatal(format!("request build failed: {err}")))?;
    // 等待响应头期间也可取消 / 受首字节超时约束（见 send_cancellable）
    let (response, first_byte_deadline) =
        send_cancellable(client, request, req.cancel, req.first_byte_timeout_ms)?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = error_body(response, req.cancel)?;
        let message = api_error_message(status, &detail);
        // 502 / 503 走网络错误同一套重试（对齐 `isRetryableStatus`）
        return Err(if is_retryable_status(status.as_u16()) {
            StreamFailure::Retryable(message)
        } else {
            StreamFailure::Fatal(message)
        });
    }

    let cancel = req.cancel;
    // 退化重复检测器：单次尝试内、单个流一个（对齐 `RealApi` 的 textRepetition / thinkingRepetition）
    let mut text_repetition = RepetitionDetector::new();
    let mut thinking_repetition = RepetitionDetector::new();
    let mut tool_index: Option<u64> = None;
    // usage 累计值
    let mut accumulated_input_tokens: u64 = 0;
    let mut accumulated_output_tokens: u64 = 0;
    read_sse(response, cancel, first_byte_deadline, req.first_byte_timeout_ms, req.idle_timeout_ms, &mut |payload| {
        let Ok(event) = serde_json::from_str::<Value>(&sanitize_json_surrogates(payload)) else {
            return Ok(false);
        };
        // 对齐 `isProgressEvent(event, '')`：有非空 type 且不是心跳 `ping` 才算进展
        let progress = event
            .get("type")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty() && value != "ping")
            .unwrap_or(false);
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                let usage = event
                    .get("message")
                    .and_then(|message| message.get("usage"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let cache_creation = usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                // DeepSeek 风格网关的
                // `input_tokens` 不含缓存命中部分，必须把两个 cache 计数加回，
                // 否则 `totalContextTokens` 偏小、缓存命中率显示为负增长。
                accumulated_input_tokens =
                    usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0)
                        + cache_read
                        + cache_creation;
                accumulated_output_tokens =
                    usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
                emit(LlmEvent::Usage(Usage {
                    input_tokens: accumulated_input_tokens,
                    output_tokens: accumulated_output_tokens,
                    cache_read_input_tokens: Some(cache_read),
                    cache_creation_input_tokens: Some(cache_creation),
                    reasoning_tokens: None,
                }));
            }
            "content_block_start" => {
                let block = event.get("content_block").cloned().unwrap_or(Value::Null);
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "tool_use" => {
                        tool_index = event.get("index").and_then(Value::as_u64);
                        // 先发
                        // `block_start`（引擎据此把当前块切到 tool_use），再发
                        // `tool_use` 起始事件。
                        emit(LlmEvent::BlockStart(BlockKind::ToolUse));
                        // 假值（null / 0 /
                        // 空串 / false）都退化成 `{}`，对象 / 数组原样保留。
                        let input = block
                            .get("input")
                            .filter(|value| crate::history::js_truthy(Some(value)))
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        emit(LlmEvent::ToolUseStart {
                            id: block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            input,
                        });
                    }
                    // thinking 块
                    // 自带非空 signature 时先记下来（部分网关只在这一帧给完整签名）。
                    "thinking" => {
                        emit(LlmEvent::BlockStart(BlockKind::Thinking));
                        if let Some(signature) = block
                            .get("signature")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                        {
                            emit(LlmEvent::ThinkingSignatureStart(signature.to_string()));
                        }
                    }
                    "text" => emit(LlmEvent::BlockStart(BlockKind::Text)),
                    _ => {}
                }
            }
            // 每个块结束都发
            // `block_stop`（引擎据此立刻给该块补一条 `usage` 缺省的 `streamEnd`）。
            "content_block_stop" => emit(LlmEvent::BlockStop),
            "content_block_delta" => {
                let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            check_repetition(&mut text_repetition, text, "text")?;
                            emit(LlmEvent::TextDelta(text.to_string()));
                        }
                    }
                    "thinking_delta" => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            check_repetition(&mut thinking_repetition, text, "thinking")?;
                            emit(LlmEvent::ThinkingDelta(text.to_string()));
                        }
                    }
                    "signature_delta" => {
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            emit(LlmEvent::ThinkingSignatureDelta(signature.to_string()));
                        }
                    }
                    "input_json_delta" => {
                        let _ = tool_index;
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            emit(LlmEvent::ToolUseInputDelta(partial.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                // input 沿用 message_start 的累计值
                // （缺省时保留原值），cache 取本次 delta 的值（缺省 0），
                // 最终 input = 累计 input + delta 的两个 cache 计数。
                let usage = event.get("usage").cloned().unwrap_or(Value::Null);
                if let Some(value) = usage.get("input_tokens").and_then(Value::as_u64) {
                    accumulated_input_tokens = value;
                }
                if let Some(value) = usage.get("output_tokens").and_then(Value::as_u64) {
                    accumulated_output_tokens = value;
                }
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let cache_creation = usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                emit(LlmEvent::Usage(Usage {
                    input_tokens: accumulated_input_tokens + cache_read + cache_creation,
                    output_tokens: accumulated_output_tokens,
                    cache_read_input_tokens: Some(cache_read),
                    cache_creation_input_tokens: Some(cache_creation),
                    reasoning_tokens: None,
                }));
                // `stopReason = msgDelta.stop_reason as string || stopReason`：
                // 空串是假值，**不能**覆盖已经收到的 stop_reason（否则流里
                // 先回 `tool_use` 再回一帧空 `stop_reason` 时，落盘的 assistant
                // 会丢掉结束原因，工具轮次判定随之出错）。
                if let Some(reason) = event
                    .get("delta")
                    .and_then(|delta| delta.get("stop_reason"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    emit(LlmEvent::StopReason(reason.to_string()));
                }
                // `applyMessageDelta` 一定会给 `usage` 赋对象，
                // 因此紧随其后的 `message_delta` StreamEvent 上 `event.usage` 恒为真值。
                emit(LlmEvent::MessageDelta);
            }
            "error" => {
                let message = event
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error");
                return Err(StreamFailure::Fatal(format!("LLM stream error: {message}")));
            }
            _ => {}
        }
        Ok(progress)
    })
}

// ==================== OpenAI Chat Completions ====================

/// 流内 `error` 对象的文案（对齐 `OpenAiApi`：`` `${err?.message || JSON.stringify(err)}` ``）。
///
/// `message` 为**真值**时按 JS 字符串化拼接（对象是 `[object Object]`）；
/// 缺失 / 空串 / `null` 等假值时序列化整个 error 对象——「服务商只回了错误码」时
/// 把整段 JSON 显示给用户，而不是 `unknown error`。
fn stream_error_message(error: &Value) -> String {
    if let Some(message) = error.get("message") {
        if crate::history::js_truthy(Some(message)) {
            return crate::util::js_string(message);
        }
    }
    // `JSON.stringify(err)`：数字走 JS 口径
    crate::util::js_json_stringify(error)
}

/// 消息里是否还有图片块（用户消息的 `image` 块 / `tool_result` content 里的
/// image 部分）。只读遍历、零克隆：非多模态且无图的历史直接透传原请求，
/// 不付整树克隆的代价（`specs/012-multimodal-model-filter` 的快路径）。
fn has_images(messages: &[Value]) -> bool {
    for message in messages {
        let Some(Value::Array(blocks)) = message.get("content") else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("image") => return true,
                Some("tool_result") => {
                    if let Some(Value::Array(parts)) = block.get("content") {
                        if parts
                            .iter()
                            .any(|part| part.get("type").and_then(Value::as_str) == Some("image"))
                        {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    false
}

/// 非多模态模型的请求出口过滤：克隆后丢弃用户消息里的 `image` 块与
/// `tool_result` content 里的 image 部分；过滤清空的消息 / 工具结果补一个
/// `IMAGE_PLACEHOLDER` 文本占位，保证不发送空内容块（Anthropic 对空 content
/// 会拒绝）。入参不改写——过滤只作用于副本，会话落盘与历史回显保留完整图片
/// （`specs/012-multimodal-model-filter` FR-006）。
fn strip_images(messages: &[Value]) -> Vec<Value> {
    let mut out = Vec::with_capacity(messages.len());
    for message in messages {
        let mut message = message.clone();
        let Some(Value::Array(blocks)) = message.get("content") else {
            out.push(message);
            continue;
        };
        let mut kept: Vec<Value> = Vec::with_capacity(blocks.len());
        for block in blocks {
            let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "image" {
                continue;
            }
            if kind == "tool_result" {
                if let Some(Value::Array(parts)) = block.get("content") {
                    let has_image = parts
                        .iter()
                        .any(|part| part.get("type").and_then(Value::as_str) == Some("image"));
                    if !has_image {
                        kept.push(block.clone());
                        continue;
                    }
                    let mut block = block.clone();
                    let remaining: Vec<Value> = parts
                        .iter()
                        .filter(|part| part.get("type").and_then(Value::as_str) != Some("image"))
                        .cloned()
                        .collect();
                    if remaining.is_empty() {
                        block["content"] =
                            json!([{ "type": "text", "text": crate::util::IMAGE_PLACEHOLDER }]);
                    } else {
                        block["content"] = Value::Array(remaining);
                    }
                    kept.push(block);
                    continue;
                }
            }
            kept.push(block.clone());
        }
        // 原本非空、过滤后清空才占位；本来就没有内容的不动
        if kept.is_empty() && !blocks.is_empty() {
            message["content"] =
                json!([{ "type": "text", "text": crate::util::IMAGE_PLACEHOLDER }]);
        } else {
            message["content"] = Value::Array(kept);
        }
        out.push(message);
    }
    out
}

/// `toImagePart`：内部 image block → Chat Completions 的 `image_url` part。
/// `source.data` 为真值时才产出，否则返回 None（对齐 `OpenAiApi.ts` 的同名逻辑）。
/// Chat Completions 侧的图片 part（`image_url` 包一层对象；空 data 返回 None 整体省略）。
/// 注意与 `responses.rs::to_image_part` 不是同一份逻辑的两份拷贝：Responses 协议的
/// `input_image` 是平铺字段且空 data 继续下发，二者形状与空值语义都不同（对齐
/// `OpenAiApi.ts` / `ResponsesApi.ts` 各自的 `toImagePart`），不做合并。
fn to_image_part(block: &Value) -> Option<Value> {
    let source = block.get("source")?;
    let data = source
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(json!({
        "type": "image_url",
        "image_url": { "url": format!("data:{media_type};base64,{data}") }
    }))
}

/// `convertToolResultContent`：tool_result 的 content（字符串 / 内容块数组）转成
/// Chat Completions 的 tool 消息 content（对齐 `OpenAiApi.ts` 的同名函数）。
///
/// 纯文本（字符串 / 只含 text 的数组）压平成字符串以兼容更多服务商；含图片时保留为
/// content parts 数组（`text` / `image_url`），使 Read 等工具返回的图片真正送达模型，
/// 而不是被替换成 `[image]` 占位符。
fn convert_tool_result_content(raw: &Value) -> Value {
    match raw {
        Value::String(text) => Value::String(text.clone()),
        Value::Array(parts) => {
            let mut out: Vec<Value> = Vec::new();
            for part in parts {
                match part {
                    Value::String(text) => out.push(json!({ "type": "text", "text": text })),
                    Value::Object(_) => {
                        let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                        if kind == "text" {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                out.push(json!({ "type": "text", "text": text }));
                                continue;
                            }
                        }
                        if kind == "image" {
                            if let Some(image) = to_image_part(part) {
                                out.push(image);
                            }
                            continue;
                        }
                        // `JSON.stringify(part ?? '')`：数字走 JS 口径
                        out.push(json!({
                            "type": "text",
                            "text": crate::util::js_json_stringify(part),
                        }));
                    }
                    // `JSON.stringify(null ?? '')` === '""'
                    Value::Null => out.push(json!({ "type": "text", "text": "\"\"" })),
                    other => out.push(json!({
                        "type": "text",
                        "text": crate::util::js_json_stringify(other),
                    })),
                }
            }
            // 纯文本时退化为字符串形式（与旧行为一致）
            let only_text = out
                .iter()
                .all(|part| part.get("type").and_then(Value::as_str) == Some("text"));
            if only_text {
                let joined = out
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                Value::String(joined)
            } else {
                Value::Array(out)
            }
        }
        // `JSON.stringify(raw ?? '')`
        Value::Null => Value::String("\"\"".to_string()),
        other => Value::String(crate::util::js_json_stringify(other)),
    }
}

/// 内部消息 → Chat Completions 消息（逐分支对齐 `OpenAiApi.convertMessagesToChatCompletions`）。
pub fn to_chat_messages(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str);
        let content = message.get("content");
        match role {
            Some("user") => {
                // 字符串 content 原样透传（含空串）
                if let Some(Value::String(text)) = content {
                    out.push(json!({ "role": "user", "content": text }));
                    continue;
                }
                let Some(Value::Array(blocks)) = content else {
                    continue;
                };
                let mut user_parts: Vec<Value> = Vec::new();
                for block in blocks {
                    if !block.is_object() {
                        continue;
                    }
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "tool_result" => {
                            let call_id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .or_else(|| {
                                    block
                                        .get("tool_call_id")
                                        .and_then(Value::as_str)
                                        .filter(|value| !value.is_empty())
                                })
                                .unwrap_or("");
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": call_id,
                                "content": convert_tool_result_content(
                                    block.get("content").unwrap_or(&Value::Null),
                                ),
                            }));
                        }
                        "text" | "input_text" => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                user_parts.push(json!({ "type": "text", "text": text }));
                            }
                        }
                        "image" => {
                            if let Some(image) = to_image_part(block) {
                                user_parts.push(image);
                            }
                        }
                        _ => {}
                    }
                }
                if !user_parts.is_empty() {
                    // 纯文本时退化为字符串形式，兼容更多服务商
                    let only_text = user_parts
                        .iter()
                        .all(|part| part.get("type").and_then(Value::as_str) == Some("text"));
                    if only_text {
                        let joined = user_parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n");
                        out.push(json!({ "role": "user", "content": joined }));
                    } else {
                        out.push(json!({ "role": "user", "content": Value::Array(user_parts) }));
                    }
                }
            }
            Some("assistant") => {
                if let Some(Value::String(text)) = content {
                    out.push(json!({ "role": "assistant", "content": text }));
                    continue;
                }
                let Some(Value::Array(blocks)) = content else {
                    continue;
                };
                let mut text_parts: Vec<String> = Vec::new();
                let mut tool_calls: Vec<Value> = Vec::new();
                for block in blocks {
                    if !block.is_object() {
                        continue;
                    }
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(value) = block.get("text").and_then(Value::as_str) {
                                text_parts.push(value.to_string());
                            }
                        }
                        // thinking block 不回传（多个 Chat Completions 服务商拒绝 reasoning_content）
                        "thinking" => {}
                        "tool_use" => {
                            // 逐字对齐 JS：`id: block.id || block.call_id`。
                            // `||` 返回第一个真值；两者都缺（`undefined`）时
                            // `JSON.stringify` 会把该键整个丢掉（不是空串）。
                            let id = block
                                .get("id")
                                .filter(|value| crate::history::js_truthy(Some(value)))
                                .or_else(|| block.get("call_id"));
                            // 与 JS `serializeToolArguments` 对齐：合法 JSON 字符串原样
                            // 保留（兼容 double-encode），非法 JSON 字符串降级为字符串
                            // 字面量，保证 arguments 一定是合法 JSON（否则严格校验的
                            // 服务商会 400，此后每轮请求都失败）。
                            let arguments =
                                crate::engine::serialize_tool_arguments(block.get("input"));
                            let mut call = Map::new();
                            if let Some(id) = id {
                                call.insert("id".to_string(), id.clone());
                            }
                            call.insert("type".to_string(), json!("function"));
                            let mut function = Map::new();
                            // `name: block.name`：键缺失（`undefined`）时同样被丢弃；
                            // `null` 等显式值原样保留。
                            if let Some(name) = block.get("name") {
                                function.insert("name".to_string(), name.clone());
                            }
                            function.insert("arguments".to_string(), json!(arguments));
                            call.insert("function".to_string(), Value::Object(function));
                            tool_calls.push(Value::Object(call));
                        }
                        _ => {}
                    }
                }
                if !tool_calls.is_empty() {
                    let content_value = if text_parts.is_empty() {
                        Value::Null
                    } else {
                        Value::String(text_parts.join(""))
                    };
                    out.push(json!({
                        "role": "assistant",
                        "content": content_value,
                        "tool_calls": Value::Array(tool_calls),
                    }));
                } else if !text_parts.is_empty() {
                    out.push(json!({ "role": "assistant", "content": text_parts.join("") }));
                }
            }
            // 其它 role（system / developer 等）原样透传；缺 role 的裸消息在 JS 里
            // `{ role: undefined, content }` 序列化后同样只剩 content（此处逐字复刻）。
            _ => {
                if let Some(Value::String(text)) = content {
                    match role {
                        Some(role) => out.push(json!({ "role": role, "content": text })),
                        None => out.push(json!({ "content": text })),
                    }
                }
            }
        }
    }
    out
}

/// 内部工具定义（Anthropic 风格）→ Chat Completions 工具
/// （逐分支对齐 `OpenAiApi.convertToolsToChatCompletionsFormat`）。
pub fn to_chat_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let object = tool.as_object()?;
            // 非 function 的工具在 Chat Completions 下不支持，直接丢弃
            if let Some(kind) = object.get("type").and_then(Value::as_str) {
                if kind != "function" {
                    return None;
                }
            }
            // 逐字对齐 JS 的 `||` 兜底：`name: t.name || 'unknown'`、
            // `description: t.description || ''`、`parameters: t.input_schema || {...}`。
            // 真值判定按 JS 口径（0 / "" / false / null 均为假值），真值原样透传
            // （包括非字符串，如数字 / 对象——`JSON.stringify` 会原样保留）。
            let name = object
                .get("name")
                .filter(|value| crate::history::js_truthy(Some(value)))
                .cloned()
                .unwrap_or_else(|| json!("unknown"));
            let description = object
                .get("description")
                .filter(|value| crate::history::js_truthy(Some(value)))
                .cloned()
                .unwrap_or_else(|| json!(""));
            let parameters = object
                .get("input_schema")
                .filter(|value| crate::history::js_truthy(Some(value)))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {}, "required": [] }));
            Some(json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": parameters,
                }
            }))
        })
        .collect()
}

/// OpenAI `finish_reason` → 内部 `stop_reason`（对齐 `OpenAiApi.mapFinishReason`）
fn map_finish_reason(reason: &str) -> String {
    match reason {
        "stop" => "end_turn",
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "content_filter" => "content_filter",
        other => other,
    }
    .to_string()
}

fn stream_openai(
    req: &LlmRequest,
    emit: &mut dyn FnMut(LlmEvent),
    retry_count: &mut u32,
    include_stream_usage: &mut bool,
) -> Result<(), StreamFailure> {
    let provider = req.provider;
    let mut body = Map::new();
    body.insert("model".to_string(), json!(provider.model));
    body.insert("stream".to_string(), json!(true));
    body.insert("max_tokens".to_string(), json!(provider.max_tokens));
    body.insert("temperature".to_string(), json!(1.0));
    body.insert("top_p".to_string(), json!(0.95));
    if *include_stream_usage {
        // 让服务商在流末尾补一帧 usage（OpenAI / 多数兼容网关支持）
        body.insert("stream_options".to_string(), json!({ "include_usage": true }));
    }
    // 思考开启时用 `reasoning_effort`
    if req.thinking_enabled {
        body.insert(
            "reasoning_effort".to_string(),
            json!(provider.thinking_effort),
        );
    }
    body.insert("messages".to_string(), Value::Array(to_chat_messages(req.messages)));
    if !req.system_prompt.is_empty() {
        let mut messages = vec![json!({ "role": "system", "content": req.system_prompt })];
        if let Some(Value::Array(rest)) = body.get("messages") {
            messages.extend(rest.iter().cloned());
        }
        body.insert("messages".to_string(), Value::Array(messages));
    }
    if !req.tools.is_empty() {
        body.insert("tools".to_string(), Value::Array(to_chat_tools(req.tools)));
    }

    let client = http_client().map_err(StreamFailure::Fatal)?;
    let build_request = |body: &Map<String, Value>| -> Result<reqwest::blocking::Request, reqwest::Error> {
        client
            .post(chat_completions_url(&provider.base_url))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", provider.api_key))
            // 部分网关（如 opencode.ai/zen/go）要求 x-opencode-session 才会路由请求
            .header("x-api-key", &provider.api_key)
            .header("x-opencode-session", req.session_id)
            .header("x-session-id", req.session_id)
            // JS `JSON.stringify` 口径（见 Anthropic 分支的同款说明）
            .body(crate::util::js_json_stringify(&Value::Object(body.clone())))
            .build()
    };

    let request = build_request(&body)
        .map_err(|err| StreamFailure::Fatal(format!("request build failed: {err}")))?;
    // 等待响应头期间也可取消 / 受首字节超时约束（见 send_cancellable）
    let (mut response, mut first_byte_deadline) =
        send_cancellable(client.clone(), request, req.cancel, req.first_byte_timeout_ms)?;
    // 服务商不认识 stream_options：去掉该字段重试一次
    // （对齐 `OpenAiApi`：占用一次重试预算、先等 `RETRY_DELAY_MS`，并在本次调用内持续省略该字段）
    if !response.status().is_success() && response.status().as_u16() == 400 {
        let status = response.status();
        let detail = error_body(response, req.cancel)?;
        if *include_stream_usage
            && detail.to_lowercase().contains("stream_options")
            && *retry_count < MAX_RETRIES
        {
            *include_stream_usage = false;
            *retry_count += 1;
            eprintln!(
                "[core] provider rejected \"stream_options\"; retrying without it ({}/{MAX_RETRIES}) after {RETRY_DELAY_MS}ms...",
                *retry_count
            );
            // 重试等待可中断：取消置位（含等待期间到达）时立刻以「用户中断」返回，
            // 由引擎按取消收尾，不再发起下一次请求，也不落空 assistant 消息。
            if sleep_ms_interruptible(RETRY_DELAY_MS, req.cancel) {
                return Err(StreamFailure::Fatal(LLM_ABORTED_MESSAGE.to_string()));
            }
            body.remove("stream_options");
            let request = build_request(&body)
                .map_err(|err| StreamFailure::Fatal(format!("request build failed: {err}")))?;
            // 每次尝试重新武装看门狗：首字节 deadline 从本次发送重新起算
            let sent = send_cancellable(
                client.clone(),
                request,
                req.cancel,
                req.first_byte_timeout_ms,
            )?;
            response = sent.0;
            first_byte_deadline = sent.1;
        } else {
            return Err(StreamFailure::Fatal(api_error_message(status, &detail)));
        }
    }
    if !response.status().is_success() {
        let status = response.status();
        let detail = error_body(response, req.cancel)?;
        let message = api_error_message(status, &detail);
        return Err(if is_retryable_status(status.as_u16()) {
            StreamFailure::Retryable(message)
        } else {
            StreamFailure::Fatal(message)
        });
    }

    let cancel = req.cancel;
    // 退化重复检测器：单次尝试内、单个流一个（对齐 `OpenAiApi` 的 textRepetition / thinkingRepetition）
    let mut text_repetition = RepetitionDetector::new();
    let mut thinking_repetition = RepetitionDetector::new();
    // 是否收到过任何内容 / 结束原因（用于「无 finish_reason」的收尾判定）
    let mut saw_content = false;
    let mut saw_stop_reason = false;
    // 当前打开的块：Chat Completions
    // 的 SSE 没有显式块边界，适配器按「角色切换」合成 block_start / block_stop。
    let mut open_kind: Option<BlockKind> = None;
    // 本次流调用的消息 ID（`streamMessageId`：
    // `msg_${Date.now()}_${random}`）。用于给缺少 `id` 的工具调用生成兜底 id。
    let stream_message_id = crate::util::unique_id("msg");
    // 工具调用按 `index` 归并：并行工具调用的 arguments 可能交错分片，
    // 必须按 index 累积，
    // 流结束后再按「首次出现顺序」补发，避免把后一个调用的参数拼进前一个。
    let mut tool_calls_by_index: Vec<(u64, String, String, String)> = Vec::new();
    read_sse(response, cancel, first_byte_deadline, req.first_byte_timeout_ms, req.idle_timeout_ms, &mut |payload| {
        let Ok(event) = serde_json::from_str::<Value>(&sanitize_json_surrogates(payload)) else {
            return Ok(false);
        };
        // `if (parsed.error)`：`null` / `false` / `0` / 空串 视为没有错误
        if let Some(error) = event
            .get("error")
            .filter(|value| crate::history::js_truthy(Some(value)))
        {
            return Err(StreamFailure::Fatal(format!(
                "Chat Completions failed: {}",
                stream_error_message(error)
            )));
        }
        if let Some(usage) = event.get("usage").filter(|value| !value.is_null()) {
            emit(LlmEvent::Usage(Usage {
                input_tokens: usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                output_tokens: usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_read_input_tokens: usage
                    .get("prompt_tokens_details")
                    .and_then(|details| details.get("cached_tokens"))
                    .and_then(Value::as_u64),
                cache_creation_input_tokens: None,
                reasoning_tokens: usage
                    .get("completion_tokens_details")
                    .and_then(|details| details.get("reasoning_tokens"))
                    .and_then(Value::as_u64),
            }));
        }
        let Some(choices) = event.get("choices").and_then(Value::as_array) else {
            // usage-only / 空 choices 帧也算进展（对齐 `parsedEvents.length > 0`）
            return Ok(true);
        };
        for choice in choices {
            let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
            // `reasoning_content` 只有非空时才优先，空串回退到 `reasoning`
            let reasoning = delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| delta.get("reasoning").and_then(Value::as_str))
                .unwrap_or("");
            if !reasoning.is_empty() {
                // 角色切换时先关上一个块、再开新块
                // （`emitBlockStop()` 只在确实有打开的块时才发 `block_stop`）。
                if open_kind != Some(BlockKind::Thinking) {
                    if open_kind.is_some() {
                        emit(LlmEvent::BlockStop);
                    }
                    emit(LlmEvent::BlockStart(BlockKind::Thinking));
                    open_kind = Some(BlockKind::Thinking);
                }
                check_repetition(&mut thinking_repetition, reasoning, "thinking")?;
                saw_content = true;
                emit(LlmEvent::ThinkingDelta(reasoning.to_string()));
            }
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                if !content.is_empty() {
                    if open_kind != Some(BlockKind::Text) {
                        if open_kind.is_some() {
                            emit(LlmEvent::BlockStop);
                        }
                        emit(LlmEvent::BlockStart(BlockKind::Text));
                        open_kind = Some(BlockKind::Text);
                    }
                    check_repetition(&mut text_repetition, content, "text")?;
                    saw_content = true;
                    emit(LlmEvent::TextDelta(content.to_string()));
                }
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    // `if (!tc) continue`：null / false / 0 / 空串
                    // 这类假值直接跳过（否则会产出一个空的 tool_use block）。
                    if !crate::history::js_truthy(Some(call)) {
                        continue;
                    }
                    saw_content = true;
                    // 缺省 index=0
                    let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let position = match tool_calls_by_index
                        .iter()
                        .position(|entry| entry.0 == index)
                    {
                        Some(position) => position,
                        None => {
                            // 新 index 首次出现时先关掉
                            // 当前块、再开一个 tool_use 块（多个并行工具调用之间
                            // 同样会成对出现 block_stop / block_start）。
                            if open_kind.is_some() {
                                emit(LlmEvent::BlockStop);
                            }
                            emit(LlmEvent::BlockStart(BlockKind::ToolUse));
                            open_kind = Some(BlockKind::ToolUse);
                            // id 在 block **创建时**定死
                            // （`id: tc.id || \`call_${streamMessageId}_${idx}\``）。
                            // 后续分片即使补上 id 也不会替换：
                            // block.id 此时已经是兜底 id（真值）。
                            let id = call
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| format!("call_{stream_message_id}_{index}"));
                            tool_calls_by_index.push((
                                index,
                                id,
                                String::new(),
                                String::new(),
                            ));
                            tool_calls_by_index.len() - 1
                        }
                    };
                    let entry = &mut tool_calls_by_index[position];
                    if entry.2.is_empty() {
                        if let Some(name) = call
                            .get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                        {
                            entry.2 = name.to_string();
                        }
                    }
                    if let Some(arguments) = call
                        .get("function")
                        .and_then(|function| function.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        entry.3.push_str(arguments);
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                if !reason.is_empty() {
                    saw_stop_reason = true;
                    emit(LlmEvent::StopReason(map_finish_reason(reason)));
                }
            }
        }
        // Chat Completions 的 SSE 没有统一 type：能解析出 JSON 的数据帧都算进展
        // （对齐 `OpenAiApi` 的 `parsedEvents.length > 0 → watchdog.noteProgress()`）。
        Ok(true)
    })?;

    // 收尾：关闭仍打开的块。
    // 块边界只影响引擎的「当前块类型」与 block_stop 时的 `streamEnd`
    // （tool_use 块不发 streamEnd），与随后补发的工具事件本身无关。
    if open_kind.is_some() {
        emit(LlmEvent::BlockStop);
    }

    // 流结束后按「首次出现顺序」补发工具调用
    for (_index, id, name, arguments) in tool_calls_by_index {
        // id 已在创建 block 时定死（含兜底 id），此处原样使用。
        // Chat Completions 的 tool_calls 没有「初始 input」概念，初始 input 固定 `input: {}`。
        emit(LlmEvent::ToolUseStart {
            id,
            name,
            input: json!({}),
        });
        if !arguments.is_empty() {
            emit(LlmEvent::ToolUseInputDelta(arguments));
        }
    }

    // 截断检测（对齐 `OpenAiApi`）：流结束但既没有 finish_reason 也没有任何内容
    // → 视为服务端异常并重试；已有内容则按 `end_turn` 接受。
    // 被用户取消时不补结束原因（对齐 `checkAborted` 直接抛 AbortError 的路径）。
    if !saw_stop_reason && !req.cancel.load(Ordering::Relaxed) {
        if saw_content {
            emit(LlmEvent::StopReason("end_turn".to_string()));
        } else if *retry_count < MAX_RETRIES {
            return Err(StreamFailure::Retryable(
                "Stream ended without finish_reason and no content".to_string(),
            ));
        } else {
            emit(LlmEvent::StopReason("end_turn".to_string()));
        }
    }
    // 收尾时恒发一次
    // `message_delta`（usage 缺失时补零，见上游的 `if (!usage)` 兜底）。
    emit(LlmEvent::MessageDelta);
    Ok(())
}


// ==================== 退化重复检测（对齐 repetitionDetector.ts） ====================

/// 尾窗长度：可检出的最大重复单元长度 = windowSize / minRepeats
const DEFAULT_REPETITION_WINDOW: usize = 16_384;
/// 连续重复次数阈值
const DEFAULT_REPETITION_MIN_REPEATS: usize = 50;
/// 重复片段的最小总长度（字符），与 minRepeats 取更严格者
const DEFAULT_REPETITION_MIN_SPAN: usize = 200;
/// 累积长度低于该值不做检测（避免短输出误报）
const DEFAULT_REPETITION_MIN_CHECK_LENGTH: usize = 5_000;
/// 两次检测之间至少要新增的字符数（节流，避免每 chunk 都跑 O(W)）
const DEFAULT_REPETITION_CHECK_INTERVAL: usize = 128;
/// 重复检测触发的重试次数上限（独立于网络错误与超时看门狗）
const DEFAULT_MAX_REPETITION_RETRIES: u32 = 1;

/// 命中退化重复的详情
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepetitionHit {
    pub unit_length: usize,
    pub repeat_count: usize,
    pub span_length: usize,
    pub unit_preview: String,
    pub total_length: usize,
}

/// 单个流（正文 / 思考）的退化重复检测器（算法见 `repetitionDetector.ts`：
/// 尾部窗口 + 反转串 Z 函数，判定 `z[p] >= (required - 1) * p`）。
pub struct RepetitionDetector {
    window_size: usize,
    min_repeats: usize,
    min_span: usize,
    min_check_length: usize,
    check_interval: usize,
    /// 尾部缓冲（UTF-16 code unit，长度介于 [windowSize, 2*windowSize]）
    buffer: Vec<u16>,
    /// 累积总长度（不受窗口裁剪影响）
    total_length: usize,
    last_check_length: usize,
}

impl Default for RepetitionDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl RepetitionDetector {
    pub fn new() -> Self {
        Self {
            window_size: DEFAULT_REPETITION_WINDOW,
            min_repeats: DEFAULT_REPETITION_MIN_REPEATS,
            min_span: DEFAULT_REPETITION_MIN_SPAN,
            min_check_length: DEFAULT_REPETITION_MIN_CHECK_LENGTH,
            check_interval: DEFAULT_REPETITION_CHECK_INTERVAL,
            buffer: Vec::new(),
            total_length: 0,
            last_check_length: 0,
        }
    }

    /// 追加一段增量文本；命中时返回重复详情。
    pub fn append(&mut self, delta: &str) -> Option<RepetitionHit> {
        if delta.is_empty() {
            return None;
        }
        let units: Vec<u16> = delta.encode_utf16().collect();
        self.buffer.extend_from_slice(&units);
        self.total_length += units.len();

        // 尾窗裁剪：留 2 倍余量再裁，避免每 chunk 都做一次 O(W) 复制
        if self.buffer.len() > self.window_size * 2 {
            let start = self.buffer.len() - self.window_size;
            self.buffer.drain(0..start);
        }

        // 短输出不检测；检测本身按新增字符数节流
        if self.total_length < self.min_check_length {
            return None;
        }
        if self.total_length - self.last_check_length < self.check_interval {
            return None;
        }
        self.last_check_length = self.total_length;
        self.detect()
    }

    fn detect(&self) -> Option<RepetitionHit> {
        let tail = if self.buffer.len() > self.window_size {
            &self.buffer[self.buffer.len() - self.window_size..]
        } else {
            &self.buffer[..]
        };
        let n = tail.len();
        if n < self.min_repeats {
            return None;
        }
        let z = compute_z_on_reversed(tail);
        // 至少要能放下 minRepeats 个块
        let max_unit = n / self.min_repeats;
        for p in 1..=max_unit {
            // 需要的重复次数：minRepeats 与「重复片段至少 minSpan 字符」取更严格者
            let required = self.min_repeats.max(self.min_span.div_ceil(p));
            let need = (required - 1) * p;
            if need + p > n {
                continue;
            }
            if z[p] >= need {
                let repeat_count = z[p] / p + 1;
                return Some(RepetitionHit {
                    unit_length: p,
                    repeat_count,
                    span_length: p * repeat_count,
                    unit_preview: String::from_utf16_lossy(&tail[n - p..]),
                    total_length: self.total_length,
                });
            }
        }
        None
    }
}

/// 计算「反转串 R」的 Z 数组，其中 R[i] === tail[n - 1 - i]（对齐
/// `computeZOnReversed`，摊还 O(n)）。
fn compute_z_on_reversed(tail: &[u16]) -> Vec<usize> {
    let n = tail.len();
    let mut z = vec![0usize; n];
    if n == 0 {
        return z;
    }
    z[0] = n;
    let (mut l, mut r) = (0usize, 0usize);
    for i in 1..n {
        let mut k = 0usize;
        if i < r {
            let reuse = z[i - l];
            k = std::cmp::min(r - i, reuse);
        }
        while i + k < n && tail[n - 1 - k] == tail[n - 1 - i - k] {
            k += 1;
        }
        z[i] = k;
        if i + k > r {
            l = i;
            r = i + k;
        }
    }
    z
}

/// 追加增量并校验；命中时返回 `StreamFailure::Repetition`（对齐 `checkRepetition` 的抛错）。
pub(crate) fn check_repetition(
    detector: &mut RepetitionDetector,
    delta: &str,
    stream: &str,
) -> Result<(), StreamFailure> {
    if let Some(hit) = detector.append(delta) {
        let label = if stream == "thinking" { "思考" } else { "正文" };
        return Err(StreamFailure::Repetition(format!(
            "检测到模型循环输出：{label}中长度 {} 的片段连续重复 {} 次（共 {} 字符），判定为服务端异常",
            hit.unit_length, hit.repeat_count, hit.span_length
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "llm_tests.rs"]
mod tests;
