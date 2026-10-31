package pycharm.host.ui

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * 用户选择队列 + 管理器（对齐 src/shared/UserChoiceQueue.ts + src/host/ui/userChoice.ts）：
 * - 每会话至多一个 pending，新请求顶替旧请求（旧 Promise 以「被顶替」错误结束）；
 * - 会话未 open 保留 pending，open / onSessionLoaded 时重投；
 * - 弹出时上报 userChoicePendingChanged(true)，应答或释放时 false；
 * - 会话关闭按补偿语义拒答（core 不悬挂）。
 */
class UserChoiceManager(
    private val postToWebview: (sessionId: String, message: JsonObject) -> Unit,
    private val closeDiffPreview: () -> Unit,
    private val emitUiEvent: (JsonObject) -> Unit,
    private val isSessionOpen: (sessionId: String) -> Boolean,
    private val log: (String) -> Unit,
) {

    data class PendingChoice(
        val sessionId: String,
        val options: JsonObject,
        val future: CompletableFuture<JsonObject>,
    )

    // ===== diff 快照（「当前请求」的全局暂存位 + 归属标记，对齐 saveDiffSnapshot）=====
    @Volatile var currentBeforeContent: String = ""; private set
    @Volatile var currentAfterContent: String = ""; private set
    var currentContextBefore: List<String> = emptyList(); private set
    var currentContextAfter: List<String> = emptyList(); private set
    @Volatile var currentStartLine: Int? = null; private set
    @Volatile var currentEndLine: Int? = null; private set
    @Volatile private var diffSnapshotSessionId: String? = null

    /** 已弹出、等待用户应答的确认（choiceId → 归属） */
    private val shownChoices = ConcurrentHashMap<String, ShownChoice>()
    /** 队列 pending（会话未 open 时保留） */
    private val pendingChoices = ConcurrentHashMap<String, PendingChoice>()

    data class ShownChoice(val sessionId: String, val future: CompletableFuture<JsonObject>)

    private fun emitUserChoicePending(sessionId: String, pending: Boolean) {
        emitUiEvent(buildJsonObject {
            put("type", "userChoicePendingChanged")
            put("sessionId", sessionId)
            put("pending", pending)
        })
    }

    fun saveDiffSnapshot(
        sessionId: String,
        beforeContent: String,
        afterContent: String,
        contextBefore: List<String>,
        contextAfter: List<String>,
        startLine: Int?,
        endLine: Int?,
    ) {
        diffSnapshotSessionId = sessionId
        currentBeforeContent = beforeContent
        currentAfterContent = afterContent
        currentContextBefore = contextBefore
        currentContextAfter = contextAfter
        currentStartLine = startLine
        currentEndLine = endLine
    }

    private fun clearDiffSnapshot() {
        diffSnapshotSessionId = null
        currentBeforeContent = ""
        currentAfterContent = ""
        currentContextBefore = emptyList()
        currentContextAfter = emptyList()
        currentStartLine = null
        currentEndLine = null
    }

    /** CoreRequest.userChoice 的入口（对齐 requestUserChoice：先入队，open 即投递） */
    fun requestUserChoice(sessionId: String, options: JsonObject): CompletableFuture<JsonObject> {
        val existing = pendingChoices[sessionId]
        if (existing != null) {
            existing.future.completeExceptionally(IllegalStateException("User choice was replaced by a new request"))
        }
        val future = CompletableFuture<JsonObject>()
        pendingChoices[sessionId] = PendingChoice(sessionId, options, future)
        if (isSessionOpen(sessionId)) {
            restoreUserChoiceIfPending(sessionId)
        }
        return future
    }

    /** 会话 open / 会话加载完成时重投（对齐 onShowUserChoice / onSessionLoaded） */
    fun restoreUserChoiceIfPending(sessionId: String) {
        val pending = pendingChoices[sessionId] ?: return
        log("[UserChoiceManager] Restoring pending user choice for session $sessionId")
        // 清理该会话旧的已弹条目（重投前重置 UI 状态）
        for ((choiceId, shown) in shownChoices) {
            if (shown.sessionId == sessionId) shownChoices.remove(choiceId)
        }
        postToWebview(sessionId, buildJsonObject {
            put("type", "showThinkingAnimation")
            put("show", false)
        })
        showUserChoice(sessionId, pending)
    }

    private fun showUserChoice(sessionId: String, pending: PendingChoice) {
        val options = pending.options
        val kind = (options["kind"] as? JsonPrimitive)?.content
        val choiceId = "choice-${System.currentTimeMillis()}-${(0..999).random()}"
        if (kind == "permission") {
            val contextBefore = (options["contextBefore"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                ?.filter { it.isNotBlank() && it != "undefined" } ?: emptyList()
            val contextAfter = (options["contextAfter"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                ?.filter { it.isNotBlank() && it != "undefined" } ?: emptyList()
            currentContextBefore = contextBefore
            currentContextAfter = contextAfter
            currentBeforeContent = (options["beforeContent"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
            currentAfterContent = (options["afterContent"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
            diffSnapshotSessionId = sessionId
        }
        postToWebview(sessionId, buildJsonObject {
            put("type", "requestUserChoice")
            put("choiceId", choiceId)
            put("toolName", (options["toolName"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "")
            if (kind == "question") {
                put("message", "")
                options["questions"]?.let { put("questions", it) }
            } else {
                put("message", (options["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "")
                options["choices"]?.let { put("choices", it) }
            }
        })
        emitUserChoicePending(sessionId, true)
        val shown = ShownChoice(sessionId, pending.future)
        shownChoices[choiceId] = shown
        // 从队列摘除：已进入「已弹出」状态
        pendingChoices.remove(sessionId, pending)
    }

    /** webview respondUserChoice 的处理（对齐 handleRespondUserChoice 的结果形状） */
    fun respond(choiceId: String, result: JsonObject): Boolean {
        val shown = shownChoices.remove(choiceId) ?: run {
            log("[UserChoiceManager] respond for unknown choiceId $choiceId, ignored")
            return false
        }
        closeDiffPreview()
        emitUserChoicePending(shown.sessionId, false)
        shown.future.complete(result)
        return true
    }

    /** 会话关闭的补偿拒答（core 不悬挂；对齐 dropSession） */
    fun dropSession(sessionId: String) {
        val pending = pendingChoices.remove(sessionId)
        pending?.future?.completeExceptionally(
            IllegalStateException("Session $sessionId closed before user choice was answered"),
        )
        var hadShown = false
        for ((choiceId, shown) in shownChoices) {
            if (shown.sessionId == sessionId) {
                shownChoices.remove(choiceId)
                hadShown = true
                shown.future.completeExceptionally(
                    IllegalStateException("Session $sessionId closed before user choice was answered"),
                )
            }
        }
        if (hadShown) emitUserChoicePending(sessionId, false)
        if (diffSnapshotSessionId == sessionId) clearDiffSnapshot()
    }

    fun hasPendingChoice(sessionId: String): Boolean {
        if (pendingChoices.containsKey(sessionId)) return true
        return shownChoices.values.any { it.sessionId == sessionId }
    }
}
