package pycharm.host.settings

import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.FileTime
import java.util.concurrent.TimeUnit

/**
 * 跨进程文件写安全（对齐 src/shared/utils/fileLock.ts 的字节级行为，Kotlin 侧与
 * TS / Rust 宿主互操作同一把锁）：
 * - 锁文件 `wx` 语义创建（O_CREAT|O_EXCL），内容 `<pid> <毫秒时间戳>`；
 * - 陈旧判定：mtime 距今 > 15s，或锁内 pid 已不存在（Windows 用 tasklist 探活）；
 * - 同步获取最多 20 次 × 10ms；拿不到返回 false，调用方放弃写入；
 * - 原子落盘：同目录临时文件 + rename（Windows 瞬时 EPERM/EACCES 重试 10 次 5ms→100ms）。
 */
object FileLock {
    const val LOCK_STALE_MS = 15_000L
    const val LOCK_MAX_ATTEMPTS = 20
    const val LOCK_RETRY_DELAY_MS = 10L
    const val RENAME_MAX_ATTEMPTS = 10
    const val RENAME_RETRY_BASE_MS = 5L
    const val RENAME_RETRY_MAX_MS = 100L

    private val pid: Long = ProcessHandle.current().pid()

    /** 尝试获取锁；成功返回释放动作，失败返回 null（不抛错，调用方放弃写） */
    fun tryAcquire(lockPath: Path): AutoCloseable? {
        repeat(LOCK_MAX_ATTEMPTS) { attempt ->
            try {
                Files.writeString(
                    lockPath,
                    "$pid ${System.currentTimeMillis()}",
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE,
                )
                return AutoCloseable { runCatching { Files.deleteIfExists(lockPath) } }
            } catch (_: IOException) {
                // EEXIST 或其它：对现存锁判定陈旧才接管（对齐 file-lock-stale-break-destroys-recreated-lock
                // 缺陷修复：锁文件不存在时不授权 unlink）
                if (Files.exists(lockPath) && isLockStale(lockPath)) {
                    runCatching { Files.deleteIfExists(lockPath) }
                }
            }
            Thread.sleep(LOCK_RETRY_DELAY_MS)
        }
        return null
    }

    private fun isLockStale(lockPath: Path): Boolean {
        val mtime: FileTime = try { Files.getLastModifiedTime(lockPath) } catch (_: IOException) { return false }
        if (System.currentTimeMillis() - mtime.toMillis() > LOCK_STALE_MS) return true
        val content = try { Files.readString(lockPath) } catch (_: IOException) { return false }
        val ownerPid = content.trim().split(" ", limit = 2).firstOrNull()?.toLongOrNull() ?: return false
        return !isProcessAlive(ownerPid)
    }

    private fun isProcessAlive(pid: Long): Boolean {
        if (pid == ProcessHandle.current().pid()) return true
        val handle = ProcessHandle.of(pid)
        if (handle.isPresent) {
            // handle.isAlive 在 Windows 上对他人进程可能不准；EPERM 视为存活（对齐 TS 口径）
            return try { handle.get().isAlive || runCatching { handle.get().supportsNormalTermination() }.getOrDefault(false) } catch (_: Exception) { true }
        }
        if (System.getProperty("os.name").lowercase().contains("windows")) {
            // ProcessHandle 查不到时退回 tasklist（Windows 的已退出进程句柄解析差异）
            return try {
                val proc = ProcessBuilder("tasklist", "/FI", "PID eq $pid", "/FO", "CSV", "/NH")
                    .redirectErrorStream(true).start()
                val out = proc.inputStream.readAllBytes().decodeToString()
                proc.waitFor(2, TimeUnit.SECONDS)
                out.contains("\"$pid\"")
            } catch (_: Exception) {
                true // 探活失败按存活处理：宁可等待也不误删活跃锁
            }
        }
        return false
    }

    /** 同目录临时文件 + 原子 rename（Windows 瞬时占用重试） */
    fun writeFileAtomic(target: Path, data: String, tmpPath: Path) {
        Files.writeString(tmpPath, data, Charsets.UTF_8)
        var attempt = 0
        while (true) {
            try {
                Files.move(tmpPath, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
                return
            } catch (e: IOException) {
                attempt++
                if (attempt >= RENAME_MAX_ATTEMPTS) {
                    runCatching { Files.deleteIfExists(tmpPath) }
                    throw e
                }
                Thread.sleep(minOf(RENAME_RETRY_BASE_MS * (1L shl (attempt - 1)), RENAME_RETRY_MAX_MS))
            }
        }
    }
}
