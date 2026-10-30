package pycharm.host.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 配置快照解析（移植 src/shared/settingsSnapshot.ts 的 resolveSettingsSnapshot——
 * 与 tui-rs/src/settings.rs 同款移植模式；注释声明对齐源，锁值测试防漂移）。
 *
 * 纯函数不做 I/O：字段缺失 / 类型错 / 取值非法一律落默认值。默认值唯一来源仍是
 * TS settingsSnapshot.ts；本文件只承载解析规则，测试锁定两侧一致（字段名单对照测试
 * 是防 multimodal 式漂移的关键，见 specs/035 plan 宪章检查）。
 *
 * wire 形状（camelCase，core-rs serde 同构）：
 * `llm{activeProvider, webSearch, thinkingEffort, model, maxTokens, enableUsageStats,
 * providers{baseURL, apiKey, models, defaultModel, modelLimits}, modelLimitsFallback},
 * mcp{enabled}, defaultAgentMode, defaultPromptMode`；
 * `ModelLimits = {context, output, apiType, thinkingTokenBudget, multimodal}`。
 */
object SettingsSnapshot {

    private const val DEFAULT_WEB_SEARCH = true
    private const val DEFAULT_THINKING_EFFORT = "high"
    private const val DEFAULT_AGENT_MODE = "risk"
    private const val DEFAULT_PROMPT_MODE = "normal"
    private const val DEFAULT_ENABLE_USAGE_STATS = true
    private const val DEFAULT_API_TYPE = "OpenAI"
    private const val DEFAULT_MODEL_MULTIMODAL = true
    // FALLBACK_MODEL_PARAMS（src/shared/utils/modelConfig.ts）
    private const val FALLBACK_CONTEXT = 1_048_576L
    private const val FALLBACK_THINKING_BUDGET = 196_608L
    private const val FALLBACK_OUTPUT = 131_072L

    /** 内置模型注册表（对齐 MODEL_CONFIGS：contextWindow / thinking_token_budget / maxOutputTokens） */
    private val MODEL_CONFIGS: List<Triple<String, Long, Long>> = listOf(
        Triple("deepseek-flash", 1_048_576L, 384_000L),
        Triple("deepseek-v4-flash", 1_048_576L, 384_000L),
        Triple("deepseek-v4-pro", 1_048_576L, 384_000L),
    )

    private fun modelLimits(context: Long, output: Long, apiType: String, thinkingTokenBudget: Long, multimodal: Boolean): JsonObject = JsonObject(
        linkedMapOf(
            "context" to JsonPrimitive(context),
            "output" to JsonPrimitive(output),
            "apiType" to JsonPrimitive(apiType),
            "thinkingTokenBudget" to JsonPrimitive(thinkingTokenBudget),
            "multimodal" to JsonPrimitive(multimodal),
        ),
    )

    private fun fallbackLimits(): JsonObject =
        modelLimits(FALLBACK_CONTEXT, FALLBACK_OUTPUT, DEFAULT_API_TYPE, FALLBACK_THINKING_BUDGET, DEFAULT_MODEL_MULTIMODAL)

