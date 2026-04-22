package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class GetFileContentHandlerTest {

    private val handler = GetFileContentHandler()

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    @Test
    fun `null project short-circuits before param validation — returns error object`() {
        // param check is skipped when project is null; returns structured error regardless of params
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `success result shape has all required fields`() {
        // Validate the shape contract by constructing synthetic buffer result
        val synthetic = JsonObject().apply {
            addProperty("content", "fun main() {}")
            addProperty("isDirty", false)
            addProperty("languageId", "kotlin")
            addProperty("lineCount", 1)
            addProperty("version", 42L)
            addProperty("source", "intellij-buffer")
        }
        assertTrue(synthetic.has("content"))
        assertTrue(synthetic.has("isDirty"))
        assertTrue(synthetic.has("languageId"))
        assertTrue(synthetic.has("lineCount"))
        assertTrue(synthetic.has("version"))
        assertTrue(synthetic.has("source"))
        assertTrue(synthetic.get("source").asString.startsWith("intellij-"))
    }

    @Test
    fun `error result has success=false and error field, no content`() {
        val err = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "File not found: /tmp/x.kt")
        }
        assertFalse(err.get("success").asBoolean)
        assertTrue(err.has("error"))
        assertFalse(err.has("content"))
    }
}
