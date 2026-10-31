package pycharm.host.core

import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import pycharm.host.protocol.FrameDecoder
import pycharm.host.protocol.FrameKinds
import pycharm.host.protocol.coreResponseFrame
import pycharm.host.protocol.helloFrame
import pycharm.host.protocol.readFrame
import pycharm.host.protocol.shutdownFrame
import pycharm.host.protocol.uiEventFrame
import pycharm.host.protocol.uiRequestFrame
import pycharm.host.protocol.writeFrame
import java.io.BufferedReader
import java.nio.file.Path
import java.io.InputStreamReader
import java.io.Writer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * 传输抽象（对齐 StandaloneEventBus 的 CoreChannelTransport）：本地 [CoreProcess] 实现，
 * 测试用 Fake 传输注入——总线语义单测不依赖真实 Core。
 */
interface CoreChannelTransport {
    /** 进程外送（UiEvent / UiRequest / response 帧由总线组好后交出） */
    fun send(frame: JsonObject)
    /** core→UI 帧的入口（传输层收到帧后回调总线） */
    var onFrame: ((JsonObject) -> Unit)?
    /** 连接状态：ready（握手完成）/ notReady / terminal */
    var onReady: (() -> Unit)?
    var onNotReady: (() -> Unit)?
    var onFatal: ((String) -> Unit)?
    var onDiagnostic: ((String) -> Unit)?
    /** core 退出信息（code/signal/expected） */
    var onExit: ((CoreExitInfo) -> Unit)?
    fun stop()
    val isStopped: Boolean
}

data class CoreExitInfo(val code: Int?, val signal: String?, val expected: Boolean)

/** 重启策略（常量与 src/host/standalone/CoreProcess.ts 同口径） */
data class RestartPolicy(
    val maxAttempts: Int = 5,
    val windowMs: Long = 60_000,
    val baseDelayMs: Long = 500,
    val maxDelayMs: Long = 10_000,
)

/**
 * 本地 Core 子进程（stdio 帧通道）。
 *
 * 生命周期常量同 CoreProcess.ts：握手 10s、优雅关闭 2s、重启 60s 窗口 5 次 500ms→10s
 * 指数退避、出站有序队列 + drain 背压（1 万帧告警）。
 */
