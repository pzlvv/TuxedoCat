package pycharm.host.ide

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.editor.DiffVirtualFile
import com.intellij.diff.impl.DiffRequestProcessor
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem

/**
 * IDE diff 与文件跳转（specs/035 FR-004 / FR-005）。
 *
 * diff 四约定对齐 src/VSCodeUIHost/documentManager.ts：
 * 1. 不夺焦点打开（DiffManager.showDiff 为非模态承载，打开不 requestFocus）；
 * 2. 内容哈希去重（相同内容不重复打开）；
 * 3. 同一时刻至多一个 diff 视图（打开新 diff 前先关旧的）；
 * 4. 用户应答 userChoice 后关闭（[closeCurrent]）。
 *
 * `beforeContent == null`（Write 新建文件）时只展示新内容单侧。
 * 打开 / 关闭 / 去重 / 焦点决策写 idea.log 结构化诊断行（e2e 断言面）。
 */
class DiffService(private val project: Project, private val log: (String) -> Unit) {

    private var currentHash: Int? = null
    private var currentTitle: String? = null
    /**
     * 「已请求未打开」标记：showDiff 在投递 EDT 前置位，EDT lambda 打开时校验——应答
     * （closeCurrent）可能赶在 lambda 执行之前到达（e2e 实测竞态：点允许瞬间 respond
     * 先到，close 被 currentTitle==null 吞掉，随后 lambda 才把 diff 打开，close 永远不来）。
     */
    @Volatile private var pendingRequest = false
    /** 单实例编辑器 tab 承载：同一时刻至多一个 diff 视图（内容原地更新） */
    private var currentFile: StaticDiffFile? = null
    private val lock = Any()

    /** 打开 diff；EDT 安全（内部 invokeLater）。`beforeContent` 为 null = 新建文件单侧显示 */
    fun showDiff(title: String, beforeContent: String?, afterContent: String, sessionId: String?) {
        log("[diff] showDiff requested title=$title sessionId=$sessionId")
        synchronized(lock) {
            val hash = beforeContent.hashCode() * 31 + afterContent.hashCode()
            if (currentHash == hash && pendingRequest) {
                log("[diff] open skipped (same content hash=$hash, title=$title)")
                return
            }
            // ModalityState.any()：后台线程的 invokeLater 若钉在某个已消失的模态上下文上
            // 会永不执行（实测 EDT lambda 不进入），any() 免除该等待
            pendingRequest = true
            currentTitle = title
            currentHash = hash
            ApplicationManager.getApplication().invokeLater({
                try {
                    if (!pendingRequest) {
                        log("[diff] open cancelled (respond arrived before EDT open) title=$title")
                        return@invokeLater
                    }
                    val contentFactory = DiffContentFactory.getInstance()
                    val request = if (beforeContent != null) {
                        SimpleDiffRequest(
                            title,
                            listOf(contentFactory.create(beforeContent), contentFactory.create(afterContent)),
                            listOf("$title (修改前)", "$title (修改后)"),
                        )
                    } else {
                        SimpleDiffRequest(
                            title,
                            listOf(contentFactory.create(afterContent)),
                            listOf("$title (新文件)"),
                        )
                    }
                    val file = currentFile ?: StaticDiffFile("Tuxedo Diff").also { currentFile = it }
                    file.currentRequest = request
                    // 非模态 diff（编辑器 tab 承载）：DiffManager.showDiff 默认是对话框（模态，
                    // 会卡 EDT）；编辑器 tab 路线不夺焦点（用户停留在面板或原编辑器应答）
                    com.intellij.openapi.fileEditor.OpenFileDescriptor(project, file).navigate(false)
                    log("[diff] open title=$title hash=$hash beforeLen=${beforeContent?.length ?: -1} afterLen=${afterContent.length} sessionId=$sessionId focus=not-requested")
                } catch (e: Throwable) {
                    log("[diff] showDiff error: $e")
                }
            }, com.intellij.openapi.application.ModalityState.any())
        }
    }

