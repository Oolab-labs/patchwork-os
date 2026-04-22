package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.patchwork.bridge.BridgeHandler

/**
 * Handles extension/getSelection.
 *
 * Wire contract (WIRE_INVARIANTS.md §1, §2):
 *  - No active editor → result { "error": "No active editor" }  (NOT a JSON-RPC error)
 *  - Line/column are 1-based
 *  - file is absolute filesystem path (not file:// URI)
 */
class SelectionHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        var result: JsonElement = JsonObject().apply {
            addProperty("error", "No active editor")
        }

        ApplicationManager.getApplication().runReadAction {
            val fileEditor = FileEditorManager.getInstance(project).selectedEditor
            val textEditor = fileEditor as? TextEditor
            val editor: Editor? = textEditor?.editor

            if (editor == null) {
                // result stays "No active editor"
                return@runReadAction
            }

            val document = editor.document
            val selectionModel = editor.selectionModel
            val virtualFile = fileEditor.file

            val startOffset = selectionModel.selectionStart
            val endOffset = selectionModel.selectionEnd
            val selectedText = selectionModel.selectedText ?: ""

            val startLine = document.getLineNumber(startOffset)          // 0-based
            val startLineStart = document.getLineStartOffset(startLine)
            val startColumn = startOffset - startLineStart               // 0-based

            val endLine = document.getLineNumber(endOffset)              // 0-based
            val endLineStart = document.getLineStartOffset(endLine)
            val endColumn = endOffset - endLineStart                     // 0-based

            val filePath = virtualFile?.path ?: ""

            result = JsonObject().apply {
                addProperty("file", filePath)
                addProperty("startLine", startLine + 1)     // 1-based
                addProperty("startColumn", startColumn + 1) // 1-based
                addProperty("endLine", endLine + 1)         // 1-based
                addProperty("endColumn", endColumn + 1)     // 1-based
                addProperty("selectedText", selectedText)
            }
        }

        return result
    }
}
