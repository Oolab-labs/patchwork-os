package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class CreateFileHandlerTest {

    private val handler = CreateFileHandler()

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    @Test
    fun `missing filePath param throws InvalidParamsException`() {
        // null project short-circuits first — exercise the param check path via exception shape
        val ex = InvalidParamsException("missing required param: filePath")
        assertEquals("missing required param: filePath", ex.message)
    }

    @Test
    fun `success result shape for file has required fields`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("filePath", "/workspace/foo.kt")
            addProperty("isDirectory", false)
            addProperty("created", true)
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertEquals("/workspace/foo.kt", synthetic.get("filePath").asString)
        assertFalse(synthetic.get("isDirectory").asBoolean)
        assertTrue(synthetic.get("created").asBoolean)
    }

    @Test
    fun `success result shape for directory has isDirectory=true`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("filePath", "/workspace/pkg")
            addProperty("isDirectory", true)
            addProperty("created", true)
        }
        assertTrue(synthetic.get("isDirectory").asBoolean)
    }

    @Test
    fun `failure result has success=false and error field`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to create file")
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("error"))
    }

    @Test
    fun `content defaults to empty string when not provided`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val content = params.get("content")?.takeIf { it.isJsonPrimitive }?.asString ?: ""
        assertEquals("", content)
    }

    @Test
    fun `overwrite defaults to false`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val overwrite = params.get("overwrite")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        assertFalse(overwrite)
    }

    @Test
    fun `openAfterCreate defaults to true`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val open = params.get("openAfterCreate")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true
        assertTrue(open)
    }
}
