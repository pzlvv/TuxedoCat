package pycharm.host.llm

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pycharm.host.settings.SettingsSnapshot
import pycharm.host.settings.SettingsStore

/**
 * LLM 配置保存（对齐 src/host/llmConfigSave.ts 的 applyLlmConfigSave 语义子集）：
 * 读-改-写 settings.json（经 SettingsStore.updateSettings 的四层保护），保存成功回
 * `llmConfigSaved`（defaultsChanged 对比保存前后快照），失败回 `llmConfigSaveError`。
 *
 * v1 简化（有意留痕）：逐字段校验比 TS 侧宽松（非法字段按缺省处理不拒绝）——写盘由
 * updateSettings 的「内容未变不落盘」兜底；MCP 默认列表保存走同一 mutator。
 */
object LlmConfigSave {

    fun handleSave(
        store: SettingsStore,
        message: JsonObject,
        log: (String) -> Unit,
        sendToWebview: (JsonObject) -> Unit,
    ) {
        try {
            val snapshotBefore = store.getSnapshot()
            store.updateSettings { raw ->
                var changed = raw
                if ((message["saveProviders"] as? JsonPrimitive)?.content == "true") {
                    val providers = message["providers"]
                    if (providers is JsonArray) {
                        val llm = (changed["llm"] as? JsonObject) ?: JsonObject(emptyMap())
                        // 读-改-写保留未知 provider 字段：以磁盘现状为底，逐 key 覆盖面板提交的字段
                        val next = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
                        ((llm["providers"] as? JsonObject) ?: JsonObject(emptyMap())).forEach { (k, v) -> next[k] = v }
                        for (provider in providers) {
                            val entry = provider as? JsonObject ?: continue
                            val key = (entry["key"] as? JsonPrimitive)?.content ?: continue
                            val current = (next[key] as? JsonObject) ?: JsonObject(emptyMap())
                            val merged = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(current)
                            listOf("baseURL", "apiKey", "models", "defaultModel", "modelConfigs").forEach { field ->
                                entry[field]?.let { merged[field] = it }
                            }
                            next[key] = JsonObject(merged)
                        }
                        changed = JsonObject(changed + ("llm" to JsonObject(llm + ("providers" to JsonObject(next)))))
                    }
                    (message["activeProvider"] as? JsonPrimitive)?.takeIf { it.isString }?.let { active ->
                        val llm = (changed["llm"] as? JsonObject) ?: JsonObject(emptyMap())
                        changed = JsonObject(changed + ("llm" to JsonObject(llm + ("activeProvider" to active))))
                    }
                }
                val llmMutations = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
                (message["webSearch"] as? JsonPrimitive)?.let { llmMutations["webSearch"] = it }
                (message["thinkingEffort"] as? JsonPrimitive)?.let { llmMutations["thinking_effort"] = it }
                if (llmMutations.isNotEmpty()) {
                    val llm = (changed["llm"] as? JsonObject) ?: JsonObject(emptyMap())
                    changed = JsonObject(changed + ("llm" to JsonObject(llm + llmMutations)))
                }
                listOf("defaultAgentMode", "defaultPromptMode").forEach { field ->
                    (message[field] as? JsonPrimitive)?.takeIf { it.isString }?.let { value ->
                        changed = JsonObject(changed + (field to value))
                    }
                }
                (message["language"] as? JsonPrimitive)?.takeIf { it.isString }?.let { changed = JsonObject(changed + ("uiLanguage" to it)) }
                (message["fontSize"] as? JsonPrimitive)?.takeIf { it.isString }?.let { changed = JsonObject(changed + ("uiFontSize" to it)) }
                (message["mcpServers"] as? JsonArray)?.let { changed = JsonObject(changed + ("mcp" to buildJsonObject { put("enabled", it) })) }
                changed
            }
            val snapshotAfter = store.getSnapshot()
            sendToWebview(buildJsonObject {
                put("type", "llmConfigSaved")
                put("defaultsChanged", buildJsonObject {
                    put("activeProvider", activeKeyOf(snapshotBefore) != activeKeyOf(snapshotAfter))
                    put("thinkingEffort", strOf(snapshotBefore, "thinkingEffort") != strOf(snapshotAfter, "thinkingEffort"))
                    put("promptMode", strOf(snapshotBefore, "defaultPromptMode") != strOf(snapshotAfter, "defaultPromptMode"))
                    put("agentMode", strOf(snapshotBefore, "defaultAgentMode") != strOf(snapshotAfter, "defaultAgentMode"))
                    put("webSearch", boolOf(snapshotBefore) != boolOf(snapshotAfter))
                })
                (message["closeAfterSave"] as? JsonPrimitive)?.let { put("closeAfterSave", it) }
            })
        } catch (e: Exception) {
            log("[llmConfigSave] failed: ${e.message}")
            sendToWebview(buildJsonObject { put("type", "llmConfigSaveError"); put("error", e.message ?: "save failed") })
        }
    }

    private fun activeKeyOf(snapshot: JsonObject): String =
        (snapshot["llm"] as? JsonObject)?.get("activeProvider")?.let { (it as? JsonPrimitive)?.content } ?: ""

    private fun strOf(snapshot: JsonObject, key: String): String? {
        val source = if (key == "thinkingEffort") snapshot["llm"] as? JsonObject else snapshot
        return (source?.get(key) as? JsonPrimitive)?.content
    }

    private fun boolOf(snapshot: JsonObject): Boolean? =
        ((snapshot["llm"] as? JsonObject)?.get("webSearch") as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
}
