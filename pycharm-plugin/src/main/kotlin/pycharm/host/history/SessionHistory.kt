package pycharm.host.history

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pycharm.host.util.EditDiff
import java.io.File
import java.net.URLEncoder
import java.nio.file.Files
import java.nio.file.Path

/**
 * 会话落盘的宿主侧只读访问（落盘格式由 core-rs 写入、src/shared/history/ 是 TS 宿主侧
 * 同一格式——本文件是同一格式在 Kotlin 宿主侧的读取实现，改格式须两侧同步）：
 * - 会话目录：`<home>/<configDirName>/conversations/<encoded-project>/`，项目目录名是
 *   workspacePath 的 URL 编码（同 core-rs 的 encode 口径）；
 * - meta.json / `<sessionId>.jsonl`；
 * - tool_use 块顶层 `_meta` 与 tool_result 兜底（requestToolMeta 的数据面）。
 */
object SessionHistory {

    /** 会话 → 工作目录（宿主侧同构表，对齐 shared/history/Config.js 的会话归属表） */
    private val sessionWorkspaces = HashMap<String, String>()

    @Synchronized
    fun setSessionWorkspace(sessionId: String, workspacePath: String) {
        sessionWorkspaces.putIfAbsent(sessionId, workspacePath)
    }

    @Synchronized
    fun getSessionWorkspace(sessionId: String): String? = sessionWorkspaces[sessionId]

    /** 项目目录编码（对齐 core-rs：workspacePath 的 URL 编码，保留部分安全字符由 core 决定——两侧同一实现来源） */
    fun encodeProjectPath(workspacePath: String): String =
        URLEncoder.encode(workspacePath.replace("\\", "/"), Charsets.UTF_8)

    fun conversationsDir(homeDir: Path, configDirName: String, workspacePath: String): Path =
        homeDir.resolve(configDirName).resolve("conversations").resolve(encodeProjectPath(workspacePath))

    fun sessionJsonl(homeDir: Path, configDirName: String, workspacePath: String, sessionId: String): Path =
        conversationsDir(homeDir, configDirName, workspacePath).resolve("$sessionId.jsonl")

    /**
     * 读取会话 jsonl 全部行（每行一个 JsonObject；坏行跳过）。
     * 文件不存在返回空列表（「读不到」与「空会话」同口径）。
     */
    fun readSessionLines(jsonl: Path): List<JsonObject> {
        if (!Files.exists(jsonl)) return emptyList()
        return Files.readAllLines(jsonl).mapNotNull { line ->
            if (line.isBlank()) null
            else try { Json.parseToJsonElement(line) as? JsonObject } catch (_: Exception) { null }
        }
    }

    /**
     * requestToolMeta 的数据面（对齐 webviewMessageHandler.handleRequestToolMeta）：
     * tool_use 顶层 `_meta` 优先，tool_result 块兜底；Edit 且两侧内容齐全 → 紧凑
     * diffHunks（不回传完整文件内容）。
     */
    fun readToolMeta(
        homeDir: Path,
        configDirName: String,
        workspacePath: String,
        sessionId: String,
        toolUseIds: List<String>,
    ): JsonObject {
        val lines = readSessionLines(sessionJsonl(homeDir, configDirName, workspacePath, sessionId))
        val result = LinkedHashMap<String, JsonObject>()
        // tool_result 兜底索引
        val resultDiff = HashMap<String, JsonObject>()
        for (msg in lines) {
            val content = (msg["message"] as? JsonObject)?.get("content") as? kotlinx.serialization.json.JsonArray ?: continue
            if ((msg["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content != "user") continue
            for (block in content) {
                val obj = block as? JsonObject ?: continue
                if ((obj["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "tool_result") {
                    val id = (obj["tool_use_id"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: continue
                    resultDiff[id] = obj
                }
            }
        }
        fun field(a: JsonObject?, b: JsonObject?, key: String): kotlinx.serialization.json.JsonElement? {
            for (source in listOf(a, b)) {
                val v = source?.get(key)
                if (v != null && v !is kotlinx.serialization.json.JsonNull) return v
            }
            return null
        }
        for (msg in lines) {
            if ((msg["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content != "assistant") continue
            val content = (msg["message"] as? JsonObject)?.get("content") as? kotlinx.serialization.json.JsonArray ?: continue
            for (block in content) {
                val obj = block as? JsonObject ?: continue
                if ((obj["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content != "tool_use") continue
                val id = (obj["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: continue
                if (!toolUseIds.contains(id)) continue
                val name = (obj["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val meta = obj["_meta"] as? JsonObject
                val fallback = resultDiff[id]
                val beforeContent = field(meta, fallback, "beforeContent")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
                val afterContent = field(meta, fallback, "afterContent")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
                val startLine = field(meta, fallback, "startLine")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() }
                val endLine = field(meta, fallback, "endLine")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() }
                val contextBefore = (field(meta, fallback, "contextBefore") as? kotlinx.serialization.json.JsonArray) ?: kotlinx.serialization.json.JsonArray(emptyList())
                val contextAfter = (field(meta, fallback, "contextAfter") as? kotlinx.serialization.json.JsonArray) ?: kotlinx.serialization.json.JsonArray(emptyList())
                if (name == "Edit" && beforeContent != null && afterContent != null) {
                    result[id] = buildJsonObject {
                        put("diffHunks", EditDiff.buildEditDiffHunks(beforeContent, afterContent, startLine, endLine))
                        put("contextBefore", contextBefore)
                        put("contextAfter", contextAfter)
                        startLine?.let { put("startLine", it) }
                        endLine?.let { put("endLine", it) }
                    }
                } else if (name == "Edit" || name == "Write") {
                    result[id] = buildJsonObject {
                        if (meta != null) meta.forEach { (k, v) -> put(k, v) }
                        if (beforeContent != null) put("beforeContent", beforeContent) else put("beforeContent", kotlinx.serialization.json.JsonNull)
                        put("afterContent", afterContent ?: "")
                        put("contextBefore", contextBefore)
                        put("contextAfter", contextAfter)
                        startLine?.let { put("startLine", it) }
                        endLine?.let { put("endLine", it) }
                    }
                } else if (!meta.isNullOrEmpty()) {
                    result[id] = meta
                }
            }
        }
        return kotlinx.serialization.json.JsonObject(result)
    }

    private fun kotlinx.serialization.json.JsonPrimitive?.contentOrNullExt(): String? = this?.takeIf { it.isString }?.content
    private val kotlinx.serialization.json.JsonPrimitive.contentOrNull: String? get() = if (isString) content else null

    /** meta.json 读取（title 等；坏文件返回 null） */
    fun readMeta(metaPath: Path): JsonObject? = try {
        if (!Files.exists(metaPath)) null
        else Json.parseToJsonElement(Files.readString(metaPath)) as? JsonObject
    } catch (_: Exception) { null }

    /** 遍历某个工作区目录下的会话文件（诊断用；列表事实走 core 的 conversationListRequested） */
    fun listSessionFiles(homeDir: Path, configDirName: String, workspacePath: String): List<File> {
        val dir = conversationsDir(homeDir, configDirName, workspacePath).toFile()
        return dir.listFiles { f -> f.extension == "jsonl" }?.toList() ?: emptyList()
    }
}
