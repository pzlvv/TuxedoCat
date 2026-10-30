package pycharm.host

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pycharm.host.core.CoreBus
import pycharm.host.core.CoreChannelTransport
import pycharm.host.core.CoreExitInfo
import pycharm.host.settings.SettingsSnapshot
import pycharm.host.settings.parseMcpServerDefinitions
import pycharm.host.util.EditDiff
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.future.await

/**
 * 总线接线语义（对齐 StandaloneEventBus；specs/035 测试计划第 1 层）：
 * 就绪前排队 / 连接态重放 / conversationOpened 重放 / epoch 丢弃旧应答 / 未注册回 ok:false。
 * 用 Fake 传输驱动，不依赖真实 Core。
 */
class CoreBusTest {

    private class FakeTransport : CoreChannelTransport {
        val sent = mutableListOf<kotlinx.serialization.json.JsonObject>()
        override fun send(frame: kotlinx.serialization.json.JsonObject) { sent.add(frame) }
        override var onFrame: ((kotlinx.serialization.json.JsonObject) -> Unit)? = null
        override var onReady: (() -> Unit)? = null
        override var onNotReady: (() -> Unit)? = null
        override var onFatal: ((String) -> Unit)? = null
        override var onDiagnostic: ((String) -> Unit)? = null
        override var onExit: ((CoreExitInfo) -> Unit)? = null
        override var isStopped: Boolean = false
        override fun stop() { isStopped = true }

        fun coreReady() { onReady?.invoke() }
        fun deliverCoreEvent(event: kotlinx.serialization.json.JsonObject) {
            onFrame?.invoke(buildJsonObject {
                put("kind", "event")
                put("event", event)
            })
        }
    }

    private fun runBlockingIo(block: suspend () -> Unit) {
        kotlinx.coroutines.runBlocking { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { block() } }
    }

