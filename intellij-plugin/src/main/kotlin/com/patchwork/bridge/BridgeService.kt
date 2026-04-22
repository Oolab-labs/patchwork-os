package com.patchwork.bridge

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
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
        const val PLUGIN_VERSION = "0.1.0"
        const val EXTENSION_PROTOCOL_VERSION = "1.1.0"

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

    @field:Volatile
    private var lastMessageTime = System.currentTimeMillis()

    private var heartbeatFuture: ScheduledFuture<*>? = null
    private var reconnectFuture: ScheduledFuture<*>? = null

    private val handlerRegistry = HandlerRegistry()

    init {
        // Register handlers
        handlerRegistry.register("extension/getSelection", com.patchwork.bridge.handlers.SelectionHandler())
        handlerRegistry.register("extension/getOpenFiles", com.patchwork.bridge.handlers.OpenFilesHandler())
        handlerRegistry.register("extension/getWorkspaceFolders", com.patchwork.bridge.handlers.WorkspaceFoldersHandler())

        // Register stubs for all known-unimplemented methods (Tier 1)
        val stubs = listOf(
            "extension/getFileContent",
            "extension/openFile",
            "extension/isDirty",
            "extension/getDiagnostics",
            "extension/readClipboard",
            "extension/writeClipboard",
            "extension/saveFile",
            "extension/closeTab",
            "extension/getAIComments",
            "extension/createFile",
            "extension/deleteFile",
            "extension/renameFile",
            "extension/editText",
            "extension/replaceBlock",
            "extension/listTerminals",
            "extension/getTerminalOutput",
            "extension/createTerminal",
            "extension/disposeTerminal",
            "extension/sendTerminalCommand",
            "extension/executeInTerminal",
            "extension/waitForTerminalOutput",
            "extension/formatDocument",
            "extension/fixAllLintErrors",
            "extension/organizeImports",
            "extension/goToDefinition",
            "extension/findReferences",
            "extension/findImplementations",
            "extension/goToTypeDefinition",
            "extension/goToDeclaration",
            "extension/getHover",
            "extension/getCodeActions",
            "extension/applyCodeAction",
            "extension/previewCodeAction",
            "extension/renameSymbol",
            "extension/searchSymbols",
            "extension/prepareRename",
            "extension/formatRange",
            "extension/signatureHelp",
            "extension/foldingRanges",
            "extension/selectionRanges",
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
            "extension/getDocumentSymbols",
            "extension/getCallHierarchy",
            "extension/getDebugState",
            "extension/evaluateInDebugger",
            "extension/setDebugBreakpoints",
            "extension/startDebugging",
            "extension/stopDebugging",
            "extension/setDecorations",
            "extension/clearDecorations"
        )
        val stubHandler = StubHandler()
        for (method in stubs) {
            handlerRegistry.register(method, stubHandler)
        }

        // Start connection on first project open — deferred so IDE is ready
        scheduler.schedule({ connect() }, 2, TimeUnit.SECONDS)
    }

    fun setActiveProject(project: Project?) {
        activeProject = project
    }

    // ---------------------------------------------------------------------------
    // Lock file discovery
    // ---------------------------------------------------------------------------

    private data class LockFile(val port: Int, val pid: Long, val authToken: String, val workspace: String)

    private fun discoverLockFile(): LockFile? {
        val configDir = System.getenv("CLAUDE_CONFIG_DIR")?.let { File(it) }
            ?: File(System.getProperty("user.home"), ".claude")
        val ideDir = File(configDir, "ide")
        if (!ideDir.isDirectory) return null

        val lockFiles = ideDir.listFiles { f -> f.name.endsWith(".lock") } ?: return null

        return lockFiles.mapNotNull { f ->
            try {
                val json = gson.fromJson(f.readText(), JsonObject::class.java)
                val isBridge = json.get("isBridge")?.asBoolean ?: false
                if (!isBridge) return@mapNotNull null
                val port = f.nameWithoutExtension.toIntOrNull() ?: return@mapNotNull null
                val pid = json.get("pid")?.asLong ?: return@mapNotNull null
                val token = json.get("authToken")?.asString ?: return@mapNotNull null
                val workspace = json.get("workspace")?.asString ?: ""
                if (!isPidAlive(pid)) return@mapNotNull null
                LockFile(port, pid, token, workspace)
            } catch (e: Exception) {
                LOG.warn("Failed to parse lock file ${f.name}: ${e.message}")
                null
            }
        }.maxByOrNull { it.port }
    }

    private fun isPidAlive(pid: Long): Boolean {
        return try {
            ProcessHandle.of(pid).isPresent
        } catch (_: SecurityException) {
            true // treat as alive if we can't check
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
        val headers = mapOf("x-claude-code-ide-authorization" to lock.authToken)

        val client = object : WebSocketClient(uri, org.java_websocket.drafts.Draft_6455(), headers, 30000) {
            override fun onOpen(handshake: ServerHandshake) {
                if (gen != this@BridgeService.generation.get()) return
                LOG.info("Bridge WebSocket connected (port=${lock.port})")
                lastMessageTime = System.currentTimeMillis()
                reconnectDelay = 1000L
                sendHello()
                startHeartbeatWatchdog(gen)
            }

            override fun onMessage(message: String) {
                if (gen != this@BridgeService.generation.get()) return
                lastMessageTime = System.currentTimeMillis()
                handleIncomingMessage(message)
            }

            override fun onClose(code: Int, reason: String, remote: Boolean) {
                if (gen != this@BridgeService.generation.get()) return
                LOG.info("Bridge WebSocket closed: code=$code reason=$reason remote=$remote")
                cancelHeartbeatWatchdog()
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

        val hello = JsonObject().apply {
            addProperty("extensionVersion", EXTENSION_PROTOCOL_VERSION)
            addProperty("packageVersion", PLUGIN_VERSION)
            addProperty("ideVersion", ideVersion)
        }
        sendNotification("extension/hello", hello)
    }

    fun sendNotification(method: String, params: JsonObject) {
        val msg = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("method", method)
            add("params", params)
        }
        sendRaw(gson.toJson(msg))
    }

    fun sendRaw(text: String) {
        val client = ws ?: return
        if (client.isOpen) {
            try {
                client.send(text)
            } catch (e: Exception) {
                LOG.warn("sendRaw failed: ${e.message}")
            }
        }
    }

    private fun handleIncomingMessage(message: String) {
        scheduler.submit {
            MessageDispatcher(handlerRegistry, gson).dispatch(message, activeProject) { response ->
                if (response != null) sendRaw(response)
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Reconnect backoff
    // ---------------------------------------------------------------------------

    private fun scheduleReconnect(gen: Int) {
        val delay = (500 + Random.nextDouble() * reconnectDelay).roundToLong()
        reconnectDelay = min(reconnectDelay * 2, 30000L)
        LOG.info("Reconnecting in ${delay}ms (gen=$gen)")
        reconnectFuture = scheduler.schedule({
            if (gen == this.generation.get()) connect()
        }, delay, TimeUnit.MILLISECONDS)
    }

    // ---------------------------------------------------------------------------
    // Heartbeat watchdog (120s no-message → reconnect)
    // ---------------------------------------------------------------------------

    private fun startHeartbeatWatchdog(gen: Int) {
        cancelHeartbeatWatchdog()
        heartbeatFuture = scheduler.scheduleAtFixedRate({
            if (gen != this.generation.get()) return@scheduleAtFixedRate
            val elapsed = System.currentTimeMillis() - lastMessageTime
            if (elapsed > 120_000) {
                LOG.warn("No message for ${elapsed}ms, forcing reconnect")
                ws?.close()
            }
        }, 30, 30, TimeUnit.SECONDS)
    }

    private fun cancelHeartbeatWatchdog() {
        heartbeatFuture?.cancel(false)
        heartbeatFuture = null
    }

    fun dispose() {
        cancelHeartbeatWatchdog()
        reconnectFuture?.cancel(false)
        generation.incrementAndGet() // prevent any pending callbacks from acting
        ws?.close()
        scheduler.shutdownNow()
    }
}
