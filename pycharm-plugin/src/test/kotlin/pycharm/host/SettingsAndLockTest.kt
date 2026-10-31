package pycharm.host

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import pycharm.host.settings.FileLock
import pycharm.host.settings.SettingsSnapshot
import pycharm.host.settings.SettingsStore
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** FileLock / settings 快照 / SettingsStore 的行为锁值（specs/035 测试计划第 1 层） */
class SettingsAndLockTest {

    private fun tempDir(): java.nio.file.Path = Files.createTempDirectory("tuxedo-settings-test")

    // ===== FileLock =====

    @Test
    fun lockIsMutuallyExclusiveWithinProcess() {
        val dir = tempDir()
        val lockPath = dir.resolve("settings.json.lock")
        val first = FileLock.tryAcquire(lockPath)
        assertNotNull(first)
        try {
            assertNull(FileLock.tryAcquire(lockPath), "第二次获取必须失败（O_CREAT|O_EXCL）")
        } finally {
            first.close()
        }
        val third = FileLock.tryAcquire(lockPath)
        assertNotNull(third, "释放后可重新获取")
        third.close()
        Files.deleteIfExists(dir.resolve("x"))
    }

    @Test
    fun lockFileContentIsPidAndTimestamp() {
        val dir = tempDir()
        val lockPath = dir.resolve("settings.json.lock")
        val lock = FileLock.tryAcquire(lockPath)!!
        try {
            val content = Files.readString(lockPath).trim()
            val pid = content.split(" ").first().toLongOrNull()
            assertEquals(ProcessHandle.current().pid(), pid, "锁内容 = `<pid> <毫秒>`，陈旧判定按 pid 探活")
        } finally {
            lock.close()
        }
    }

    @Test
    fun staleLockIsTakenOverByTimestamp() {
        val dir = tempDir()
        val lockPath = dir.resolve("settings.json.lock")
        // 伪造一把 16s 前的陈旧锁（> 15s 陈旧线）
        Files.writeString(lockPath, "999999 ${System.currentTimeMillis() - 16_000}")
        val acquired = FileLock.tryAcquire(lockPath)
        assertNotNull(acquired, "陈旧锁（mtime 超过 15s）应被接管")
        acquired.close()
    }

    @Test
    fun freshLockWithLivePidIsNotStolen() {
        val dir = tempDir()
        val lockPath = dir.resolve("settings.json.lock")
        // 新鲜锁 + 活跃 pid（本进程）：不接管（陈旧判定 = mtime 超线 OR pid 已死；死 pid 的
        // 新鲜锁按 TS process.kill(pid,0) 同语义会被接管）
        Files.writeString(lockPath, "${ProcessHandle.current().pid()} ${System.currentTimeMillis()}")
        assertNull(FileLock.tryAcquire(lockPath), "新鲜且 pid 存活的锁不应被接管（拿不到即放弃，不误删活跃锁）")
    }

    @Test
    fun atomicWriteIsAtomicAndComplete() {
        val dir = tempDir()
        val target = dir.resolve("out.json")
        FileLock.writeFileAtomic(target, "{\"a\":1}", dir.resolve("out.json.tmp"))
        assertEquals("{\"a\":1}", Files.readString(target))
        assertTrue(!Files.exists(dir.resolve("out.json.tmp")), "临时文件已 rename 消失")
    }

    // ===== SettingsSnapshot（resolveSettingsSnapshot 移植的锁值测试）=====

    @Test
    fun emptyConfigFallsBackToDefaults() {
        val snapshot = SettingsSnapshot.resolve(null)
        val llm = snapshot["llm"]!!.jsonObject
        assertEquals("", llm["activeProvider"]!!.jsonPrimitiveContent())
        assertEquals(true, llm["webSearch"]!!.jsonPrimitiveContent().toBoolean())
        assertEquals("high", llm["thinkingEffort"]!!.jsonPrimitiveContent())
        assertEquals("risk", snapshot["defaultAgentMode"]!!.jsonPrimitiveContent())
        assertEquals("normal", snapshot["defaultPromptMode"]!!.jsonPrimitiveContent())
        assertEquals(131072L, llm["maxTokens"]!!.jsonPrimitiveContent().toLong())
        val fallback = llm["modelLimitsFallback"]!!.jsonObject
        assertEquals(1048576L, fallback["context"]!!.jsonPrimitiveContent().toLong())
        assertEquals("OpenAI", fallback["apiType"]!!.jsonPrimitiveContent())
        // 字段名单对照（防 multimodal 式漂移——specs/012 曾漏改 tui-rs）
        assertEquals(
            setOf("context", "output", "apiType", "thinkingTokenBudget", "multimodal"),
            fallback.keys,
        )
        assertEquals(
            setOf("activeProvider", "webSearch", "thinkingEffort", "model", "maxTokens", "enableUsageStats", "providers", "modelLimitsFallback"),
            llm.keys,
        )
        assertEquals(setOf("llm", "mcp", "defaultAgentMode", "defaultPromptMode"), snapshot.keys)
    }

    @Test
    fun whitelistOutsideValuesFallBack() {
        val raw = Json.parseToJsonElement("""{
            "defaultAgentMode": "bogus", "defaultPromptMode": "bogus",
            "llm": {"thinking_effort": "bogus", "webSearch": false}
        }""") as JsonObject
        val snapshot = SettingsSnapshot.resolve(raw)
        assertEquals("risk", snapshot["defaultAgentMode"]!!.jsonPrimitiveContent())
        assertEquals("normal", snapshot["defaultPromptMode"]!!.jsonPrimitiveContent())
        assertEquals("high", snapshot["llm"]!!.jsonObject["thinkingEffort"]!!.jsonPrimitiveContent())
        assertEquals(false, snapshot["llm"]!!.jsonObject["webSearch"]!!.jsonPrimitiveContent().toBoolean())
    }

