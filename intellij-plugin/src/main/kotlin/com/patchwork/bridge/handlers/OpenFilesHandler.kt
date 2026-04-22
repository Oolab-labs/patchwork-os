package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.patchwork.bridge.BridgeHandler

/**
 * Handles extension/getOpenFiles.
 *
 * Wire contract (WIRE_INVARIANTS.md §1, §2):
 *  - Returns plain array of TabInfo objects (not wrapped)
 *  - Each item: { filePath, isActive, isDirty, languageId? }
 *  - filePath is absolute filesystem path
 *  - languageId is lowercase file language ID (may be omitted if unknown)
 */
class OpenFilesHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val result = JsonArray()

        ApplicationManager.getApplication().runReadAction {
            val fem = FileEditorManager.getInstance(project)
            val selectedFile = fem.selectedEditor?.file
            val fdm = FileDocumentManager.getInstance()

            for (file in fem.openFiles) {
                val item = JsonObject().apply {
                    addProperty("filePath", file.path)
                    addProperty("isActive", file == selectedFile)
                    val doc = fdm.getCachedDocument(file)
                    addProperty("isDirty", if (doc != null) fdm.isDocumentUnsaved(doc) else false)
                    val langId = file.fileType.name.lowercase().takeIf { it.isNotEmpty() }
                    if (langId != null) addProperty("languageId", langId)
                }
                result.add(item)
            }
        }

        return result
    }
}
