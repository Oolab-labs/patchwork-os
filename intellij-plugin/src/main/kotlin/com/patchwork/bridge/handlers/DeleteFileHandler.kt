package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard

class DeleteFileHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val filePath = params?.get("filePath")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: filePath")

        WorkspaceGuard.assertInWorkspace(filePath, project)

        val recursive = params.get("recursive")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        // useTrash default true — IJ's VirtualFile.delete moves to trash on supported platforms
        // We use VirtualFile.delete which respects platform trash on macOS/Windows via VFS.

        // VFS lookup + child enumeration require a read action.
        val vf = ApplicationManager.getApplication().runReadAction<com.intellij.openapi.vfs.VirtualFile?> {
            LocalFileSystem.getInstance().findFileByPath(filePath)
        } ?: return JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to delete: File not found: $filePath")
        }

        if (vf.isDirectory && !recursive) {
            val hasChildren = ApplicationManager.getApplication().runReadAction<Boolean> {
                vf.children?.isNotEmpty() ?: false
            }
            if (hasChildren) {
                return JsonObject().apply {
                    addProperty("success", false)
                    addProperty("error", "Failed to delete: Directory is not empty (use recursive=true)")
                }
            }
        }

        return try {
            // runWriteAction asserts EDT; handlers run on a background thread.
            ApplicationManager.getApplication().invokeAndWait {
                ApplicationManager.getApplication().runWriteAction<Unit> {
                    vf.delete(this)
                }
            }
            JsonObject().apply {
                addProperty("success", true)
                addProperty("filePath", filePath)
                addProperty("deleted", true)
            }
        } catch (e: Exception) {
            JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to delete: ${e.message}")
            }
        }
    }
}
