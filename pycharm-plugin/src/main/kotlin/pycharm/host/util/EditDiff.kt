package pycharm.host.util

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.add

/**
 * Edit 紧凑 diff（对齐 src/shared/utils/editDiff.ts 的 DiffHunk/DiffLine 结构）：
 * 行级 LCS（超 4000 行/侧退化整侧替换，同 tui-rs/src/diffview.rs 口径）；
 * wordDiff 字段不产出（webview 端可选，v1 行级足够渲染——有意的降级点，注释留痕）。
 */
object EditDiff {

    data class DiffLine(val lineNumber: Int, val content: String, val type: String)

    fun buildEditDiffHunks(
        beforeContent: String,
        afterContent: String,
        startLine: Int?,
        endLine: Int?,
    ): kotlinx.serialization.json.JsonArray {
        val before = beforeContent.split("\n")
        val after = afterContent.split("\n")
        val maxSide = maxOf(before.size, after.size)
        val lines: List<DiffLine> = if (maxSide > 4000) {
            // 大文件退化：整侧替换（避免 O(n*m) LCS 内存爆炸）
            before.map { DiffLine(0, it, "removed") } + after.map { DiffLine(0, it, "added") }
        } else {
            lcsDiff(before, after)
        }
        val hunk = buildJsonObject {
            put("lines", buildJsonArray {
                for (line in lines) {
                    add(buildJsonObject {
                        put("lineNumber", line.lineNumber)
                        put("content", line.content)
                        put("type", line.type)
                    })
                }
            })
        }
        return buildJsonArray { add(hunk) }
    }

    /** 行级 LCS → DiffLine 列表（removed 行带原行号，added 行带新行号） */
    private fun lcsDiff(before: List<String>, after: List<String>): List<DiffLine> {
        val n = before.size
        val m = after.size
        val dp = Array(n + 1) { IntArray(m + 1) }
        for (i in n - 1 downTo 0) {
            for (j in m - 1 downTo 0) {
                dp[i][j] = if (before[i] == after[j]) dp[i + 1][j + 1] + 1 else maxOf(dp[i + 1][j], dp[i][j + 1])
            }
        }
        val out = mutableListOf<DiffLine>()
        var i = 0
        var j = 0
        while (i < n && j < m) {
            when {
                before[i] == after[j] -> { out.add(DiffLine(i + 1, before[i], "unchanged")); i++; j++ }
                dp[i + 1][j] >= dp[i][j + 1] -> { out.add(DiffLine(i + 1, before[i], "removed")); i++ }
                else -> { out.add(DiffLine(j + 1, after[j], "added")); j++ }
            }
        }
        while (i < n) { out.add(DiffLine(i + 1, before[i], "removed")); i++ }
        while (j < m) { out.add(DiffLine(j + 1, after[j], "added")); j++ }
        return out
    }
}
