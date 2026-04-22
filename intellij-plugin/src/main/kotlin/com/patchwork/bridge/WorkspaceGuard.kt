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
        val roots = ProjectRootManager.getInstance(project).contentRoots.map { java.io.File(it.path) }
        if (!isInsideRoots(filePath, roots)) throw WorkspaceViolationException(filePath)
    }

    /**
     * Pure containment check — testable without a real IntelliJ Project.
     * Resolves symlinks via toRealPath() before comparing canonical path prefixes.
     * A trailing separator is appended to the root string to prevent prefix collisions
     * (e.g. /tmp/foo should not match /tmp/foobar).
     */
    fun isInsideRoots(filePath: String, roots: List<java.io.File>): Boolean {
        val canonical = try {
            Paths.get(filePath).toRealPath().toString()
        } catch (_: Exception) {
            filePath
        }
        return roots.any { root ->
            val rootReal = try { Paths.get(root.path).toRealPath().toString() } catch (_: Exception) { root.path }
            val rootWithSep = if (rootReal.endsWith(java.io.File.separator)) rootReal else rootReal + java.io.File.separator
            canonical == rootReal || canonical.startsWith(rootWithSep)
        }
    }
}
