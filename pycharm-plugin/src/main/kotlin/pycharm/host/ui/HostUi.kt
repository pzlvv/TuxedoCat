package pycharm.host.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import pycharm.host.core.CoreBus
import pycharm.host.history.SessionHistory
import pycharm.host.settings.SettingsStore
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import kotlinx.coroutines.launch

/**
 * 对话管理（对齐 src/host/ConversationManager.ts 的最小职责）：
 * 会话运行态快照缓存（sessionRuntimeChanged 的唯一消费方）与对话列表刷新
 * （conversationListRequested → conversationsData 推送）。
 */
class ConversationManager(
    private val homeDir: Path,
    private val configDirName: String,
    private val workspacePath: String?,
    private val bus: CoreBus,
    private val sendToWebview: (message: JsonObject) -> Unit,
    private val log: (String) -> Unit,
) {

    /** 最近一次会话运行时状态快照（按会话 id 索引） */
    @Volatile var sessionStates: List<JsonObject> = emptyList(); private set

    fun updateSessionStates(states: JsonArray) {
        sessionStates = states.mapNotNull { it as? JsonObject }
        pushSessionRuntimeStates()
    }

    /** 全量推送（webview 启动 / 切换视图时也会主动拉一次） */
    fun pushSessionRuntimeStates() {
        sendToWebview(buildJsonObject {
            put("type", "sessionRuntimeStates")
            put("states", JsonArray(sessionStates))
        })
    }

    fun findRuntimeState(sessionId: String): JsonObject? = sessionStates.firstOrNull {
        (it["sessionId"] as? JsonPrimitive)?.content == sessionId
    }

    /** 会话是否空闲（sendMessage 排队判定读这里） */
    fun isSessionIdle(sessionId: String): Boolean =
        findRuntimeState(sessionId)?.get("idle")?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: true

    /** 对话列表刷新（core 事实，经 conversationListRequested） */
    fun refresh() {
        busScope.launch {
            try {
                val result = bus.requestCore(buildJsonObject {
                    put("type", "conversationListRequested")
                    workspacePath?.let { put("workspacePath", it) }
                })?.awaitResult()
                val conversations = result?.get("conversations") ?: JsonArray(emptyList())
                sendToWebview(buildJsonObject {
                    put("type", "conversationsData")
                    put("conversations", conversations)
                })
            } catch (e: Exception) {
                log("[conversations] refresh failed: ${e.message}")
            }
        }
    }

    private companion object {
        val busScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO + kotlinx.coroutines.SupervisorJob())
    }
}

/**
 * 宿主 UI 核心（WebViewUI + WebviewMessageHandler 的 Kotlin 移植）：
 * CoreEvent → HostToWebview wire 翻译、WebviewToHost → UiEvent/UiRequest 翻译、
 * 工具卡片与确认流、会话生命周期。载荷 JsonObject 透传；协议唯一来源
 * src/host/webviewMessages.ts（映射逐条对齐，字段名单有测试锁定）。
 */
