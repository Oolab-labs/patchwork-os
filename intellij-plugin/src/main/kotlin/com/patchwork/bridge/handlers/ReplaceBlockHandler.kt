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

class ReplaceBlockHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val filePath = params?.get("filePath")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: filePath")
        val oldContent = params.get("oldContent")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: oldContent")
        val newContent = params.get("newContent")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: newContent")
        val save = params.get("save")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true

        WorkspaceGuard.assertInWorkspace(filePath, project)

        val vf = LocalFileSystem.getInstance().findFileByPath(filePath)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "File not found: $filePath")
            }

        // Read full buffer text and find match under read lock
        var text: String? = null
        var firstIndex = -1
        var matchCount = 0
        var docRef: com.intellij.openapi.editor.Document? = null

        ApplicationManager.getApplication().runReadAction {
            val doc = FileDocumentManager.getInstance().getDocument(vf)
                ?: return@runReadAction
            docRef = doc
            text = doc.text
            val t = text!!

            firstIndex = t.indexOf(oldContent)
            if (firstIndex == -1) return@runReadAction

            // Count all occurrences
            matchCount = 1
            var idx = firstIndex
            while (true) {
                idx = t.indexOf(oldContent, idx + 1)
                if (idx == -1) break
                matchCount++
            }
        }

        if (text == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Cannot load document: $filePath")
            }
        }

        if (firstIndex == -1) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "oldContent not found in file — verify the exact text including whitespace and line endings")
            }
        }

        if (matchCount > 1) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "oldContent matches $matchCount locations — add more surrounding context to make it unique")
            }
        }

        val doc = docRef!!
        val endOffset = firstIndex + oldContent.length

        var applyError: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            ApplicationManager.getApplication().runWriteAction {
                try {
                    doc.replaceString(firstIndex, endOffset, newContent)
                } catch (e: Exception) {
                    applyError = "VS Code failed to apply the replacement"
                }
            }
        }

        applyError?.let {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", it)
            }
        }

        var saved = false
        if (save) {
            ApplicationManager.getApplication().invokeAndWait {
                FileDocumentManager.getInstance().saveDocument(doc)
                saved = true
            }
        }

        return JsonObject().apply {
            addProperty("success", true)
            addProperty("saved", saved)
            addProperty("source", "intellij-buffer")
        }
    }
}
