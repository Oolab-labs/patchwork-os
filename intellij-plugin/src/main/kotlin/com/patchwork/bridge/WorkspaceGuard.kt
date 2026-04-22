package com.patchwork.bridge

import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import java.nio.file.Files
import java.nio.file.Paths

class WorkspaceViolationException(path: String) :
    Exception("path outside workspace: $path")

object WorkspaceGuard {

    /**
     * Asserts that filePath is contained within one of the project's content roots.
     * Resolves symlinks before comparison.
     * Throws WorkspaceViolationException if outside.
     */
    fun assertInWorkspace(filePath: String, project: Project) {
        val canonical = try {
            Files.readSymbolicLink(Paths.get(filePath)).toString()
        } catch (_: Exception) {
            try {
                Paths.get(filePath).toRealPath().toString()
            } catch (_: Exception) {
                filePath
            }
        }

        val roots = ProjectRootManager.getInstance(project).contentRoots
        val inWorkspace = roots.any { root ->
            val rootReal = try { Paths.get(root.path).toRealPath().toString() } catch (_: Exception) { root.path }
            canonical.startsWith(rootReal)
        }

        if (!inWorkspace) {
            throw WorkspaceViolationException(filePath)
        }
    }
}
