package com.patchwork.bridge

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.io.File
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.random.Random

@Service(Service.Level.APP)
class BridgeService {

    companion object {
        private val LOG = Logger.getInstance(BridgeService::class.java)

        // Wire-protocol version. Matches vscode-extension/src/constants.ts and
        // the bridge's BRIDGE_PROTOCOL_VERSION. Bump only on breaking-handshake
        // changes — see ADR-0001.
        const val EXTENSION_PROTOCOL_VERSION = "1.1.0"

        /**
         * Plugin package version as seen by the JetBrains Marketplace.
         *
         * Read at runtime from the installed plugin descriptor so it stays in
         * lock-step with `intellij-plugin/gradle.properties`. Hardcoding here
         * (the previous behavior) drifted: 1.0.1 shipped to the Marketplace
         * while this constant still said "1.0.0", and the bridge's
         * `extension/hello` digests + logs reflected the stale value.
         *
         * Falls back to "0.0.0-dev" if the plugin descriptor isn't available
         * (e.g. running unit tests outside the IntelliJ runtime).
         */
        @JvmStatic
        val PLUGIN_VERSION: String by lazy {
            val pluginId = PluginId.getId("com.patchwork.bridge")
            PluginManagerCore.getPlugin(pluginId)?.version ?: "0.0.0-dev"
        }

        // Auth header name — confirmed from vscode-extension/src/connection.ts line 320
        private const val AUTH_HEADER = "x-claude-ide-extension"

        // Heartbeat: bridge pings every 30s; we check every 45s; declare dead after 120s
        // Matches vscode-extension/src/connection.ts heartbeatTimer interval (45s) and
        // lastBridgePong threshold (120s).
        private const val HEARTBEAT_INTERVAL_MS = 45_000L
        private const val LIVENESS_TIMEOUT_MS = 120_000L

        // Lock file: drop if startedAt is older than 24h (matches lockfiles.ts line 68)
        private const val LOCK_MAX_AGE_MS = 24L * 60 * 60 * 1000

        fun getInstance(): BridgeService =
            ApplicationManager.getApplication().getService(BridgeService::class.java)
    }