    @Test
    fun uiEventsQueueBeforeReadyAndFlushInOrder() = runBlockingIo {
        val transport = FakeTransport()
        val bus = CoreBus(transport) { }
        bus.start()
        bus.emitToCore(buildJsonObject { put("type", "modelChanged"); put("sessionId", "s"); put("ref", buildJsonObject { put("provider", "p"); put("model", "m") }) })
        assertTrue(transport.sent.isEmpty(), "就绪前 UiEvent 排队不发")
        transport.coreReady()
        // ready 后按序冲刷：排队事件先发（hostEnvironmentProvided 未登记时无连接态重放）
        assertEquals(1, transport.sent.size)
        assertEquals("modelChanged", transport.sent[0]["event"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        // 就绪后直发
        bus.emitToCore(buildJsonObject { put("type", "queryBegin"); put("sessionId", "s") })
        assertEquals(2, transport.sent.size)
    }

    @Test
    fun connectionScopedEventReplaysFirstOnEveryReady() = runBlockingIo {
        val transport = FakeTransport()
        val bus = CoreBus(transport) { }
        bus.start()
        val environment = buildJsonObject { put("type", "hostEnvironmentProvided"); put("configDirName", "c") }
        bus.emitToCore(environment)
        assertTrue(transport.sent.isEmpty())
        transport.coreReady()
        assertEquals("hostEnvironmentProvided", transport.sent[0]["event"]!!.jsonObject["type"]!!.jsonPrimitive.content, "连接态事实最先重放")
        transport.coreReady()
        assertEquals(2, transport.sent.size, "每次 ready 都重放 hostEnvironmentProvided")
    }

    @Test
    fun openSessionsReplayConversationOpened() = runBlockingIo {
        val transport = FakeTransport()
        val bus = CoreBus(transport) { }
        bus.start()
        bus.emitToCore(buildJsonObject { put("type", "conversationOpened"); put("sessionId", "s1") })
        bus.emitToCore(buildJsonObject { put("type", "conversationOpened"); put("sessionId", "s2") })
        bus.emitToCore(buildJsonObject { put("type", "conversationClosed"); put("sessionId", "s2") })
        transport.coreReady()
        val replayed = transport.sent.map { it["event"]!!.jsonObject["sessionId"]!!.jsonPrimitive.content }
        assertEquals(listOf("s1"), replayed, "Core 重启后按 openSessions 重放 conversationOpened（closed 的不重放）")
    }

    @Test
    fun unknownCoreRequestGetsOkFalse() = runBlockingIo {
        val transport = FakeTransport()
        val bus = CoreBus(transport) { }
        bus.start()
        bus.coreRequestHandlers = emptyMap()
        transport.coreReady()
        transport.onFrame?.invoke(buildJsonObject {
            put("kind", "request")
            put("id", 7)
            put("request", buildJsonObject { put("type", "userChoice") })
        })
        val response = transport.sent.single()
        assertEquals("response", response["kind"]!!.jsonPrimitive.content)
        assertEquals(false, response["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(7, response["id"]!!.jsonPrimitive.content.toLong())
    }

    @Test
    fun staleResponsesAreDroppedAfterReconnect() = runBlockingIo {
        val transport = FakeTransport()
        val bus = CoreBus(transport) { }
        bus.start()
        bus.coreRequestHandlers = mapOf("userChoice" to { buildJsonObject { put("kind", "permission"); put("index", 0) } })
        transport.coreReady()
        val future = bus.requestCore(buildJsonObject { put("type", "userChoice") })
        // Core 断开（notReady → epoch++）后迟到的应答不套用到新连接
        transport.onNotReady?.invoke()
        transport.coreReady()
        val frame = buildJsonObject {
            put("kind", "response")
            put("id", 1)
            put("ok", true)
        }
        transport.onFrame?.invoke(frame)
        assertTrue(future.isCompletedExceptionally, "旧 epoch 的请求应在断连时已失败（不悬挂）")
    }

    // ===== mcp.json 解析容错（parseMcpServerDefinitions 移植）=====

    @Test
    fun mcpParseHandlesThreeShapesAndDefaults() {
        val direct = Json.parseToJsonElement("""{"srv1": {"command": "node", "args": [], "url": ""}}""") as JsonObject
        assertEquals(1, parseMcpServerDefinitions(direct).size)
        val wrapped = Json.parseToJsonElement("""{"mcpServers": {"srv2": {"url": "https://x"}}}""") as JsonObject
        val defs = parseMcpServerDefinitions(wrapped)
        assertEquals("remote", defs[0]["type"]!!.jsonPrimitive.content, "url 非空且无 command → remote")
        val typed = Json.parseToJsonElement("""{"mcp": {"srv3": {"type": "local", "command": ["a", "b"]}}}""") as JsonObject
        assertEquals("local", parseMcpServerDefinitions(typed)[0]["type"]!!.jsonPrimitive.content)
        // 解析失败 → 空列表不抛错
        assertEquals(0, parseMcpServerDefinitions(Json.parseToJsonElement("""{"srv": "not-an-object"}""") as JsonObject).size)
    }

    // ===== Edit 紧凑 diff（行级 LCS）=====

    @Test
    fun editDiffProducesRemovedAddedUnchanged() {
        val hunks = EditDiff.buildEditDiffHunks("a\nb\nc", "a\nX\nc", 1, 3)
        val lines = (hunks[0] as JsonObject)["lines"]!! as JsonArray
        val types = lines.map { (it as JsonObject)["type"]!!.jsonPrimitive.content }
        assertEquals(listOf("unchanged", "removed", "added", "unchanged"), types)
        val bigDiff = EditDiff.buildEditDiffHunks("x\n".repeat(5000), "y\n".repeat(5000), null, null)
        assertTrue(((bigDiff[0] as JsonObject)["lines"]!!.jsonArray).size > 0, "超 4000 行退化整侧替换不抛错")
    }

    // ===== 会话 jsonl _meta 读取（fixture 锁读取语义）=====

    @Test
    fun toolMetaReadsMetaWithToolResultFallback() {
        val dir = Files.createTempDirectory("tuxedo-meta-test")
        try {
            val workspace = dir.resolve("ws")
            Files.createDirectories(workspace)
            val conversations = SessionHistoryTestDir.conversationsDir(dir, "cfg", workspace.toString())
            Files.createDirectories(conversations)
            val jsonl = conversations.resolve("sess1.jsonl")
            Files.writeString(jsonl, listOf(
                """{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Edit","input":{},"_meta":{"beforeContent":"old","afterContent":"new","startLine":2,"endLine":4}}]}}""",
                """{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu2","afterContent":"fallback-new"}]}}""",
                """{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu2","name":"Write","input":{}}]}}""",
            ).joinToString("\n"))
            val meta = SessionHistoryTestDir.readToolMeta(dir, "cfg", workspace.toString(), "sess1", listOf("tu1", "tu2"))
            println("DEBUG meta=" + meta + " jsonlExists=" + java.nio.file.Files.exists(SessionHistoryTestDir.conversationsDir(dir, "cfg", workspace.toString()).resolve("sess1.jsonl")))
            val tu1 = (meta["tu1"] ?: error("tu1 missing; meta=$meta")).jsonObject
                        assertTrue(tu1.containsKey("diffHunks"), "Edit 且两侧内容齐全 → 返回紧凑 diffHunks")
            val tu2 = (meta["tu2"] ?: error("tu2 missing; meta=$meta")).jsonObject
            assertEquals("fallback-new", tu2["afterContent"]!!.jsonPrimitive.content, "_meta 缺失时 tool_result 兜底")
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    /** SessionHistory 的测试代理（避免直接依赖 home 布局） */
    private object SessionHistoryTestDir {
        fun conversationsDir(home: java.nio.file.Path, configDirName: String, workspacePath: String): java.nio.file.Path =
            pycharm.host.history.SessionHistory.conversationsDir(home, configDirName, workspacePath)
        fun readToolMeta(home: java.nio.file.Path, configDirName: String, workspacePath: String, sessionId: String, ids: List<String>) =
            pycharm.host.history.SessionHistory.readToolMeta(home, configDirName, workspacePath, sessionId, ids)
    }
}
