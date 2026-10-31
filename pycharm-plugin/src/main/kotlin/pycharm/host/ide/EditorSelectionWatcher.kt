package pycharm.host.ide

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 编辑器当前文件与选区联动（对齐 src/extension.ts 的 sendCurrentFileInfo，US-69 的
 * 「面板能力与 VS Code 宿主一致」）：
 *
 * - IDE 编辑器的活跃文件 / 选区变化即发 webview 消息 `setCurrentFile`，输入框出现
 *   文件引用芯片，发消息时 webview 自动携带 filePath / selectedLines 给 core；
 * - 无选区时 selectedLines = 光标行（start === end，与 VS Code 语义一致：芯片恒显示
 *   光标行）；选区止于行首（换行符处）不把空行算进区间；
 * - 非本地文件系统编辑器（Run 控制台 / scratch 等，对齐 VS Code 的 scheme==='file'
   过滤）发 `{filePath: ''}` 清芯片；
 * - 有活跃会话时经 `UiEvent.conversationContextUpdated` 持久化到 meta.json（写盘
   归 core，宿主不直接写）。
 */
class EditorSelectionWatcher(
    private val project: Project,
    private val getActiveSessionId: () -> String?,
    private val emitUiEvent: (JsonObject) -> Unit,
    private val sendToWebview: (JsonObject) -> Unit,
    private val log: (String) -> Unit,
) {

    // 监听器的父 Disposable 用 project 本身：随项目关闭断开（面板生命周期 = 项目生命周期）
    private val messageBusConnection = project.messageBus.connect(project)

    init {
        messageBusConnection.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    // 活跃编辑器切换：直接推事件里的新文件，不回读全局
                    // selectedTextEditor（导航瞬间回读会拿到旧编辑器，实测竞态）
                    pushFile(event.newFile)
                }
            },
        )
        EditorFactory.getInstance().eventMulticaster.addSelectionListener(
            object : SelectionListener {
                override fun selectionChanged(event: SelectionEvent) {
                    // SelectionEvent 自带 editor 与新选区：跨编辑器切换瞬间回读全局状态
                    // 会拿到旧编辑器（实测竞态），必须用事件载荷
                    pushSelection(event.editor, event.newRange.startOffset, event.newRange.endOffset)
                }
            },
            project,
        )
    }

    /** 推送当前文件与选区状态（webview 挂载完成后的初始推送也走这里） */
    fun send() {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return
        pushSelection(editor, editor.selectionModel.selectionStart, editor.selectionModel.selectionEnd)
    }

    private fun pushSelection(editor: Editor, startOffset: Int, endOffset: Int) {
        // 非本地文件系统（控制台 / scratch 等）清芯片，对齐 VS Code 的 scheme==='file' 过滤
        val file: VirtualFile? = FileDocumentManager.getInstance().getFile(editor.document)
        if (file == null || !file.isInLocalFileSystem) {
            sendToWebview(buildJsonObject {
                put("type", "setCurrentFile")
                put("filePath", "")
            })
            return
        }

        val filePath = file.path
        val document = editor.document
        val hasSelection = endOffset > startOffset
        val startLine = document.getLineNumber(startOffset) + 1 // 0-based → 1-indexed
        val endLine = if (hasSelection) {
            // 选区止于行首（换行符处）归上一行，不把空行算进区间
            val adjusted = if (document.getLineNumber(endOffset) != document.getLineNumber(endOffset - 1) &&
                document.getLineStartOffset(document.getLineNumber(endOffset)) == endOffset
            ) endOffset - 1 else endOffset
            document.getLineNumber(adjusted) + 1
        } else {
            startLine
        }

        log("[currentFile] sent path=$filePath lines=$startLine-$endLine hasSelection=$hasSelection")

        sendToWebview(buildJsonObject {
            put("type", "setCurrentFile")
            put("filePath", filePath)
            put("selectedLines", buildJsonObject {
                put("start", startLine)
                put("end", endLine)
            })
        })

        // 持久化到活跃会话的 meta.json（写盘归 core）
        val activeSessionId = getActiveSessionId() ?: return
        emitUiEvent(buildJsonObject {
            put("type", "conversationContextUpdated")
            put("sessionId", activeSessionId)
            put("changes", kotlinx.serialization.json.buildJsonArray {
                add(buildJsonObject {
                    put("key", "currentFile")
                    put("value", filePath)
                })
                add(buildJsonObject {
                    put("key", "selectedLines")
                    put("value", buildJsonObject {
                        put("start", startLine)
                        put("end", endLine)
                    })
                })
            })
        })
    }

    private fun pushFile(file: VirtualFile?) {
        if (file == null || !file.isInLocalFileSystem) {
            log("[currentFile] sent path= (cleared: non-local file)")
            sendToWebview(buildJsonObject {
                put("type", "setCurrentFile")
                put("filePath", "")
            })
            return
        }
        log("[currentFile] sent path=${file.path} (editor switch)")
        sendToWebview(buildJsonObject {
            put("type", "setCurrentFile")
            put("filePath", file.path)
        })
    }

}
