package pycharm.host

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pycharm.host.core.CoreBus
import pycharm.host.core.CoreProcess
import pycharm.host.ide.DiffService
import pycharm.host.ide.FileJumpService
import pycharm.host.settings.SettingsSnapshot
import pycharm.host.settings.SettingsStore
import pycharm.host.ui.HostUi
import pycharm.host.webview.WebViewPanel
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JLabel

/**
 * 面板控制器（每个 project 一个）：装配 Core 进程 / 总线 / 宿主 UI / JCEF 面板
 * （对齐 src/host/bootstrapCore.ts 的宿主接线骨架）。
 *
 * 装配顺序（铁律：处理器注册先于连接建立，见 docs/hosts/host-bootstrap.md 第 1 节）：
 * SettingsStore.loadSync → HostUi（处理器表）→ CoreProcess spawn → bus.start →
 * hostEnvironmentProvided（就绪前排队，ready 后按连接态重放语义最先发）→ coreReady 门禁。
 */
@Service(Service.Level.PROJECT)
class PanelController(private val project: Project) {

    private val log: (String) -> Unit = { line ->
        com.intellij.openapi.diagnostic.Logger.getInstance(ProductIdentity.EXTENSION_NAME).info(line)
    }

    private val pluginRoot: Path = resolvePluginRoot()
    private val webviewDir: Path = pluginRoot.resolve("webview")
    private val configDirName: String = ProductIdentity.CONFIG_DIR_NAME
    private val homeDir: Path = SettingsStore.homeDir()
    private val configDir: Path = homeDir.resolve(configDirName)
    private val workspacePath: String? = project.basePath

    private val settingsStore = SettingsStore(configDir, log)
    private var hostUi: HostUi? = null
    private var bus: CoreBus? = null
    private var coreProcess: CoreProcess? = null
    private var panel: WebViewPanel? = null

    val component: javax.swing.JComponent by lazy { createPanel() }

    private fun createPanel(): javax.swing.JComponent {
        return try {
            createPanelInternal()
        } catch (e: Exception) {
            // 启动期错误显式上屏（铁律 1：不过度 fallback），细节进 idea.log
            log("panel init failed: ${e.stackTraceToString()}")
            JLabel("[${ProductIdentity.PRODUCT_NAME}] 面板初始化失败：${e.message}")
        }
    }

    private fun createPanelInternal(): javax.swing.JComponent {
        settingsStore.loadSync()
        val localeState = WebViewPanel.LocaleState(
            theme = if (com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().isDarkEditor) "dark" else "light",
            uiLocale = settingsStore.readUiLanguage(),
            ideLocale = java.util.Locale.getDefault().toLanguageTag(),
            uiFontSize = settingsStore.readUiFontSize(),
        )
        val bus = createBus()
        val hostUi = HostUi(
            project = project,
            homeDir = homeDir,
            configDirName = configDirName,
            workspacePath = workspacePath,
            bus = bus,
            settingsStore = settingsStore,
            diffService = DiffService(project, log),
            fileJumpService = FileJumpService(project, log),
            pluginRoot = pluginRoot,
            log = log,
        )
        this.hostUi = hostUi
        bus.onCoreEvent = { event -> hostUi.onCoreEvent(event) }
        bus.coreRequestHandlers = mapOf(
            "toolPermissionRequested" to { request -> hostUi.onCoreRequest(request) },
            "userChoice" to { request -> hostUi.onCoreRequest(request) },
            "crossWorkspaceAgentRequested" to { request -> hostUi.onCoreRequest(request) },
            "crossWorkspaceTransferRequested" to { request -> hostUi.onCoreRequest(request) },
        )
        val panel = WebViewPanel(
            webviewDir = webviewDir,
            localeState = localeState,
            onWebviewMessage = { message -> hostUi.handleWebviewMessage(message) },
            log = log,
        )
        this.panel = panel
        hostUi.sendToWebview = { message -> panel.postMessage(message) }
        return panel.browser.component
    }

    /** 总线与 Core 进程装配：spawn 后立即 hostEnvironmentProvided（就绪前排队） */
    private fun createBus(): CoreBus {
        val coreBinary = resolveCoreBinary()
        val process = CoreProcess(coreBinary, workspacePath, log = log)
        process.onDiagnostic = log // core stderr（解码错误诊断等）进 idea.log
        coreProcess = process
        val bus = CoreBus(process, log)
        bus.start()
        val emitEnvironment = {
            bus.emitToCore(buildJsonObject {
                put("type", "hostEnvironmentProvided")
                put("extensionPath", pluginRoot.toString())
                put("logToConsole", false)
                put("configDirName", configDirName)
                put("settings", SettingsSnapshot.resolve(settingsStore.getRawSettings()))
                put("mcpServers", JsonArray(settingsStore.getMcpServers()))
                put("crossWorkspaceAgent", false)
                put("crossWorkspaceTransfer", false)
            })
        }
        emitEnvironment()
        // settings.json 写盘重推整份快照（对齐 bootstrap 骨架的 SettingsStore.subscribe）
        settingsStore.subscribe { emitEnvironment() }
        return bus
    }

    /**
     * Core 产物定位（同 src/host/standalone/coreBinary.ts 口径）：
     * `<pluginRoot>/core|resources/core/<arch>-<platform>/<binaryName>` + 同级 fingerprint。
     * 全部落空抛错（启动期错误，不回退 PATH）。
     */
    private fun resolveCoreBinary(): Path {
        val arch = when (System.getProperty("os.arch")) {
            "aarch64", "arm64" -> "arm64"
            else -> "x64"
        }
        val osName = System.getProperty("os.name").lowercase()
        val os = when {
            osName.contains("win") -> "win32"
            osName.contains("linux") -> "linux"
            else -> error("不支持的操作系统：${System.getProperty("os.name")}（本插件分发仅内置 win32/linux 平台的 Core 产物）")
        }
        val exeSuffix = if (os == "win32") ".exe" else ""
        for (base in listOf(pluginRoot.resolve("core"), pluginRoot.resolve("resources").resolve("core"))) {
            val candidate = base.resolve("$arch-$os").resolve(ProductIdentity.CORE_BINARY_NAME + exeSuffix)
            val fingerprint = candidate.resolveSibling("fingerprint")
            if (Files.isRegularFile(candidate) && Files.isRegularFile(fingerprint)) {
                val fp = Files.readString(fingerprint).trim()
                if (!fp.matches(Regex("[0-9a-f]{64}"))) {
                    error("Core fingerprint 非法（应为 64 位小写 hex）：$fingerprint")
                }
                return candidate
            }
        }
        error(
            "Core 产物缺失：在 $pluginRoot/(core|resources)/core/$arch-$os/ 下没有找到 " +
                "${ProductIdentity.CORE_BINARY_NAME}$exeSuffix 与 fingerprint。请使用 npm run package:pycharm 产出的完整分发包。",
        )
    }

    private fun resolvePluginRoot(): Path {
        val pluginId = "${ProductIdentity.EXTENSION_NAME}.pycharm"
        val plugin = com.intellij.openapi.extensions.PluginId.getId(pluginId)
        return com.intellij.ide.plugins.PluginManagerCore.getPlugin(plugin)?.pluginPath
            ?: Path.of(".").toAbsolutePath()
    }

    fun dispose() {
        panel?.close()
        coreProcess?.stop()
    }
}
