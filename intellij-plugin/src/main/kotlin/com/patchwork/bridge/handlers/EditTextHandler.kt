package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException
import com.patchwork.bridge.WorkspaceGuard

class EditTextHandler : BridgeHandler {

    private sealed class Edit {
        data class Insert(val line: Int, val col: Int, val text: String) : Edit()
        data class Delete(val line: Int, val col: Int, val endLine: Int, val endCol: Int) : Edit()
        data class Replace(val line: Int, val col: Int, val endLine: Int, val endCol: Int, val text: String) : Edit()
    }

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val filePath = params?.get("filePath")?.takeIf { it.isJsonPrimitive }?.asString
            ?: throw InvalidParamsException("missing required param: filePath")

        val editsEl = params.get("edits")
        if (editsEl == null || !editsEl.isJsonArray)
            throw InvalidParamsException("edits must be an array")
        val editsArr = editsEl.asJsonArray
        if (editsArr.size() > 1000)
            throw InvalidParamsException("Maximum 1000 edits per call")

        val save = params.get("save")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

        WorkspaceGuard.assertInWorkspace(filePath, project)

        val vf = LocalFileSystem.getInstance().findFileByPath(filePath)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "File not found: $filePath")
            }

        // Parse all edits first (pure validation, no IJ APIs)
        val parsed = parseEdits(editsArr)

        // Pre-validate all offsets under a read lock before opening write action
        var document: Document? = null
        var validationError: String? = null
        ApplicationManager.getApplication().runReadAction {
            val doc = FileDocumentManager.getInstance().getDocument(vf)
            if (doc == null) {
                validationError = "Cannot load document: $filePath"
                return@runReadAction
            }
            document = doc
            val lineCount = doc.lineCount
            for ((i, edit) in parsed.withIndex()) {
                val err = validateEditOffsets(edit, doc, lineCount, i)
                if (err != null) {
                    validationError = err
                    return@runReadAction
                }
            }
        }

        validationError?.let {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", it)
            }
        }

        val doc = document!!

        // Apply all edits atomically in a single write action on the EDT
        var applyError: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            ApplicationManager.getApplication().runWriteAction {
                try {
                    applyEdits(parsed, doc)
                } catch (e: Exception) {
                    applyError = "Failed to apply edits: ${e.message}"
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
            addProperty("editCount", editsArr.size())
            addProperty("saved", saved)
        }
    }

    private fun parseEdits(arr: JsonArray): List<Edit> {
        return arr.mapIndexed { i, el ->
            if (!el.isJsonObject) throw InvalidParamsException("edit[$i] must be an object")
            val e = el.asJsonObject
            val type = e.get("type")?.takeIf { it.isJsonPrimitive }?.asString
                ?: throw InvalidParamsException("edit[$i].type is required")
            // 1-based → 0-based
            val line = (e.get("line")?.takeIf { it.isJsonPrimitive }?.asInt
                ?: throw InvalidParamsException("edit[$i].line is required")) - 1
            val col = (e.get("column")?.takeIf { it.isJsonPrimitive }?.asInt
                ?: throw InvalidParamsException("edit[$i].column is required")) - 1

            when (type) {
                "insert" -> {
                    val text = e.get("text")?.takeIf { it.isJsonPrimitive }?.asString
                        ?: throw InvalidParamsException("edit[$i].text is required for insert")
                    Edit.Insert(line, col, text)
                }
                "delete" -> {
                    val endLine = (e.get("endLine")?.takeIf { it.isJsonPrimitive }?.asInt
                        ?: throw InvalidParamsException("edit[$i].endLine is required for delete")) - 1
                    val endCol = (e.get("endColumn")?.takeIf { it.isJsonPrimitive }?.asInt
                        ?: throw InvalidParamsException("edit[$i].endColumn is required for delete")) - 1
                    Edit.Delete(line, col, endLine, endCol)
                }
                "replace" -> {
                    val text = e.get("text")?.takeIf { it.isJsonPrimitive }?.asString
                        ?: throw InvalidParamsException("edit[$i].text is required for replace")
                    val endLine = (e.get("endLine")?.takeIf { it.isJsonPrimitive }?.asInt
                        ?: throw InvalidParamsException("edit[$i].endLine is required for replace")) - 1
                    val endCol = (e.get("endColumn")?.takeIf { it.isJsonPrimitive }?.asInt
                        ?: throw InvalidParamsException("edit[$i].endColumn is required for replace")) - 1
                    Edit.Replace(line, col, endLine, endCol, text)
                }
                else -> throw InvalidParamsException("Unknown edit type: $type")
            }
        }
    }

    private fun validateEditOffsets(edit: Edit, doc: Document, lineCount: Int, idx: Int): String? {
        fun checkLine(l: Int, label: String): String? =
            if (l < 0 || l >= lineCount) "edit[$idx] $label (${ l + 1}) out of range (file has $lineCount lines)" else null

        fun checkCol(l: Int, c: Int, label: String): String? {
            val lineEnd = doc.getLineEndOffset(l) - doc.getLineStartOffset(l)
            return if (c < 0 || c > lineEnd) "edit[$idx] $label column (${c + 1}) out of range" else null
        }

        return when (edit) {
            is Edit.Insert -> checkLine(edit.line, "line") ?: checkCol(edit.line, edit.col, "insert")
            is Edit.Delete -> checkLine(edit.line, "startLine") ?: checkLine(edit.endLine, "endLine")
                ?: checkCol(edit.line, edit.col, "delete start") ?: checkCol(edit.endLine, edit.endCol, "delete end")
            is Edit.Replace -> checkLine(edit.line, "startLine") ?: checkLine(edit.endLine, "endLine")
                ?: checkCol(edit.line, edit.col, "replace start") ?: checkCol(edit.endLine, edit.endCol, "replace end")
        }
    }

    private fun applyEdits(edits: List<Edit>, doc: Document) {
        for (edit in edits) {
            when (edit) {
                is Edit.Insert -> {
                    val offset = doc.getLineStartOffset(edit.line) + edit.col
                    doc.insertString(offset, edit.text)
                }
                is Edit.Delete -> {
                    val start = doc.getLineStartOffset(edit.line) + edit.col
                    val end = doc.getLineStartOffset(edit.endLine) + edit.endCol
                    doc.deleteString(start, end)
                }
                is Edit.Replace -> {
                    val start = doc.getLineStartOffset(edit.line) + edit.col
                    val end = doc.getLineStartOffset(edit.endLine) + edit.endCol
                    doc.replaceString(start, end, edit.text)
                }
            }
        }
    }
}
