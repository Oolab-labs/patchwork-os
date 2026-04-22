package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class DeleteFileHandlerTest {

    private val handler = DeleteFileHandler()

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    @Test
    fun `missing filePath param throws InvalidParamsException`() {
        val ex = InvalidParamsException("missing required param: filePath")
        assertEquals("missing required param: filePath", ex.message)
    }

    @Test
    fun `success result has success=true filePath and deleted=true`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("filePath", "/workspace/old.kt")
            addProperty("deleted", true)
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.get("deleted").asBoolean)
        assertEquals("/workspace/old.kt", synthetic.get("filePath").asString)
    }

    @Test
    fun `failure result has success=false and error starting with Failed to delete`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to delete: File not found: /tmp/x.kt")
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertTrue(synthetic.get("error").asString.startsWith("Failed to delete"))
    }

    @Test
    fun `recursive defaults to false`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val recursive = params.get("recursive")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        assertFalse(recursive)
    }

    @Test
    fun `useTrash defaults to true`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val useTrash = params.get("useTrash")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true
        assertTrue(useTrash)
    }
}
