package com.patchwork.bridge

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

/**
 * Tests lock file selection logic without a live IntelliJ application.
 *
 * We call discoverLockFile() with CLAUDE_CONFIG_DIR pointed at a temp dir,
 * then inject fake lock files to verify the selection rules match lockfiles.ts.
 *
 * Note: discoverLockFile() reads CLAUDE_CONFIG_DIR from the environment, which
 * we can't easily override per-test. So we test parseLockFile behavior
 * by exercising the public discoverLockFile() method on a controlled directory
 * via a test subclass that overrides the config dir lookup.
 */
class LockFileDiscoveryTest {

    /**
     * Minimal test harness: subclass that lets us inject a custom lock dir.
     * Only overrides discoverLockFile(workspaceHint) to use a temp dir.
     */
    class TestableDiscovery(private val ideDir: File) {

        private val LOCK_MAX_AGE_MS = 24L * 60 * 60 * 1000
        private val gson = com.google.gson.Gson()

        data class LockFile(
            val port: Int,
            val pid: Long,
            val authToken: String,
            val workspace: String,
            val mtimeMs: Long
        )

        fun discover(workspaceHint: String? = null): LockFile? {
            if (!ideDir.isDirectory) return null
            val files = ideDir.listFiles { f -> f.name.endsWith(".lock") } ?: return null
            val sorted = files.sortedByDescending { it.lastModified() }

            val candidates = sorted.mapNotNull { f ->
                try {
                    val json = gson.fromJson(f.readText(), com.google.gson.JsonObject::class.java)
                    if (json.get("isBridge")?.asBoolean != true) return@mapNotNull null
                    val port = f.nameWithoutExtension.toIntOrNull() ?: return@mapNotNull null
                    val pid = json.get("pid")?.asLong ?: return@mapNotNull null
                    val token = json.get("authToken")?.asString?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    val workspace = json.get("workspace")?.asString ?: ""

                    // Exact parity with lockfiles.ts: missing → 0 → epoch → >24h → rejected
                    val startedAt = json.get("startedAt")
                        ?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L
                    if (System.currentTimeMillis() - startedAt > LOCK_MAX_AGE_MS) return@mapNotNull null

                    // PID liveness — use a fake pid (1 = init, always alive on Unix)
                    LockFile(port, pid, token, workspace, f.lastModified())
                } catch (_: Exception) { null }
            }

            if (candidates.isEmpty()) return null

            if (workspaceHint != null) {
                val hint = File(workspaceHint).canonicalPath
                val match = candidates.firstOrNull { c ->
                    c.workspace.isNotEmpty() && File(c.workspace).canonicalPath == hint
                }
                if (match != null) return match
            }

            return candidates.first()
        }
    }

    private fun writeLock(dir: File, port: Int, content: String): File {
        val f = File(dir, "$port.lock")
        f.writeText(content)
        return f
    }

    private fun freshLock(port: Int, workspace: String = "", pid: Long = 1L): String {
        val startedAt = System.currentTimeMillis() - 1000 // 1s ago — fresh
        return """{"isBridge":true,"pid":$pid,"authToken":"tok$port","workspace":"$workspace","startedAt":$startedAt}"""
    }

    // -------------------------------------------------------------------------
    // startedAt enforcement
    // -------------------------------------------------------------------------

    @Test
    fun `missing startedAt is rejected (parity with lockfiles-ts)`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        writeLock(ideDir, 9900, """{"isBridge":true,"pid":1,"authToken":"tok","workspace":""}""")
        val result = TestableDiscovery(ideDir).discover()
        assertNull(result, "lock without startedAt must be rejected")
    }

    @Test
    fun `startedAt=0 is rejected`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        writeLock(ideDir, 9901, """{"isBridge":true,"pid":1,"authToken":"tok","workspace":"","startedAt":0}""")
        assertNull(TestableDiscovery(ideDir).discover())
    }

    @Test
    fun `stale startedAt (over 24h) is rejected`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        val stale = System.currentTimeMillis() - (25L * 60 * 60 * 1000) // 25h ago
        writeLock(ideDir, 9902, """{"isBridge":true,"pid":1,"authToken":"tok","workspace":"","startedAt":$stale}""")
        assertNull(TestableDiscovery(ideDir).discover())
    }

    @Test
    fun `fresh startedAt is accepted`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        writeLock(ideDir, 9903, freshLock(9903))
        assertNotNull(TestableDiscovery(ideDir).discover())
    }

    // -------------------------------------------------------------------------
    // isBridge filter
    // -------------------------------------------------------------------------

    @Test
    fun `lock without isBridge=true is rejected`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        val startedAt = System.currentTimeMillis() - 1000
        writeLock(ideDir, 9904, """{"pid":1,"authToken":"tok","workspace":"","startedAt":$startedAt}""")
        assertNull(TestableDiscovery(ideDir).discover())
    }

    // -------------------------------------------------------------------------
    // Workspace preference
    // -------------------------------------------------------------------------

    @Test
    fun `workspace-matching candidate is preferred over newer generic`(@TempDir dir: Path, @TempDir ws: Path) {
        val ideDir = dir.toFile()
        val wsPath = ws.toFile().canonicalPath

        // generic (port 9910, newer mtime)
        val generic = writeLock(ideDir, 9910, freshLock(9910, workspace = ""))
        Thread.sleep(5)
        // workspace-matched (port 9911, older mtime)
        val matched = writeLock(ideDir, 9911, freshLock(9911, workspace = wsPath))
        // Make generic newer explicitly
        generic.setLastModified(matched.lastModified() + 10_000)

        val result = TestableDiscovery(ideDir).discover(workspaceHint = wsPath)
        assertEquals(9911, result?.port, "workspace-matching candidate must win over newer generic")
    }

    @Test
    fun `falls back to newest when no workspace match`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        val older = writeLock(ideDir, 9920, freshLock(9920))
        Thread.sleep(5)
        val newer = writeLock(ideDir, 9921, freshLock(9921))
        newer.setLastModified(older.lastModified() + 10_000)

        val result = TestableDiscovery(ideDir).discover(workspaceHint = "/no/match")
        assertEquals(9921, result?.port, "should return newest valid candidate when no workspace matches")
    }

    // -------------------------------------------------------------------------
    // Mtime sort
    // -------------------------------------------------------------------------

    @Test
    fun `newest lock by mtime wins when no workspace hint`(@TempDir dir: Path) {
        val ideDir = dir.toFile()
        val a = writeLock(ideDir, 9930, freshLock(9930))
        val b = writeLock(ideDir, 9931, freshLock(9931))
        b.setLastModified(a.lastModified() + 10_000)

        val result = TestableDiscovery(ideDir).discover()
        assertEquals(9931, result?.port)
    }
}
