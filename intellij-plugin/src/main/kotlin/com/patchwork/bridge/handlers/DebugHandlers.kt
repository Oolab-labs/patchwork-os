package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.xdebugger.XExpression
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.XDebuggerUtil
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import com.intellij.xdebugger.breakpoints.XLineBreakpointType
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.XValuePlace
import com.intellij.xdebugger.frame.presentation.XValuePresentation
import com.patchwork.bridge.BridgeHandler
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.swing.Icon

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

private fun currentSession(project: Project) =
    XDebuggerManager.getInstance(project).currentSession

private fun createDebuggerExpression(text: String): XExpression? {
    return try {
        val util = XDebuggerUtil.getInstance()
        val method = util.javaClass.methods.firstOrNull {
            it.name == "createExpression" && (it.parameterCount == 1 || it.parameterCount == 4)
        } ?: return null

        val expression = when (method.parameterCount) {
            1 -> method.invoke(util, text)
            4 -> {
                val evaluationModeClass = Class.forName("com.intellij.xdebugger.evaluation.EvaluationMode")
                val expressionMode = evaluationModeClass.enumConstants
                    ?.firstOrNull { (it as? Enum<*>)?.name == "EXPRESSION" }
                    ?: return null
                method.invoke(util, text, null, null, expressionMode)
            }
            else -> null
        }

        expression as? XExpression
    } catch (_: Exception) {
        null
    }
}

private fun allBreakpointsJson(project: Project): JsonArray {
    val arr = JsonArray()
    try {
        XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints.forEach { bp ->
            if (bp is XLineBreakpoint<*>) {
                arr.add(JsonObject().apply {
                    addProperty("file", VfsUtilCore.urlToPath(bp.fileUrl))
                    addProperty("line", bp.line + 1)
                    addProperty("enabled", bp.isEnabled)
                    val cond = try { bp.conditionExpression?.expression } catch (_: Exception) { null }
                    if (cond != null) addProperty("condition", cond)
                })
            }
        }
    } catch (_: Exception) {}
    return arr
}

// ---------------------------------------------------------------------------
// getDebugState
// ---------------------------------------------------------------------------

class GetDebugStateHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val noSession = JsonObject().apply {
            addProperty("hasActiveSession", false)
            addProperty("isPaused", false)
            add("breakpoints", if (project != null) allBreakpointsJson(project) else JsonArray())
        }
        if (project == null) return noSession

        val session = currentSession(project) ?: return noSession
        val breakpoints = allBreakpointsJson(project)
        val isPaused = session.isPaused
        val callStack = JsonArray()
        var pausedAtObj: JsonObject? = null

        if (isPaused) {
            try {
                val suspCtx = session.suspendContext
                val activeStack = suspCtx?.activeExecutionStack
                if (activeStack != null) {
                    val latch = CountDownLatch(1)
                    val frames = mutableListOf<com.intellij.xdebugger.frame.XStackFrame>()
                    activeStack.computeStackFrames(0, object : com.intellij.xdebugger.frame.XExecutionStack.XStackFrameContainer {
                        override fun addStackFrames(list: List<com.intellij.xdebugger.frame.XStackFrame>, last: Boolean) {
                            frames.addAll(list)
                            if (last) latch.countDown()
                        }
                        override fun errorOccurred(msg: String) { latch.countDown() }
                    })
                    latch.await(3, TimeUnit.SECONDS)
                    frames.take(20).forEachIndexed { i, frame ->
                        val src = frame.sourcePosition
                        callStack.add(JsonObject().apply {
                            addProperty("index", i)
                            addProperty("name", frame.toString())
                            if (src != null) {
                                addProperty("file", VfsUtilCore.urlToPath(src.file.url))
                                addProperty("line", src.line + 1)
                            }
                        })
                        if (i == 0 && src != null) {
                            pausedAtObj = JsonObject().apply {
                                addProperty("file", VfsUtilCore.urlToPath(src.file.url))
                                addProperty("line", src.line + 1)
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }

        return JsonObject().apply {
            addProperty("hasActiveSession", true)
            addProperty("sessionName", session.sessionName)
            addProperty("isPaused", isPaused)
            if (pausedAtObj != null) add("pausedAt", pausedAtObj)
            add("callStack", callStack)
            add("breakpoints", breakpoints)
        }
    }
}

// ---------------------------------------------------------------------------
// evaluateInDebugger
// ---------------------------------------------------------------------------

class EvaluateInDebuggerHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No project open")
        }
        val expression = params?.get("expression")?.takeIf { it.isJsonPrimitive }?.asString
        if (expression.isNullOrEmpty()) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "expression is required")
        }
        val session = currentSession(project) ?: return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No active debug session")
        }
        if (!session.isPaused) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "Debug session is not paused")
        }
        val evaluator = session.debugProcess.evaluator ?: return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No evaluator for this debug session type")
        }

        val latch = CountDownLatch(1)
        var capturedValue: String? = null
        var capturedType: String? = null
        var errorMsg: String? = null

        val srcPos = session.currentStackFrame?.sourcePosition
        val evaluationExpression = createDebuggerExpression(expression)
        if (evaluationExpression != null) {
            evaluator.evaluate(evaluationExpression, object : XDebuggerEvaluator.XEvaluationCallback {
                override fun evaluated(result: XValue) {
                    val node = CaptureNode()
                    result.computePresentation(node, XValuePlace.TOOLTIP)
                    // computePresentation may be async — wait briefly for it
                    Thread.sleep(200)
                    capturedValue = node.value ?: result.toString()
                    capturedType = node.type
                    latch.countDown()
                }
                override fun errorOccurred(errorMessage: String) {
                    errorMsg = errorMessage
                    latch.countDown()
                }
            }, srcPos)
        } else {
            evaluator.evaluate(expression, object : XDebuggerEvaluator.XEvaluationCallback {
                override fun evaluated(result: XValue) {
                    val node = CaptureNode()
                    result.computePresentation(node, XValuePlace.TOOLTIP)
                    // computePresentation may be async — wait briefly for it
                    Thread.sleep(200)
                    capturedValue = node.value ?: result.toString()
                    capturedType = node.type
                    latch.countDown()
                }
                override fun errorOccurred(errorMessage: String) {
                    errorMsg = errorMessage
                    latch.countDown()
                }
            }, srcPos)
        }

        latch.await(8, TimeUnit.SECONDS)

        return if (errorMsg != null) {
            JsonObject().apply { addProperty("success", false); addProperty("error", errorMsg) }
        } else {
            JsonObject().apply {
                addProperty("success", true)
                addProperty("result", capturedValue ?: "")
                if (capturedType != null) addProperty("type", capturedType)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// setDebugBreakpoints
// ---------------------------------------------------------------------------

class SetDebugBreakpointsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No project open")
        }
        val file = params?.get("file")?.takeIf { it.isJsonPrimitive }?.asString
            ?: return JsonObject().apply { addProperty("success", false); addProperty("error", "file is required") }
        val vf = LocalFileSystem.getInstance().findFileByPath(file)
            ?: return JsonObject().apply { addProperty("success", false); addProperty("error", "File not found: $file") }
        val specs = params.get("breakpoints")?.takeIf { it.isJsonArray }?.asJsonArray ?: JsonArray()

        var setCount = 0
        var errorMsg: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                val bpMgr = XDebuggerManager.getInstance(project).breakpointManager
                val lineTypes = XDebuggerUtil.getInstance().lineBreakpointTypes

                // Remove existing breakpoints for this file
                bpMgr.allBreakpoints
                    .filterIsInstance<XLineBreakpoint<*>>()
                    .filter { it.fileUrl == vf.url }
                    .forEach { bp ->
                        @Suppress("UNCHECKED_CAST")
                        bpMgr.removeBreakpoint(bp as XLineBreakpoint<XBreakpointProperties<*>>)
                    }

                if (lineTypes.isEmpty()) {
                    errorMsg = "No line breakpoint types registered"
                    return@invokeAndWait
                }

                specs.forEach { specEl ->
                    val spec = specEl.asJsonObject
                    val line = spec.get("line")?.takeIf { it.isJsonPrimitive }?.asInt ?: return@forEach
                    val condition = spec.get("condition")?.takeIf { it.isJsonPrimitive }?.asString

                    @Suppress("UNCHECKED_CAST")
                    val type = (lineTypes.firstOrNull { it.canPutAt(vf, line - 1, project) }
                        ?: lineTypes[0]) as XLineBreakpointType<XBreakpointProperties<*>>

                    val bp = bpMgr.addLineBreakpoint(type, vf.url, line - 1, null)
                    if (condition != null) {
                        val expression = createDebuggerExpression(condition)
                        if (expression != null) {
                            bp.conditionExpression = expression
                        }
                    }
                    setCount++
                }
            } catch (e: Exception) {
                errorMsg = e.message ?: "Failed to set breakpoints"
            }
        }

        return if (errorMsg != null) {
            JsonObject().apply { addProperty("success", false); addProperty("error", errorMsg) }
        } else {
            JsonObject().apply { addProperty("success", true); addProperty("set", setCount); addProperty("file", file) }
        }
    }
}

// ---------------------------------------------------------------------------
// startDebugging
// ---------------------------------------------------------------------------

class StartDebuggingHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("started", false); addProperty("error", "No project open")
        }
        val configName = params?.get("configName")?.takeIf { it.isJsonPrimitive }?.asString
        var started = false
        var errorMsg: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                val runManager = RunManager.getInstance(project)
                val setting = if (configName != null) {
                    runManager.allSettings.firstOrNull { it.name == configName }
                        ?: run { errorMsg = "Run configuration \"$configName\" not found"; return@invokeAndWait }
                } else {
                    runManager.selectedConfiguration
                        ?: runManager.allSettings.firstOrNull()
                        ?: run { errorMsg = "No run configurations available"; return@invokeAndWait }
                }
                val executor = DefaultDebugExecutor.getDebugExecutorInstance()
                ProgramRunnerUtil.executeConfiguration(setting, executor)
                started = true
            } catch (e: Exception) {
                errorMsg = e.message ?: "Failed to start debugging"
            }
        }

        return JsonObject().apply {
            addProperty("started", started)
            if (errorMsg != null) addProperty("error", errorMsg)
        }
    }
}

// ---------------------------------------------------------------------------
// stopDebugging
// ---------------------------------------------------------------------------

class StopDebuggingHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("stopped", false); addProperty("error", "No project open")
        }
        val session = currentSession(project) ?: return JsonObject().apply {
            addProperty("stopped", false); addProperty("message", "No active debug session")
        }
        var stopped = false
        var errorMsg: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                session.stop()
                stopped = true
            } catch (e: Exception) {
                errorMsg = e.message ?: "Failed to stop debug session"
            }
        }

        return JsonObject().apply {
            addProperty("stopped", stopped)
            if (errorMsg != null) addProperty("error", errorMsg)
        }
    }
}
