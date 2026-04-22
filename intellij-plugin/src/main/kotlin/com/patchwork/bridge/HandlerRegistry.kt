package com.patchwork.bridge

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project

/**
 * Handler function type. Returns a JsonElement result on success.
 * Throws MethodNotFoundException, InvalidParamsException, or any other
 * exception for error paths.
 */
fun interface BridgeHandler {
    fun handle(params: JsonObject?, project: Project?): JsonElement
}

class MethodNotFoundException(method: String) :
    Exception("Method not found: $method") {
    val code = -32601
}

class InvalidParamsException(message: String) :
    Exception(message) {
    val code = -32602
}

class InternalErrorException(message: String) :
    Exception(message) {
    val code = -32603
}

class HandlerRegistry {

    private val handlers = mutableMapOf<String, BridgeHandler>()

    fun register(method: String, handler: BridgeHandler) {
        handlers[method] = handler
    }

    /**
     * Dispatches a method call. Returns a JsonElement result or throws one of
     * MethodNotFoundException / InvalidParamsException / InternalErrorException.
     */
    fun dispatch(method: String, params: JsonObject?, project: Project?): JsonElement {
        val handler = handlers[method] ?: throw MethodNotFoundException(method)
        return try {
            handler.handle(params, project)
        } catch (e: MethodNotFoundException) {
            throw e
        } catch (e: InvalidParamsException) {
            throw e
        } catch (e: InternalErrorException) {
            throw e
        } catch (e: Exception) {
            throw InternalErrorException(e.message ?: "Unknown error")
        }
    }
}
