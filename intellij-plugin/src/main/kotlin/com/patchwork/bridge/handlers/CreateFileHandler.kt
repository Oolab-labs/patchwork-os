package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard
import java.io.File
import java.io.IOException

class CreateFileHandler : BridgeHandler {

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

        val content = params.get("content")?.takeIf { it.isJsonPrimitive }?.asString ?: ""
        val isDirectory = params.get("isDirectory")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        val overwrite = params.get("overwrite")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        val openAfterCreate = params.get("openAfterCreate")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true

        val file = File(filePath)

        if (isDirectory) {
            return try {
                ApplicationManager.getApplication().runWriteAction<JsonObject> {
                    file.mkdirs()
                    LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
                    JsonObject().apply {
                        addProperty("success", true)
                        addProperty("filePath", filePath)
                        addProperty("isDirectory", true)
                        addProperty("created", true)
                    }
                }
            } catch (e: Exception) {
                JsonObject().apply {
                    addProperty("success", false)
                    addProperty("error", "Failed to create directory: ${e.message}")
                }
            }
        }

        // File creation
        if (file.exists() && !overwrite) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "File already exists: $filePath")
            }
        }

        return try {
            var vf: com.intellij.openapi.vfs.VirtualFile? = null
            ApplicationManager.getApplication().runWriteAction<Unit> {
                file.parentFile?.mkdirs()
                file.writeText(content, Charsets.UTF_8)
                vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
            }

            val createdVf = vf ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to create file")
            }

            if (openAfterCreate) {
                ApplicationManager.getApplication().invokeAndWait {
                    FileEditorManager.getInstance(project)
                        .openEditor(OpenFileDescriptor(project, createdVf), true)
                }
            }

            JsonObject().apply {
                addProperty("success", true)
                addProperty("filePath", filePath)
                addProperty("isDirectory", false)
                addProperty("created", true)
            }
        } catch (e: IOException) {
            JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to create file: ${e.message}")
            }
        }
    }
}