class CoreProcess(
    private val coreBinary: Path,
    private val workspacePath: String?,
    private val restartPolicy: RestartPolicy = RestartPolicy(),
    private val handshakeTimeoutMs: Long = 10_000,
    private val shutdownTimeoutMs: Long = 2_000,
    private val log: (String) -> Unit,
) : CoreChannelTransport {

    @Volatile private var process: Process? = null
    @Volatile private var writer: Writer? = null
    @Volatile private var stopped = false
    @Volatile private var ready = false
    private val restartTimestamps = ArrayDeque<Long>()
    private val outbox = ArrayDeque<JsonObject>()
    private val lock = Any()
    private val ioPool = Executors.newCachedThreadPool { r -> Thread(r, "core-io").apply { isDaemon = true } }
    private val handshakeTimer = java.util.concurrent.ScheduledThreadPoolExecutor(1) { r ->
        Thread(r, "core-handshake").apply { isDaemon = true }
    }

    override var onFrame: ((JsonObject) -> Unit)? = null
    override var onReady: (() -> Unit)? = null
    override var onNotReady: (() -> Unit)? = null
    override var onFatal: ((String) -> Unit)? = null
    override var onDiagnostic: ((String) -> Unit)? = null
    override var onExit: ((CoreExitInfo) -> Unit)? = null
    override val isStopped: Boolean get() = stopped

    init {
        // JVM 退出兜底杀子进程（孤儿防护，对齐 CoreProcess 的 process.on('exit')）
        Runtime.getRuntime().addShutdownHook(Thread { gracefulKill() })
        start()
    }

    override fun send(frame: JsonObject) {
        log("[core] send ${frame.toString().take(300)}")
        val toQueue = synchronized(lock) {
            val proc = process
            if (stopped || proc == null) return
            if (outbox.isNotEmpty()) { outbox.addLast(frame); flushOutboxLocked(); return }
            try {
                (writer ?: return).writeFrame(frame)
            } catch (e: Exception) {
                // EPIPE 等写失败：进队列等重启后的连接冲刷（对齐 TS：send 失败入 outbox）
                outbox.addLast(frame)
                log("[core] send failed, queued: ${e.message}")
            }
        }
    }

    private fun flushOutboxLocked() {
        val w = writer ?: return
        while (outbox.isNotEmpty()) {
            try {
                w.writeFrame(outbox.first())
            } catch (e: Exception) {
                log("[core] outbox flush failed: ${e.message}")
                return
            }
            outbox.removeFirst()
        }
        if (outbox.size == 10_000) {
            // 背压软水位：只记录不丢帧（对齐 OUTBOX_WARN_THRESHOLD）
            onDiagnostic?.invoke("[core] outbox reached 10000 frames; peer is not draining")
        }
    }

    private fun start() {
        if (stopped) return
        val cmd = mutableListOf(coreBinary.toAbsolutePath().toString(), "stdio")
        log("[core] spawn: ${cmd.joinToString(" ")}")
        val proc = try {
            ProcessBuilder(cmd).apply {
                directory(workspacePath?.let { java.io.File(it) })
            }.start()
        } catch (e: Exception) {
            onFatal?.invoke("Core 产物启动失败（${coreBinary.toAbsolutePath()}）：${e.message}")
            return
        }
        process = proc
        ready = false
        synchronized(lock) { writer = proc.outputStream.writer(Charsets.UTF_8) }
        // spawn 后立即握手（对齐 CoreProcess：hello 先行）
        try {
            writer?.writeFrame(helloFrame())
        } catch (e: Exception) {
            log("[core] hello write failed: ${e.message}")
        }
        // 握手超时：10s 杀进程（走非预期退出 → 重启流程）
        handshakeTimer.schedule({
            if (!ready && !stopped) {
                onDiagnostic?.invoke("[core] handshake timed out after ${handshakeTimeoutMs}ms; terminating core process")
                proc.destroyForcibly()
            }
        }, handshakeTimeoutMs, TimeUnit.MILLISECONDS)
        ioPool.submit {
            try { pumpOutput(proc) } catch (e: Throwable) { log("[core] output pump crashed: $e") }
        }
        ioPool.submit { pumpError(proc) }
        ioPool.submit { awaitExit(proc) }
    }

    private fun pumpOutput(proc: Process) {
        val reader = BufferedReader(InputStreamReader(proc.inputStream, Charsets.UTF_8))
        val decoder = FrameDecoder()
        while (true) {
            val chunk = CharArray(8192)
            val n = try { reader.read(chunk) } catch (e: Exception) { break }
            if (n < 0) break
            for (frame in decoder.push(String(chunk, 0, n))) handleFrame(frame)
        }
        // stdout close → kill → 非预期退出走重启（对齐 CoreProcess）
        if (!stopped) proc.destroyForcibly()
    }

    private fun pumpError(proc: Process) {
        val reader = BufferedReader(InputStreamReader(proc.errorStream, Charsets.UTF_8))
        while (true) {
            val line = reader.readLine() ?: break
            onDiagnostic?.invoke("[core:stderr] $line")
        }
    }

    private fun awaitExit(proc: Process) {
        val code = proc.waitFor()
        log("[core] exited code=$code stopped=$stopped")
        synchronized(lock) {
            writer = null
            process = null
        }
        ready = false
        val expected = stopped
        onExit?.invoke(CoreExitInfo(code = if (code == 0) 0 else code, signal = null, expected = expected))
        if (!stopped) {
            onNotReady?.invoke()
            scheduleRestart()
        }
    }

    private fun scheduleRestart() {
        log("[core] scheduleRestart")
        val now = System.currentTimeMillis()
        synchronized(restartTimestamps) {
            while (restartTimestamps.isNotEmpty() && now - restartTimestamps.first() > restartPolicy.windowMs) {
                restartTimestamps.removeFirst()
            }
            if (restartTimestamps.size >= restartPolicy.maxAttempts) {
                log("[core] fatal: restart limit reached")
                onFatal?.invoke("Core 在 ${restartPolicy.windowMs / 1000}s 内崩溃 ${restartPolicy.maxAttempts} 次，已停止重启；请检查 Core 产物与日志。")
                return
            }
            restartTimestamps.addLast(now)
            val delay = minOf(restartPolicy.baseDelayMs * (1L shl (restartTimestamps.size - 1)), restartPolicy.maxDelayMs)
            ioPool.submit {
                Thread.sleep(delay)
                if (!stopped) start()
            }
        }
    }

    private fun handleFrame(frame: JsonObject) {
        val kind = frame["kind"]?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.content
        log("[core] frame kind=$kind ${frame.toString().take(300)}")
        when (kind) {
            FrameKinds.READY -> {
                ready = true
                log("[core] handshake ready")
                onReady?.invoke()
            }
            FrameKinds.EVENT, FrameKinds.REQUEST, FrameKinds.RESPONSE -> onFrame?.invoke(frame)
            else -> onDiagnostic?.invoke("[core] unknown frame kind: $frame")
        }
    }

    override fun stop() {
        if (stopped) return
        stopped = true
        val proc = process
        if (proc != null) {
            try { writer?.writeFrame(shutdownFrame()) } catch (_: Exception) {}
        }
        ioPool.submit {
            if (proc != null) {
                proc.waitFor(shutdownTimeoutMs, TimeUnit.MILLISECONDS)
                if (proc.isAlive) proc.destroyForcibly()
            }
        }
    }

    private fun gracefulKill() {
        try { process?.destroyForcibly() } catch (_: Exception) {}
    }
}

