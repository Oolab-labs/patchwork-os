package com.patchwork.bridge

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

/**
 * Tests WorkspaceGuard containment logic without a real IntelliJ Project.
 * We test the pure path logic directly.
 */
class WorkspaceGuardTest {

    @Test
    fun `path inside root is accepted`(@TempDir root: Path) {
        val child = root.resolve("src/main/Foo.kt").also {
            it.parent.toFile().mkdirs()
            it.toFile().createNewFile()
        }
        // isInsideRoots returns true when path is under one of the roots
        assertTrue(WorkspaceGuard.isInsideRoots(child.toString(), listOf(root.toFile())))
    }

    @Test
    fun `path outside root is rejected`(@TempDir root: Path, @TempDir other: Path) {
        val outside = other.resolve("evil.kt").also { it.toFile().createNewFile() }
        assertFalse(WorkspaceGuard.isInsideRoots(outside.toString(), listOf(root.toFile())))
    }

    @Test
    fun `path traversal via dotdot is rejected`(@TempDir root: Path) {
        // Canonical resolution means ../../ tricks don't escape
        val traversal = root.resolve("sub/../../outside").toString()
        // The canonical path of traversal is outside root, so it should be rejected
        // (unless 'outside' happens to be inside root, which it won't be for a real temp dir)
        // Just verify no exception is thrown and the result is false
        val result = WorkspaceGuard.isInsideRoots(traversal, listOf(root.toFile()))
        // The canonical path resolves to root.parent/outside which is NOT under root
        assertFalse(result)
    }

    @Test
    fun `exact root path itself is accepted`(@TempDir root: Path) {
        assertTrue(WorkspaceGuard.isInsideRoots(root.toString(), listOf(root.toFile())))
    }

    @Test
    fun `path matching root prefix but not child is rejected`(@TempDir root: Path) {
        // /tmp/foo should not match /tmp/foobar as a child of /tmp/foo
        val sibling = root.parent.resolve(root.fileName.toString() + "sibling")
        sibling.toFile().mkdirs()
        val file = sibling.resolve("file.kt").also { it.toFile().createNewFile() }
        assertFalse(WorkspaceGuard.isInsideRoots(file.toString(), listOf(root.toFile())))
    }

    @Test
    fun `symlink resolved before comparison`(@TempDir root: Path, @TempDir other: Path) {
        val realFile = other.resolve("secret.kt").also { it.toFile().createNewFile() }
        val symlink = root.resolve("link.kt")
        try {
            java.nio.file.Files.createSymbolicLink(symlink, realFile)
        } catch (_: Exception) {
            return // skip on platforms that don't support symlinks
        }
        // The symlink is inside root, but its target is outside — should be rejected
        assertFalse(WorkspaceGuard.isInsideRoots(symlink.toString(), listOf(root.toFile())))
    }
}
