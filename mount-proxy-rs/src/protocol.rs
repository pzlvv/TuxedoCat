//! Core ↔ 常驻代理的私有帧协议（specs/051 plan 的「代执行协议」节）。
//!
//! 长度前缀 + JSON：`<8 位十六进制长度>\n<JSON 载荷>`。与 Core 帧通道（换行分隔的
//! JSON）分开实现，因为这里是**二进制安全**的（`writeFile` 要携带任意字节）。
//!
//! **不引 serde**（本 crate 零依赖）：请求 / 应答的 JSON 由本模块手写解析与拼装。协议的
//! 形状极窄——一层对象、值为字符串 / 数字 / 布尔——手写解析足够，且把「解析什么」变成
//! 显式代码而不是 derive 出来的黑盒。
//!
//! 运行期协议版本（`IPC_PROTOCOL_VERSION`）与安装握手版本（`build.rs` 的
//! `TC_PROTOCOL_VERSION`）**分开**：前者是帧语义兼容性，后者是「装的这份代理能不能被
//! 这个 Core 用」。两者任一不匹配都不启用能力。

use std::io::{Read, Write};

/// 运行期 IPC 协议版本；改帧语义（新增 / 改名字段）必须递增。
///
/// 消费方是 Linux 侧的 `serve`；非 Linux 目标只编译本模块的测试，读它的是单测。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const IPC_PROTOCOL_VERSION: u32 = 1;

/// 单帧长度上限：8 MiB。超过即认为流已损坏（防止恶意长度触发巨量分配）。
const MAX_FRAME: usize = 8 * 1024 * 1024;

/// 一个请求 / 应答：`{ "op": "...", "_v": 1, ...其余字段 }`
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub op: String,
    pub fields: Vec<(String, Value)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Num(i64),
    Bool(bool),
    /// 基16 编码的字节串（阶段二 `readFile` / `writeFile` / `gitShow` 的载荷）
    ///
    /// 阶段一没有任何请求产出这个变体（挂载类请求全走字符串路径），因此
    /// `allow(dead_code)`：它与 `bytes_field` / `hex_decode` 一起是**已定型的协议面**，
    /// 阶段二直接接上；现在删掉会让阶段二重新定义一遍编码口径。
    #[allow(dead_code)]
    Bytes(Vec<u8>),
    /// JSON 数组（`spawn.argv` / `spawn.env` 用）。
    ///
    /// 阶段一只在**解析**时需要它：未知 op 的请求也可能带数组载荷，解析器不能因此
    /// 整帧失败（实测踩到：`spawn` 帧带 `argv: [...]`，解析器报「值既不是字符串也不是
    /// 数字」并让整个进程退出，连前一条合法请求的应答都没送到）。
    #[allow(dead_code)]
    Array(Vec<Value>),
    /// JSON 对象（`listDir` 的目录项用）。
    ///
    /// 嵌套对象只在**应答**里出现，但解析器同样要能吃下它——Core 侧的读线程会把
    /// 请求原样记进日志，一条带对象的帧不能因此整帧失败。
    Object(Vec<(String, Value)>),
    Null,
}

impl Frame {
    pub fn new(op: &str) -> Self {
        Self {
            op: op.to_string(),
            fields: Vec::new(),
        }
    }

    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.fields.push((key.to_string(), value));
        self
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub fn str_field(&self, key: &str) -> Result<&str, String> {
        match self.get(key) {
            Some(Value::Str(text)) => Ok(text),
            Some(_) => Err(format!("字段 {key} 不是字符串")),
            None => Err(format!("缺字段 {key}")),
        }
    }

    /// 数组字段（`spawn.argv` / `spawn.env`）
    pub fn array_field(&self, key: &str) -> Result<&[Value], String> {
        match self.get(key) {
            Some(Value::Array(items)) => Ok(items),
            Some(_) => Err(format!("字段 {key} 不是数组")),
            None => Err(format!("缺字段 {key}")),
        }
    }

