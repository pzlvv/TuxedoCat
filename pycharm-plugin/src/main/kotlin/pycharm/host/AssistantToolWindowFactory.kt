package pycharm.host

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import javax.swing.JPanel

/**
 * 助手工具窗口（specs/035 FR-001）：以 JCEF 承载同一份 webview 渲染实现。
 *
 * T002 骨架阶段先挂一个最小 JBCefBrowser（about:blank），用于关闭 spike 探针
 * 1/3（CDP 随首个 JCEF 浏览器创建而启动、脚本前注入可行）；真正的 scheme handler
 * 与 bootstrap 注入在 T005 落地。
 */
class AssistantToolWindowFactory : ToolWindowFactory {

    override fun shouldBeAvailable(project: Project): Boolean = true

    override fun isApplicable(project: Project): Boolean = true

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val contentComponent = if (JBCefApp.isSupported()) {
            // JCEF 不可用时的明确报错面（铁律：不静默降级）——supported 分支才是产品路径
            val browser = JBCefBrowser("about:blank")
            Disposer.register(toolWindow.disposable, browser)
            browser.component
        } else {
            JBLabel(
                "[${ProductIdentity.PRODUCT_NAME}] JCEF 不可用：内嵌浏览器组件初始化失败，" +
                    "请使用 2020.2+ 且内置 JCEF 的 IDE（Help | Find Action | Registry 检查 ide.browser.jcef.enabled）。",
            )
        }
        val content = toolWindow.contentManager.factory
            .createContent(JPanel().apply { add(contentComponent) }, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
