package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class IsDirtyHandlerTest {

    private val handler = IsDirtyHandler()

    @Test
    fun `null project returns false (not error object)`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val result = handler.handle(params, project = null)
        assertTrue(result.isJsonPrimitive)
        assertFalse(result.asBoolean)
    }

    @Test
    fun `null project short-circuits before param validation — returns false`() {
        // param check is skipped when project is null; returns false regardless of params
        val result = handler.handle(JsonObject(), project = null)
        assertFalse(result.asBoolean)
    }

    @Test
    fun `result is plain boolean not wrapped object`() {
        val params = JsonObject().apply { addProperty("file", "/tmp/foo.kt") }
        val result = handler.handle(params, null)
        assertFalse(result.isJsonObject, "isDirty must return a plain boolean, not an object")
        assertFalse(result.isJsonArray)
    }
}
