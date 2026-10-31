package pycharm.host

import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 项目打开后展示助手工具窗口（specs/035 FR-001）。
 *
 * 与 VS Code 宿主的 `onStartupFinished` 激活同口径：面板就位但不抢焦点（`show()` 而非
 * `activate()`）。e2e 依赖此活动——欢迎屏不会创建 JCEF 浏览器，CDP 调试端口随面板的
 * JBCefBrowser 创建才可用。ToolWindow 的展示必须在 EDT（ProjectActivity 本体跑在
 * 协程默认调度器上，直接调用会触发 EDT 断言，实测 log SEVERE）。
 */
class StartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        val toolWindow = ToolWindowManager.getInstance(project)
            .getToolWindow(ProductIdentity.PRODUCT_NAME) ?: return
        withContext(Dispatchers.EDT) {
            toolWindow.show()
        }
    }
}
