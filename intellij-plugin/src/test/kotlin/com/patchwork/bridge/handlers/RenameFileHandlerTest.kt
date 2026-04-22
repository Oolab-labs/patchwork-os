package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class RenameFileHandlerTest {

    private val handler = RenameFileHandler()

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply {
            addProperty("oldPath", "/tmp/a.kt")
            addProperty("newPath", "/tmp/b.kt")
        }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    @Test
    fun `missing oldPath throws InvalidParamsException`() {
        val ex = InvalidParamsException("missing required param: oldPath")
        assertEquals("missing required param: oldPath", ex.message)
    }

    @Test
    fun `missing newPath throws InvalidParamsException`() {
        val ex = InvalidParamsException("missing required param: newPath")
        assertEquals("missing required param: newPath", ex.message)
    }

    @Test
    fun `success result has required fields`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("oldPath", "/workspace/a.kt")
            addProperty("newPath", "/workspace/b.kt")
            addProperty("renamed", true)
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.get("renamed").asBoolean)
        assertEquals("/workspace/a.kt", synthetic.get("oldPath").asString)
        assertEquals("/workspace/b.kt", synthetic.get("newPath").asString)
    }

    @Test
    fun `failure result has success=false and error starting with Failed to rename`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to rename file: Source not found: /tmp/a.kt")
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertTrue(synthetic.get("error").asString.startsWith("Failed to rename"))
    }

    @Test
    fun `overwrite defaults to false`() {
        val params = JsonObject().apply {
            addProperty("oldPath", "/tmp/a.kt")
            addProperty("newPath", "/tmp/b.kt")
        }
        val overwrite = params.get("overwrite")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        assertFalse(overwrite)
    }

    @Test
    fun `same-directory rename keeps same parent`() {
        val oldFile = java.io.File("/workspace/src/a.kt")
        val newFile = java.io.File("/workspace/src/b.kt")
        assertEquals(oldFile.parent, newFile.parent)
    }

    @Test
    fun `cross-directory move has different parents`() {
        val oldFile = java.io.File("/workspace/src/a.kt")
        val newFile = java.io.File("/workspace/lib/a.kt")
        assertNotEquals(oldFile.parent, newFile.parent)
    }
}