    /// 字符串数组字段（`spawn.argv` / `spawn.env` 的元素必须是字符串，否则直接拒绝）
    ///
    /// 不做 `to_string()` 兜底：`argv` 里出现数字 / 布尔说明 Core 侧编码错了，
    /// 静默转成字符串会让工具收到一个谁也不认识的参数。
    pub fn string_array_field(&self, key: &str) -> Result<Vec<String>, String> {
        self.array_field(key)?
            .iter()
            .map(|item| match item {
                Value::Str(text) => Ok(text.clone()),
                other => Err(format!("字段 {key} 含非字符串元素：{other:?}")),
            })
            .collect()
    }

    /// 带上请求 id（`id` 关联，见本模块头注释的「并发」）
    ///
    /// 请求与应答都带同一个 `id`：Core 侧读线程据此把应答分派到等待中的请求，代理侧
    /// 才能让多条请求同时在途。没有它，一条长 Bash 会把同会话的 Read 卡在队头。
    pub fn with_id(mut self, id: u64) -> Self {
        self.fields.push(("id".to_string(), Value::Num(id as i64)));
        self
    }

    /// 请求 id；缺省（老协议帧 / 单测里的裸帧）回 0。
    ///
    /// 用 `0` 而不是 `Err`：挂载类请求在阶段一就不带 id，回错误会让既有调用点全部
    /// 要处理一个不可能发生的情形。`0` 是 Core 侧永远不会分配的保留值。
    pub fn id(&self) -> u64 {
        match self.get("id") {
            Some(Value::Num(n)) if *n > 0 => *n as u64,
            _ => 0,
        }
    }

    /// 数字字段（阶段一的 mountOverlay 请求不带数字；`version` 应答与单测用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn num_field(&self, key: &str) -> Result<i64, String> {
        match self.get(key) {
            Some(Value::Num(n)) => Ok(*n),
            Some(_) => Err(format!("字段 {key} 不是数字")),
            None => Err(format!("缺字段 {key}")),
        }
    }

    /// 字节串字段（阶段二 `readFile` / `writeFile` / `gitShow` 用）
    ///
    /// 线上形态是十六进制字符串（`Value::Bytes::to_json` 走 `hex_encode`），所以解码
    /// 回来的只会是 `Value::Str`——这里必须按 hex 还原；直接匹配 `Value::Bytes` 永远
    /// 不成立（曾经的实现就是这样，Windows 上整树被 cfg 摘掉报「0 个测试 ok」掩盖了）。
    #[allow(dead_code)]
    pub fn bytes_field(&self, key: &str) -> Result<Vec<u8>, String> {
        match self.get(key) {
            Some(Value::Bytes(bytes)) => Ok(bytes.clone()),
            Some(Value::Str(text)) => {
                hex_decode(text).map_err(|err| format!("字段 {key} 不是字节串：{err}"))
            }
            Some(_) => Err(format!("字段 {key} 不是字节串")),
            None => Err(format!("缺字段 {key}")),
        }
    }

    /// 编码成一帧（长度前缀 + JSON）
    pub fn encode(&self) -> Vec<u8> {
        let mut json = String::from("{");
        json.push_str(&json_pair("op", &json_string(&self.op)));
        for (key, value) in &self.fields {
            json.push(',');
            json.push_str(&json_pair(key, &value.to_json()));
        }
        json.push('}');
        let mut out = format!("{:08x}\n", json.len()).into_bytes();
        out.extend_from_slice(json.as_bytes());
        out
    }

    /// 从流里读一帧；`Ok(None)` = 干净 EOF（对端正常关闭）
    pub fn read_from<R: Read>(stream: &mut R) -> Result<Option<Self>, String> {
        let mut header = [0u8; 9];
        match stream.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(format!("读帧头失败（{error}）")),
        }
        if header[8] != b'\n' {
            return Err("帧头缺换行终止符".to_string());
        }
        let len_text =
            std::str::from_utf8(&header[..8]).map_err(|_| "帧头不是 ASCII".to_string())?;
        let len = usize::from_str_radix(len_text.trim(), 16)
            .map_err(|_| "帧头不是十六进制".to_string())?;
        if len > MAX_FRAME {
            return Err(format!("帧长 {len} 超过上限 {MAX_FRAME}"));
        }
        let mut payload = vec![0u8; len];
        stream
            .read_exact(&mut payload)
            .map_err(|error| format!("读帧载荷失败（{error}）"))?;
        let text = String::from_utf8(payload).map_err(|_| "帧载荷不是 UTF-8".to_string())?;
        parse_frame(&text).map(Some)
    }

    /// 写一帧（非 Linux 目标只跑本模块测试，没有调用方）
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn write_to<W: Write>(&self, stream: &mut W) -> Result<(), String> {
        stream
            .write_all(&self.encode())
            .map_err(|error| format!("写帧失败（{error}）"))?;
        stream
            .flush()
            .map_err(|error| format!("刷新帧失败（{error}）"))
    }
}