    /**
     * 关闭当前 diff（应答 userChoice / 打开新 diff 前）。同步取消 pendingRequest +
     * 立即写诊断行（e2e 断言面）；tab 的实际关闭投递 EDT。请求已发出但尚未打开时，
     * 本调用撤销它（EDT lambda 见 pendingRequest=false 后不打开）。
     */
    fun closeCurrent(reason: String) {
        val cancelled: Boolean
        var fileToClose: StaticDiffFile? = null
        synchronized(lock) {
            cancelled = pendingRequest
            pendingRequest = false
            fileToClose = currentFile
            currentFile = null
            currentHash = null
        }
        val title = currentTitle
        currentTitle = null
        if (title == null && !cancelled) return
        if (fileToClose != null) {
            // 关闭 diff 编辑器 tab（应答即关，对齐 VS Code 宿主的 closePreview）
            ApplicationManager.getApplication().invokeLater({
                runCatching {
                    com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).closeFile(fileToClose)
                }
            }, com.intellij.openapi.application.ModalityState.any())
        }
        log("[diff] close title=${title ?: "(pending)"} reason=$reason")
    }
}

/**
 * 单实例 diff 编辑器 tab（FR-004 的非模态承载）：DiffVirtualFile 子类 +
 * DiffRequestProcessor，request 原地更新（同一文件实例 → 同一 tab → 至多一个视图）。
 */
private class StaticDiffFile(name: String) : DiffVirtualFile(name) {

    var currentRequest: DiffRequest? = null

    override fun createProcessor(project: com.intellij.openapi.project.Project): DiffRequestProcessor =
        object : DiffRequestProcessor(project) {
            override fun updateRequest(force: Boolean, policy: DiffUserDataKeysEx.ScrollToPolicy?) {
                val request = this@StaticDiffFile.currentRequest ?: return
                applyRequest(request, force, policy)
            }
        }

    override fun getName(): String = this::class.simpleName ?: "diff"

    override fun equals(other: Any?): Boolean = other is StaticDiffFile
    override fun hashCode(): Int = StaticDiffFile::class.hashCode()
}

/**
 * 文件跳转（FR-005）：编辑器打开文件、焦点切到编辑器、选中改动行区间。
 * 对齐 VS Code 宿主的 openFile（reveal + selection）；夺焦是用户主动行为。
 */
class FileJumpService(private val project: Project, private val log: (String) -> Unit) {

    fun openFile(filePath: String, selectedLines: Pair<Int, Int>?) {
        // ModalityState.any()：同 DiffService——后台线程的默认 modality 会钉死 lambda
        ApplicationManager.getApplication().invokeLater({
            log("[openFile] EDT entered path=$filePath")
            try {
                // refreshAndFind：notes.md 由 core 子进程在 IDE 外创建，VFS 不刷新就查不到
                val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(java.nio.file.Path.of(filePath))
                if (file == null) {
                    log("[openFile] file not found: $filePath")
                    return@invokeLater
                }
                // navigate(true) = 夺焦（对齐 VS Code openFile 语义）
                OpenFileDescriptor(project, file, 0, 0).navigate(true)
                if (selectedLines != null) {
                    val editor = FileEditorManager.getInstance(project).selectedTextEditor
                    if (editor != null) {
                        val document = editor.document
                        val start = (selectedLines.first - 1).coerceIn(0, document.lineCount - 1)
                        val end = (selectedLines.second - 1).coerceIn(0, document.lineCount - 1)
                        val startOffset = document.getLineStartOffset(start)
                        val endOffset = document.getLineEndOffset(end)
                        editor.selectionModel.setSelection(startOffset, endOffset)
                        editor.caretModel.moveToOffset(startOffset)
                        editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
                    }
                }
                log("[openFile] opened path=$filePath lines=${selectedLines?.first}-${selectedLines?.second} focus=true")
            } catch (e: Throwable) {
                log("[openFile] error: $e")
            }
        }, com.intellij.openapi.application.ModalityState.any())
    }
}
