package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
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
                val highlights = collectDaemonHighlights(project, document)
                for (info in highlights) {
                    val obj = highlightToJson(info, document) ?: continue
                    array.add(obj)
                }
            }
        } catch (_: Exception) {
            // File not indexed or daemon not available — return empty
        }
        return array
    }
}
