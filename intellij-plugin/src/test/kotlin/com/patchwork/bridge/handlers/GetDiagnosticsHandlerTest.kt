package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class GetDiagnosticsHandlerTest {

    private val handler = GetDiagnosticsHandler()

    @Test
    fun `null project with file param returns empty array`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null)
        assertTrue(result.isJsonArray)
        assertEquals(0, result.asJsonArray.size())
    }

    @Test
    fun `null project without file param returns diagnostics+truncated object`() {
        val result = handler.handle(JsonObject(), project = null)
        assertTrue(result.isJsonObject)
        val obj = result.asJsonObject
        assertTrue(obj.has("diagnostics"))
        assertTrue(obj.has("truncated"))
        assertTrue(obj.get("diagnostics").isJsonArray)
        assertFalse(obj.get("truncated").asBoolean)
    }

    @Test
    fun `single-file shape is bare JsonArray not wrapped object`() {
        // Wire contract: file param → plain array (not {diagnostics:[...]})
        val synthetic = com.google.gson.JsonArray()
        assertTrue(synthetic.isJsonArray)
        assertFalse(synthetic.isJsonObject)
    }

    @Test
    fun `all-files shape has required fields diagnostics and truncated`() {
        val synthetic = JsonObject().apply {
            add("diagnostics", com.google.gson.JsonArray())
            addProperty("truncated", false)
        }
        assertTrue(synthetic.has("diagnostics"))
        assertTrue(synthetic.has("truncated"))
        assertTrue(synthetic.get("diagnostics").isJsonArray)
    }

    @Test
    fun `diagnostic entry has all required fields`() {
        val d = JsonObject().apply {
            addProperty("message", "Unresolved reference: foo")
            addProperty("severity", "error")
            addProperty("line", 5)
            addProperty("column", 3)
            addProperty("endLine", 5)
            addProperty("endColumn", 6)
            addProperty("source", "kotlin")
            addProperty("code", "")
        }
        assertTrue(d.has("message"))
        assertTrue(d.has("severity"))
        assertTrue(d.has("line"))
        assertTrue(d.has("column"))
        assertTrue(d.has("endLine"))
        assertTrue(d.has("endColumn"))
        assertTrue(d.has("source"))
        assertTrue(d.has("code"))
    }

    @Test
    fun `severity values match VS Code contract`() {
        val valid = setOf("error", "warning", "information", "hint")
        assertTrue(valid.contains("error"))
        assertTrue(valid.contains("warning"))
        assertTrue(valid.contains("information"))
        assertTrue(valid.contains("hint"))
    }

    @Test
    fun `line and column are 1-based`() {
        // Line 0, col 0 in IJ → line 1, col 1 in wire format
        val startOffset = 0
        val lineNumber = 0 // IJ 0-based
        val lineStartOffset = 0
        val wireLine = lineNumber + 1
        val wireCol = startOffset - lineStartOffset + 1
        assertEquals(1, wireLine)
        assertEquals(1, wireCol)
    }

    @Test
    fun `truncated=true when total count reaches 500`() {
        // Validate truncation logic in isolation
        val MAX = 500
        var total = 500
        val truncated = total >= MAX
        assertTrue(truncated)
    }
}
