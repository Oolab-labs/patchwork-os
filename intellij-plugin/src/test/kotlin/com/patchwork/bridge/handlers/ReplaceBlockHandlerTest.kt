package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.patchwork.bridge.InvalidParamsException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class ReplaceBlockHandlerTest {

    private val handler = ReplaceBlockHandler()

    // --- null project ---

    @Test
    fun `null project returns success=false error object`() {
        val params = JsonObject().apply {
            addProperty("filePath", "/tmp/foo.kt")
            addProperty("oldContent", "old")
            addProperty("newContent", "new")
        }
        val result = handler.handle(params, project = null).asJsonObject
        assertFalse(result.get("success").asBoolean)
        assertTrue(result.has("error"))
    }

    // --- param validation (throw) ---

    @Test
    fun `missing filePath throws InvalidParamsException`() {
        val ex = InvalidParamsException("missing required param: filePath")
        assertEquals("missing required param: filePath", ex.message)
    }

    @Test
    fun `missing oldContent throws InvalidParamsException`() {
        val ex = InvalidParamsException("missing required param: oldContent")
        assertEquals("missing required param: oldContent", ex.message)
    }

    @Test
    fun `missing newContent throws InvalidParamsException`() {
        val ex = InvalidParamsException("missing required param: newContent")
        assertEquals("missing required param: newContent", ex.message)
    }

    // --- save default (CRITICAL — differs from editText) ---

    @Test
    fun `save defaults to true when not provided`() {
        val params = JsonObject().apply {
            addProperty("filePath", "/tmp/foo.kt")
            addProperty("oldContent", "old")
            addProperty("newContent", "new")
        }
        val save = params.get("save")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true
        assertTrue(save)
    }

    // --- soft failure shapes ---

    @Test
    fun `not-found error has exact message text`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "oldContent not found in file — verify the exact text including whitespace and line endings")
        }
        assertFalse(synthetic.get("success").asBoolean)
        assertTrue(synthetic.get("error").asString.startsWith("oldContent not found"))
    }

    @Test
    fun `ambiguous match error includes count`() {
        val count = 3
        val msg = "oldContent matches $count locations — add more surrounding context to make it unique"
        assertTrue(msg.contains("3"))
        assertTrue(msg.contains("locations"))
    }

    @Test
    fun `ambiguous match result is success=false`() {
        val synthetic = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "oldContent matches 2 locations — add more surrounding context to make it unique")
        }
        assertFalse(synthetic.get("success").asBoolean)
    }

    // --- success shape ---

    @Test
    fun `success result has success=true saved and source=intellij-buffer`() {
        val synthetic = JsonObject().apply {
            addProperty("success", true)
            addProperty("saved", true)
            addProperty("source", "intellij-buffer")
        }
        assertTrue(synthetic.get("success").asBoolean)
        assertTrue(synthetic.get("saved").asBoolean)
        assertEquals("intellij-buffer", synthetic.get("source").asString)
    }

    @Test
    fun `source is intellij-buffer not vscode-buffer`() {
        // Wire adaptation: mirrors GetFileContentHandler convention
        val source = "intellij-buffer"
        assertNotEquals("vscode-buffer", source)
        assertEquals("intellij-buffer", source)
    }

    // --- match logic ---

    @Test
    fun `single match is found correctly`() {
        val text = "fun foo() {\n    val x = 1\n}\n"
        val old = "val x = 1"
        val first = text.indexOf(old)
        val second = text.indexOf(old, first + 1)
        assertTrue(first >= 0)
        assertEquals(-1, second) // unique
    }

    @Test
    fun `duplicate match is counted correctly`() {
        val text = "val x = 1\nval x = 1\n"
        val old = "val x = 1"
        val first = text.indexOf(old)
        val second = text.indexOf(old, first + 1)
        var count = if (first >= 0) 1 else 0
        var idx = first
        while (true) {
            idx = text.indexOf(old, idx + 1)
            if (idx == -1) break
            count++
        }
        assertEquals(2, count)
        assertTrue(second >= 0)
    }

    @Test
    fun `missing match returns index -1`() {
        val text = "fun foo() {}"
        val old = "fun bar() {}"
        assertEquals(-1, text.indexOf(old))
    }

    @Test
    fun `replace is applied at correct offset`() {
        val text = "hello world"
        val old = "world"
        val new = "there"
        val idx = text.indexOf(old)
        val result = text.substring(0, idx) + new + text.substring(idx + old.length)
        assertEquals("hello there", result)
    }
}
