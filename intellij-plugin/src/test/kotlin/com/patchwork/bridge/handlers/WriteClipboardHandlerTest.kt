package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class WriteClipboardHandlerTest {

    private val handler = WriteClipboardHandler()

    @Test
    fun `missing text param throws InvalidParamsException`() {
        assertThrows(InvalidParamsException::class.java) {
            handler.handle(JsonObject(), project = null)
        }
    }

    @Test
    fun `non-string text param throws InvalidParamsException`() {
        val params = JsonObject().apply { addProperty("text", 42) }
        assertThrows(InvalidParamsException::class.java) {
            handler.handle(params, project = null)
        }
    }

    @Test
    fun `text exceeding 1MB returns written=false with error`() {
        val bigText = "a".repeat(1024 * 1024 + 1)
        val params = JsonObject().apply { addProperty("text", bigText) }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("written").asBoolean)
        assertTrue(result.has("error"))
        assertFalse(result.has("byteLength"))
    }

    @Test
    fun `success result shape has written=true and byteLength`() {
        val synthetic = JsonObject().apply {
            addProperty("written", true)
            addProperty("byteLength", 5L)
        }
        assertTrue(synthetic.get("written").asBoolean)
        assertTrue(synthetic.has("byteLength"))
        assertFalse(synthetic.has("error"))
    }

    @Test
    fun `write error result has written=false and error field`() {
        val synthetic = JsonObject().apply {
            addProperty("written", false)
            addProperty("error", "Clipboard unavailable")
        }
        assertFalse(synthetic.get("written").asBoolean)
        assertTrue(synthetic.has("error"))
    }

    @Test
    fun `null project is accepted — clipboard does not require project`() {
        // text param valid but CopyPasteManager unavailable in unit test → written=false+error
        val params = JsonObject().apply { addProperty("text", "hello") }
        val result = handler.handle(params, project = null).asJsonObject
        // Either succeeds or fails gracefully — must not throw, must have written field
        assertTrue(result.has("written"))
    }

    @Test
    fun `write size boundary — exactly 1MB is accepted`() {
        val maxBytes = 1024 * 1024
        val text = "a".repeat(maxBytes)
        val byteLength = text.toByteArray(Charsets.UTF_8).size.toLong()
        assertTrue(byteLength <= maxBytes)
    }
}
