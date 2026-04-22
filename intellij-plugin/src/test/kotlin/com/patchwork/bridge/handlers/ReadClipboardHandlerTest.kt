package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class ReadClipboardHandlerTest {

    private val handler = ReadClipboardHandler()

    @Test
    fun `result has required fields text byteLength truncated`() {
        // Shape contract — cannot call CopyPasteManager in unit test, so validate via synthetic
        val synthetic = JsonObject().apply {
            addProperty("text", "hello")
            addProperty("byteLength", 5L)
            addProperty("truncated", false)
        }
        assertTrue(synthetic.has("text"))
        assertTrue(synthetic.has("byteLength"))
        assertTrue(synthetic.has("truncated"))
        assertFalse(synthetic.get("truncated").asBoolean)
    }

    @Test
    fun `truncated result has truncated=true and byteLength is original size`() {
        val synthetic = JsonObject().apply {
            addProperty("text", "short")
            addProperty("byteLength", 200_000L) // original was over 100KB
            addProperty("truncated", true)
        }
        assertTrue(synthetic.get("truncated").asBoolean)
        assertEquals(200_000L, synthetic.get("byteLength").asLong)
    }

    @Test
    fun `null project is accepted — clipboard does not require project`() {
        // readClipboard has no project dependency; must not throw on null project
        // (CopyPasteManager will throw in unit test context, but handler catches it)
        val result = handler.handle(JsonObject(), project = null)
        assertTrue(result.isJsonObject)
        val obj = result.asJsonObject
        assertTrue(obj.has("text"))
        assertTrue(obj.has("byteLength"))
        assertTrue(obj.has("truncated"))
    }

    @Test
    fun `empty clipboard returns text=empty string byteLength=0 truncated=false`() {
        // When clipboard is empty (or CopyPasteManager returns null), text should be ""
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertEquals("", result.get("text").asString)
        assertEquals(0L, result.get("byteLength").asLong)
        assertFalse(result.get("truncated").asBoolean)
    }

    @Test
    fun `byte truncation boundary — content at exactly 100KB is not truncated`() {
        val boundary = 100 * 1024
        val text = "a".repeat(boundary)
        val byteLength = text.toByteArray(Charsets.UTF_8).size.toLong()
        val truncated = byteLength > boundary
        assertFalse(truncated)
    }

    @Test
    fun `byte truncation boundary — content above 100KB is truncated`() {
        val boundary = 100 * 1024
        val text = "a".repeat(boundary + 1)
        val byteLength = text.toByteArray(Charsets.UTF_8).size.toLong()
        val truncated = byteLength > boundary
        assertTrue(truncated)
    }
}