/**
 * 总线（对齐 StandaloneEventBus 的接线语义）：
 * - 就绪前 UiEvent 排队，握手后按序发出（conversationOpened 例外：openSessions 统一管理）；
 * - `hostEnvironmentProvided` 连接态重放（每次 ready 后最先发）；
 * - openSessions 的 conversationOpened 每次 ready 后重放；
 * - connectionEpoch：Core 重启后丢弃旧请求的迟到应答；
 * - CoreRequest 未注册回 ok:false。
 */
class CoreBus(private val transport: CoreChannelTransport, private val log: (String) -> Unit) {
    private val queuedUiEvents = ArrayDeque<JsonObject>()
    private var connectionScopedEvent: JsonObject? = null
    private val openSessions = LinkedHashSet<String>()
    @Volatile private var epoch = 0L
    @Volatile private var ready = false
    @Volatile private var terminalError: String? = null
    private val requestId = AtomicLong(1)
    private val pendingUiRequests = ConcurrentHashMap<Long, CompletableFuture<kotlinx.serialization.json.JsonElement?>>()
    private val readyResolvers = mutableListOf<CompletableFuture<Void>>()
    private val pendingCoreRequests = ConcurrentHashMap<Long, Long>() // request id -> epoch

    /** CoreRequest 处理表：type -> handler(payload JsonObject) -> result JsonObject（挂起） */
    var coreRequestHandlers: Map<String, suspend (JsonObject) -> JsonObject?> = emptyMap()

    /** 一次性初始化：接传输回调 */
    fun start() {
        transport.onFrame = { frame -> onCoreFrame(frame) }
        transport.onReady = { handleReady() }
        transport.onNotReady = {
            ready = false
            epoch++
            failPendingUiRequests("Standalone Core connection lost before responding.")
        }
        transport.onFatal = { message ->
            terminalError = message
            failPendingUiRequests(message)
        }
    }

    val isReady: Boolean get() = ready

    fun whenReady(): CompletableFuture<Void> {
        val f = CompletableFuture<Void>()
        if (ready) f.complete(null)
        else if (terminalError != null) f.completeExceptionally(IllegalStateException(terminalError))
        else synchronized(readyResolvers) { readyResolvers.add(f) }
        return f
    }

    private fun handleReady() {
        ready = true
        epoch++
        val resolvers = synchronized(readyResolvers) { readyResolvers.toList().also { readyResolvers.clear() } }
        resolvers.forEach { it.complete(null) }
        // 重放顺序（对齐 StandaloneEventBus.handleReady）：连接态事实 → openSessions → 排队事件
        connectionScopedEvent?.let { transport.send(it) }
        synchronized(openSessions) {
            for (sessionId in openSessions) {
                transport.send(uiEventFrame(buildJsonObject {
                    put("type", "conversationOpened")
                    put("sessionId", sessionId)
                }))
            }
        }
        val queued = synchronized(queuedUiEvents) { val copy = queuedUiEvents.toList(); queuedUiEvents.clear(); copy }
        for (event in queued) transport.send(uiEventFrame(event))
    }

