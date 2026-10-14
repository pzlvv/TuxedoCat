//! 帧协议（见 docs/core/standalone-core.md 第 6 节）。
//!
//! 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧。
//! 帧内换行以 JSON 转义表达，帧边界只由 `\n` 决定。
//!
//! 载荷字段名与 `src/core/AssistantEventBus.ts` 的类型逐项一致（camelCase 原样）。
//! 事件载荷暂以 `serde_json::Value` 透传，按里程碑逐步替换为强类型。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 协议版本；握手时由 Core 校验。
///
/// 2：新增 UI → core 的请求方向（`UiToCoreFrame::Request` /
/// `CoreToUiFrame::Response`），用于宿主向 Core 索取「core 的事实」
/// （对话列表 / 界面语言 / 配置目录，见 `docs/core/standalone-core-boundaries.md` 第 2 节）。
pub const CORE_PROTOCOL_VERSION: u32 = 2;

/// UI → Core 的帧。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiToCoreFrame {
    /// 握手请求
    Hello { protocol: u32 },
    /// `CoreRequest` 的应答
    Response {
        id: u64,
        ok: bool,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        error: Option<String>,
    },
    /// 单向事件
    UiEvent { event: Value },
    /// UI → core 的请求；Core 以 `CoreToUiFrame::Response` 回同 id
    Request { id: u64, request: Value },
    /// 优雅关闭
    Shutdown,
}

/// Core → UI 的帧。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CoreToUiFrame {
    /// 握手通过
    Ready,
    /// 单向事件
    Event { event: Value },
    /// 请求-响应；M2 起由权限确认与用户问答发出
    #[allow(dead_code)]
    Request { id: u64, request: Value },
    /// 应答：`CoreRequest` 的响应，以及 UI → core 请求的响应（两个方向共用）
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl CoreToUiFrame {
    /// 成功应答
    pub fn response(id: u64, result: Value) -> Self {
        CoreToUiFrame::Response { id, ok: true, result: Some(result), error: None }
    }

    /// 失败应答
    pub fn error_response(id: u64, error: impl Into<String>) -> Self {
        CoreToUiFrame::Response { id, ok: false, result: None, error: Some(error.into()) }
    }
}

impl CoreToUiFrame {
    /// 编码为一帧（含结尾换行）。
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        let mut line = serde_json::to_string(self)?;
        line.push('\n');
        Ok(line)
    }
}

#[cfg(test)]
#[path = "frame_tests.rs"]
mod tests;
