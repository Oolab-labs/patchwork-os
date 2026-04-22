package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard
import java.io.File

class CloseTabHandler : BridgeHandler {

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

        // Resolve symlinks for comparison — mirrors VS Code's realpathSync logic
        val normalizedTarget = try {
            File(file).canonicalPath
        } catch (_: Exception) {
            File(file).absolutePath
        }

        val fem = FileEditorManager.getInstance(project)
        val fdm = FileDocumentManager.getInstance()

        // Find matching open file among all open editors
        var matchedVf = fem.openFiles.firstOrNull { vf ->
            val tabPath = try {
                File(vf.path).canonicalPath
            } catch (_: Exception) {
                File(vf.path).absolutePath
            }
            tabPath == normalizedTarget
        }

        if (matchedVf == null) {
            // Also check via LocalFileSystem in case not yet opened in editor
            val vf = LocalFileSystem.getInstance().findFileByPath(file)
            if (vf != null && fem.isFileOpen(vf)) matchedVf = vf
        }

        if (matchedVf == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Tab not found")
            }
        }

        val document = fdm.getCachedDocument(matchedVf)
        val wasDirty = document != null && fdm.isDocumentUnsaved(document)

        ApplicationManager.getApplication().invokeAndWait {
            fem.closeFile(matchedVf)
        }

        return JsonObject().apply {
            addProperty("success", true)
            addProperty("promptedToSave", wasDirty)
        }
    }
}