    private fun JsonElement?.objOrNull(): JsonObject? = this as? JsonObject
    private fun JsonElement?.strOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonElement?.boolOrNull(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull
    private fun JsonElement?.finiteOrNull(): Double? = (this as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }

    /** 注册表匹配（精确 → 子串）+ 用户覆盖（context/output） */
    private fun baseLimits(model: String?, overrides: JsonObject): Pair<Long, Long> {
        if (model.isNullOrBlank()) return FALLBACK_CONTEXT to FALLBACK_OUTPUT
        val entry = MODEL_CONFIGS.firstOrNull { it.first == model }
            ?: MODEL_CONFIGS.firstOrNull { model.contains(it.first) }
        val baseContext = entry?.second ?: FALLBACK_CONTEXT
        val baseOutput = entry?.third ?: FALLBACK_OUTPUT
        val override = overrides[model].objOrNull()
        val oContext = override?.get("context").finiteOrNull()?.toLong() ?: baseContext
        val oOutput = override?.get("output").finiteOrNull()?.toLong() ?: baseOutput
        return oContext to oOutput
    }

    private fun normalizeApiType(raw: String?): String {
        // 对齐 normalizeApiType：只认三个协议名，其余回落默认
        return if (raw == "OpenAI" || raw == "Anthropic" || raw == "Responses") raw else DEFAULT_API_TYPE
    }

    private fun resolveModelLimits(model: String?, overrides: JsonObject): JsonObject {
        val (context, output) = baseLimits(model, overrides)
        val explicit = if (model.isNullOrBlank()) null else overrides[model].objOrNull()
        val apiType = explicit?.get("apiType").strOrNull().let(::normalizeApiType)
        val multimodal = explicit?.get("multimodal").boolOrNull() ?: DEFAULT_MODEL_MULTIMODAL
        // 注册表条目的 thinking 预算与全局兜底同值（192K，对齐 MODEL_CONFIGS）
        return modelLimits(context, output, apiType, FALLBACK_THINKING_BUDGET, multimodal)
    }

    private fun normalizeModels(raw: JsonElement?): List<String> {
        if (raw !is JsonArray) return emptyList()
        return raw.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            .filter { it.isNotBlank() }
            .map { it.trim() }
            .distinct()
    }

    private fun normalizeModelConfigs(raw: JsonElement?): JsonObject {
        val configs = raw.objOrNull() ?: return JsonObject(emptyMap())
        val out = LinkedHashMap<String, JsonElement>()
        for ((model, limits) in configs) {
            val entry = limits.objOrNull() ?: continue
            val normalized = LinkedHashMap<String, JsonElement>()
            entry.get("context").finiteOrNull()?.let { normalized["context"] = JsonPrimitive(it) }
            entry.get("output").finiteOrNull()?.let { normalized["output"] = JsonPrimitive(it) }
            entry.get("apiType").strOrNull()?.let { normalized["apiType"] = JsonPrimitive(it) }
            entry.get("multimodal").boolOrNull()?.let { normalized["multimodal"] = JsonPrimitive(it) }
            if (normalized.isNotEmpty()) out[model] = JsonObject(normalized)
        }
        return JsonObject(out)
    }

    private fun collectKnownModels(models: List<String>, configs: JsonObject): List<String> {
        val names = LinkedHashSet<String>(models)
        names.addAll(configs.keys)
        MODEL_CONFIGS.forEach { names.add(it.first) }
        return names.toList()
    }

    private fun resolveProviders(raw: JsonElement?): JsonObject {
        val providersRaw = raw.objOrNull() ?: return JsonObject(emptyMap())
        val out = LinkedHashMap<String, JsonElement>()
        for ((key, value) in providersRaw) {
            val provider = value.objOrNull() ?: continue
            val baseURL = provider.get("baseURL").strOrNull()?.trim() ?: ""
            val models = normalizeModels(provider.get("models"))
            val configs = normalizeModelConfigs(provider.get("modelConfigs"))
            val modelLimits = LinkedHashMap<String, JsonElement>()
            for (model in collectKnownModels(models, configs)) {
                modelLimits[model] = resolveModelLimits(model, configs)
            }
            val explicitDefault = provider.get("defaultModel").strOrNull()?.trim() ?: ""
            out[key] = JsonObject(
                linkedMapOf(
                    "baseURL" to JsonPrimitive(baseURL),
                    "apiKey" to JsonPrimitive(provider.get("apiKey").strOrNull() ?: ""),
                    "models" to JsonArray(models.map { JsonPrimitive(it) }),
                    "defaultModel" to JsonPrimitive(explicitDefault.ifBlank { models.firstOrNull() ?: "" }),
                    "modelLimits" to JsonObject(modelLimits),
                ),
            )
        }
        return JsonObject(out)
    }

    private fun resolveMcpEnabled(raw: JsonElement?): JsonArray {
        val enabled = raw.objOrNull()?.get("enabled") as? JsonArray ?: return JsonArray(emptyList())
        return JsonArray(enabled.filterIsInstance<JsonPrimitive>().filter { it.isString })
    }

    /** 解析 raw settings 为快照（字段全必选；core serde 拒收缺字段） */
    fun resolve(rawSettings: JsonObject?): JsonObject {
        val root = rawSettings ?: JsonObject(emptyMap())
        val llm = root.get("llm").objOrNull() ?: JsonObject(emptyMap())
        val providers = resolveProviders(llm.get("providers"))
        val activeRaw = llm.get("activeProvider").strOrNull()
        val activeProvider = if (activeRaw != null && (providers[activeRaw].objOrNull()?.get("baseURL").strOrNull() ?: "").isNotBlank()) activeRaw else ""
        val maxTokensRaw = llm.get("maxTokens").finiteOrNull()
        return JsonObject(
            linkedMapOf(
                "llm" to JsonObject(
                    linkedMapOf(
                        "activeProvider" to JsonPrimitive(activeProvider),
                        "webSearch" to JsonPrimitive(llm.get("webSearch").boolOrNull() ?: DEFAULT_WEB_SEARCH),
                        "thinkingEffort" to JsonPrimitive(resolveThinkingEffort(llm.get("thinking_effort").strOrNull())),
                        "model" to JsonPrimitive(llm.get("model").strOrNull()?.trim() ?: ""),
                        "maxTokens" to JsonPrimitive(
                            (maxTokensRaw?.takeIf { it > 0 }?.toLong()) ?: FALLBACK_OUTPUT,
                        ),
                        "enableUsageStats" to JsonPrimitive(llm.get("enableUsageStats").boolOrNull() ?: DEFAULT_ENABLE_USAGE_STATS),
                        "providers" to providers,
                        "modelLimitsFallback" to fallbackLimits(),
                    ),
                ),
                "mcp" to JsonObject(linkedMapOf("enabled" to resolveMcpEnabled(root.get("mcp")))),
                "defaultAgentMode" to JsonPrimitive(resolveAgentMode(root.get("defaultAgentMode").strOrNull())),
                "defaultPromptMode" to JsonPrimitive(resolvePromptMode(root.get("defaultPromptMode").strOrNull())),
            ),
        )
    }

    private fun resolveThinkingEffort(raw: String?): String =
        if (raw == "off" || raw == "low" || raw == "high" || raw == "max") raw else DEFAULT_THINKING_EFFORT

    private fun resolveAgentMode(raw: String?): String =
        if (raw == "manual" || raw == "auto") raw else DEFAULT_AGENT_MODE

    private fun resolvePromptMode(raw: String?): String =
        if (raw == "minimal" || raw == "mixed") raw else DEFAULT_PROMPT_MODE
}
