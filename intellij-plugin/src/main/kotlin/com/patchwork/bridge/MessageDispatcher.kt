package com.patchwork.bridge

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.util.concurrent.atomic.AtomicInteger

class MessageDispatcher(
    private val registry: HandlerRegistry,
    private val gson: Gson
) {

    companion object {
        private val LOG = Logger.getInstance(MessageDispatcher::class.java)
        private val pendingCount = AtomicInteger(0)
        private const val MAX_PENDING = 50
    }

    /**
     * Parse and dispatch a raw JSON-RPC text message.
     * Calls [respond] with a serialized response string, or null for notifications.
     */
    fun dispatch(message: String, project: Project?, respond: (String?) -> Unit) {
        val root = try {
            gson.fromJson(message, JsonObject::class.java)
        } catch (e: Exception) {
            LOG.warn("Failed to parse incoming message: ${e.message}")
            respond(null)
            return
        }

        val id: JsonElement? = root.get("id")
        val method = root.get("method")?.asString
        val params = root.get("params")?.takeIf { it.isJsonObject }?.asJsonObject

        if (method == null) {
            // Not a valid request — ignore
            respond(null)
            return
        }

        // Notification (no id) — silently ack, no response
        if (id == null) {
            handleIncomingNotification(method, params)
            respond(null)
            return
        }

        // Request — must respond
        if (pendingCount.incrementAndGet() > MAX_PENDING) {
            pendingCount.decrementAndGet()
            respond(errorResponse(id, -32000, "Too many pending handlers — try again later"))
            return
        }

        try {
            val result = registry.dispatch(method, params, project)
            respond(resultResponse(id, result))
        } catch (e: MethodNotFoundException) {
            respond(errorResponse(id, e.code, e.message ?: "Method not found"))
        } catch (e: InvalidParamsException) {
            respond(errorResponse(id, e.code, e.message ?: "Invalid params"))
        } catch (e: InternalErrorException) {
            respond(errorResponse(id, e.code, e.message ?: "Internal error"))
        } catch (e: Exception) {
            respond(errorResponse(id, -32603, e.message ?: "Internal error"))
        } finally {
            pendingCount.decrementAndGet()
        }
    }

    private fun handleIncomingNotification(method: String, params: JsonObject?) {
        // Handle bridge→plugin notifications if needed
        when (method) {
            "bridge/claudeConnectionChanged",
            "bridge/claudeTaskOutput",
            "extension/bridgeLiveState" -> {
                LOG.debug("Received notification: $method")
            }
            else -> LOG.debug("Unhandled notification: $method")
        }
    }

    private fun resultResponse(id: JsonElement, result: JsonElement): String {
        val obj = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            add("id", id)
            add("result", result)
        }
        return gson.toJson(obj)
    }

    private fun errorResponse(id: JsonElement, code: Int, message: String): String {
        val error = JsonObject().apply {
            addProperty("code", code)
            addProperty("message", message)
        }
        val obj = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            add("id", id)
            add("error", error)
        }
        return gson.toJson(obj)
    }
}
