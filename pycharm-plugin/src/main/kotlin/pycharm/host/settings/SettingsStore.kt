package pycharm.host.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path

/**
 * settings.json 读写（对齐 src/host/SettingsStore.ts）：
 * - 路径 `<home>/<configDirName>/settings.json`（home 解析序 USERPROFILE → HOME）；
 * - 读三态 ok / missing / invalid（invalid 不可当空配置）；
 * - 写四层保护：写链串行 → 跨进程锁 → 磁盘存在但解析失败拒绝写 → 内容未变不落盘 +
 *   原子落盘；未知字段与键序保留（读-改-写）；
 * - 规范文本 = `JSON.stringify(对象, null, 2) + '\n'`（比较的是磁盘现有内容的规范形式）。
 *
 * kotlinx.serialization 的 JsonObject 保序（LinkedHashMap），与 TS 的 stringify 键序语义一致；
 * 写出格式为 2 空格缩进 + 尾换行（prettyPrintJson）。
 */
class SettingsStore(private val configDir: Path, private val log: (String) -> Unit) {

    data class ReadResult(val kind: Kind, val value: JsonObject?) {
        enum class Kind { OK, MISSING, INVALID }
    }

    val settingsPath: Path = configDir.resolve("settings.json")
    private val lockPath: Path = configDir.resolve("settings.json.lock")
    private val tmpPath: Path = configDir.resolve("settings.json.tmp")

    @Volatile private var rawSettings: JsonObject? = null
    @Volatile private var snapshot: JsonObject? = null
    @Volatile private var mcpServers: List<JsonObject> = emptyList()
    private val listeners = mutableListOf<(JsonObject) -> Unit>()
    private val writeLock = Any()

