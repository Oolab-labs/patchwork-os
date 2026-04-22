package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard
import java.io.File

class RenameFileHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val oldPath = params?.get("oldPath")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: oldPath")
        val newPath = params.get("newPath")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: newPath")

        WorkspaceGuard.assertInWorkspace(oldPath, project)
        WorkspaceGuard.assertInWorkspace(newPath, project)

        val overwrite = params.get("overwrite")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

        val vf = LocalFileSystem.getInstance().findFileByPath(oldPath)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to rename file: Source not found: $oldPath")
            }

        val newFile = File(newPath)
        val newName = newFile.name
        val newParentPath = newFile.parent ?: return JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Failed to rename file: Invalid destination path")
        }

        val destExists = File(newPath).exists()
        if (destExists && !overwrite) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to rename file: Destination already exists (use overwrite=true)")
            }
        }

        return try {
            ApplicationManager.getApplication().runWriteAction<Unit> {
                val isSameDir = vf.parent?.path == newParentPath

                if (isSameDir) {
                    // Same directory — just rename
                    vf.rename(this, newName)
                } else {
                    // Different directory — move: find/create parent, then move
                    File(newParentPath).mkdirs()
                    val newParentVf = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(newParentPath)
                        ?: throw IllegalStateException("Cannot resolve destination directory: $newParentPath")

                    if (destExists && overwrite) {
                        newParentVf.findChild(newName)?.delete(this)
                    }
                    vf.move(this, newParentVf)
                    if (vf.name != newName) vf.rename(this, newName)
                }
            }

            JsonObject().apply {
                addProperty("success", true)
                addProperty("oldPath", oldPath)
                addProperty("newPath", newPath)
                addProperty("renamed", true)
            }
        } catch (e: Exception) {
            JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to rename file: ${e.message}")
            }
        }
    }
}
