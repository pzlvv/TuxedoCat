package pycharm.host.ui

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * 工具处理（对齐 src/host/ui/toolHandler.ts 的「展示」职责，权限加工全在 core 的
 * PermissionPolicy）：上架卡片、Edit/Write 的 diff 快照暂存、manual 模式的 IDE diff、
 * 运行/失败状态更新、`_meta` 追加写（append-only 落盘）。
 */
class ToolHandler(
    private val postToWebview: (sessionId: String, message: JsonObject) -> Unit,
    private val userChoiceManager: UserChoiceManager,
    private val diffService: pycharm.host.ide.DiffService,
    private val writeToolMeta: (sessionId: String, toolUseId: String, meta: JsonObject) -> Unit,
    private val log: (String) -> Unit,
) {

    /** CoreRequest.toolPermissionRequested 的处理方（对齐 requestToolPermission） */
    fun requestToolPermission(
        sessionId: String,
        toolUseId: String,
        toolName: String,
        permResult: JsonObject,
        displayArgs: JsonObject,
        agentMode: String,
    ): JsonObject {
        val toolCallId = toolUseId
        // 只有本次权限结果确实携带 diff 字段时才保存快照（否则会把上一次 Edit/Write 的
        // diff 错误挂到本次失败卡片上，对齐 hasPermDiff 判定）
        val hasPermDiff = (toolName == "Edit" || toolName == "Write") && permResult.containsKey("beforeContent")
        log("[ToolHandler] requestToolPermission: $toolName (toolCallId: $toolCallId) hasPermDiff=$hasPermDiff agentMode=$agentMode permKeys=${permResult.keys}")
        if (hasPermDiff) {
            userChoiceManager.saveDiffSnapshot(
                sessionId,
                beforeContent = (permResult["beforeContent"] as? JsonPrimitive)?.let { if (it.isString) it.content else "" } ?: "",
                afterContent = (permResult["afterContent"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "",
                contextBefore = (permResult["contextBefore"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull } ?: emptyList(),
                contextAfter = (permResult["contextAfter"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull } ?: emptyList(),
                startLine = (permResult["startLine"] as? JsonPrimitive)?.content?.toIntOrNull(),
                endLine = (permResult["endLine"] as? JsonPrimitive)?.content?.toIntOrNull(),
            )
        }

        // 授权前先显示这次改动：卡片 normal 状态（diff 在卡片内完整展开由 webview 行为自带）
        postToWebview(sessionId, buildJsonObject {
            put("type", "addMessage")
            put("role", "toolcall")
            put("content", "")
            put("param", "⚙️ $toolName")
            put("toolName", toolName)
            put("toolArgs", displayArgs)
            put("status", "normal")
            put("toolCallId", toolCallId)
        })

        // 只有 manual 模式才在宿主侧打开 IDE diff（auto/risk 自动放行，再弹原生 diff 只会打扰）
        if (hasPermDiff && agentMode == "manual") {
            val filePath = (displayArgs["file_path"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            diffService.showDiff(
                title = filePath ?: toolName,
                beforeContent = userChoiceManager.currentBeforeContent,
                afterContent = userChoiceManager.currentAfterContent,
                sessionId = sessionId,
            )
        }

        // 异步追加写入 block 顶层 _meta（append-only；只服务 UI 的 diff 展示与回滚）
        if (hasPermDiff) {
            val meta = buildJsonObject {
                put("beforeContent", userChoiceManager.currentBeforeContent)
                put("afterContent", userChoiceManager.currentAfterContent)
                put("contextBefore", JsonArray(userChoiceManager.currentContextBefore.map { JsonPrimitive(it) }))
                put("contextAfter", JsonArray(userChoiceManager.currentContextAfter.map { JsonPrimitive(it) }))
                userChoiceManager.currentStartLine?.let { put("startLine", it) }
                userChoiceManager.currentEndLine?.let { put("endLine", it) }
            }
            writeToolMeta(sessionId, toolUseId, meta)
        }
        return permResult
    }

    /** CoreEvent.toolCall → 卡片进入 running（对齐 onToolCall） */
    fun onToolCall(sessionId: String, toolUseId: String, toolName: String) {
        log("[ToolHandler] Tool call start: $toolName (toolCallId: $toolUseId)")
        postToWebview(sessionId, buildJsonObject {
            put("type", "updateToolStatus")
            put("toolCallId", toolUseId)
            put("status", "running")
        })
    }

    /** CoreEvent.toolResult → 状态更新 + Edit 失败清 diff（对齐 onToolResult） */
    fun onToolResult(sessionId: String, toolUseId: String, toolName: String, output: String, status: String) {
        val toolCallId = toolUseId
        if (toolName == "Edit") {
            if (status == "error") {
                log("[ToolHandler] Edit tool failed, clearing diff display")
                postToWebview(sessionId, buildJsonObject {
                    put("type", "updateToolArgs")
                    put("toolCallId", toolCallId)
                    put("beforeContent", "")
                    put("afterContent", "")
                    put("diffHunks", JsonArray(emptyList()))
                    put("contextBefore", JsonArray(emptyList()))
                    put("contextAfter", JsonArray(emptyList()))
                })
            } else {
                val outputObj = try { kotlinx.serialization.json.Json.parseToJsonElement(output).jsonObject } catch (_: Exception) { null }
                val hasContext = (outputObj?.get("hasContext") as? JsonPrimitive)?.content.toBoolean() || status == "success"
                if (hasContext) {
                    postToWebview(sessionId, buildJsonObject {
                        put("type", "updateToolArgs")
                        put("toolCallId", toolCallId)
                        put("contextBefore", outputObj?.get("contextBefore")
                            ?: JsonArray(userChoiceManager.currentContextBefore.map { JsonPrimitive(it) }))
                        put("contextAfter", outputObj?.get("contextAfter")
                            ?: JsonArray(userChoiceManager.currentContextAfter.map { JsonPrimitive(it) }))
                        val sl = outputObj?.get("startLine")?.let { (it as? JsonPrimitive)?.content?.toIntOrNull() }
                            ?: userChoiceManager.currentStartLine
                        val el = outputObj?.get("endLine")?.let { (it as? JsonPrimitive)?.content?.toIntOrNull() }
                            ?: userChoiceManager.currentEndLine
                        sl?.let { put("startLine", it) }
                        el?.let { put("endLine", it) }
                    })
                }
            }
        }

        val statusUpdate = buildJsonObject {
            put("type", "updateToolStatus")
            put("toolCallId", toolCallId)
            put("status", if (status == "error") "fail" else "success")
            put("output", output)
            if (toolName == "Edit" && status == "success") {
                userChoiceManager.currentStartLine?.let { put("startLine", it) }
                userChoiceManager.currentEndLine?.let { put("endLine", it) }
            }
        }
        postToWebview(sessionId, statusUpdate)
    }
}
