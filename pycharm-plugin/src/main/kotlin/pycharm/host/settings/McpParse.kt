package pycharm.host.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Files
import java.nio.file.Path

/**
 * mcp.json → 服务器定义（移植 src/shared/mcp/parse.ts 的 parseMcpServerDefinitions，
 * 同 tui-rs/src/settings.rs 先例）：兼容 `{mcp:{…}}` / `{mcpServers:{…}}` / 直接服务器表；
 * command 兼容 string / string[]；url 兼容 url/endpoint/serverUrl；type 缺省按
 * 「url 非空且无 command → remote」推断；解析失败一律空列表不抛错。
 */
fun parseMcpServerDefinitions(raw: JsonObject?): List<JsonObject> {
    if (raw == null) return emptyList()
    val table = raw["mcp"]?.jsonObject
        ?: raw["mcpServers"]?.jsonObject
        ?: raw
    val defs = mutableListOf<JsonObject>()
    for ((name, value) in table) {
        if (value !is JsonObject) continue // 值 null / 非对象：跳过
        val entry = value
        val commands: List<String> = when (val c = entry["command"]) {
            is JsonPrimitive -> if (c.isString && c.contentOrNull!!.isNotBlank()) listOf(c.content) else emptyList()
            is kotlinx.serialization.json.JsonArray -> c.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.filter { it.isNotBlank() }
            else -> emptyList()
        }
        val url = (entry["url"] ?: entry["endpoint"] ?: entry["serverUrl"]).let { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }
        val type = (entry["type"] as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull
            ?: if (!url.isNullOrBlank() && commands.isEmpty()) "remote" else "local"
        val environment = LinkedHashMap<String, String>()
        (entry["environment"] ?: entry["env"]).let { env ->
            when (env) {
                is JsonObject -> for ((k, v) in env) environment[k] = when (v) {
                    is JsonPrimitive -> if (v.isString) v.contentOrNull ?: "" else v.toString()
                    is JsonNull -> ""
                    else -> v.toString()
                }
                else -> {}
            }
        }
        val headers = LinkedHashMap<String, String>()
        entry["headers"].let { h ->
            if (h is JsonObject) for ((k, v) in h) headers[k] = if (v is JsonPrimitive && v.isString) v.contentOrNull ?: "" else v.toString()
        }
        defs.add(buildJsonObject {
            put("name", name)
            put("type", type)
            put("command", kotlinx.serialization.json.JsonArray(commands.map { JsonPrimitive(it) }))
            put("environment", buildJsonObject { for ((k, v) in environment) put(k, v) })
            put("url", url ?: "")
            put("headers", buildJsonObject { for ((k, v) in headers) put(k, v) })
        })
    }
    return defs
}

/** 读 mcp.json（只读不写；读不出/不存在 → 空列表） */
fun readMcpServers(configDir: Path): List<JsonObject> = try {
    val file = configDir.resolve("mcp.json")
    if (!Files.exists(file)) emptyList()
    else parseMcpServerDefinitions(Json.parseToJsonElement(Files.readString(file)).let { it as? JsonObject })
} catch (_: Exception) {
    emptyList()
}
