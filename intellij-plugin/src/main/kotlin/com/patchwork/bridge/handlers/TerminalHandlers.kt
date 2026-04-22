package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException

// ---------------------------------------------------------------------------
// Terminal handler utilities
// ---------------------------------------------------------------------------

private const val SHELL_METACHAR_PATTERN = """[;&|`${'$'}()<>{}!\\\n\r]"""
private val SHELL_METACHAR_RE = Regex(SHELL_METACHAR_PATTERN)

/** Returns the TerminalToolWindowManager instance or null if terminal plugin absent. */
private fun getTerminalManager(project: Project): Any? = try {
    val cls = Class.forName("org.jetbrains.plugins.terminal.TerminalToolWindowManager")
    val getter = cls.getMethod("getInstance", Project::class.java)
    getter.invoke(null, project)
} catch (_: Exception) { null }

/**
 * Returns list of open terminal widgets from TerminalToolWindowManager.
 * Each entry is a Pair(name: String, widget: Any).
 */
private fun listTerminalWidgets(manager: Any): List<Pair<String, Any>> {
    return try {
        val getWidgets = manager.javaClass.getMethod("getTerminalWidgets")
        @Suppress("UNCHECKED_CAST")
        val widgets = getWidgets.invoke(manager) as? List<Any> ?: return emptyList()
        widgets.mapNotNull { w ->
            val name = try {
                w.javaClass.getMethod("getTerminalTitle").invoke(w) as? String
                    ?: w.javaClass.getMethod("getName").invoke(w) as? String
                    ?: "Terminal"
            } catch (_: Exception) { "Terminal" }
            Pair(name, w)
        }
    } catch (_: Exception) { emptyList() }
}

private fun findWidget(manager: Any, name: String?, index: Int?): Any? {
    val widgets = listTerminalWidgets(manager)
    return when {
        name != null -> widgets.firstOrNull { it.first == name }?.second
        index != null -> widgets.getOrNull(index)?.second
        else -> widgets.firstOrNull()?.second
    }
}

private fun sendTextToWidget(widget: Any, text: String, addNewline: Boolean) {
    // Try JBTerminalWidget.sendTextToProcess (direct connector write)
    try {
        val m = widget.javaClass.getMethod("sendTextToProcess", String::class.java)
        m.invoke(widget, if (addNewline) "$text\n" else text)
        return
    } catch (_: Exception) {}
    // Fallback: getTtyConnector().write()
    try {
        val conn = widget.javaClass.getMethod("getTtyConnector").invoke(widget)
        if (conn != null) {
            val write = conn.javaClass.getMethod("write", String::class.java)
            write.invoke(conn, if (addNewline) "$text\n" else text)
        }
    } catch (_: Exception) {}
}

private fun disposeWidget(widget: Any) {
    try {
        widget.javaClass.getMethod("close").invoke(widget)
    } catch (_: Exception) {
        try { widget.javaClass.getMethod("dispose").invoke(widget) } catch (_: Exception) {}
    }
}

// ---------------------------------------------------------------------------
// listTerminals
// ---------------------------------------------------------------------------

class ListTerminalsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                add("terminals", JsonArray())
                addProperty("count", 0)
                addProperty("outputCaptureAvailable", false)
            }
        }
        val manager = getTerminalManager(project)
        if (manager == null) {
            return JsonObject().apply {
                add("terminals", JsonArray())
                addProperty("count", 0)
                addProperty("outputCaptureAvailable", false)
            }
        }
        val widgets = listTerminalWidgets(manager)
        val arr = JsonArray()
        widgets.forEachIndexed { i, (name, _) ->
            arr.add(JsonObject().apply {
                addProperty("name", name)
                addProperty("index", i)
                addProperty("isActive", false) // IJ has no reliable activeTerminal API
                addProperty("hasOutputCapture", false)
            })
        }
        return JsonObject().apply {
            add("terminals", arr)
            addProperty("count", arr.size())
            addProperty("outputCaptureAvailable", false)
        }
    }
}

// ---------------------------------------------------------------------------
// createTerminal
// ---------------------------------------------------------------------------

class CreateTerminalHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val name = params?.get("name")?.takeIf { it.isJsonPrimitive }?.asString
        val cwd = params?.get("cwd")?.takeIf { it.isJsonPrimitive }?.asString
        val show = params?.get("show")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true

        // env validation
        val envEl = params?.get("env")
        if (envEl != null && !envEl.isJsonNull) {
            if (!envEl.isJsonObject) throw InvalidParamsException("env must be an object")
            envEl.asJsonObject.entrySet().forEach { (k, v) ->
                if (!v.isJsonPrimitive || !v.asJsonPrimitive.isString)
                    throw InvalidParamsException("env[\"$k\"] must be a string")
            }
        }

        var termName = ""
        var termIndex = -1
        var created = false
        var error: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                // Try TerminalView.getInstance(project).createLocalShellWidget(cwd, name)
                val tvCls = Class.forName("org.jetbrains.plugins.terminal.TerminalView")
                val tv = tvCls.getMethod("getInstance", Project::class.java).invoke(null, project)

                val widget = try {
                    tvCls.getMethod("createLocalShellWidget", String::class.java, String::class.java)
                        .invoke(tv, cwd ?: project.basePath ?: "", name ?: "")
                } catch (_: NoSuchMethodException) {
                    // Older IJ: createNewSession
                    tvCls.getMethod("createNewSession", String::class.java)
                        .invoke(tv, name ?: "Terminal")
                }

                termName = try {
                    widget?.javaClass?.getMethod("getTerminalTitle")?.invoke(widget) as? String ?: name ?: "Terminal"
                } catch (_: Exception) { name ?: "Terminal" }

                val manager = getTerminalManager(project)
                termIndex = if (manager != null) listTerminalWidgets(manager).indexOfFirst { it.first == termName } else 0
                created = true

                if (show) {
                    try {
                        val twm = Class.forName("com.intellij.openapi.wm.ToolWindowManager")
                            .getMethod("getInstance", Project::class.java).invoke(null, project)
                        val tw = twm.javaClass.getMethod("getToolWindow", String::class.java)
                            .invoke(twm, "Terminal")
                        tw?.javaClass?.getMethod("show")?.invoke(tw)
                    } catch (_: Exception) {}
                }
            } catch (e: Exception) {
                error = "Failed to create terminal: ${e.message}"
            }
        }

        return if (created) {
            JsonObject().apply {
                addProperty("success", true)
                addProperty("name", termName)
                addProperty("index", termIndex)
            }
        } else {
            JsonObject().apply {
                addProperty("success", false)
                addProperty("error", error ?: "Terminal plugin not available")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// disposeTerminal
// ---------------------------------------------------------------------------

class DisposeTerminalHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }
        val name = params?.get("name")?.takeIf { it.isJsonPrimitive }?.asString
        val index = params?.get("index")?.takeIf { it.isJsonPrimitive }?.asInt

        val manager = getTerminalManager(project)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Terminal plugin not available")
            }

        val widget = findWidget(manager, name, index)
        if (widget == null) {
            val available = JsonArray()
            listTerminalWidgets(manager).forEach { available.add(it.first) }
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Terminal not found${if (name != null) " with name \"$name\"" else if (index != null) " at index $index" else ""}")
                add("availableTerminals", available)
            }
        }

        val terminalName = listTerminalWidgets(manager).firstOrNull { it.second === widget }?.first ?: ""
        ApplicationManager.getApplication().invokeAndWait { disposeWidget(widget) }
        return JsonObject().apply {
            addProperty("success", true)
            addProperty("terminalName", terminalName)
        }
    }
}

// ---------------------------------------------------------------------------
// sendTerminalCommand
// ---------------------------------------------------------------------------

class SendTerminalCommandHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val textEl = params?.get("text")
        if (textEl == null || !textEl.isJsonPrimitive || !textEl.asJsonPrimitive.isString) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "text must be a string")
            }
        }
        val text = textEl.asString

        if (SHELL_METACHAR_RE.containsMatchIn(text)) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Terminal command must not contain shell metacharacters or newlines")
            }
        }

        val name = params.get("name")?.takeIf { it.isJsonPrimitive }?.asString
        val index = params.get("index")?.takeIf { it.isJsonPrimitive }?.asInt
        val addNewline = params.get("addNewline")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true

        if (project == null) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "No project open")
            }
        }

        val manager = getTerminalManager(project)
            ?: return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Terminal plugin not available")
            }

        val widget = findWidget(manager, name, index)
        if (widget == null) {
            val available = JsonArray()
            listTerminalWidgets(manager).forEach { available.add(it.first) }
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Terminal not found${if (name != null) " with name \"$name\"" else if (index != null) " at index $index" else ""}")
                add("availableTerminals", available)
            }
        }

        val terminalName = listTerminalWidgets(manager).firstOrNull { it.second === widget }?.first ?: ""
        ApplicationManager.getApplication().invokeAndWait {
            sendTextToWidget(widget, text, addNewline)
        }
        return JsonObject().apply {
            addProperty("success", true)
            addProperty("terminalName", terminalName)
        }
    }
}

// ---------------------------------------------------------------------------
// getTerminalOutput — output capture not available in IJ plugin API
// ---------------------------------------------------------------------------

class GetTerminalOutputHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val name = params?.get("name")?.takeIf { it.isJsonPrimitive }?.asString
        val index = params?.get("index")?.takeIf { it.isJsonPrimitive }?.asInt
        return JsonObject().apply {
            addProperty("available", false)
            addProperty("error",
                "Terminal output capture is not available in the JetBrains plugin. " +
                "The IJ terminal API does not expose a public output buffer. " +
                "Use executeInTerminal (shell integration) or read files written by the command.")
            if (name != null) addProperty("terminalName", name)
            else if (index != null) addProperty("terminalIndex", index)
        }
    }
}

// ---------------------------------------------------------------------------
// waitForTerminalOutput — not available
// ---------------------------------------------------------------------------

class WaitForTerminalOutputHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val patternStr = params?.get("pattern")?.takeIf { it.isJsonPrimitive }?.asString
        if (patternStr == null || patternStr.isEmpty()) {
            return JsonObject().apply {
                addProperty("matched", false)
                addProperty("error", "pattern must be a non-empty string")
            }
        }
        return JsonObject().apply {
            addProperty("matched", false)
            addProperty("error",
                "Terminal output capture is not available in the JetBrains plugin. " +
                "The IJ terminal API does not expose a real-time output stream. " +
                "Use executeInTerminal for commands that need output capture.")
        }
    }
}

// ---------------------------------------------------------------------------
// executeInTerminal — runs via GeneralCommandLine (captures output, not in a tab)
// ---------------------------------------------------------------------------

class ExecuteInTerminalHandler : BridgeHandler {

    companion object {
        private const val MAX_OUTPUT_BYTES = 512 * 1024
        private val METACHAR_RE = Regex("""[;&|`${'$'}()<>{}!\\]""")
    }

    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val command = params?.get("command")?.takeIf { it.isJsonPrimitive }?.asString
        if (command == null || command.isEmpty()) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "command must be a non-empty string")
            }
        }
        if (command.contains('\n') || command.contains('\r')) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Command must not contain newlines")
            }
        }
        if (METACHAR_RE.containsMatchIn(command)) {
            return JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Command must not contain shell metacharacters")
            }
        }

        val timeoutMs = params?.get("timeoutMs")?.takeIf { it.isJsonPrimitive }?.asLong
            ?.coerceIn(1_000L, 300_000L) ?: 30_000L

        val cwd = if (project != null) {
            params?.get("cwd")?.takeIf { it.isJsonPrimitive }?.asString ?: project.basePath
        } else {
            params?.get("cwd")?.takeIf { it.isJsonPrimitive }?.asString
        }

        return try {
            val cmdLine = com.intellij.execution.configurations.GeneralCommandLine()
                .withExePath("/bin/sh")
                .withParameters("-c", command)
            if (cwd != null) cmdLine.setWorkDirectory(cwd)

            val process = cmdLine.createProcess()
            val outputBuf = java.io.ByteArrayOutputStream()
            var truncated = false
            val stdoutThread = Thread {
                try {
                    process.inputStream.use { stream ->
                        val buf = ByteArray(4096)
                        var n: Int
                        while (stream.read(buf).also { n = it } != -1) {
                            if (!truncated) {
                                val written = outputBuf.size()
                                val remaining = MAX_OUTPUT_BYTES - written
                                if (n > remaining) {
                                    outputBuf.write(buf, 0, remaining)
                                    truncated = true
                                } else {
                                    outputBuf.write(buf, 0, n)
                                }
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
            stdoutThread.isDaemon = true
            stdoutThread.start()
            // Drain stderr to prevent blocking
            Thread { try { process.errorStream.use { it.readBytes() } } catch (_: Exception) {} }
                .also { it.isDaemon = true; it.start() }

            val finished = process.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!finished) {
                process.destroyForcibly()
                stdoutThread.join(500)
                val output = stripAnsi(outputBuf.toString(Charsets.UTF_8.name()))
                return JsonObject().apply {
                    addProperty("success", false)
                    addProperty("error", "Command timed out after ${timeoutMs}ms")
                    addProperty("timedOut", true)
                    addProperty("output", output)
                }
            }
            stdoutThread.join(500)
            val exitCode = process.exitValue()
            val output = stripAnsi(outputBuf.toString(Charsets.UTF_8.name()))
            JsonObject().apply {
                addProperty("success", true)
                addProperty("exitCode", exitCode)
                addProperty("output", output)
                if (truncated) addProperty("truncated", true)
            }
        } catch (e: Exception) {
            JsonObject().apply {
                addProperty("success", false)
                addProperty("error", "Failed to execute command: ${e.message}")
            }
        }
    }

    private fun stripAnsi(text: String): String =
        text.replace(Regex("\\[[0-9;?]*[a-zA-Z]|].*?(?:|\\\\)|[()][AB012]|[>=]|\r"), "")
}
