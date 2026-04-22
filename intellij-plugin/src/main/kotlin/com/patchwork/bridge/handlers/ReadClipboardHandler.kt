package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.patchwork.bridge.BridgeHandler
import java.awt.datatransfer.DataFlavor

class ReadClipboardHandler : BridgeHandler {

    companion object {
        private const val MAX_READ_BYTES = 100 * 1024L // 100 KB
    }

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val text = try {
            CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor) ?: ""
        } catch (_: Exception) {
            ""
        }

        val byteLength = text.toByteArray(Charsets.UTF_8).size.toLong()

        return if (byteLength > MAX_READ_BYTES) {
            val truncated = text.toByteArray(Charsets.UTF_8)
                .take(MAX_READ_BYTES.toInt())
                .toByteArray()
                .toString(Charsets.UTF_8)
            JsonObject().apply {
                addProperty("text", truncated)
                addProperty("byteLength", byteLength)
                addProperty("truncated", true)
            }
        } else {
            JsonObject().apply {
                addProperty("text", text)
                addProperty("byteLength", byteLength)
                addProperty("truncated", false)
            }
        }
    }
}
