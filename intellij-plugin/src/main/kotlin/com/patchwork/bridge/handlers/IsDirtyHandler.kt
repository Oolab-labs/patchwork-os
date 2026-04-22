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
import com.intellij.openapi.roots.ProjectRootManager

/**
 * Handles extension/isDirty.
 *
 * Wire contract (WIRE_INVARIANTS.md §1, §2):
 *  - params: { file: string } — absolute filesystem path
 *  - result: plain boolean (true if unsaved edits, false otherwise)
 *  - file not open → false (matches VS Code: iterates open docs, returns false if not found)
 *  - file outside workspace → WorkspaceGuard throws → -32602
 */
class IsDirtyHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonPrimitive(false)

        val file = params?.get("file")?.asString
            ?: throw InvalidParamsException("missing required param: file")

        WorkspaceGuard.assertInWorkspace(file, project)

        var dirty = false
        ApplicationManager.getApplication().runReadAction {
            val vf = LocalFileSystem.getInstance().findFileByPath(file)
            if (vf != null) {
                val doc = FileDocumentManager.getInstance().getCachedDocument(vf)
                if (doc != null) {
                    dirty = FileDocumentManager.getInstance().isDocumentUnsaved(doc)
                }
                // doc == null → file not loaded in memory → not dirty
            }
        }
        return JsonPrimitive(dirty)
    }
}