    companion object {
        fun homeDir(): Path {
            val userprofile = System.getenv("USERPROFILE")
            val home = System.getenv("HOME")
            return Path.of(userprofile ?: home ?: System.getProperty("user.home"))
        }

        /** 规范文本（对齐 JSON.stringify(obj, null, 2) + '\n'） */
        fun canonicalText(value: JsonObject): String = prettyJson(value) + "\n"

        /** kotlinx 默认 4 空格缩进——这里手工 2 空格输出，与 TS 写盘格式一致 */
        fun prettyJson(element: kotlinx.serialization.json.JsonElement, indent: String = ""): String {
            val childIndent = indent + "  "
            return when (element) {
                is JsonObject -> {
                    if (element.isEmpty()) return "{}"
                    val body = element.entries.joinToString(",\n") { (k, v) ->
                        "$childIndent${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(k))}: ${prettyJson(v, childIndent)}"
                    }
                    "{\n$body\n$indent}"
                }
                is kotlinx.serialization.json.JsonArray -> {
                    if (element.isEmpty()) return "[]"
                    val body = element.joinToString(",\n") { "$childIndent${prettyJson(it, childIndent)}" }
                    "[\n$body\n$indent]"
                }
                is kotlinx.serialization.json.JsonPrimitive ->
                    Json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), element)
            }
        }
    }

    /** 读盘三态（对齐 readSettingsFile） */
    fun readSettingsFile(): ReadResult {
        if (!Files.exists(settingsPath)) return ReadResult(ReadResult.Kind.MISSING, null)
        return try {
            val text = Files.readString(settingsPath)
            val parsed = Json.parseToJsonElement(text)
            if (parsed is JsonObject) ReadResult(ReadResult.Kind.OK, parsed)
            else ReadResult(ReadResult.Kind.INVALID, null)
        } catch (_: Exception) {
            ReadResult(ReadResult.Kind.INVALID, null)
        }
    }

    /** 启动期一次（mcp.json 只在这里读一次） */
    fun loadSync() {
        Files.createDirectories(configDir)
        val read = readSettingsFile()
        when (read.kind) {
            ReadResult.Kind.OK -> applyRead(read.value!!)
            ReadResult.Kind.MISSING -> applyRead(JsonObject(emptyMap()))
            ReadResult.Kind.INVALID -> {
                log("[settings] settings.json 解析失败，启动期按空配置处理但拒绝后续写入覆盖")
                applyRead(JsonObject(emptyMap()))
            }
        }
        mcpServers = readMcpServers(configDir)
    }

    private fun applyRead(value: JsonObject) {
        rawSettings = value
        snapshot = SettingsSnapshot.resolve(value)
    }

    /** 面板挂载 / 打开设置前重读；内容没变不 notify（对齐 refreshFromDisk） */
    fun refreshFromDisk() {
        val read = readSettingsFile()
        if (read.kind == ReadResult.Kind.OK) {
            val old = rawSettings
            if (old == null || canonicalText(old) != canonicalText(read.value!!)) {
                applyRead(read.value!!)
                notifyListeners()
            }
        }
    }

    fun getSnapshot(): JsonObject = snapshot ?: error("SettingsStore 未 loadSync（启动期错误，不做静默兜底）")
    fun getRawSettings(): JsonObject = rawSettings ?: error("SettingsStore 未 loadSync")
    fun getMcpServers(): List<JsonObject> = mcpServers

    fun subscribe(listener: (JsonObject) -> Unit) {
        synchronized(listeners) { listeners.add(listener) }
    }

    private fun notifyListeners() {
        val snapshotValue = snapshot ?: return
        synchronized(listeners) { listeners.toList() }.forEach { listener ->
            try { listener(snapshotValue) } catch (e: Exception) { log("[settings] listener failed: ${e.message}") }
        }
    }

    /**
     * 读-改-写（对齐 updateSettings 的四层保护）。mutator 收到 raw 的深可变视图由实现
     * 决定——kotlinx JsonObject 不可变，这里约定 mutator 返回「改写后的新 raw」。
     * 返回 null 表示无需变更。
     */
    fun updateSettings(mutator: (JsonObject) -> JsonObject?) {
        synchronized(writeLock) {
            val lock = FileLock.tryAcquire(lockPath) ?: run {
                log("[settings] 无法获取 settings.json 锁，放弃本次写入")
                return
            }
            try {
                val disk = readSettingsFile()
                if (disk.kind == ReadResult.Kind.INVALID) {
                    // 读不出拒绝写：绝不用 {} 覆盖（铁律 11 / SettingsStore 同口径）
                    log("[settings] settings.json 解析失败，拒绝覆盖写")
                    return
                }
                val before = disk.value ?: JsonObject(emptyMap())
                val next = mutator(before) ?: return
                val beforeText = canonicalText(before)
                val nextText = canonicalText(next)
                if (beforeText == nextText) {
                    // 内容未变不落盘（比较的是磁盘内容的规范形式）
                    return
                }
                Files.createDirectories(configDir)
                FileLock.writeFileAtomic(settingsPath, nextText, tmpPath)
                applyRead(next)
                notifyListeners()
            } finally {
                lock.close()
            }
        }
    }

    /** highlightLanguages 记录（对齐 highlightLanguagesMutator：去重 + 上限 60 + 保留未知字段） */
    fun recordHighlightLanguages(languages: List<String>) {
        if (languages.isEmpty()) return
        updateSettings { raw ->
            val existing = (raw["highlightLanguages"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }
                ?: emptyList()
            val merged = (existing + languages).distinct().takeLast(60)
            if (merged == existing) null
            else JsonObject(raw + ("highlightLanguages" to kotlinx.serialization.json.JsonArray(merged.map { kotlinx.serialization.json.JsonPrimitive(it) })))
        }
    }

    /** uiLanguage 读取（默认 auto） */
    fun readUiLanguage(): String = try {
        getRawSettings()["uiLanguage"]?.jsonPrimitive?.contentOrNull ?: "auto"
    } catch (_: Exception) { "auto" }

    /** uiFontSize 读取（默认 medium） */
    fun readUiFontSize(): String = try {
        getRawSettings()["uiFontSize"]?.jsonPrimitive?.contentOrNull ?: "medium"
    } catch (_: Exception) { "medium" }
}
