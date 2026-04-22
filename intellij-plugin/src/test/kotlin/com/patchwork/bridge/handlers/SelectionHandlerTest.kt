package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Tests SelectionHandler contract for paths that don't require a live IntelliJ application.
 * The active-editor path is verified via integration smoke test (requires IJ runtime).
 */
class SelectionHandlerTest {

    private val handler = SelectionHandler()

    // -------------------------------------------------------------------------
    // No project → structured error result (not JSON-RPC error)
    // -------------------------------------------------------------------------

    @Test
    fun `null project returns result object with success=false`() {
        val result = handler.handle(params = null, project = null)
        assertTrue(result.isJsonObject, "result must be a JSON object")
        val obj = result.asJsonObject
        // Must be a result-level object, not a JSON-RPC error code
        assertFalse(obj.get("success")?.asBoolean ?: true)
        assertNotNull(obj.get("error"))
    }

    @Test
    fun `null project result has no startLine or file field`() {
        val result = handler.handle(null, null).asJsonObject
        assertFalse(result.has("startLine"), "error result must not contain startLine")
        assertFalse(result.has("file"), "error result must not contain file")
    }

    // -------------------------------------------------------------------------
    // Stub invariant: known contract fields
    // -------------------------------------------------------------------------

    @Test
    fun `result fields when project null contain error key`() {
        val result = handler.handle(null, null).asJsonObject
        assertTrue(result.has("error"))
    }
}