impl Value {
    fn to_json(&self) -> String {
        match self {
            Value::Str(text) => json_string(text),
            Value::Num(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            // 字节串编码成 JSON 字符串（JS 侧同样按占位符处理语义）
            Value::Bytes(bytes) => json_string(&hex_encode(bytes)),
            Value::Array(items) => {
                let mut out = String::from("[");
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&item.to_json());
                }
                out.push(']');
                out
            }
            Value::Object(fields) => {
                let mut out = String::from("{");
                for (index, (key, value)) in fields.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&json_pair(key, &value.to_json()));
                }
                out.push('}');
                out
            }
            Value::Null => "null".to_string(),
        }
    }
}

fn json_pair(key: &str, value: &str) -> String {
    format!("{}:{}", json_string(key), value)
}

/// JSON 字符串转义（只处理协议里会出现的字符）
fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// 十六进制编码（字节串的 JSON 载体）
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 十六进制解码（阶段二的字节串载荷用）
#[allow(dead_code)]
pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("十六进制串长度为奇数".to_string());
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for index in (0..text.len()).step_by(2) {
        let byte = u8::from_str_radix(&text[index..index + 2], 16)
            .map_err(|_| "十六进制串含非法字符".to_string())?;
        out.push(byte);
    }
    Ok(out)
}

