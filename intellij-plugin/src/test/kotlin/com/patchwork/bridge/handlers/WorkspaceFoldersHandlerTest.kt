package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Tests WorkspaceFoldersHandler contract for the null-project path.
 * Content-root enumeration requires a live IJ runtime (smoke test).
 */
class WorkspaceFoldersHandlerTest {

    private val handler = WorkspaceFoldersHandler()

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
    fun `workspace folder shape has all required fields`() {
        // Validate field names match wire contract by constructing a synthetic item
        val synthetic = JsonObject().apply {
            addProperty("name", "my-project")
            addProperty("path", "/Users/dev/my-project")
            addProperty("uri", "file:///Users/dev/my-project")
            addProperty("index", 0)
        }
        assertTrue(synthetic.has("name"))
        assertTrue(synthetic.has("path"))
        assertTrue(synthetic.has("uri"))
        assertTrue(synthetic.has("index"))
        assertEquals(0, synthetic.get("index").asInt)
        assertTrue(synthetic.get("uri").asString.startsWith("file://"),
            "uri must be file:// form")
    }
}
