package pycharm.host

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory

/**
 * 助手工具窗口（specs/035 FR-001）：以 JCEF 承载同一份 webview 渲染实现。
 *
 * 面板接线由 [PanelController] 承担（Core 装配 + 消息桥）；本工厂只负责把面板组件
 * 挂进工具窗口。JCEF 不可用的 IDE 在插件装载期即失败（plugin.xml 的 jcef depends），
 * 不静默降级。
 */
class AssistantToolWindowFactory : ToolWindowFactory {

    override fun shouldBeAvailable(project: Project): Boolean = true

    override fun isApplicable(project: Project): Boolean = true

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val controller = project.getService(PanelController::class.java)
        val content = toolWindow.contentManager.factory
            .createContent(controller.component, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
