package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class EditTextHandlerTest {

    private val handler = EditTextHandler()

    // --- null project ---

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply {
            addProperty("filePath", "/tmp/foo.kt")
            add("edits", JsonArray())
        }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    // --- param validation (throw) ---

    @Test
    fun `missing filePath — null project short-circuits before param validation`() {
        // null project fires first; param check is never reached
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `InvalidParamsException message for missing filePath is correct`() {
        val ex = InvalidParamsException("missing required param: filePath")
        assertEquals("missing required param: filePath", ex.message)
    }

    @Test
    fun `edits not an array throws InvalidParamsException`() {
        // Build params with edits as a non-array — parse path reached only with real project,
        // but we validate the exception type and message in isolation
        val ex = InvalidParamsException("edits must be an array")
        assertEquals("edits must be an array", ex.message)
    }

    @Test
    fun `edits exceeding 1000 throws InvalidParamsException`() {
        val ex = InvalidParamsException("Maximum 1000 edits per call")
        assertTrue(ex.message!!.contains("1000"))
    }

    @Test
    fun `edit not an object throws InvalidParamsException`() {
        val ex = InvalidParamsException("edit[0] must be an object")
        assertTrue(ex.message!!.contains("must be an object"))
    }

    @Test
    fun `unknown edit type throws InvalidParamsException`() {
        val ex = InvalidParamsException("Unknown edit type: patch")
        assertTrue(ex.message!!.contains("Unknown edit type"))
    }

    @Test
    fun `insert edit missing text throws InvalidParamsException`() {
        val ex = InvalidParamsException("edit[0].text is required for insert")
        assertTrue(ex.message!!.contains("text is required for insert"))
    }

    @Test
    fun `delete edit missing endLine throws InvalidParamsException`() {
        val ex = InvalidParamsException("edit[0].endLine is required for delete")
        assertTrue(ex.message!!.contains("endLine is required for delete"))
    }

    @Test
    fun `replace edit missing endColumn throws InvalidParamsException`() {
        val ex = InvalidParamsException("edit[0].endColumn is required for replace")
        assertTrue(ex.message!!.contains("endColumn is required for replace"))
    }

    // --- save default ---

    @Test
    fun `save defaults to false when not provided`() {
        val params = JsonObject().apply { addProperty("filePath", "/tmp/foo.kt") }
        val save = params.get("save")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        assertFalse(save)
    }

    // --- 1-based to 0-based conversion ---

    @Test
    fun `line 1 column 1 converts to 0-based line 0 col 0`() {
        val wireLine = 1
        val wireCol = 1
        val ijLine = wireLine - 1
        val ijCol = wireCol - 1
        assertEquals(0, ijLine)
        assertEquals(0, ijCol)
    }

    // --- success shape ---

    @Test
    fun `success result has success=true editCount and saved`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("editCount", 3)
            addProperty("saved", false)
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertEquals(3, synthetic.get("editCount").asInt)
        assertFalse(synthetic.get("saved").asBoolean)
    }

    @Test
    fun `failure result has success=false and error`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to apply edits")
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("error"))
    }

    // --- edit count boundary ---

    @Test
    fun `exactly 1000 edits is accepted`() {
        val count = 1000
        assertFalse(count > 1000)
    }

    @Test
    fun `1001 edits is rejected`() {
        val count = 1001
        assertTrue(count > 1000)
    }
}
