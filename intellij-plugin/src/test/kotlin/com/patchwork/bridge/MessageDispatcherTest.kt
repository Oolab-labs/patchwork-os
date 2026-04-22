package com.patchwork.bridge

import com.google.gson.Gson
import com.google.gson.JsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class MessageDispatcherTest {

    private val gson = Gson()
    private lateinit var registry: HandlerRegistry
    private lateinit var dispatcher: MessageDispatcher

    @BeforeEach
    fun setUp() {
        registry = HandlerRegistry()
        dispatcher = MessageDispatcher(registry, gson)
    }

    private fun dispatch(json: String): String? {
        var captured: String? = null
        dispatcher.dispatch(json, project = null) { captured = it }
        return captured
    }

    private fun parseResponse(raw: String): JsonObject =
        gson.fromJson(raw, JsonObject::class.java)

    // -------------------------------------------------------------------------
    // Unknown method → -32601
    // -------------------------------------------------------------------------

    @Test
    fun `unknown method returns -32601`() {
        val raw = dispatch("""{"jsonrpc":"2.0","id":1,"method":"extension/doesNotExist"}""")
        assertNotNull(raw)
        val resp = parseResponse(raw!!)
        assertFalse(resp.has("result"), "must not have result")
        val error = resp.getAsJsonObject("error")
        assertEquals(-32601, error.get("code").asInt)
        assertTrue(error.get("message").asString.contains("extension/doesNotExist"))
    }

    // -------------------------------------------------------------------------
    // Known-unimplemented stub → result { success:false } (NOT JSON-RPC error)
    // -------------------------------------------------------------------------

    @Test
    fun `stub method returns result with success=false, no error block`() {
        registry.register("extension/openFile", StubHandler())
        val raw = dispatch("""{"jsonrpc":"2.0","id":2,"method":"extension/openFile"}""")
        assertNotNull(raw)
        val resp = parseResponse(raw!!)
        assertFalse(resp.has("error"), "must not have JSON-RPC error block")
        val result = resp.getAsJsonObject("result")
        assertFalse(result.get("success").asBoolean)
        assertEquals("Not implemented in JetBrains plugin MVP", result.get("error").asString)
    }

    // -------------------------------------------------------------------------
    // Handler throws InvalidParamsException → -32602
    // -------------------------------------------------------------------------

    @Test
    fun `handler InvalidParamsException returns -32602`() {
        registry.register("extension/bad") { _, _ -> throw InvalidParamsException("missing field: file") }
        val raw = dispatch("""{"jsonrpc":"2.0","id":3,"method":"extension/bad"}""")
        val resp = parseResponse(raw!!)
        val error = resp.getAsJsonObject("error")
        assertEquals(-32602, error.get("code").asInt)
    }

    // -------------------------------------------------------------------------
    // Handler throws generic exception → -32603 (no stack trace in message)
    // -------------------------------------------------------------------------

    @Test
    fun `handler generic exception returns -32603 with sanitized message`() {
        registry.register("extension/crash") { _, _ -> throw RuntimeException("boom") }
        val raw = dispatch("""{"jsonrpc":"2.0","id":4,"method":"extension/crash"}""")
        val resp = parseResponse(raw!!)
        val error = resp.getAsJsonObject("error")
        assertEquals(-32603, error.get("code").asInt)
        // message must not contain a stack trace line
        assertFalse(error.get("message").asString.contains("\tat "), "no stack trace on wire")
    }

    // -------------------------------------------------------------------------
    // Notification (no id) → no response
    // -------------------------------------------------------------------------

    @Test
    fun `notification with no id produces null response`() {
        val raw = dispatch("""{"jsonrpc":"2.0","method":"bridge/claudeConnectionChanged","params":{"connected":true}}""")
        assertNull(raw)
    }

    // -------------------------------------------------------------------------
    // Response shape: id echoed, result and error are mutually exclusive
    // -------------------------------------------------------------------------

    @Test
    fun `result response echoes id and has no error field`() {
        registry.register("extension/ok") { _, _ -> JsonObject().apply { addProperty("ok", true) } }
        val raw = dispatch("""{"jsonrpc":"2.0","id":99,"method":"extension/ok"}""")
        val resp = parseResponse(raw!!)
        assertEquals("2.0", resp.get("jsonrpc").asString)
        assertEquals(99, resp.get("id").asInt)
        assertTrue(resp.has("result"))
        assertFalse(resp.has("error"))
    }

    @Test
    fun `error response echoes id and has no result field`() {
        val raw = dispatch("""{"jsonrpc":"2.0","id":42,"method":"extension/nope"}""")
        val resp = parseResponse(raw!!)
        assertEquals(42, resp.get("id").asInt)
        assertTrue(resp.has("error"))
        assertFalse(resp.has("result"))
    }

    // -------------------------------------------------------------------------
    // Malformed JSON → no crash, null response
    // -------------------------------------------------------------------------

    @Test
    fun `malformed JSON produces null response without throwing`() {
        val raw = dispatch("this is not json {{{")
        assertNull(raw)
    }
}
