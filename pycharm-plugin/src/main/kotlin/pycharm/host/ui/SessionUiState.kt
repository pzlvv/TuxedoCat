package pycharm.host.ui

import java.util.concurrent.ConcurrentHashMap

/**
 * 会话级 UI 运行态（对齐 src/host/SessionUiState.ts）：活动阶段（idle/thinking/text/tool）
 * 与查询 / 工具计数。线程安全（core IO 线程与 EDT 都会触达）。
 */
class SessionUiState {

    private data class Entry(
        var phase: String = "idle",
        var queryCount: Int = 0,
        var toolCount: Int = 0,
    )

    private val sessions = ConcurrentHashMap<String, Entry>()

    private fun entry(sessionId: String): Entry = sessions.computeIfAbsent(sessionId) { Entry() }

    fun markIdle(sessionId: String) { entry(sessionId).phase = "idle" }
    fun markThinking(sessionId: String) { entry(sessionId).phase = "thinking" }
    fun markText(sessionId: String) { entry(sessionId).phase = "text" }
    fun markToolPhase(sessionId: String) { entry(sessionId).phase = "tool" }

    fun beginToolPhase(sessionId: String) {
        val e = entry(sessionId)
        e.toolCount++
        e.phase = "tool"
    }

    fun endToolPhase(sessionId: String) {
        val e = entry(sessionId)
        if (e.toolCount > 0) e.toolCount--
        if (e.toolCount == 0) e.phase = "idle"
    }

    /** 返回 false 表示嵌套 begin（重复 queryBegin 忽略，对齐 SessionUiState.beginQuery） */
    fun beginQuery(sessionId: String): Boolean {
        val e = entry(sessionId)
        if (e.queryCount > 0) return false
        e.queryCount = 1
        return true
    }

    fun endQuery(sessionId: String): Boolean {
        val e = entry(sessionId)
        if (e.queryCount == 0) return false
        e.queryCount = 0
        return true
    }

    fun isQueryActive(sessionId: String): Boolean = sessions[sessionId]?.queryCount?.let { it > 0 } ?: false

    fun getActivityPhase(sessionId: String): String = sessions[sessionId]?.phase ?: "idle"

    fun dropSession(sessionId: String) { sessions.remove(sessionId) }
}
