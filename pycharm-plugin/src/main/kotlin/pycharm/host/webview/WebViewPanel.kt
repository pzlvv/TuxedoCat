package pycharm.host.webview

import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors

/**
 * webview 承载（specs/035 FR-001）：
 * - 内嵌 JDK HttpServer（127.0.0.1 随机端口）伺服插件分发目录的 `webview/` 静态资源，
 *   `index.html` 响应做运行期注入（对齐 src/extension.ts 的改写手法）：在 module 脚本前
 *   插入 bootstrap——`window.vscode` shim（postMessage → JBCefJSQuery）+
 *   `__hostInfo`/`__initialTheme`/locale/`__uiFontSize`/`logoUri`/`__hasWorkspace`
 *   （注入清单以 docs/hosts/webview-facts.md 的同步注入事实为准，webview 对缺失项即抛错）。
 *   不用 CEF 自定义 scheme：`addCefCustomSchemeHandlerFactory` 要求在 CEF 初始化前注册，
 *   而 IDE 其它组件（What's New 等）可能先把 JCEF 跑起来——实测报
 *   「JBCefApp has already been initialized!」。http://127.0.0.1 没有时序问题。
 * - 下行 `executeJavaScript(window.postMessage(<json>,'*'))`；
 * - 上行 query handler → 宿主路由。
 */
