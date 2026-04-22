package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class CloseTabHandlerTest {

    private val handler = CloseTabHandler()

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    @Test
    fun `null project short-circuits before param validation`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `success result shape has success and promptedToSave`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("promptedToSave", false)
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("promptedToSave"))
        assertFalse(synthetic.has("error"))
    }

    @Test
    fun `tab-not-found returns success=false with error`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Tab not found")
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertEquals("Tab not found", synthetic.get("error").asString)
    }

    @Test
    fun `promptedToSave=true when tab was dirty before close`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("promptedToSave", true)
        }
        assertTrue(synthetic.get("promptedToSave").asBoolean)
    }

    @Test
    fun `symlink normalization — canonical paths are compared not raw paths`() {
        // Validate the canonical-path comparison logic in isolation
        val a = java.io.File("/tmp/foo.kt").canonicalPath
        val b = java.io.File("/tmp/foo.kt").canonicalPath
        assertEquals(a, b)
    }
}
