package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard

class SaveFileHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val file = params?.get("file")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: file")

        WorkspaceGuard.assertInWorkspace(file, project)

        val vf = LocalFileSystem.getInstance().findFileByPath(file)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Document not open")
            }

        val fdm = FileDocumentManager.getInstance()
        val document = fdm.getCachedDocument(vf)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Document not open")
            }

        // Untitled check: VirtualFile has no path on disk (never been saved)
        if (vf.path.isEmpty() || !vf.isInLocalFileSystem) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Cannot save untitled document")
            }
        }

        ApplicationManager.getApplication().invokeAndWait {
            fdm.saveDocument(document)
        }

        return JsonPrimitive(true)
    }
}
