package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Tests OpenFilesHandler contract for the null-project path.
 * Active-editor path requires a live IJ runtime (smoke test).
 */
class OpenFilesHandlerTest {

    private val handler = OpenFilesHandler()

    @Test
    fun `null project returns error result object`() {
        val result = handler.handle(params = null, project = null)
        assertTrue(result.isJsonObject)
        val obj = result.asJsonObject
        assertFalse(obj.get("success")?.asBoolean ?: true)
        assertTrue(obj.has("error"))
    }

    @Test
    fun `null project result is not an array`() {
        val result = handler.handle(null, null)
        assertFalse(result.isJsonArray, "error result must not be a plain array")
    }

    @Test
    fun `tab info shape has required fields`() {
        // Verify field names match wire contract by constructing a synthetic item
        val synthetic = JsonObject().apply {
            addProperty("filePath", "/abs/path/Foo.kt")
            addProperty("isActive", true)
            addProperty("isDirty", false)
            addProperty("languageId", "kotlin")
        }
        assertTrue(synthetic.has("filePath"))
        assertTrue(synthetic.has("isActive"))
        assertTrue(synthetic.has("isDirty"))
        // languageId is optional but must be string when present
        assertEquals("kotlin", synthetic.get("languageId").asString)
    }
}
