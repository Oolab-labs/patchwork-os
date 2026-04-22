package com.patchwork.bridge

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project

/**
 * Returns the Tier 1 "known-unimplemented" result shape for any method
 * registered but not yet implemented.
 */
class StubHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        return JsonObject().apply {
            addProperty("success", false)
            addProperty("error", "Not implemented in JetBrains plugin MVP")
        }
    }
}