class WebViewPanel(
    private val webviewDir: Path,
    private val localeState: LocaleState,
    private val onWebviewMessage: (JsonObject) -> Unit,
    private val log: (String) -> Unit,
) : AutoCloseable {

    /** 面板注入的宿主事实（主题 / 语言 / 字号），requestTheme / 保存后可更新重发 */
    data class LocaleState(var theme: String, var uiLocale: String, var ideLocale: String, var uiFontSize: String)

    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val baseUrl: String
    val browser: JBCefBrowser
    private val jsQuery: JBCefJSQuery
    @Volatile private var bootstrap: String = ""

    init {
        server.createContext("/") { exchange -> serve(exchange) }
        server.executor = Executors.newSingleThreadExecutor { r -> Thread(r, "tuxedo-webview-server").apply { isDaemon = true } }
        server.start()
        baseUrl = "http://127.0.0.1:${server.address.port}"

        val browser = JBCefBrowser("$baseUrl/index.html")
        this.browser = browser
        jsQuery = JBCefJSQuery.create(browser)
        jsQuery.addHandler { request ->
            try {
                val message = Json.parseToJsonElement(request)
                if (message is JsonObject) {
                    // __cursor 是面板桥私有消息（不属于 webview 协议）：JCEF-in-IDE 的光标
                    // 链路（CEF OnCursorChange → AWT）有断点，CSS 的 pointer 落不到系统
                    // 光标上——由注入的 pointermove 探测补偿，见 buildBootstrap
                    val type = (message["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    if (type == "__cursor") {
                        applyCursor((message["cursor"] as? JsonPrimitive)?.content ?: "default")
                    } else {
                        onWebviewMessage(message)
                    }
                }
                JBCefJSQuery.Response("ok")
            } catch (e: Exception) {
                log("[webview] query handle failed: ${e.message}")
                JBCefJSQuery.Response("error: ${e.message}")
            }
        }
        bootstrap = buildBootstrap()
        log("[webview] panel ready url=$baseUrl dir=$webviewDir")
    }

    private fun buildBootstrap(): String {
        // inject(alias) 产出的是「调用点」：window.cefQuery_<id>({request: '' + alias, ...})——
        // 引用的是别处的 alias 表达式而不是函数定义。把调用点的请求表达式换成参数 request，
        // 包成 window.__javaQuery = function(request) {...}，bootstrap 其余部分照常引用
        val callSite = jsQuery.inject("__javaQuery")
        val inject = "window.__javaQuery = function(request) { " +
            callSite.replace("'' + __javaQuery", "request") + " };"
        fun jsonOf(value: String): String =
            Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(value)).replace("</", "<\\\\/")
        val hostInfo = """{"conversationView":"single","conversationListOwner":"webview"}"""
        return buildString {
            append(inject)
            append("\nwindow.vscode = { postMessage: function(msg){ __javaQuery(typeof msg === 'string' ? msg : JSON.stringify(msg)); } };\n")
            append("window.__hostInfo = $hostInfo;\n")
            append("window.__initialTheme = ${jsonOf(localeState.theme)};\n")
            append("window.__uiLocale = ${jsonOf(localeState.uiLocale)};\n")
            append("window.__vscodeLocale = ${jsonOf(localeState.ideLocale)};\n")
            append("window.__systemLocale = ${jsonOf(localeState.ideLocale)};\n")
            append("window.__uiFontSize = ${jsonOf(localeState.uiFontSize)};\n")
            append("window.logoUri = ${jsonOf("./logo1.png")};\n")
            append("window.__hasWorkspace = true;\n")
            // 光标补偿：JCEF-in-IDE 的 CEF OnCursorChange → AWT 链路有断点，CSS 的
            // pointer 落不到系统光标。pointermove 时读悬停目标的 computed cursor，
            // 仅在值变化时经桥通知 Java 侧设 AWT 光标（Chrome 会先应用 :hover 再派发
            // 事件，computed 值可靠；只在变化时发，避免高频桥调用）
            append("""
(function() {
  var last = null;
  document.addEventListener('pointermove', function(e) {
    var t = e.target;
    var cur = t ? window.getComputedStyle(t).cursor : 'default';
    if (cur === last) return;
    last = cur;
    window.__javaQuery(JSON.stringify({ type: '__cursor', cursor: cur }));
  }, true);
})();
""".trimIndent())
        }
    }

    /** 把页面 CSS 光标意图映射到 AWT 光标（pointer→手型，text→文本，其余→默认箭头） */
    private fun applyCursor(cssCursor: String) {
        val cursor = when (cssCursor) {
            "pointer" -> java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            "text" -> java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.TEXT_CURSOR)
            else -> java.awt.Cursor.getDefaultCursor()
        }
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            if (browser.component.cursor != cursor) browser.component.cursor = cursor
        }
    }

    private fun serve(exchange: HttpExchange) {
        try {
            val requestPath = exchange.requestURI.path.trimStart('/').ifBlank { "index.html" }
            val resolved = webviewDir.resolve(requestPath).normalize()
            if (!resolved.startsWith(webviewDir) || !Files.isRegularFile(resolved)) {
                respond(exchange, 404, "text/plain", "not found: $requestPath")
                return
            }
            var body = Files.readAllBytes(resolved)
            var mime = mimeOf(resolved.fileName.toString())
            if (resolved.fileName.toString() == "index.html") {
                val html = body.toString(Charsets.UTF_8)
                // 对齐 extension.ts：把 bootstrap 插到 module 脚本之前
                val injected = html.replace(Regex("""(<script type="module"[^>]*>)""")) { m ->
                    "<script>" + bootstrap + "</script>\n" + m.groupValues[1]
                }
                body = injected.toByteArray(Charsets.UTF_8)
            }
            respond(exchange, 200, mime, bytes = body)
        } catch (e: Exception) {
            runCatching { respond(exchange, 500, "text/plain", "serve error: ${e.message}") }
        } finally {
            exchange.close()
        }
    }

    private fun respond(exchange: HttpExchange, status: Int, mime: String, text: String? = null, bytes: ByteArray? = null) {
        exchange.responseHeaders.add("Content-Type", mime)
        exchange.responseHeaders.add("Access-Control-Allow-Origin", "*")
        val payload = bytes ?: (text ?: "").toByteArray(Charsets.UTF_8)
        exchange.sendResponseHeaders(status, payload.size.toLong())
        exchange.responseBody.use { it.write(payload) }
    }

    private fun mimeOf(name: String): String = when {
        name.endsWith(".html") -> "text/html; charset=utf-8"
        name.endsWith(".js") -> "text/javascript; charset=utf-8"
        name.endsWith(".css") -> "text/css; charset=utf-8"
        name.endsWith(".svg") -> "image/svg+xml"
        name.endsWith(".png") -> "image/png"
        name.endsWith(".woff2") -> "font/woff2"
        name.endsWith(".woff") -> "font/woff"
        name.endsWith(".ttf") -> "font/ttf"
        name.endsWith(".json") -> "application/json"
        else -> "application/octet-stream"
    }

    /** 下行：webview 的 window message 事件（对齐 electron preload 的转发语义） */
    fun postMessage(message: JsonObject) {
        val json = Json.encodeToString(JsonObject.serializer(), message)
        val jsSafe = json.replace(" ", "\u2028").replace(" ", "\u2029")
        browser.cefBrowser.executeJavaScript("window.postMessage($jsSafe, '*')", "$baseUrl/index.html", 0)
    }

    override fun close() {
        runCatching { jsQuery.dispose() }
        runCatching { browser.dispose() }
        runCatching { server.stop(0) }
    }
}
