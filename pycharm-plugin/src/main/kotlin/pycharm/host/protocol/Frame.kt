package pycharm.host.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.io.Writer

/**
 * 帧协议 v2（对齐 src/host/standalone/protocol.ts 与 core-rs/src/frame.rs）：
 * UTF-8、换行分隔 JSON，一行一帧；信封 kind 区分方向。
 *
 * 载荷一律 [JsonObject] 透传不建模（同 tui-rs/src/protocol.rs 手法）：
 * 宿主只读 kind 与个别字段，其余原样转发。
 */
const val CORE_PROTOCOL_VERSION = 2

/** UI→core 帧（kind: hello / response / uiEvent / request / shutdown） */
object FrameKinds {
    const val HELLO = "hello"
    const val RESPONSE = "response"
    const val UI_EVENT = "uiEvent"
    const val REQUEST = "request"
    const val SHUTDOWN = "shutdown"
    // core→UI
    const val READY = "ready"
    const val EVENT = "event"
}

private val json = Json {
    // 与 TS JSON.stringify 对齐：非 ASCII 原样输出 UTF-8（core 侧按 UTF-8 解）
    prettyPrint = false
    encodeDefaults = false
}

/**
 * 编码一帧为单行 JSON（不含换行）。
 *
 * 孤立代理项兜底（对齐 stringifyJsonSafe）：kotlinx 序列化遇到无配对代理项会产
 * `\uDxxx` 转义，core 的 serde 拒收整帧——encode 前扫描字符串值并替换为 U+DE00，
 * 与 TS 侧同一兜底值。
 */
fun encodeFrame(frame: JsonObject): String = json.encodeToString(JsonElement.serializer(), sanitizeSurrogates(frame))

/** 解析一行；坏行返回 null（调用方跳过该行，不中断流） */
fun decodeFrame(line: String): JsonObject? = try {
    Json.parseToJsonElement(line) as? JsonObject
} catch (_: Exception) {
    null
}

private fun sanitizeSurrogates(element: JsonElement): JsonElement = when (element) {
    is JsonPrimitive -> if (element.isString) {
        JsonPrimitive(element.content.replace(Regex("[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]"), "\uDE00"))
    } else element
    is JsonObject -> JsonObject(element.mapValues { (_, v) -> sanitizeSurrogates(v) })
    else -> element
}

fun helloFrame(): JsonObject = buildJsonObject { put("kind", FrameKinds.HELLO); put("protocol", CORE_PROTOCOL_VERSION) }

fun shutdownFrame(): JsonObject = buildJsonObject { put("kind", FrameKinds.SHUTDOWN) }

/** UI→core：UiEvent 帧（字段名是 `event`，对齐 protocol.ts / frame.rs 的 UiEvent { event }） */
fun uiEventFrame(event: JsonObject): JsonObject = buildJsonObject {
    put("kind", FrameKinds.UI_EVENT)
    put("event", event)
}

/** UI→core：UiRequest 帧（自增 id 由调用方分配） */
fun uiRequestFrame(id: Long, request: JsonObject): JsonObject = buildJsonObject {
    put("kind", FrameKinds.REQUEST)
    put("id", id)
    put("request", request)
}

/** UI→core：CoreRequest 应答帧 */
fun coreResponseFrame(id: Long, ok: Boolean, result: JsonElement? = null, error: String? = null): JsonObject =
    buildJsonObject {
        put("kind", FrameKinds.RESPONSE)
        put("id", id)
        put("ok", ok)
        if (ok) result?.let { put("result", it) } else put("error", error ?: "unknown error")
    }

/**
 * 增量帧解码（对齐 protocol.ts 的 FrameDecoder）：按行切、空行跳过、坏行只报该行。
 */
class FrameDecoder {
    private val buffer = StringBuilder()

    /** 追加一段原始文本，返回完整解析出的帧序列 */
    fun push(text: String): List<JsonObject> {
        buffer.append(text)
        val frames = mutableListOf<JsonObject>()
        var newline = buffer.indexOf('\n')
        while (newline >= 0) {
            val line = buffer.substring(0, newline)
            buffer.delete(0, newline + 1)
            if (line.isNotBlank()) {
                decodeFrame(line)?.let(frames::add)
            }
            newline = buffer.indexOf('\n')
        }
        return frames
    }
}

/** 写侧：帧 + '\n'，写失败抛 IO 异常由进程层处理 */
fun Writer.writeFrame(frame: JsonObject) {
    write(encodeFrame(frame))
    write("\n")
    flush()
}

/** 读侧便捷：BufferedReader 逐行解码，坏行跳过 */
fun BufferedReader.readFrame(): JsonObject? {
    while (true) {
        val line = readLine() ?: return null
        if (line.isBlank()) continue
        return decodeFrame(line)
    }
}