    @Test
    fun activeProviderKeptOnlyWithNonEmptyBaseURL() {
        val raw = Json.parseToJsonElement("""{
            "llm": {"activeProvider": "p1", "providers": {"p1": {"baseURL": "", "apiKey": "k"}}}
        }""") as JsonObject
        assertEquals("", SettingsSnapshot.resolve(raw)["llm"]!!.jsonObject["activeProvider"]!!.jsonPrimitiveContent())
        val raw2 = Json.parseToJsonElement("""{
            "llm": {"activeProvider": "p1", "providers": {"p1": {"baseURL": "https://x", "models": ["m1"], "defaultModel": "m1"}}}
        }""") as JsonObject
        assertEquals("p1", SettingsSnapshot.resolve(raw2)["llm"]!!.jsonObject["activeProvider"]!!.jsonPrimitiveContent())
    }

    @Test
    fun providerModelLimitsResolvedFromRegistryAndOverrides() {
        val raw = Json.parseToJsonElement("""{
            "llm": {"activeProvider": "p", "providers": {"p": {
                "baseURL": "https://x",
                "models": ["deepseek-v4-pro", "custom-model"],
                "modelConfigs": {"custom-model": {"context": 32000, "output": 4000, "apiType": "Anthropic", "multimodal": false}}
            }}}
        }""") as JsonObject
        val providers = SettingsSnapshot.resolve(raw)["llm"]!!.jsonObject["providers"]!!.jsonObject
        val limits = providers["p"]!!.jsonObject["modelLimits"]!!.jsonObject
        // 注册表命中（deepseek-v4-pro）：1M / 384K
        assertEquals(1048576L, limits["deepseek-v4-pro"]!!.jsonObject["context"]!!.jsonPrimitiveContent().toLong())
        assertEquals(384000L, limits["deepseek-v4-pro"]!!.jsonObject["output"]!!.jsonPrimitiveContent().toLong())
        // 未注册模型：用户覆盖 + 默认协议
        assertEquals(32000L, limits["custom-model"]!!.jsonObject["context"]!!.jsonPrimitiveContent().toLong())
        assertEquals(4000L, limits["custom-model"]!!.jsonObject["output"]!!.jsonPrimitiveContent().toLong())
        assertEquals("Anthropic", limits["custom-model"]!!.jsonObject["apiType"]!!.jsonPrimitiveContent())
        assertEquals(false, limits["custom-model"]!!.jsonObject["multimodal"]!!.jsonPrimitiveContent().toBoolean())
    }

    // ===== SettingsStore =====

    @Test
    fun storeRefusesToWriteWhenDiskInvalid() {
        val dir = tempDir()
        try {
            Files.createDirectories(dir)
            Files.writeString(dir.resolve("settings.json"), "{broken json")
            val store = SettingsStore(dir) { }
            store.loadSync()
            store.updateSettings { raw -> JsonObject(raw + ("newKey" to JsonPrimitive(1))) }
            assertEquals("{broken json", Files.readString(dir.resolve("settings.json")), "读不出拒绝写：磁盘文件原样保留")
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun storeSkipsWriteWhenContentUnchanged() {
        val dir = tempDir()
        try {
            Files.createDirectories(dir)
            Files.writeString(dir.resolve("settings.json"), "{\n  \"a\": 1\n}\n")
            val store = SettingsStore(dir) { }
            store.loadSync()
            var notified = 0
            store.subscribe { notified++ }
            // 读-改-写后值不变 → 不落盘不 notify（内容未变不落盘）
            store.updateSettings { raw -> raw }
            assertEquals("{\n  \"a\": 1\n}\n", Files.readString(dir.resolve("settings.json")))
            assertEquals(0, notified)
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun updatePreservesUnknownKeysAndKeyOrder() {
        val dir = tempDir()
        try {
            Files.createDirectories(dir)
            Files.writeString(dir.resolve("settings.json"), "{\n  \"uiLanguage\": \"zh\",\n  \"customFutureField\": {\"x\": 1},\n  \"llm\": {\"activeProvider\": \"p\"}\n}\n")
            val store = SettingsStore(dir) { }
            store.loadSync()
            store.updateSettings { raw ->
                val llm = raw["llm"]!!.jsonObject
                JsonObject(raw + ("llm" to JsonObject(llm + ("webSearch" to JsonPrimitive(false)))))
            }
            val text = Files.readString(dir.resolve("settings.json"))
            // 键序保留（uiLanguage 在前），未知字段保留
            assertTrue(text.indexOf("uiLanguage") < text.indexOf("llm"))
            assertTrue(text.contains("customFutureField"))
            assertTrue(text.contains("\"webSearch\""))
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun highlightLanguagesAreDedupedAndCapped() {
        val dir = tempDir()
        try {
            val store = SettingsStore(dir) { }
            store.loadSync()
            store.recordHighlightLanguages(listOf("ts", "rust", "ts"))
            store.recordHighlightLanguages((1..70).map { "lang$it" })
            store.updateSettings { raw -> null } // no-op；读盘校验
            val raw = Json.parseToJsonElement(Files.readString(dir.resolve("settings.json"))) as JsonObject
            val langs = (raw["highlightLanguages"] as JsonArray).map { (it as JsonPrimitive).content }
            assertEquals(60, langs.size, "去重 + 上限 60")
            assertTrue(!langs.contains("ts"), "超上限后最早的被裁掉")
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveContent(): String = (this as JsonPrimitive).content
}