class HostUi(
    private val project: Any?,
    val homeDir: Path,
    val configDirName: String,
    val workspacePath: String?,
    val bus: CoreBus,
    private val settingsStore: SettingsStore,
    val diffService: pycharm.host.ide.DiffService,
    val fileJumpService: pycharm.host.ide.FileJumpService,
    private val pluginRoot: Path?,
    val log: (String) -> Unit,
) {

    val sessionUi = SessionUiState()
    val conversationManager = ConversationManager(
        homeDir, configDirName, workspacePath, bus, { message -> sendToWebview(message) }, log,
    )

    private val closeDiffPreview = { diffService.closeCurrent("user-choice-answered") }
    val userChoiceManager = UserChoiceManager(
        postToWebview = ::postToWebview,
        closeDiffPreview = closeDiffPreview,
        emitUiEvent = { bus.emitToCore(it) },
        isSessionOpen = { sessionId -> trackedActiveSessionId == sessionId },
        log = log,
    )
    val toolHandler = ToolHandler(
        postToWebview = ::postToWebview,
        userChoiceManager = userChoiceManager,
        diffService = diffService,
        writeToolMeta = { sessionId, toolUseId, meta -> writeToolUseMeta(sessionId, toolUseId, meta) },
        log = log,
    )

    /** webview 下行入口（PanelController 注入） */
    var sendToWebview: (message: JsonObject) -> Unit = {}

    /** 当前活跃会话（UI 自己的状态，principles 第 7 节） */
    @Volatile var trackedActiveSessionId: String? = null

    fun postToWebview(sessionId: String, message: JsonObject) {
        val withSession = JsonObject(message + ("sessionId" to JsonPrimitive(sessionId)))
        sendToWebview(withSession)
    }

    private fun str(obj: JsonObject, key: String): String = (obj[key] as? JsonPrimitive)?.contentOrNull ?: ""
    private fun optStr(obj: JsonObject, key: String): String? = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun optInt(obj: JsonObject, key: String): Int? = (obj[key] as? JsonPrimitive)?.content?.toIntOrNull()

    // ==================== CoreEvent → webview（对齐 buildCoreEventHandlers）====================

    fun onCoreEvent(event: JsonObject) {
        val type = str(event, "type")
        val sessionId = optStr(event, "sessionId")
        when (type) {
            "coreReady" -> log("[ui] coreReady")
            "message" -> {
                val data = event["data"]?.jsonObject ?: return
                postToWebview(sessionId!!, JsonObject(data + ("type" to JsonPrimitive("addMessage"))))
                if ((data["role"] as? JsonPrimitive)?.content == "user") conversationManager.refresh()
            }
            "streamMessage" -> {
                val data = event["data"]?.jsonObject ?: return
                val role = str(data, "role")
                val accumulated = optStr(data, "accumulated") ?: ""
                if (role == "assistant" && accumulated.isBlank()) return
                if (role == "assistant") sessionUi.markText(sessionId!!) else sessionUi.markThinking(sessionId!!)
                postToWebview(sessionId!!, buildJsonObject {
                    put("type", "streamMessage")
                    put("role", role)
                    put("delta", str(data, "delta"))
                    put("accumulated", accumulated)
                    data["streamId"]?.let { put("streamId", it) }
                })
            }
            "streamEnd" -> {
                val data = event["data"]?.jsonObject ?: return
                postToWebview(sessionId!!, buildJsonObject {
                    put("type", "streamEnd")
                    put("role", str(data, "role"))
                    put("accumulated", str(data, "accumulated"))
                    data["usage"]?.let { put("usage", it) }
                    data["streamId"]?.let { put("streamId", it) }
                })
            }
            "toolCall" -> {
                sessionUi.markToolPhase(sessionId!!)
                toolHandler.onToolCall(sessionId, str(event, "toolUseId"), str(event, "toolName"))
            }
            "toolResult" -> {
                sessionUi.endToolPhase(sessionId!!)
                toolHandler.onToolResult(sessionId, str(event, "toolUseId"), str(event, "toolName"), str(event, "output"), str(event, "status"))
            }
            "toolArgsUpdated" -> postToWebview(sessionId!!, buildJsonObject {
                put("type", "updateToolArgs")
                put("toolCallId", str(event, "toolUseId"))
                put("toolArgs", event["args"] ?: JsonObject(emptyMap()))
            })
            "toolProgress" -> {
                val progress = event["progress"]?.jsonObject ?: JsonObject(emptyMap())
                postToWebview(sessionId!!, buildJsonObject {
                    put("type", "toolProgress")
                    put("toolCallId", str(event, "toolUseId"))
                    progress.forEach { (k, v) -> put(k, v) }
                })
            }
            "aiBegin" -> {
                sessionUi.markThinking(sessionId!!)
                postToWebview(sessionId, buildJsonObject { put("type", "showThinkingAnimation"); put("show", true) })
                postToWebview(sessionId, buildJsonObject { put("type", "aiBegin") })
                fetchBalance(sessionId)
            }
            "aiEnd" -> {
                sessionUi.markIdle(sessionId!!)
                postToWebview(sessionId, buildJsonObject { put("type", "showThinkingAnimation"); put("show", false) })
                postToWebview(sessionId, buildJsonObject { put("type", "aiEnd") })
            }
            "messagesReplaced" -> postToWebview(sessionId!!, buildJsonObject {
                put("type", "messagesReplaced")
                put("messages", event["messages"] ?: JsonArray(emptyList()))
            })
            "queryBegin" -> {
                if (!sessionUi.beginQuery(sessionId!!)) { log("Ignoring nested queryBegin for session: $sessionId"); return }
                sessionUi.markThinking(sessionId)
                postToWebview(sessionId, buildJsonObject { put("type", "showThinkingAnimation"); put("show", true) })
                postToWebview(sessionId, buildJsonObject { put("type", "queryBegin") })
            }
            "queryEnd" -> {
                if (!sessionUi.endQuery(sessionId!!)) { log("Ignoring redundant queryEnd for session: $sessionId"); return }
                sessionUi.markIdle(sessionId)
                postToWebview(sessionId, buildJsonObject { put("type", "showThinkingAnimation"); put("show", false) })
                postToWebview(sessionId, buildJsonObject { put("type", "queryEnd") })
                conversationManager.refresh()
            }
            "titleChanged" -> postToWebview(sessionId!!, buildJsonObject { put("type", "setTitle"); put("title", str(event, "title")) })
            "sessionCreated" -> postToWebview(sessionId!!, buildJsonObject { put("type", "initSessionState") })
            "conversationListChanged" -> conversationManager.refresh()
            "sessionRuntimeChanged" -> conversationManager.updateSessionStates(event["states"] as? JsonArray ?: JsonArray(emptyList()))
            "todosChanged" -> postToWebview(sessionId!!, buildJsonObject {
                put("type", "sessionTodos")
                put("todos", event["todos"] ?: JsonArray(emptyList()))
            })
            "workModeChanged" -> postToWebview(sessionId!!, buildJsonObject { put("type", "setWorkMode"); put("workMode", str(event, "workMode")) })
            "highlightLanguagesUsed" -> {
                val languages = (event["languages"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                try { settingsStore.recordHighlightLanguages(languages) } catch (e: Exception) { log("Failed to record highlight languages: ${e.message}") }
            }
            "compactBegin" -> postToWebview(sessionId!!, buildJsonObject { put("type", "compressProgress"); put("status", "start") })
            "compactEnd" -> {
                val result = event["result"]?.jsonObject ?: JsonObject(emptyMap())
                val status = str(result, "status")
                postToWebview(sessionId!!, buildJsonObject {
                    put("type", "compressProgress")
                    put("status", if (status == "complete") "complete" else "error")
                    if (status == "complete") result["postCompactTokenCount"]?.let { put("postCompactTokenCount", it) }
                })
            }
            "sessionConfigChanged" -> {
                val change = event["change"]?.jsonObject ?: return
                val sid = sessionId!!
                when (str(change, "key")) {
                    "model" -> {
                        val ref = change["ref"]?.jsonObject ?: return
                        postToWebview(sid, buildJsonObject {
                            put("type", "setModel")
                            put("model", str(ref, "model"))
                            ref["provider"]?.let { put("provider", it) }
                        })
                    }
                    "thinkingEffort" -> postToWebview(sid, buildJsonObject { put("type", "setThinkingMode"); put("mode", str(change, "value")) })
                    "promptMode" -> postToWebview(sid, buildJsonObject { put("type", "setPromptMode"); put("mode", str(change, "value")) })
                    "agentMode" -> postToWebview(sid, buildJsonObject { put("type", "setAgentMode"); put("mode", str(change, "value")) })
                    "webSearch" -> postToWebview(sid, buildJsonObject { put("type", "setWebSearch"); put("webSearch", change["webSearch"] ?: change["value"] ?: JsonPrimitive(false)) })
                    "mcpEnabled" -> pushMcpServers(sid)
                }
            }
            "notice" -> postToWebview(sessionId!!, buildJsonObject {
                put("type", "notice")
                put("key", str(event, "key"))
                put("params", event["params"] ?: JsonObject(emptyMap()))
                put("level", str(event, "level"))
            })
            "conversationSpaceCleared" -> {
                val result = event["result"]?.jsonObject ?: return
                if (str(result, "status") == "complete") {
                    sendToWebview(buildJsonObject {
                        put("type", "conversationSpaceCleared")
                        put("dirName", str(event, "dirName"))
                        put("removedFiles", result["removedFiles"] ?: JsonPrimitive(0))
                        put("removedBytes", result["removedBytes"] ?: JsonPrimitive(0))
                    })
                } else {
                    sendToWebview(buildJsonObject { put("type", "conversationSpacesError"); put("error", str(result, "message")) })
                }
            }
            // 跨工作区与远程监听能力 v1 声明不支持（能力位 false，core 不会派发）；日志留痕
            "workspaceFileChanged" -> log("[ui] workspaceFileChanged ignored (capability not supported)")
            "spinDesignDataChanged" -> log("[ui] spinDesignDataChanged ignored (no designer surface)")
            "commandDispatched" -> {
                // 内置命令就地执行：清排队项（对齐 onCommandSend 的排队清理；spin 设计器无 surface）
                postToWebview(sessionId ?: return, buildJsonObject { put("type", "clearQueuedMessage") })
            }
            "crossWorkspaceAgentReplyRequested", "crossWorkspaceAgentAbortRequested", "crossWorkspaceAgentEnded" ->
                log("[ui] cross-workspace event ignored (capability not supported)")
            "log" -> log(str(event, "message"))
            else -> log("[ui] unknown core event type: $type")
        }
    }

    // ==================== CoreRequest 处理（对齐 buildCoreRequestHandlers）====================

    suspend fun onCoreRequest(request: JsonObject): JsonObject? {
        val type = str(request, "type")
        return when (type) {
            "toolPermissionRequested" -> toolHandler.requestToolPermission(
                sessionId = str(request, "sessionId"),
                toolUseId = str(request, "toolUseId"),
                toolName = str(request, "toolName"),
                permResult = request["permResult"]?.jsonObject ?: JsonObject(emptyMap()),
                displayArgs = request["displayArgs"]?.jsonObject ?: JsonObject(emptyMap()),
                agentMode = str(request, "agentMode"),
            )
            "userChoice" -> {
                val sessionId = str(request, "sessionId")
                val options = request["options"]?.jsonObject ?: JsonObject(emptyMap())
                userChoiceManager.requestUserChoice(sessionId, options).awaitResult()
            }
            // 能力位 false，core 不应派发；如实报错不悬挂
            "crossWorkspaceAgentRequested" -> buildJsonObject { put("error", "cross-workspace agent is not supported by this host") }
            "crossWorkspaceTransferRequested" -> buildJsonObject { put("error", "cross-workspace transfer is not supported by this host") }
            else -> {
                log("[ui] no handler for core request $type")
                null
            }
        }
    }

    // ==================== webview → 宿主（对齐 buildMessageHandlers）====================

    fun handleWebviewMessage(message: JsonObject) {
        val type = str(message, "type")
        try {
            when (type) {
                // ===== UiEvent 翻译 =====
                "sendMessage" -> handleUserMessage(message)
                "abort" -> {
                    val sessionId = optStr(message, "sessionId") ?: return
                    bus.emitToCore(buildJsonObject { put("type", "abortRequested"); put("sessionId", sessionId) })
                }
                "requestCompress" -> bus.emitToCore(buildJsonObject { put("type", "compactRequested"); put("sessionId", str(message, "sessionId")) })
                "backgroundBashTool" -> bus.emitToCore(buildJsonObject {
                    put("type", "bashBackgroundRequested"); put("sessionId", str(message, "sessionId")); put("toolUseId", str(message, "toolUseId"))
                })
                "discardQueuedMessage" -> bus.emitToCore(buildJsonObject {
                    put("type", "queuedMessageDiscarded"); put("sessionId", str(message, "sessionId")); put("uuid", str(message, "uuid"))
                })
                "deleteConversation" -> bus.emitToCore(buildJsonObject { put("type", "conversationDeleted"); put("sessionId", str(message, "sessionId")) })
                "renameConversation" -> bus.emitToCore(buildJsonObject {
                    put("type", "conversationRenamed"); put("sessionId", str(message, "sessionId")); put("title", str(message, "title"))
                })
                "rollbackEdit" -> bus.emitToCore(buildJsonObject {
                    put("type", "editRolledBack"); put("sessionId", str(message, "sessionId"))
                    put("toolUseId", str(message, "toolUseId")); put("direction", str(message, "direction"))
                    optStr(message, "filePath")?.let { put("filePath", it) }
                })
                "clearConversationSpace" -> bus.emitToCore(buildJsonObject {
                    put("type", "conversationSpaceCleared"); put("dirName", str(message, "dirName")); put("mode", str(message, "mode"))
                })
                "setThinkingMode" -> bus.emitToCore(buildJsonObject {
                    put("type", "thinkingEffortChanged"); put("sessionId", str(message, "sessionId")); put("mode", str(message, "mode"))
                })
                "setPromptMode" -> bus.emitToCore(buildJsonObject {
                    put("type", "promptModeChanged"); put("sessionId", str(message, "sessionId")); put("mode", str(message, "mode"))
                })
                "setAgentMode" -> bus.emitToCore(buildJsonObject {
                    put("type", "agentModeChanged"); put("sessionId", str(message, "sessionId")); put("mode", str(message, "mode"))
                })
                "setWebSearch" -> bus.emitToCore(buildJsonObject {
                    put("type", "webSearchChanged"); put("sessionId", str(message, "sessionId")); put("enabled", (message["webSearch"] as? JsonPrimitive)?.booleanOrNullCompat() ?: false)
                })
                "setMcpEnabled" -> {
                    val sessionId = optStr(message, "sessionId") ?: return
                    bus.emitToCore(buildJsonObject {
                        put("type", "mcpEnabledChanged"); put("sessionId", sessionId)
                        put("name", str(message, "name")); put("enabled", (message["enabled"] as? JsonPrimitive)?.booleanOrNullCompat() ?: false)
                    })
                }
                "setMcpEnabledList" -> {
                    val sessionId = optStr(message, "sessionId") ?: return
                    bus.emitToCore(buildJsonObject {
                        put("type", "mcpEnabledListChanged"); put("sessionId", sessionId)
                        put("names", message["names"] ?: JsonArray(emptyList()))
                    })
                }
                // ===== 会话生命周期 =====
                "startNewConversation" -> handleStartNewConversation(message)
                "loadConversation" -> handleLoadConversation(str(message, "sessionId"))
                "getConversations" -> conversationManager.refresh()
                "requestSessionRuntimeStates" -> conversationManager.pushSessionRuntimeStates()
                "updateConversationContext" -> handleUpdateConversationContext(message)
                "openFile" -> {
                    val filePath = str(message, "filePath")
                    log("[ui] openFile received: $filePath")
                    if (filePath.isNotEmpty()) {
                        val lines = message["selectedLines"]?.jsonObject
                        val pair = lines?.let {
                            val s = (it["start"] as? JsonPrimitive)?.content?.toIntOrNull() ?: return@let null
                            val e = (it["end"] as? JsonPrimitive)?.content?.toIntOrNull() ?: return@let null
                            s to e
                        }
                        fileJumpService.openFile(filePath, pair)
                    }
                }
                "openUrl" -> {
                    val url = str(message, "url")
                    if (url.isNotEmpty()) com.intellij.ide.BrowserUtil.browse(url)
                }
                "requestTheme" -> {
                    // IDE 主题 → webview（对齐 VS Code activeColorTheme.kind）
                    val dark = !com.intellij.util.ui.UIUtil.isUnderWin10LookAndFeel() &&
                        com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().isDarkEditor
                    sendToWebview(buildJsonObject { put("type", "setTheme"); put("theme", if (dark) "dark" else "light") })
                }
                "requestToolMeta" -> handleRequestToolMeta(message)
                // ===== 查询类（core 事实）=====
                "requestSessionTodos" -> busRequestToWebview(
                    buildJsonObject { put("type", "sessionTodosRequested"); put("sessionId", str(message, "sessionId")) },
                ) { result -> buildJsonObject {
                    put("type", "sessionTodos")
                    put("sessionId", str(message, "sessionId"))
                    put("todos", result?.get("todos") ?: JsonArray(emptyList()))
                } }
                "requestSkills" -> busRequestToWebview(
                    buildJsonObject { put("type", "skillsRequested"); trackedActiveSessionId?.let { put("sessionId", it) } },
                ) { result -> buildJsonObject {
                    put("type", "setSkills")
                    put("skills", result?.get("skills") ?: JsonArray(emptyList()))
                } }
                "requestMcpServers" -> pushMcpServers(optStr(message, "sessionId") ?: trackedActiveSessionId)
                "requestModels" -> sendToWebview(buildJsonObject {
                    put("type", "setModels")
                    put("providers", providersPayload())
                    put("activeProvider", activeProviderKey())
                })
                "requestSettingsDefaults" -> sendToWebview(settingsDefaultsMessage())
                "requestLLMConfig" -> sendToWebview(llmConfigPanelMessage())
                "requestContextLimit" -> pushContextLimit()
                "respondUserChoice" -> {
                    val result = buildJsonObject {
                        if (message.containsKey("answers")) {
                            put("kind", "question")
                            put("answers", message["answers"] ?: JsonArray(emptyList()))
                        } else {
                            put("kind", "permission")
                            put("index", message["index"] ?: JsonPrimitive(0))
                            put("reply", optStr(message, "reply")?.let { JsonPrimitive(it) } ?: JsonNull)
                        }
                    }
                    userChoiceManager.respond(str(message, "choiceId"), result)
                }
                "saveLLMConfig" -> pycharm.host.llm.LlmConfigSave.handleSave(settingsStore, message, log) { sendToWebview(it) }
                "fetchProviderModels" -> pycharm.host.llm.ProviderProbe.fetch(message) { sendToWebview(it) }
                "detectProviderModelApiTypes" -> pycharm.host.llm.ProviderProbe.detect(message) { sendToWebview(it) }
                "requestSmartNaming" -> busRequestToWebview(
                    buildJsonObject { put("type", "smartNamingRequested"); put("sessionId", str(message, "sessionId")) },
                ) { buildJsonObject { put("type", "smartNamingResult"); put("sessionId", str(message, "sessionId")) } }
                "requestConversationSpaces" -> busRequestToWebview(
                    buildJsonObject { put("type", "conversationSpacesRequested") },
                ) { result -> buildJsonObject {
                    put("type", "conversationSpacesData")
                    put("spaces", result?.get("spaces") ?: JsonArray(emptyList()))
                } }
                "expandCompact" -> busRequestToWebview(
                    buildJsonObject { put("type", "compactArchiveRequested"); put("sessionId", str(message, "sessionId")) },
                ) { result -> buildJsonObject {
                    put("type", "expandCompactDone")
                    put("sessionId", str(message, "sessionId"))
                    if (result?.get("messages") != null) {
                        put("_expandPayload", result["messages"]!!)
                    }
                } }
                "debugLog" -> log("[Webview Debug] ${str(message, "message")}")
                "closeWebview", "openWorkspace", "openNewConversation", "openConversation", "showVirtualDocument",
                "openMermaidPreview", "openSpinDesign", "prewarmViewReady" ->
                    log("[ui] webview message '$type' ignored (surface not supported by this host)")
                // 双向消息（setModel 等）单独路由
                "setModel" -> {
                    val provider = optStr(message, "provider")
                    val model = optStr(message, "model")
                    if (provider.isNullOrBlank() || model.isNullOrBlank()) {
                        log("[WebviewMessageHandler] setModel: provider 为空（非法），忽略")
                    } else {
                        bus.emitToCore(buildJsonObject {
                            put("type", "modelChanged")
                            put("sessionId", str(message, "sessionId"))
                            put("ref", buildJsonObject { put("provider", provider); put("model", model) })
                        })
                    }
                }
                else -> log("[ui] unknown webview message type: $type")
            }
        } catch (e: Exception) {
            log("[WebviewMessageHandler] handleWebviewMessage failed for type=$type: ${e.message}")
        }
    }

    private fun JsonPrimitive.booleanOrNullCompat(): Boolean? = this.content.toBooleanStrictOrNull()

    private fun busRequestToWebview(request: JsonObject, build: (JsonObject?) -> JsonObject) {
        busScope.launch {
            try {
                val result = bus.requestCore(request)?.awaitResult()
                sendToWebview(build(result))
            } catch (e: Exception) {
                log("[ui] core request ${str(request, "type")} failed: ${e.message}")
            }
        }
    }

    private fun providersPayload(): JsonArray {
        val snapshot = settingsStore.getSnapshot()
        val llm = snapshot["llm"]?.jsonObject ?: return JsonArray(emptyList())
        val providers = llm["providers"]?.jsonObject ?: return JsonArray(emptyList())
        return JsonArray(providers.map { (key, value) ->
            val entry = value.jsonObject
            val limits = entry["modelLimits"]?.jsonObject ?: JsonObject(emptyMap())
            buildJsonObject {
                put("key", key)
                put("baseURL", (entry["baseURL"] as? JsonPrimitive)?.contentOrNull ?: "")
                put("apiKey", (entry["apiKey"] as? JsonPrimitive)?.contentOrNull ?: "")
                put("models", entry["models"] ?: JsonArray(emptyList()))
                entry["defaultModel"]?.let { put("defaultModel", it) }
                put("modelConfigs", buildJsonObject {
                    for ((model, limitsEntry) in limits) {
                        val l = limitsEntry.jsonObject
                        put(model, buildJsonObject {
                            put("context", l["context"] ?: JsonPrimitive(0))
                            put("output", l["output"] ?: JsonPrimitive(0))
                            put("apiType", l["apiType"] ?: JsonPrimitive("OpenAI"))
                            put("multimodal", l["multimodal"] ?: JsonPrimitive(true))
                        })
                    }
                })
            }
        })
    }

    private fun activeProviderKey(): String = try {
        (settingsStore.getSnapshot()["llm"]?.jsonObject?.get("activeProvider") as? JsonPrimitive)?.contentOrNull ?: ""
    } catch (_: Exception) { "" }

    private fun settingsDefaultsMessage(): JsonObject {
        val snapshot = settingsStore.getSnapshot()
        val llm = snapshot["llm"]?.jsonObject ?: JsonObject(emptyMap())
        val activeKey = (llm["activeProvider"] as? JsonPrimitive)?.contentOrNull ?: ""
        val provider = if (activeKey.isNotEmpty()) llm["providers"]?.jsonObject?.get(activeKey)?.jsonObject else null
        val defaultModel = provider?.get("defaultModel")?.jsonPrimitive?.contentOrNull ?: ""
        return buildJsonObject {
            put("type", "settingsDefaults")
            put("model", defaultModel)
            if (activeKey.isNotEmpty()) put("provider", activeKey)
            put("thinkingMode", (llm["thinkingEffort"] as? JsonPrimitive)?.contentOrNull ?: "high")
            put("defaultAgentMode", (snapshot["defaultAgentMode"] as? JsonPrimitive)?.contentOrNull ?: "risk")
            put("defaultPromptMode", (snapshot["defaultPromptMode"] as? JsonPrimitive)?.contentOrNull ?: "normal")
            put("webSearch", (llm["webSearch"] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull() ?: true)
            put("language", settingsStore.readUiLanguage())
            put("fontSize", settingsStore.readUiFontSize())
            put("providerConfigured", activeKey.isNotEmpty() && !(provider?.get("apiKey")?.jsonPrimitive?.contentOrNull.isNullOrEmpty()))
        }
    }

    private fun llmConfigPanelMessage(): JsonObject {
        settingsStore.refreshFromDisk()
        val snapshot = settingsStore.getSnapshot()
        val llm = snapshot["llm"]?.jsonObject ?: JsonObject(emptyMap())
        val activeKey = (llm["activeProvider"] as? JsonPrimitive)?.contentOrNull ?: ""
        val provider = if (activeKey.isNotEmpty()) llm["providers"]?.jsonObject?.get(activeKey)?.jsonObject else null
        val message = buildJsonObject {
            put("type", "showLLMConfig")
            put("baseURL", provider?.get("baseURL")?.jsonPrimitive?.contentOrNull ?: pycharm.host.llm.ProviderProbe.DEEPSEEK_BASE_URL)
            put("apiKey", provider?.get("apiKey")?.jsonPrimitive?.contentOrNull ?: "")
            put("webSearch", (llm["webSearch"] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull() ?: true)
            put("thinkingEffort", (llm["thinkingEffort"] as? JsonPrimitive)?.contentOrNull ?: "high")
            put("defaultModel", provider?.get("defaultModel")?.jsonPrimitive?.contentOrNull ?: "")
            put("defaultAgentMode", (snapshot["defaultAgentMode"] as? JsonPrimitive)?.contentOrNull ?: "risk")
            put("defaultPromptMode", (snapshot["defaultPromptMode"] as? JsonPrimitive)?.contentOrNull ?: "normal")
            put("providers", providersPayload())
            put("activeProvider", activeKey)
            put("language", settingsStore.readUiLanguage())
            put("fontSize", settingsStore.readUiFontSize())
        }
        return message
    }

    private fun pushContextLimit() {
        busScope.launch {
            try {
                val snapshot = settingsStore.getSnapshot()
                val llm = snapshot["llm"]?.jsonObject
                val fallback = llm?.get("modelLimitsFallback")?.jsonObject
                val max = (fallback?.get("context") as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L
                sendToWebview(buildJsonObject { put("type", "contextLimitUpdated"); put("maxContextTokens", max) })
            } catch (e: Exception) {
                log("[ui] pushContextLimit failed: ${e.message}")
            }
        }
    }

    private fun pushMcpServers(sessionId: String?) {
        busScope.launch {
            try {
                val request = buildJsonObject { put("type", "mcpServersRequested"); sessionId?.let { put("sessionId", it) } }
                val result = bus.requestCore(request)?.awaitResult()
                sendToWebview(buildJsonObject {
                    put("type", "setMcpServers")
                    sessionId?.let { put("sessionId", it) }
                    put("servers", result?.get("servers") ?: JsonArray(emptyList()))
                })
            } catch (e: Exception) {
                log("[ui] Failed to read MCP servers: ${e.message}")
            }
        }
    }

    private fun fetchBalance(sessionId: String) {
        busScope.launch {
            try {
                val result = bus.requestCore(buildJsonObject { put("type", "balanceRequested"); put("sessionId", sessionId) })?.awaitResult()
                if (result == null || result["totalBalance"] == null) {
                    postToWebview(sessionId, buildJsonObject {
                        put("type", "balanceUpdate")
                        put("totalBalance", JsonNull)
                        put("currency", JsonNull)
                        put("isUnlimited", JsonNull)
                        put("fetchedAt", System.currentTimeMillis())
                    })
                } else {
                    postToWebview(sessionId, buildJsonObject {
                        put("type", "balanceUpdate")
                        put("totalBalance", result["totalBalance"]!!)
                        put("currency", result["currency"]!!)
                        put("isUnlimited", result["isUnlimited"]!!)
                        put("fetchedAt", (result["fetchedAt"] as? JsonPrimitive)?.content?.toLongOrNull() ?: System.currentTimeMillis())
                    })
                }
            } catch (e: Exception) {
                log("Failed to fetch balance: ${e.message}")
            }
        }
    }

    /** 用户消息唯一入口（对齐 handleUserMessage：排队判定 / 乐观回显 / deferEcho） */
    private fun handleUserMessage(message: JsonObject) {
        val sessionId = str(message, "sessionId")
        val content = str(message, "content")
        if (sessionId.isEmpty() || (content.isBlank() && message["images"] == null)) return
        // 单视图宿主 open == active == 用户正在输入的会话（UserChoiceQueue 的投递判定
        // 依赖它；webview 首条消息不先发 startNewConversation，必须在此登记）
        trackedActiveSessionId = sessionId
        val selectedLines = message["selectedLines"]?.jsonObject
        val filePath = optStr(message, "filePath")
        val uuid = "user_${System.currentTimeMillis()}_${(100000..999999).random()}"
        val isCommandMessage = content.trim().startsWith("/")
        val isQueued = !conversationManager.isSessionIdle(sessionId)
        val deferEcho = isQueued || isCommandMessage
        if (isQueued) {
            postToWebview(sessionId, buildJsonObject {
                put("type", "queuedMessage")
                put("uuid", uuid)
                put("content", content)
                message["images"]?.let { put("images", it) }
                filePath?.let { put("filePath", it) }
                selectedLines?.let { put("selectedLines", it) }
            })
        }
        if (!deferEcho) {
            postToWebview(sessionId, buildJsonObject {
                put("type", "addMessage")
                put("role", "user")
                put("messageUuid", uuid)
                put("content", content)
                message["images"]?.let { put("images", it) }
                if (filePath != null && (message["fileHidden"] as? JsonPrimitive)?.content != "true") put("filePath", filePath)
                selectedLines?.let { put("fileSelectedLines", it) }
            })
        }
        val workspace = SessionHistory.getSessionWorkspace(sessionId) ?: workspacePath
        bus.emitToCore(buildJsonObject {
            put("type", "userMessageSubmitted")
            put("sessionId", sessionId)
            put("content", content)
            put("uuid", uuid)
            message["images"]?.let { put("images", it) }
            filePath?.let { put("filePath", it) }
            selectedLines?.let { put("fileSelectedLines", it) }
            if ((message["fileHidden"] as? JsonPrimitive)?.content == "true") put("fileHidden", true)
            optStr(message, "agentMode")?.let { put("agentMode", it) }
            optStr(message, "thinkingMode")?.let { put("thinkingMode", it) }
            val provider = optStr(message, "provider")
            val model = optStr(message, "model")
            if (!provider.isNullOrBlank() && !model.isNullOrBlank()) {
                put("model", buildJsonObject { put("provider", provider); put("model", model) })
            }
            optStr(message, "webSearch")?.let { put("webSearch", it.toBooleanStrictOrNull() ?: false) }
            workspace?.let { put("workspacePath", it) }
            if (deferEcho) put("deferEcho", true)
        })
    }

    /** 登记会话工作目录（宿主表 + core 事件，对齐 ensureSessionWorkspace） */
    private fun ensureSessionWorkspace(sessionId: String) {
        val registered = SessionHistory.getSessionWorkspace(sessionId)
        val path = registered ?: workspacePath ?: return
        if (registered == null) SessionHistory.setSessionWorkspace(sessionId, path)
        bus.emitToCore(buildJsonObject {
            put("type", "sessionWorkspaceAssigned")
            put("sessionId", sessionId)
            put("workspacePath", path)
        })
    }

    private fun handleStartNewConversation(message: JsonObject) {
        val newSessionId = str(message, "sessionId")
        trackedActiveSessionId = newSessionId
        ensureSessionWorkspace(newSessionId)
        bus.emitToCore(buildJsonObject { put("type", "conversationStarted"); put("sessionId", newSessionId) })
        bus.emitToCore(buildJsonObject { put("type", "conversationOpened"); put("sessionId", newSessionId) })
        postToWebview(newSessionId, buildJsonObject { put("type", "setTitle"); put("title", "") })
        fetchBalance(newSessionId)
        // 新对话默认值（读快照，不写 meta.json）
        try {
            val snapshot = settingsStore.getSnapshot()
            val llm = snapshot["llm"]?.jsonObject ?: JsonObject(emptyMap())
            val activeKey = (llm["activeProvider"] as? JsonPrimitive)?.contentOrNull ?: ""
            val provider = if (activeKey.isNotEmpty()) llm["providers"]?.jsonObject?.get(activeKey)?.jsonObject else null
            postToWebview(newSessionId, buildJsonObject {
                put("type", "setNewConversationDefaults")
                put("model", provider?.get("defaultModel")?.jsonPrimitive?.contentOrNull ?: "")
                if (activeKey.isNotEmpty()) put("provider", activeKey)
                put("thinkingMode", (llm["thinkingEffort"] as? JsonPrimitive)?.contentOrNull ?: "high")
                put("agentMode", (snapshot["defaultAgentMode"] as? JsonPrimitive)?.contentOrNull ?: "risk")
                put("promptMode", (snapshot["defaultPromptMode"] as? JsonPrimitive)?.contentOrNull ?: "normal")
                put("webSearch", (llm["webSearch"] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull() ?: true)
            })
        } catch (e: Exception) {
            log("[WebviewMessageHandler] Failed to send defaults: ${e.message}")
        }
        // 未配置 provider 时弹设置页（new-conversation 触发）
        val activeKey = try {
            (settingsStore.getSnapshot()["llm"]?.jsonObject?.get("activeProvider") as? JsonPrimitive)?.contentOrNull ?: ""
        } catch (_: Exception) { "" }
        if (activeKey.isEmpty()) sendToWebview(llmConfigPanelMessage())
    }

    /** 加载会话（对齐 handleLoadConversation 的主链路：flush → 登记 → 请求 → 组装 conversationLoaded） */
    private fun handleLoadConversation(sessionId: String) {
        busScope.launch {
            try {
                val old = trackedActiveSessionId
                if (old != null && old != sessionId) {
                    runCatching { bus.requestCore(buildJsonObject { put("type", "flushSessionRequested"); put("sessionId", old) })?.awaitResult() }
                }
                ensureSessionWorkspace(sessionId)
                val loaded = bus.requestCore(buildJsonObject {
                    put("type", "conversationLoadRequested")
                    put("sessionId", sessionId)
                })?.awaitResult() ?: return@launch
                trackedActiveSessionId = sessionId
                bus.emitToCore(buildJsonObject { put("type", "conversationOpened"); put("sessionId", sessionId) })
                fetchBalance(sessionId)
                pushMcpServers(sessionId)

                val metadata = loaded["metadata"] as? JsonObject
                val messages = loaded["messages"] as? JsonElement ?: JsonArray(emptyList())
                val pendingToolUseIds = loaded["pendingToolUseIds"] as? JsonElement ?: JsonArray(emptyList())
                val hasCompactArchive = (loaded["hasCompactArchive"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
                val workMode = loaded["workMode"]?.jsonPrimitive?.contentOrNull ?: "normal"

                val context = metadata?.get("context")?.jsonObject
                val modelRef = metadata?.get("model")?.jsonPrimitive?.contentOrNull
                val modelProvider = metadata?.get("provider")?.jsonPrimitive?.contentOrNull

                sendToWebview(buildJsonObject {
                    put("type", "conversationLoaded")
                    put("sessionId", sessionId)
                    put("conversation", buildJsonObject {
                        metadata?.let { put("metadata", it) }
                        put("messages", messages)
                    })
                    put("pendingToolUseIds", pendingToolUseIds)
                    context?.let { put("savedContext", it) }
                    metadata?.get("parentSessionId")?.let { put("parentSessionId", it) }
                    metadata?.get("creator")?.let { put("creator", it) }
                    val agentMode = loaded["agentMode"]?.jsonPrimitive?.contentOrNull
                        ?: context?.get("agentMode")?.jsonPrimitive?.contentOrNull
                        ?: (settingsStore.getSnapshot()["defaultAgentMode"] as? JsonPrimitive)?.contentOrNull
                    agentMode?.let { put("agentMode", it) }
                    put("workMode", workMode)
                    put("hasActiveQuery", sessionUi.isQueryActive(sessionId))
                    put("hasCompactArchive", hasCompactArchive)
                    modelProvider?.let { put("provider", it) }
                    modelRef?.let { put("model", it) }
                    put("activityPhase", sessionUi.getActivityPhase(sessionId))
                })
                userChoiceManager.restoreUserChoiceIfPending(sessionId)
            } catch (e: Exception) {
                log("[WebviewMessageHandler] loadConversation failed: ${e.message}")
            }
        }
    }

    private fun handleUpdateConversationContext(message: JsonObject) {
        val changes = JsonArray(buildList {
            message.containsKey("currentFile").let { if (it) add(buildJsonObject {
                put("key", "currentFile")
                put("value", message["currentFile"] ?: JsonNull)
            }) }
            message.containsKey("selectedLines").let { if (it) add(buildJsonObject {
                put("key", "selectedLines")
                put("value", message["selectedLines"] ?: JsonNull)
            }) }
            message.containsKey("totalContextTokens").let { if (it) add(buildJsonObject {
                put("key", "totalContextTokens")
                put("value", message["totalContextTokens"] ?: JsonPrimitive(0))
            }) }
        })
        bus.emitToCore(buildJsonObject {
            put("type", "conversationContextUpdated")
            put("sessionId", str(message, "sessionId"))
            put("changes", changes)
        })
    }

    /** requestToolMeta：读盘取 _meta（host 侧 jsonl 读取，落盘格式双侧一致义务） */
    private fun handleRequestToolMeta(message: JsonObject) {
        val sessionId = str(message, "sessionId")
        val ids = (message["toolUseIds"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
        busScope.launch {
            try {
                ensureSessionWorkspace(sessionId)
                val workspace = SessionHistory.getSessionWorkspace(sessionId) ?: workspacePath
                if (workspace == null) {
                    log("[ui] requestToolMeta without workspace for session $sessionId")
                    return@launch
                }
                val meta = SessionHistory.readToolMeta(homeDir, configDirName, workspace, sessionId, ids)
                sendToWebview(buildJsonObject {
                    put("type", "toolMetaData")
                    put("toolMeta", meta)
                    put("sessionId", sessionId)
                })
            } catch (e: Exception) {
                log("[WebviewMessageHandler] Error loading tool meta: ${e.message}")
            }
        }
    }

    /** tool_use 顶层 _meta 追加写（append-only；对齐 updateToolUseMeta 的宿主侧写路径） */
    private fun writeToolUseMeta(sessionId: String, toolUseId: String, meta: JsonObject) {
        busScope.launch {
            try {
                val workspace = SessionHistory.getSessionWorkspace(sessionId) ?: workspacePath ?: return@launch
                val jsonl = SessionHistory.sessionJsonl(homeDir, configDirName, workspace, sessionId)
                if (!java.nio.file.Files.exists(jsonl)) {
                    // 会话首个工具调用时 jsonl 可能尚未落盘：等待下一轮落盘后重试无意义，
                    // tool_result 块兜底会在读取路径补齐（handleRequestToolMeta 的 fallback）
                    log("[meta] jsonl not found yet for session $sessionId, skip meta append")
                    return@launch
                }
                // 读-改-写：找到含该 tool_use 的 assistant 行，合并 _meta 后整行替换
                val lines = java.nio.file.Files.readAllLines(jsonl)
                var changed = false
                val out = lines.map { line ->
                    if (changed || line.isBlank()) return@map line
                    val obj = try { Json.parseToJsonElement(line) as? JsonObject } catch (_: Exception) { null } ?: return@map line
                    if ((obj["type"] as? JsonPrimitive)?.content != "assistant") return@map line
                    val content = (obj["message"]?.jsonObject?.get("content")) as? JsonArray ?: return@map line
                    val newContent = JsonArray(content.map { block ->
                        val b = block as? JsonObject ?: return@map block
                        if ((b["type"] as? JsonPrimitive)?.content == "tool_use" &&
                            (b["id"] as? JsonPrimitive)?.content == toolUseId
                        ) {
                            changed = true
                            val merged = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(b)
                            val existingMeta = b["_meta"] as? JsonObject
                            merged["_meta"] = JsonObject((existingMeta ?: JsonObject(emptyMap())) + meta)
                            JsonObject(merged)
                        } else b
                    })
                    val newMsg = JsonObject(obj + ("message" to JsonObject((obj["message"]!!.jsonObject) + ("content" to newContent))))
                    Json.encodeToString(JsonObject.serializer(), newMsg)
                }
                if (changed) {
                    java.nio.file.Files.write(jsonl, out, java.nio.file.StandardOpenOption.TRUNCATE_EXISTING, java.nio.file.StandardOpenOption.WRITE)
                }
            } catch (e: Exception) {
                log("[meta] updateToolUseMeta error: ${e.message}")
            }
        }
    }

    private companion object {
        val busScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO + kotlinx.coroutines.SupervisorJob())
    }
}

/** CompletableFuture → 协程挂起（阻塞 get 收进 IO 调度器；调用方都在 busScope 上） */
suspend fun <T> CompletableFuture<T>.awaitResult(): T =
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { get() }