/// 解析一个扁平 JSON 对象（值只支持字符串 / 数字 / 布尔 / null）
fn parse_frame(text: &str) -> Result<Frame, String> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        at: 0,
    };
    parser.skip_ws();
    parser.expect(b'{')?;
    let mut op = String::new();
    let mut fields: Vec<(String, Value)> = Vec::new();
    parser.skip_ws();
    // 空对象 `{}`：没有 op 字段，直接拒绝（不再前进游标，尾部检查照样报错也无所谓，
    // 这条分支返回的错误更具体）
    if parser.peek() == Some(b'}') {
        return Err("帧没有 op 字段".to_string());
    }
    loop {
        parser.skip_ws();
        let key = parser.parse_string()?;
        parser.skip_ws();
        parser.expect(b':')?;
        parser.skip_ws();
        let value = parser.parse_value()?;
        if key == "op" {
            match value {
                Value::Str(text) => op = text,
                _ => return Err("op 不是字符串".to_string()),
            }
        } else {
            fields.push((key, value));
        }
        parser.skip_ws();
        match parser.peek() {
            Some(b',') => {
                parser.at += 1;
            }
            Some(b'}') => {
                parser.at += 1;
                break;
            }
            _ => return Err("JSON 对象未闭合".to_string()),
        }
    }
    parser.skip_ws();
    if parser.at != parser.bytes.len() {
        return Err("JSON 尾部有多余内容".to_string());
    }
    if op.is_empty() {
        return Err("帧没有 op 字段".to_string());
    }
    Ok(Frame { op, fields })
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(
            self.peek(),
            Some(b' ') | Some(b'\n') | Some(b'\r') | Some(b'\t')
        ) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(format!(
                "期望 `{}`，实际 `{}`",
                byte as char,
                self.peek().unwrap_or(0) as char
            ))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err("字符串未闭合".to_string());
            };
            self.at += 1;
            match byte {
                b'"' => return Ok(out),
                b'\\' => {
                    let Some(escape) = self.peek() else {
                        return Err("转义序列未结束".to_string());
                    };
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'u' => {
                            let unit = self.parse_hex4()?;
                            // 代理项成对时合并成一个标量（历史里的孤立转义按替换符处理）
                            if (0xd800..0xdc00).contains(&unit) {
                                if self.bytes.get(self.at..self.at + 2) == Some(b"\\u") {
                                    self.at += 2;
                                    let low = self.parse_hex4()?;
                                    if (0xdc00..0xe000).contains(&low) {
                                        let scalar = 0x10000
                                            + (((unit - 0xd800) as u32) << 10)
                                            + (low - 0xdc00) as u32;
                                        out.push(char::from_u32(scalar).unwrap_or('\u{fffd}'));
                                        continue;
                                    }
                                }
                                out.push('\u{fffd}');
                            } else if (0xdc00..0xe000).contains(&unit) {
                                out.push('\u{fffd}');
                            } else {
                                out.push(char::from_u32(unit as u32).unwrap_or('\u{fffd}'));
                            }
                        }
                        other => return Err(format!("未知转义 \\{}", other as char)),
                    }
                }
                byte if byte < 0x20 => return Err("字符串含裸控制字符".to_string()),
                byte => {
                    // UTF-8 多字节：把这一字节连同续字节一起取出
                    let len = utf8_len(byte);
                    let start = self.at - 1;
                    if start + len > self.bytes.len() {
                        return Err("UTF-8 序列被截断".to_string());
                    }
                    let slice = &self.bytes[start..start + len];
                    self.at = start + len;
                    let text =
                        std::str::from_utf8(slice).map_err(|_| "字符串不是 UTF-8".to_string())?;
                    out.push_str(text);
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, String> {
        if self.at + 4 > self.bytes.len() {
            return Err("\\u 转义被截断".to_string());
        }
        let text = std::str::from_utf8(&self.bytes[self.at..self.at + 4])
            .map_err(|_| "\\u 转义不是 ASCII".to_string())?;
        self.at += 4;
        u16::from_str_radix(text, 16).map_err(|_| "\\u 转义不是十六进制".to_string())
    }

    fn parse_value(&mut self) -> Result<Value, String> {
        match self.peek() {
            Some(b'"') => Ok(Value::Str(self.parse_string()?)),
            Some(b't') => {
                self.literal("true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.literal("false")?;
                Ok(Value::Bool(false))
            }
            Some(b'n') => {
                self.literal("null")?;
                Ok(Value::Null)
            }
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            // 数组与嵌套对象：阶段一不消费它们，但**必须能解析**——未知 op 的请求
            // 也可能带任意形状的载荷，解析失败会让整条连接退出（实测症状：
            // `spawn` 帧的 argv 让进程以「值既不是字符串也不是数字」退出，前一条请求
            // 的应答都来不及发）
            Some(b'[') => self.parse_array(),
            Some(b'{') => {
                // 嵌套对象按对象解析（应答里的 `listDir` 目录项就是对象）。旧实现
                // 「解析后丢弃」在本 crate 只做请求解析时成立，现在应答也要原样序列化，
                // 丢弃会让目录项变成一堆 `null`。
                self.parse_object()
            }
            _ => Err(format!(
                "值既不是字符串、数字、布尔、null、数组也不是对象（首字符 {}）",
                self.peek().map(|b| b as char).unwrap_or('?')
            )),
        }
    }

    /// 解析数组（保留元素，阶段二会用到；阶段一只为不失败）
    fn parse_array(&mut self) -> Result<Value, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.at += 1;
                }
                Some(b']') => {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err("JSON 数组未闭合".to_string()),
            }
        }
    }

    /// 解析对象并**保留**内容（`listDir` 的目录项要原样回给 Core）
    fn parse_object(&mut self) -> Result<Value, String> {
        self.expect(b'{')?;
        let mut fields: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Value::Object(fields));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            self.skip_ws();
            let value = self.parse_value()?;
            fields.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.at += 1;
                }
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Value::Object(fields));
                }
                _ => return Err("JSON 对象未闭合".to_string()),
            }
        }
    }

    fn literal(&mut self, text: &str) -> Result<(), String> {
        if self.bytes.get(self.at..self.at + text.len()) == Some(text.as_bytes()) {
            self.at += text.len();
            Ok(())
        } else {
            Err(format!("期望字面量 {text}"))
        }
    }

    fn parse_number(&mut self) -> Result<Value, String> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        // 小数 / 指数：协议里不用，出现即拒绝（不做静默截断）
        if matches!(self.peek(), Some(b'.') | Some(b'e') | Some(b'E')) {
            return Err("协议不支持浮点数".to_string());
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at])
            .map_err(|_| "数字不是 ASCII".to_string())?;
        text.parse::<i64>()
            .map(Value::Num)
            .map_err(|_| format!("数字无法解析：{text}"))
    }
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_roundtrips_and_defaults_to_zero() {
        let frame = Frame::new("readFile")
            .with_id(7)
            .with("path", Value::Str("/a".into()));
        let mut cursor = std::io::Cursor::new(frame.encode());
        let decoded = Frame::read_from(&mut cursor).unwrap().unwrap();
        assert_eq!(decoded.id(), 7);
        // 不带 id 的帧（阶段一的挂载请求）回保留值 0，不报错
        assert_eq!(Frame::new("ping").id(), 0);
    }

    #[test]
    fn roundtrip_str_and_num() {
        let frame = Frame::new("mountOverlay")
            .with("lower", Value::Str("/tmp/lower".into()))
            .with("sessionId", Value::Num(42));
        let encoded = frame.encode();
        let mut cursor = std::io::Cursor::new(encoded);
        let decoded = Frame::read_from(&mut cursor).unwrap().unwrap();
        assert_eq!(decoded.op, "mountOverlay");
        assert_eq!(decoded.str_field("lower").unwrap(), "/tmp/lower");
        assert_eq!(decoded.num_field("sessionId").unwrap(), 42);
    }

    #[test]
    fn roundtrip_bytes_and_escapes() {
        let frame = Frame::new("writeFile")
            .with("path", Value::Str("/tmp/a\"b\\c\n".into()))
            .with("bytes", Value::Bytes(vec![0, 1, 0xfe, 0xff]));
        let mut cursor = std::io::Cursor::new(frame.encode());
        let decoded = Frame::read_from(&mut cursor).unwrap().unwrap();
        assert_eq!(decoded.str_field("path").unwrap(), "/tmp/a\"b\\c\n");
        assert_eq!(
            decoded.bytes_field("bytes").unwrap(),
            vec![0, 1, 0xfe, 0xff]
        );
    }

    #[test]
    fn rejects_wrong_header_and_bad_lengths() {
        // 缺换行
        let mut bad = std::io::Cursor::new(b"00000002{}".to_vec());
        assert!(Frame::read_from(&mut bad).is_err());
        // 长度与载荷不符
        let mut bad = std::io::Cursor::new(b"000000ff{}".to_vec());
        assert!(Frame::read_from(&mut bad).is_err());
        // 非十六进制长度
        let mut bad = std::io::Cursor::new(b"zzzzzzzz\n{}".to_vec());
        assert!(Frame::read_from(&mut bad).is_err());
    }

    #[test]
    fn clean_eof_is_none() {
        let mut empty = std::io::Cursor::new(Vec::new());
        assert!(Frame::read_from(&mut empty).unwrap().is_none());
    }

    #[test]
    fn rejects_frame_without_op() {
        let text = r#"{"lower":"/x"}"#;
        assert!(parse_frame(text).is_err());
    }

    #[test]
    fn rejects_trailing_content() {
        let text = r#"{"op":"ok"} extra"#;
        assert!(parse_frame(text).is_err());
    }

    #[test]
    fn hex_roundtrip() {
        assert_eq!(
            hex_decode(&hex_encode(&[0, 15, 255])).unwrap(),
            vec![0, 15, 255]
        );
        assert!(hex_decode("abc").is_err());
        assert!(hex_decode("zz").is_err());
    }

    #[test]
    fn rejects_oversized_frame() {
        let mut bad = std::io::Cursor::new(b"ffffffff\n{}".to_vec());
        let error = Frame::read_from(&mut bad).unwrap_err();
        assert!(error.contains("超过上限"), "{error}");
    }
}
