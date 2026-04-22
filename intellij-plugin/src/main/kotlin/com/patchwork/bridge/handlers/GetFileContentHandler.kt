package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard

/**
 * Handles extension/getFileContent.
 *
 * Wire contract (WIRE_INVARIANTS.md §1, §2):
 *  - params: { file: string } — absolute filesystem path
 *  - result from in-memory buffer: { content, isDirty, languageId, lineCount, version, source:"intellij-buffer" }
 *  - result from disk (file not open): { content, isDirty:false, languageId, lineCount, version, source:"intellij-disk" }
 *  - file not found / unreadable: { success:false, error:"..." }
 *
 * Source labels use "intellij-buffer" / "intellij-disk" instead of VS Code's
 * "vscode-buffer" / "vscode-disk" so callers can distinguish the origin IDE.
 */
class GetFileContentHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val file = params?.get("file")?.asString
            ?: throw InvalidParamsException("missing required param: file")

        WorkspaceGuard.assertInWorkspace(file, project)

        var result: JsonElement = JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "File not found: $file")
        }

        ApplicationManager.getApplication().runReadAction {
            val vf = LocalFileSystem.getInstance().findFileByPath(file)
            if (vf == null || !vf.isValid) return@runReadAction

            val fdm = FileDocumentManager.getInstance()
            val cachedDoc = fdm.getCachedDocument(vf)

            if (cachedDoc != null) {
                // File is open in editor — return live buffer content
                result = JsonObject().apply {
                    addProperty("content", cachedDoc.text)
                    addProperty("isDirty", fdm.isDocumentUnsaved(cachedDoc))
                    addProperty("languageId", vf.fileType.name.lowercase())
                    addProperty("lineCount", cachedDoc.lineCount)
                    addProperty("version", cachedDoc.modificationStamp)
                    addProperty("source", "intellij-buffer")
                }
            } else {
                // File not open — read from VFS (disk snapshot)
                try {
                    val bytes = vf.contentsToByteArray()
                    val text = String(bytes, vf.charset)
                    val lineCount = text.count { it == '\n' } + if (text.isNotEmpty()) 1 else 0
                    result = JsonObject().apply {
                        addProperty("content", text)
                        addProperty("isDirty", false)
                        addProperty("languageId", vf.fileType.name.lowercase())
                        addProperty("lineCount", lineCount)
                        addProperty("version", vf.modificationStamp)
                        addProperty("source", "intellij-disk")
                    }
                } catch (e: Exception) {
                    result = JsonObject().apply {
                        addProperty("success", false)
                        addProperty("error", "Cannot read file: ${e.message}")
                    }
                }
            }
        }

        return result
    }
}
