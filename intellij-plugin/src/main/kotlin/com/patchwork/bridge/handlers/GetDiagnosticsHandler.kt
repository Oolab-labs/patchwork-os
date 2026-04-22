package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.codeInsight.daemon.impl.HighlightInfoType
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.WorkspaceGuard

class GetDiagnosticsHandler : BridgeHandler {

    companion object {
        private const val MAX_ALL_DIAGNOSTICS = 500
    }

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val fileParam = params?.get("file")?.takeIf { it.isJsonPrimitive }?.asString

        return if (fileParam != null) {
            handleSingleFile(fileParam, project)
        } else {
            handleAllFiles(project)
        }
    }

    private fun handleSingleFile(filePath: String, project: Project?): JsonArray {
        if (project == null) return JsonArray()
        try { WorkspaceGuard.assertInWorkspace(filePath, project) } catch (_: Exception) { return JsonArray() }

        val vf = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return JsonArray()
        return collectDiagnosticsForFile(vf, project)
    }

    private fun handleAllFiles(project: Project?): JsonObject {
        val result = JsonObject()
        val filesArray = JsonArray()
        result.add("diagnostics", filesArray)

        if (project == null) {
            result.addProperty("truncated", false)
            return result
        }

        var totalCount = 0
        var truncated = false

        val allFiles = mutableListOf<VirtualFile>()
        ApplicationManager.getApplication().runReadAction {
            val fileIndex = com.intellij.openapi.roots.ProjectRootManager.getInstance(project).fileIndex
            fileIndex.iterateContent { vf ->
                if (!vf.isDirectory) allFiles.add(vf)
                true
            }
        }

        for (vf in allFiles) {
            if (totalCount >= MAX_ALL_DIAGNOSTICS) {
                truncated = true
                break
            }
            val diags = collectDiagnosticsForFile(vf, project)
            if (diags.size() > 0) {
                val entry = JsonObject()
                entry.addProperty("file", vf.path)
                val capped = JsonArray()
                var i = 0
                while (i < diags.size() && totalCount < MAX_ALL_DIAGNOSTICS) {
                    capped.add(diags.get(i))
                    totalCount++
                    i++
                }
                entry.add("diagnostics", capped)
                filesArray.add(entry)
                if (totalCount >= MAX_ALL_DIAGNOSTICS) truncated = true
            }
        }

        result.addProperty("truncated", truncated)
        return result
    }

    private fun collectDiagnosticsForFile(vf: VirtualFile, project: Project): JsonArray {
        val array = JsonArray()
        try {
            ApplicationManager.getApplication().runReadAction {
                val document = FileDocumentManager.getInstance().getDocument(vf) ?: return@runReadAction
                val highlights = com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
                    .getHighlights(document, null, project)
                if (highlights != null) {
                    for (info in highlights) {
                        val obj = highlightToJson(info, document) ?: continue
                        array.add(obj)
                    }
                }
            }
        } catch (_: Exception) {
            // File not indexed or daemon not available — return empty
        }
        return array
    }

    private fun highlightToJson(info: HighlightInfo, document: Document): JsonObject? {
        val severity = when {
            info.severity == HighlightSeverity.ERROR -> "error"
            info.severity == HighlightSeverity.WARNING -> "warning"
            info.severity == HighlightSeverity.WEAK_WARNING -> "warning"
            info.severity == HighlightSeverity.INFORMATION -> "information"
            info.severity == HighlightSeverity.TEXT_ATTRIBUTES -> "hint"
            else -> return null // skip non-diagnostic highlights (e.g. syntax coloring)
        }

        val startOffset = info.startOffset
        val endOffset = info.endOffset
        if (startOffset < 0 || startOffset > document.textLength) return null

        val startLine = document.getLineNumber(startOffset)
        val startLineStart = document.getLineStartOffset(startLine)
        val endLine = if (endOffset <= document.textLength) document.getLineNumber(endOffset) else startLine
        val endLineStart = document.getLineStartOffset(endLine)

        return JsonObject().apply {
            addProperty("message", info.description ?: "")
            addProperty("severity", severity)
            addProperty("line", startLine + 1)
            addProperty("column", startOffset - startLineStart + 1)
            addProperty("endLine", endLine + 1)
            addProperty("endColumn", endOffset - endLineStart + 1)
            addProperty("source", info.type.toString())
            addProperty("code", info.problemGroup?.toString() ?: "")
        }
    }
}
