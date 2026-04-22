package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.patchwork.bridge.BridgeHandler

/**
 * Handles extension/getWorkspaceFolders.
 *
 * Wire contract (WIRE_INVARIANTS.md §1, §2):
 *  - Returns plain array of WorkspaceFolder objects (not wrapped)
 *  - Each item: { name, path, uri, index }
 *  - path is absolute filesystem path
 *  - uri is file:// URI form of path
 *  - name is the last path segment
 *  - index is 0-based position in the array
 */
class WorkspaceFoldersHandler : BridgeHandler {

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val result = JsonArray()

        ApplicationManager.getApplication().runReadAction {
            val roots = ProjectRootManager.getInstance(project).contentRoots
            roots.forEachIndexed { index, root ->
                val path = root.path
                val name = root.name
                val uri = root.url  // VirtualFile.url is already file:// form
                result.add(JsonObject().apply {
                    addProperty("name", name)
                    addProperty("path", path)
                    addProperty("uri", uri)
                    addProperty("index", index)
                })
            }
        }

        return result
    }
}
