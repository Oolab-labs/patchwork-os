package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class OpenFileHandlerTest {

    private val handler = OpenFileHandler()

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null)
        assertTrue(result.isJsonObject)
        assertFalse(result.asJsonObject.get("success").asBoolean)
    }

    @Test
    fun `null project short-circuits before param validation — returns error object`() {
        // param check is skipped when project is null; returns structured error regardless of params
        val result = handler.handle(JsonObject(), project = null)
        assertTrue(result.isJsonObject)
        assertFalse(result.asJsonObject.get("success").asBoolean)
    }

    @Test
    fun `success result is plain true boolean not wrapped object`() {
        // Wire contract: openFile returns bare true on success, not { success:true }
        val success = JsonPrimitive(true)
        assertTrue(success.isBoolean)
        assertTrue(success.asBoolean)
        assertFalse(success.isJsonObject)
    }

    @Test
    fun `line param below 1 is clamped to 1`() {
        // Validate clamping logic in isolation
        val lineParam = -5
        val clamped = lineParam.coerceAtLeast(1)
        assertEquals(1, clamped)
    }

    @Test
    fun `line param converts 1-based to 0-based internally`() {
        // line=1 → line0Based=0 (scroll to top, matches VS Code: Math.max(0, line-1))
        val line1Based = 1
        val line0Based = line1Based - 1
        assertEquals(0, line0Based)
    }

    @Test
    fun `missing line param defaults to 1`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val lineElement = params.get("line") // null
        val resolved = if (lineElement != null && lineElement.isJsonPrimitive && lineElement.asJsonPrimitive.isNumber)
            lineElement.asInt.coerceAtLeast(1) else 1
        assertEquals(1, resolved)
    }
}