    /** 发 UiEvent（hostEnvironmentProvided 保留最后取值连接态重放） */
    fun emitToCore(event: JsonObject) {
        val type = (event["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        log("[bus] emitToCore type=$type ready=$ready terminal=$terminalError")
        if (terminalError != null) { log("[bus] dropped uiEvent after fatal: $type"); return }
        if (type == null) return
        if (type == "hostEnvironmentProvided") {
            connectionScopedEvent = uiEventFrame(event)
            if (ready) transport.send(connectionScopedEvent!!)
            return
        }
        if (type == "conversationOpened" || type == "conversationClosed") {
            synchronized(openSessions) {
                if (type == "conversationOpened") openSessions.add((event["sessionId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return)
                else openSessions.remove((event["sessionId"] as? kotlinx.serialization.json.JsonPrimitive)?.content)
            }
            if (ready) transport.send(uiEventFrame(event))
            return
        }
        if (!ready) {
            synchronized(queuedUiEvents) { queuedUiEvents.add(event) }
            return
        }
        transport.send(uiEventFrame(event))
    }

    /**
     * 发 UiRequest，返回应答 future（无内置超时，调用点兜底；调用方在 IO 协程里
     * awaitResult 挂起等待——每会话至多一个等待中的用户确认，线程占用可控）。
     * 就绪前发送会被 core 拒收且无应答帧（请求会悬挂），因此先等 ready 再发。
     * 应答 result 形状无关（JsonObject / JsonArray / null）——各请求的形状见 coreFacts.ts。
     */
    fun requestCore(request: JsonObject): CompletableFuture<kotlinx.serialization.json.JsonElement?> {
        val gated = CompletableFuture<kotlinx.serialization.json.JsonElement?>()
        whenReady().whenComplete { _, error ->
            if (error != null) { gated.completeExceptionally(error); return@whenComplete }
            val terminal = terminalError
            if (terminal != null) { gated.completeExceptionally(IllegalStateException(terminal)); return@whenComplete }
            if (transport.isStopped) { gated.completeExceptionally(IllegalStateException("Standalone Core bus has been shut down.")); return@whenComplete }
            val id = requestId.getAndIncrement()
            val capturedEpoch = epoch
            pendingUiRequests[id] = gated
            gated.whenComplete { _, _ -> pendingUiRequests.remove(id) }
            if (epoch != capturedEpoch) return@whenComplete // 就绪等待期间连接已换代
            transport.send(uiRequestFrame(id, request))
        }
        return gated
    }

    private fun onCoreFrame(frame: JsonObject) {
        val kind = (frame["kind"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
        when (kind) {
            FrameKinds.EVENT -> {
                val event = frame["event"]?.let { it as? JsonObject } ?: return
                onCoreEvent?.invoke(event)
            }
            FrameKinds.REQUEST -> {
                val id = frame["id"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).longOrNull } ?: return
                val request = frame["request"]?.let { it as? JsonObject } ?: return
                val capturedEpoch = epoch
                val type = (request["type"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val handler = coreRequestHandlers[type]
                if (handler == null) {
                    transport.send(coreResponseFrame(id, ok = false, error = "No handler registered for core request $type."))
                    return
                }
                ioScope.launch {
                    val result = try {
                        handler(request)
                    } catch (e: Exception) {
                        log("[bus] core request $type failed: ${e.message}")
                        null
                    }
                    if (epoch == capturedEpoch) {
                        transport.send(coreResponseFrame(id, ok = true, result = result))
                    } else {
                        log("[bus] dropped stale response for request $id (connection changed)")
                    }
                }
            }
            FrameKinds.RESPONSE -> {
                val id = frame["id"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).longOrNull } ?: return
                val future = pendingUiRequests.remove(id) ?: return
                val ok = frame["ok"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).booleanOrNull } ?: false
                if (ok) future.complete(frame["result"]) // 形状无关：数组 / 对象 / null 都原样交给调用方
                else future.completeExceptionally(IllegalStateException((frame["error"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "core request failed"))
            }
        }
    }

    var onCoreEvent: ((JsonObject) -> Unit)? = null

    private fun failPendingUiRequests(reason: String) {
        for (future in pendingUiRequests.values) future.completeExceptionally(IllegalStateException(reason))
        pendingUiRequests.clear()
        val resolvers = synchronized(readyResolvers) { readyResolvers.toList().also { readyResolvers.clear() } }
        resolvers.forEach { it.completeExceptionally(IllegalStateException(reason)) }
    }

    private companion object {
        // 轻量协程域：CoreRequest 处理器是挂起函数，用独立池承载
        val ioScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO + kotlinx.coroutines.SupervisorJob())
    }
}
