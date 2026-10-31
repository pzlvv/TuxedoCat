package pycharm.host.llm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * 设置面板的模型拉取与协议探测（对齐 webviewMessageHandler 的 fetchProviderModels /
 * detectProviderModelApiTypes）。
 *
 * v1 简化（有意留痕）：模型列表走 `GET {baseURL}/models`；协议探测对未设置协议的
 * 模型发一次最小请求，按端点状态码分类（OpenAI /chat/completions、Anthropic
 * /v1/messages、Responses /responses）——与 shared/llm/apiTypes 的判定精神一致但未
 * 逐字段对齐，漂移风险由「探测只服务面板默认值」界定，不影响 core 链路。
 */
object ProviderProbe {
    const val DEEPSEEK_BASE_URL = "https://api.deepseek.com"
    /** 协议探测并发上限（对齐 API_TYPE_PROBE_CONCURRENCY） */
    private const val PROBE_CONCURRENCY = 10
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    private fun baseUrl(raw: String): String = raw.trimEnd('/')

    private fun getModels(baseURL: String, apiKey: String): List<String> = try {
        val request = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl(baseURL) + "/models"))
            .header("Authorization", "Bearer $apiKey")
            .timeout(Duration.ofSeconds(10))
            .GET().build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != 200) emptyList()
        else {
            val body = Json.parseToJsonElement(response.body())
            val data = (body as? JsonObject)?.get("data") as? JsonArray
            data?.mapNotNull { entry ->
                val id = (entry as? JsonObject)?.get("id") as? JsonPrimitive
                id?.takeIf { it.isString }?.content
            } ?: emptyList()
        }
    } catch (_: Exception) {
        emptyList()
    }

    /** 阶段一：拉模型列表（needDetect = 全部模型，由面板确认后进入阶段二） */
    fun fetch(message: JsonObject, sendToWebview: (JsonObject) -> Unit) {
        val baseURL = (message["baseURL"] as? JsonPrimitive)?.content ?: return
        val apiKey = (message["apiKey"] as? JsonPrimitive)?.content ?: ""
        val models = getModels(baseURL, apiKey)
        sendToWebview(buildJsonObject {
            put("type", "providerModelsFetched")
            put("models", buildJsonArray { models.forEach { add(JsonPrimitive(it)) } })
            put("modelApiTypes", buildJsonArray {})
            put("needDetect", buildJsonArray { models.forEach { add(JsonPrimitive(it)) } })
        })
    }

    /** 阶段二：逐模型探测协议（最小请求 + 状态码分类，并发上限内） */
    fun detect(message: JsonObject, sendToWebview: (JsonObject) -> Unit) {
        val baseURL = (message["baseURL"] as? JsonPrimitive)?.content ?: return
        val apiKey = (message["apiKey"] as? JsonPrimitive)?.content ?: ""
        val models = (message["models"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
        val known = (message["knownApiTypes"] as? JsonObject) ?: JsonObject(emptyMap())
        val apiTypes = LinkedHashMap<String, String>()
        for ((k, v) in known) {
            (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { apiTypes[k] = it }
        }
        val toDetect = models.filter { !apiTypes.containsKey(it) }
        val pool = java.util.concurrent.Executors.newFixedThreadPool(PROBE_CONCURRENCY)
        try {
            val futures = toDetect.map { model -> pool.submit { apiTypes[model] = detectOne(baseURL, apiKey, model) } }
            futures.forEach { it.get() }
        } finally {
            pool.shutdown()
        }
        sendToWebview(buildJsonObject {
            put("type", "providerModelsResult")
            put("models", buildJsonArray { models.forEach { add(JsonPrimitive(it)) } })
            put("modelApiTypes", buildJsonObject { apiTypes.forEach { (k, v) -> put(k, v) } })
        })
    }

    private fun detectOne(baseURL: String, apiKey: String, model: String): String {
        val base = baseUrl(baseURL)
        if (probeStatus("$base/chat/completions", apiKey, openAiBody(model)) in 200..299) return "OpenAI"
        if (probeStatus("$base/v1/messages", apiKey, anthropicBody(model)) in 200..499) return "Anthropic"
        if (probeStatus("$base/responses", apiKey, responsesBody(model)) in 200..299) return "Responses"
        return "OpenAI"
    }

    private fun probeStatus(url: String, apiKey: String, body: String): Int = try {
        val request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(10))
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()
        client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
    } catch (_: Exception) {
        -1
    }

    private fun openAiBody(model: String): String =
        """{"model":"$model","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}"""

    private fun anthropicBody(model: String): String =
        """{"model":"$model","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}"""

    private fun responsesBody(model: String): String =
        """{"model":"$model","input":"ping"}"""
}