    private val gson = Gson()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "patchwork-bridge").also { it.isDaemon = true }
    }

    val generation = AtomicInteger(0)

    @field:Volatile
    var activeProject: Project? = null
        private set

    @field:Volatile
    private var ws: WebSocketClient? = null

    @field:Volatile
    private var reconnectDelay = 1000L

    // Tracks time of last bridge ping frame received (not JSON message)
    @field:Volatile
    private var lastBridgePingMs = System.currentTimeMillis()

    private var heartbeatFuture: ScheduledFuture<*>? = null
    private var reconnectFuture: ScheduledFuture<*>? = null

    private val handlerRegistry = HandlerRegistry()

    init {
        // Register real handlers
        handlerRegistry.register("extension/getSelection", com.patchwork.bridge.handlers.SelectionHandler())
        handlerRegistry.register("extension/getOpenFiles", com.patchwork.bridge.handlers.OpenFilesHandler())
        handlerRegistry.register("extension/getWorkspaceFolders", com.patchwork.bridge.handlers.WorkspaceFoldersHandler())
        handlerRegistry.register("extension/isDirty", com.patchwork.bridge.handlers.IsDirtyHandler())
        handlerRegistry.register("extension/getFileContent", com.patchwork.bridge.handlers.GetFileContentHandler())
        handlerRegistry.register("extension/openFile", com.patchwork.bridge.handlers.OpenFileHandler())
        handlerRegistry.register("extension/readClipboard", com.patchwork.bridge.handlers.ReadClipboardHandler())
        handlerRegistry.register("extension/writeClipboard", com.patchwork.bridge.handlers.WriteClipboardHandler())
        handlerRegistry.register("extension/getDiagnostics", com.patchwork.bridge.handlers.GetDiagnosticsHandler())
        handlerRegistry.register("extension/saveFile", com.patchwork.bridge.handlers.SaveFileHandler())
        handlerRegistry.register("extension/closeTab", com.patchwork.bridge.handlers.CloseTabHandler())
        handlerRegistry.register("extension/createFile", com.patchwork.bridge.handlers.CreateFileHandler())
        handlerRegistry.register("extension/deleteFile", com.patchwork.bridge.handlers.DeleteFileHandler())
        handlerRegistry.register("extension/renameFile", com.patchwork.bridge.handlers.RenameFileHandler())
        handlerRegistry.register("extension/editText", com.patchwork.bridge.handlers.EditTextHandler())
        handlerRegistry.register("extension/replaceBlock", com.patchwork.bridge.handlers.ReplaceBlockHandler())
        handlerRegistry.register("extension/listTerminals", com.patchwork.bridge.handlers.ListTerminalsHandler())
        handlerRegistry.register("extension/createTerminal", com.patchwork.bridge.handlers.CreateTerminalHandler())
        handlerRegistry.register("extension/disposeTerminal", com.patchwork.bridge.handlers.DisposeTerminalHandler())
        handlerRegistry.register("extension/sendTerminalCommand", com.patchwork.bridge.handlers.SendTerminalCommandHandler())
        handlerRegistry.register("extension/getTerminalOutput", com.patchwork.bridge.handlers.GetTerminalOutputHandler())
        handlerRegistry.register("extension/waitForTerminalOutput", com.patchwork.bridge.handlers.WaitForTerminalOutputHandler())
        handlerRegistry.register("extension/executeInTerminal", com.patchwork.bridge.handlers.ExecuteInTerminalHandler())

        // LSP handlers
        handlerRegistry.register("extension/goToDefinition", com.patchwork.bridge.handlers.GoToDefinitionHandler())
        handlerRegistry.register("extension/findReferences", com.patchwork.bridge.handlers.FindReferencesHandler())
        handlerRegistry.register("extension/findImplementations", com.patchwork.bridge.handlers.FindImplementationsHandler())
        handlerRegistry.register("extension/goToTypeDefinition", com.patchwork.bridge.handlers.GoToTypeDefinitionHandler())
        handlerRegistry.register("extension/goToDeclaration", com.patchwork.bridge.handlers.GoToDeclarationHandler())
        handlerRegistry.register("extension/getHover", com.patchwork.bridge.handlers.GetHoverHandler())
        handlerRegistry.register("extension/getCodeActions", com.patchwork.bridge.handlers.GetCodeActionsHandler())
        handlerRegistry.register("extension/applyCodeAction", com.patchwork.bridge.handlers.ApplyCodeActionHandler())
        handlerRegistry.register("extension/previewCodeAction", com.patchwork.bridge.handlers.PreviewCodeActionHandler())
        handlerRegistry.register("extension/renameSymbol", com.patchwork.bridge.handlers.RenameSymbolHandler())
        handlerRegistry.register("extension/searchSymbols", com.patchwork.bridge.handlers.SearchSymbolsHandler())
        handlerRegistry.register("extension/getDocumentSymbols", com.patchwork.bridge.handlers.GetDocumentSymbolsHandler())
        handlerRegistry.register("extension/getCallHierarchy", com.patchwork.bridge.handlers.GetCallHierarchyHandler())
        handlerRegistry.register("extension/prepareRename", com.patchwork.bridge.handlers.PrepareRenameHandler())
        handlerRegistry.register("extension/formatRange", com.patchwork.bridge.handlers.FormatRangeHandler())
        handlerRegistry.register("extension/signatureHelp", com.patchwork.bridge.handlers.SignatureHelpHandler())
        handlerRegistry.register("extension/foldingRanges", com.patchwork.bridge.handlers.FoldingRangesHandler())
        handlerRegistry.register("extension/selectionRanges", com.patchwork.bridge.handlers.SelectionRangesHandler())

        // Code style handlers
        handlerRegistry.register("extension/formatDocument", com.patchwork.bridge.handlers.FormatDocumentHandler())
        handlerRegistry.register("extension/organizeImports", com.patchwork.bridge.handlers.OrganizeImportsHandler())
        handlerRegistry.register("extension/fixAllLintErrors", com.patchwork.bridge.handlers.FixAllLintErrorsHandler())

        // Debug handlers
        handlerRegistry.register("extension/getDebugState", com.patchwork.bridge.handlers.GetDebugStateHandler())
        handlerRegistry.register("extension/evaluateInDebugger", com.patchwork.bridge.handlers.EvaluateInDebuggerHandler())
        handlerRegistry.register("extension/setDebugBreakpoints", com.patchwork.bridge.handlers.SetDebugBreakpointsHandler())
        handlerRegistry.register("extension/startDebugging", com.patchwork.bridge.handlers.StartDebuggingHandler())
        handlerRegistry.register("extension/stopDebugging", com.patchwork.bridge.handlers.StopDebuggingHandler())

        // Tier 1 stubs: known methods, not yet implemented
        val stubs = listOf(
            "extension/getAIComments",
            "extension/watchFiles",
            "extension/unwatchFiles",
            "extension/captureScreenshot",
            "extension/listTasks",
            "extension/runTask",
            "extension/getWorkspaceSettings",
            "extension/setWorkspaceSetting",
            "extension/executeVSCodeCommand",
            "extension/listVSCodeCommands",
            "extension/getInlayHints",
            "extension/getTypeHierarchy",
            "extension/getSemanticTokens",
            "extension/getCodeLens",
            "extension/getDocumentLinks",
            "extension/setDecorations",
            "extension/clearDecorations"
        )
        val stub = StubHandler()
        for (method in stubs) handlerRegistry.register(method, stub)

        // Deferred start — IDE services must be ready before we read lock files
        scheduler.schedule({ connect() }, 2, TimeUnit.SECONDS)
    }

    fun setActiveProject(project: Project?) {
        activeProject = project
    }

    // ---------------------------------------------------------------------------
    // Lock file discovery
    // Matches lockfiles.ts: sort by mtime desc, check isBridge + PID liveness +
    // startedAt freshness (24h), prefer workspace match.
    // ---------------------------------------------------------------------------

    internal data class LockFile(
        val port: Int,
        val pid: Long,
        val authToken: String,
        val workspace: String,
        val mtimeMs: Long
    )

    internal fun discoverLockFile(workspaceHint: String? = activeProject?.basePath): LockFile? {
        val configDir = System.getenv("CLAUDE_CONFIG_DIR")?.let { File(it) }
            ?: File(System.getProperty("user.home"), ".claude")
        val ideDir = File(configDir, "ide")
        if (!ideDir.isDirectory) return null

        val files = ideDir.listFiles { f -> f.name.endsWith(".lock") } ?: return null

        // Sort newest first (mtime descending) — matches lockfiles.ts line 35
        val sorted = files.sortedByDescending { it.lastModified() }

        val candidates = sorted.mapNotNull { f ->
            parseLockFile(f) ?: return@mapNotNull null
        }

        if (candidates.isEmpty()) return null

        // Prefer candidate whose workspace matches the active project
        if (workspaceHint != null) {
            val hint = File(workspaceHint).canonicalPath
            val match = candidates.firstOrNull { c ->
                c.workspace.isNotEmpty() && File(c.workspace).canonicalPath == hint
            }
            if (match != null) return match
        }

        // Fall back to newest valid candidate
        return candidates.first()
    }

    private fun parseLockFile(f: File): LockFile? {
        return try {
            val json = gson.fromJson(f.readText(), JsonObject::class.java)
            if (json.get("isBridge")?.asBoolean != true) return null
            val port = f.nameWithoutExtension.toIntOrNull() ?: return null
            val pid = json.get("pid")?.asLong ?: return null
            val token = json.get("authToken")?.asString?.takeIf { it.isNotEmpty() } ?: return null
            val workspace = json.get("workspace")?.asString ?: ""

            // startedAt freshness: missing/non-numeric → 0 → rejected (matches lockfiles.ts:
            // "typeof content.startedAt === 'number' ? content.startedAt : 0" then ageMs > 24h check)
            val startedAt = json.get("startedAt")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L
            if (System.currentTimeMillis() - startedAt > LOCK_MAX_AGE_MS) return null

            if (!isPidAlive(pid)) return null
            LockFile(port, pid, token, workspace, f.lastModified())
        } catch (e: Exception) {
            LOG.warn("Failed to parse lock file ${f.name}: ${e.message}")
            null
        }
    }

    private fun isPidAlive(pid: Long): Boolean {
        return try {
            ProcessHandle.of(pid).isPresent
        } catch (_: SecurityException) {
            true // EPERM → treat as alive
        }
    }

    // ---------------------------------------------------------------------------
    // WebSocket connection
    // ---------------------------------------------------------------------------

    fun connect() {
        val gen = generation.incrementAndGet()
        val lock = discoverLockFile()
        if (lock == null) {
            LOG.info("No bridge lock file found, will retry")
            scheduleReconnect(gen)
            return
        }

        val uri = URI("ws://127.0.0.1:${lock.port}")
        // Fix #1: correct auth header name (was x-claude-code-ide-authorization)
        val headers = mapOf(AUTH_HEADER to lock.authToken)

        val client = object : WebSocketClient(uri, org.java_websocket.drafts.Draft_6455(), headers, 30_000) {
            override fun onOpen(handshake: ServerHandshake) {
                if (gen != this@BridgeService.generation.get()) return
                LOG.info("Bridge WebSocket connected (port=${lock.port})")
                // Seed liveness so watchdog doesn't immediately fire
                lastBridgePingMs = System.currentTimeMillis()
                reconnectDelay = 1000L
                sendHello()
                startHeartbeat(gen)
            }

            override fun onMessage(message: String) {
                if (gen != this@BridgeService.generation.get()) return
                // Fix #4: snapshot activeProject at receipt time, before scheduler delay
                val projectAtReceipt = activeProject
                scheduler.submit {
                    MessageDispatcher(handlerRegistry, gson).dispatch(message, projectAtReceipt) { response ->
                        if (response != null) sendRaw(response)
                    }
                }
            }

            // Fix #2: liveness is driven by bridge ping frames, not JSON messages.
            // Java-WebSocket calls onWebsocketPing; we override it to refresh the timestamp
            // and let the default implementation send the pong frame.
            override fun onWebsocketPing(conn: org.java_websocket.WebSocket, f: org.java_websocket.framing.Framedata) {
                if (gen != this@BridgeService.generation.get()) return
                lastBridgePingMs = System.currentTimeMillis()
                super.onWebsocketPing(conn, f) // sends the pong
            }

            override fun onClose(code: Int, reason: String, remote: Boolean) {
                if (gen != this@BridgeService.generation.get()) return
                LOG.info("Bridge WebSocket closed: code=$code reason=$reason remote=$remote")
                cancelHeartbeat()
                scheduleReconnect(gen)
            }

            override fun onError(ex: Exception) {
                if (gen != this@BridgeService.generation.get()) return
                LOG.warn("Bridge WebSocket error: ${ex.message}")
            }
        }

        ws = client
        try {
            client.connect()
        } catch (e: Exception) {
            LOG.warn("Bridge connect failed: ${e.message}")
            scheduleReconnect(gen)
        }
    }

    private fun sendHello() {
        val ideVersion = try {
            com.intellij.openapi.application.ApplicationInfo.getInstance().build.toString()
        } catch (_: Exception) { "unknown" }
        sendNotification("extension/hello", JsonObject().apply {
            addProperty("extensionVersion", EXTENSION_PROTOCOL_VERSION)
            addProperty("packageVersion", PLUGIN_VERSION)
            addProperty("ideVersion", ideVersion)
        })
    }

    fun sendNotification(method: String, params: JsonObject) {
        sendRaw(gson.toJson(JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("method", method)
            add("params", params)
        }))
    }

    fun sendRaw(text: String) {
        val client = ws ?: return
        if (client.isOpen) {
            try { client.send(text) } catch (e: Exception) { LOG.warn("sendRaw failed: ${e.message}") }
        }
    }

    // ---------------------------------------------------------------------------
    // Heartbeat: 45s check interval, 120s no-ping → reconnect
    // Matches vscode-extension/src/connection.ts heartbeatTimer (45s) + lastBridgePong (120s)
    // ---------------------------------------------------------------------------

    private fun startHeartbeat(gen: Int) {
        cancelHeartbeat()
        heartbeatFuture = scheduler.scheduleAtFixedRate({
            if (gen != this.generation.get()) return@scheduleAtFixedRate
            val elapsed = System.currentTimeMillis() - lastBridgePingMs
            if (elapsed > LIVENESS_TIMEOUT_MS) {
                LOG.warn("No bridge ping for ${elapsed}ms, forcing reconnect")
                ws?.close()
            }
        }, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun cancelHeartbeat() {
        heartbeatFuture?.cancel(false)
        heartbeatFuture = null
    }

    // ---------------------------------------------------------------------------
    // Reconnect backoff: jitter=round(500 + rnd*delay), cap=30s
    // Matches vscode-extension/src/connection.ts
    // ---------------------------------------------------------------------------

    private fun scheduleReconnect(gen: Int) {
        val delay = (500 + Random.nextDouble() * reconnectDelay).roundToLong()
        reconnectDelay = min(reconnectDelay * 2, 30_000L)
        LOG.info("Reconnecting in ${delay}ms (gen=$gen)")
        reconnectFuture = scheduler.schedule({
            if (gen == this.generation.get()) connect()
        }, delay, TimeUnit.MILLISECONDS)
    }

    fun dispose() {
        cancelHeartbeat()
        reconnectFuture?.cancel(false)
        generation.incrementAndGet()
        ws?.close()
        scheduler.shutdownNow()
    }
}
