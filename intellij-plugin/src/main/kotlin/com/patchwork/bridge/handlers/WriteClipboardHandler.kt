package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import java.awt.datatransfer.StringSelection

class WriteClipboardHandler : BridgeHandler {

    companion object {
        private const val MAX_WRITE_BYTES = 1024 * 1024L // 1 MB
    }

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val textEl = params?.get("text")
        if (textEl == null || !textEl.isJsonPrimitive || !textEl.asJsonPrimitive.isString) {
            throw InvalidParamsException("text is required and must be a string")
        }
        val text = textEl.asString

        val byteLength = text.toByteArray(Charsets.UTF_8).size.toLong()
        if (byteLength > MAX_WRITE_BYTES) {
            return JsonObject().apply {
                addProperty("written", false)
                addProperty("error", "Text too large: $byteLength bytes (max $MAX_WRITE_BYTES)")
            }
        }

        return try {
            CopyPasteManager.getInstance().setContents(StringSelection(text))
            JsonObject().apply {
                addProperty("written", true)
                addProperty("byteLength", byteLength)
            }
        } catch (e: Exception) {
            JsonObject().apply {
                addProperty("written", false)
                addProperty("error", e.message ?: "Unknown clipboard error")
            }
        }
    }
}
