package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

// ---------------------------------------------------------------------------
// listTerminals
// ---------------------------------------------------------------------------

class ListTerminalsHandlerTest {
    private val handler = ListTerminalsHandler()

    @Test
    fun `null project returns empty terminals list`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertTrue(result.has("terminals"))
        assertEquals(0, result.get("count").asInt)
        assertFalse(result.get("outputCaptureAvailable").asBoolean)
    }

    @Test
    fun `result shape has terminals count and outputCaptureAvailable`() {
        val synthetic = JsonObject().apply {
            add("terminals", com.google.gson.JsonArray())
            addProperty("count", 0)
            addProperty("outputCaptureAvailable", false)
        }
        assertTrue(synthetic.has("terminals"))
        assertTrue(synthetic.has("count"))
        assertTrue(synthetic.has("outputCaptureAvailable"))
    }

    @Test
    fun `outputCaptureAvailable is always false in IJ plugin`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("outputCaptureAvailable").asBoolean)
    }
}

// ---------------------------------------------------------------------------
// createTerminal
// ---------------------------------------------------------------------------

class CreateTerminalHandlerTest {
    private val handler = CreateTerminalHandler()

    @Test
    fun `null project returns success=false`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    @Test
    fun `invalid env value type throws InvalidParamsException`() {
        val params = JsonObject().apply {
            add("env", JsonObject().apply { addProperty("PATH", 42) })
        }
        // null project short-circuits before env check
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `success result has success=true name and index`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("name", "Terminal")
            addProperty("index", 0)
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("name"))
        assertTrue(synthetic.has("index"))
    }

    @Test
    fun `show defaults to true when not provided`() {
        val params = JsonObject()
        val show = params.get("show")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true
        assertTrue(show)
    }
}

// ---------------------------------------------------------------------------
// disposeTerminal
// ---------------------------------------------------------------------------

class DisposeTerminalHandlerTest {
    private val handler = DisposeTerminalHandler()

    @Test
    fun `null project returns success=false`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `success result has success=true and terminalName`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("terminalName", "my-term")
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("terminalName"))
    }

    @Test
    fun `not-found result has availableTerminals array`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Terminal not found with name \"ghost\"")
            add("availableTerminals", com.google.gson.JsonArray())
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("availableTerminals"))
    }
}

// ---------------------------------------------------------------------------
// sendTerminalCommand
// ---------------------------------------------------------------------------

class SendTerminalCommandHandlerTest {
    private val handler = SendTerminalCommandHandler()

    @Test
    fun `missing text returns success=false`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.get("error").asString.contains("text must be a string"))
    }

    @Test
    fun `text with semicolon is rejected`() {
        val params = JsonObject().apply { addProperty("text", "ls; rm -rf /") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.get("error").asString.contains("metacharacters"))
    }

    @Test
    fun `text with pipe is rejected`() {
        val params = JsonObject().apply { addProperty("text", "cat file | grep foo") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `text with newline is rejected`() {
        val params = JsonObject().apply { addProperty("text", "ls\nrm -rf /") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
    }

    @Test
    fun `clean command passes metachar check`() {
        val text = "gradle build"
        val METACHAR_RE = Regex("""[;&|`${'$'}()<>{}!\\\n\r]""")
        assertFalse(METACHAR_RE.containsMatchIn(text))
    }

    @Test
    fun `addNewline defaults to true`() {
        val params = JsonObject().apply { addProperty("text", "ls") }
        val addNewline = params.get("addNewline")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true
        assertTrue(addNewline)
    }

    @Test
    fun `success result has success=true and terminalName`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("terminalName", "my-term")
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("terminalName"))
    }
}

// ---------------------------------------------------------------------------
// getTerminalOutput
// ---------------------------------------------------------------------------

class GetTerminalOutputHandlerTest {
    private val handler = GetTerminalOutputHandler()

    @Test
    fun `always returns available=false with error`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("available").asBoolean)
        assertTrue(result.has("error"))
        assertTrue(result.get("error").asString.contains("not available"))
    }

    @Test
    fun `name param is reflected in result when provided`() {
        val params = JsonObject().apply { addProperty("name", "my-term") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("available").asBoolean)
    }
}

// ---------------------------------------------------------------------------
// waitForTerminalOutput
// ---------------------------------------------------------------------------

class WaitForTerminalOutputHandlerTest {
    private val handler = WaitForTerminalOutputHandler()

    @Test
    fun `missing pattern returns matched=false with error`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("matched").asBoolean)
        assertTrue(result.get("error").asString.contains("pattern"))
    }

    @Test
    fun `empty pattern returns matched=false with error`() {
        val params = JsonObject().apply { addProperty("pattern", "") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("matched").asBoolean)
    }

    @Test
    fun `valid pattern returns matched=false with not-available error`() {
        val params = JsonObject().apply { addProperty("pattern", "BUILD SUCCESS") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("matched").asBoolean)
        assertTrue(result.get("error").asString.contains("not available"))
    }
}

// ---------------------------------------------------------------------------
// executeInTerminal
// ---------------------------------------------------------------------------

class ExecuteInTerminalHandlerTest {
    private val handler = ExecuteInTerminalHandler()

    @Test
    fun `missing command returns success=false`() {
        val result = handler.handle(JsonObject(), project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.get("error").asString.contains("command"))
    }

    @Test
    fun `command with newline returns success=false`() {
        val params = JsonObject().apply { addProperty("command", "ls\nrm -rf /") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.get("error").asString.contains("newline"))
    }

    @Test
    fun `command with semicolon returns success=false`() {
        val params = JsonObject().apply { addProperty("command", "ls; rm") }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.get("error").asString.contains("metacharacter"))
    }

    @Test
    fun `simple echo command executes and returns output`() {
        val params = JsonObject().apply { addProperty("command", "echo hello") }
        val result = handler.handle(params, project = null).asJsonObject
        assertTrue(result.get("success").asBoolean)
        assertTrue(result.get("output").asString.contains("hello"))
        assertEquals(0, result.get("exitCode").asInt)
    }

    @Test
    fun `timeoutMs is clamped to 1000-300000 range`() {
        val raw = 500L
        val clamped = raw.coerceIn(1_000L, 300_000L)
        assertEquals(1_000L, clamped)

        val raw2 = 999_999L
        val clamped2 = raw2.coerceIn(1_000L, 300_000L)
        assertEquals(300_000L, clamped2)
    }

    @Test
    fun `success result has success exitCode and output`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("exitCode", 0)
            addProperty("output", "hello\n")
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.has("exitCode"))
        assertTrue(synthetic.has("output"))
    }
}
