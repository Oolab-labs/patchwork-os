package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard

/**
 * Handles extension/openFile.
 *
 * Wire contract (WIRE_INVARIANTS.md §1, §2):
 *  - params: { file: string, line?: number } — file is absolute path; line is 1-based
 *  - result on success: plain boolean true
 *  - result on failure: { success:false, error:"..." }
 *
 * Mirrors VS Code: opens the document and scrolls to line (1-based → 0-based internally).
 * Missing line defaults to 1 (scroll to top).
 */
class OpenFileHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val file = params?.get("file")?.asString
            ?: throw InvalidParamsException("missing required param: file")

        // line param: must be integer ≥ 1; default 1 (matches VS Code handler)
        val lineParam = params.get("line")
        val line1Based = if (lineParam != null && lineParam.isJsonPrimitive && lineParam.asJsonPrimitive.isNumber) {
            lineParam.asInt.coerceAtLeast(1)
        } else {
            1
        }
        val line0Based = line1Based - 1

        WorkspaceGuard.assertInWorkspace(file, project)

        val vf = LocalFileSystem.getInstance().findFileByPath(file)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "File not found: $file")
            }

        var success = false
        // openFile must run on the EDT
        ApplicationManager.getApplication().invokeAndWait {
            try {
                val descriptor = OpenFileDescriptor(project, vf, line0Based, 0)
                val editors = FileEditorManager.getInstance(project).openEditor(descriptor, true)
                success = editors.isNotEmpty()
            } catch (e: Exception) {
                success = false
            }
        }

        return if (success) JsonPrimitive(true) else JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to open file: $file")
        }
    }
}
