package com.patchwork.bridge

import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class StubHandlerTest {

    private val stub = StubHandler()

    @Test
    fun `returns result object not exception`() {
        val result = stub.handle(params = null, project = null)
        assertTrue(result.isJsonObject)
    }

    @Test
    fun `result has success=false`() {
        val result = stub.handle(null, null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `result has exact error message`() {
        val result = stub.handle(null, null).asJsonObject
        assertEquals("Not implemented in JetBrains plugin MVP", result.get("error").asString)
    }

    @Test
    fun `stub ignores params`() {
        val params = JsonObject().apply { addProperty("file", "/some/path") }
        val result = stub.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }
}
