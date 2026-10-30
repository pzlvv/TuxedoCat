package pycharm.host

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pycharm.host.protocol.CORE_PROTOCOL_VERSION
import pycharm.host.protocol.FrameDecoder
import pycharm.host.protocol.coreResponseFrame
import pycharm.host.protocol.decodeFrame
import pycharm.host.protocol.encodeFrame
import pycharm.host.protocol.helloFrame
import pycharm.host.protocol.shutdownFrame
import pycharm.host.protocol.uiEventFrame
import pycharm.host.protocol.uiRequestFrame
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 帧协议编解码（对齐 protocol.ts / frame.rs 的 wire 语义；specs/035 测试计划第 1 层） */
class FrameCodecTest {

    @Test
    fun helloFrameCarriesProtocolVersion() {
        val frame = helloFrame()
        assertEquals("hello", frame["kind"]!!.jsonPrimitiveContent())
        assertEquals(CORE_PROTOCOL_VERSION, frame["protocol"]!!.jsonPrimitiveContent().toInt())
        // 往返：encode → decode 一致
        assertEquals(frame, decodeFrame(encodeFrame(frame)))
    }

    @Test
    fun uiEventAndRequestFramesRoundTrip() {
        val event = buildJsonObject { put("type", "userMessageSubmitted"); put("sessionId", "s1"); put("content", "你好 world") }
        val frame = uiEventFrame(event)
        assertEquals("uiEvent", frame["kind"]!!.jsonPrimitiveContent())
        assertEquals(event, frame["event"])

        val request = uiRequestFrame(42, buildJsonObject { put("type", "conversationLoadRequested"); put("sessionId", "s1") })
        assertEquals(42, request["id"]!!.jsonPrimitiveContent().toLong())
        assertEquals(request, decodeFrame(encodeFrame(request)))

        val response = coreResponseFrame(42, ok = true, result = buildJsonObject { put("ok", true) })
        assertEquals("response", response["kind"]!!.jsonPrimitiveContent())
        assertEquals(response, decodeFrame(encodeFrame(response)))
    }

    @Test
    fun loneSurrogateIsSanitizedOnEncode() {
        // 孤立代理项会让 core 的 serde 拒收整帧：encode 前替换为 U+DE00（对齐 stringifyJsonSafe）
        val withLoneSurrogate = buildJsonObject {
            put("type", "log")
            put("message", "bad\uD83Dpair")
        }
        val encoded = encodeFrame(withLoneSurrogate)
        val decoded = decodeFrame(encoded)!!
        assertEquals("bad\uDE00pair", decoded["message"]!!.jsonPrimitiveContent())
        // 单帧单行（不含裸换行）
        assertTrue(!encoded.contains('\n'))
    }

    @Test
    fun decoderSplitsLinesAndSkipsBadLines() {
        val decoder = FrameDecoder()
        val good1 = encodeFrame(shutdownFrame())
        val good2 = encodeFrame(uiEventFrame(buildJsonObject { put("type", "queryBegin") }))
        val chunk = "not-json\n$good1\n\n\nbroken{\"x\":\n$good2\n"
        val frames = decoder.push(chunk)
        assertEquals(2, frames.size)
        assertEquals("shutdown", frames[0]["kind"]!!.jsonPrimitiveContent())
        assertEquals("uiEvent", frames[1]["kind"]!!.jsonPrimitiveContent())
        // 半帧留在缓冲，跨 chunk 到达后补齐
        val half = good2.substring(0, good2.length / 2)
        assertTrue(decoder.push(half).isEmpty())
        assertEquals(good2, decoder.push(good2.substring(good2.length / 2) + "\n").single().let { encodeFrame(it) })
    }

    @Test
    fun decodeFrameReturnsNullForGarbage() {
        assertNull(decodeFrame("{broken"))
        assertNull(decodeFrame(""))
        assertEquals(JsonObject(emptyMap()), decodeFrame("{}"))
    }

    private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveContent(): String = (this as JsonPrimitive).content
}
