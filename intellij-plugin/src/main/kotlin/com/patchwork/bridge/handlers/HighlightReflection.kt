package com.patchwork.bridge.handlers

import com.google.gson.JsonObject
import com.intellij.openapi.editor.Document
import com.intellij.openapi.project.Project

internal fun collectDaemonHighlights(project: Project, document: Document): List<Any> {
    return try {
        val analyzerClass = Class.forName("com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl")
        val method = analyzerClass.methods.firstOrNull {
            it.name == "getHighlights" && it.parameterCount == 3
        } ?: return emptyList()
        when (val raw = method.invoke(null, document, null, project)) {
            is Collection<*> -> raw.filterNotNull()
            is Array<*> -> raw.filterNotNull()
            else -> emptyList()
        }
    } catch (_: Exception) {
        emptyList()
    }
}

internal fun highlightToJson(info: Any, document: Document): JsonObject? {
    val severityText = reflectMember(info, "severity")?.toString()?.uppercase() ?: return null
    val severity = when {
        severityText.contains("ERROR") -> "error"
        severityText.contains("WARNING") -> "warning"
        severityText.contains("INFORMATION") || severityText == "INFO" -> "information"
        severityText.contains("TEXT") -> "hint"
        else -> return null
    }

    val startOffset = (reflectMember(info, "startOffset") as? Number)?.toInt() ?: return null
    val endOffset = (reflectMember(info, "endOffset") as? Number)?.toInt() ?: return null
    if (startOffset < 0 || startOffset > document.textLength) return null

    val startLine = document.getLineNumber(startOffset)
    val startLineStart = document.getLineStartOffset(startLine)
    val safeEndOffset = endOffset.coerceIn(0, document.textLength)
    val endLine = document.getLineNumber(safeEndOffset)
    val endLineStart = document.getLineStartOffset(endLine)

    return JsonObject().apply {
        addProperty("message", reflectMember(info, "description")?.toString() ?: "")
        addProperty("severity", severity)
        addProperty("line", startLine + 1)
        addProperty("column", startOffset - startLineStart + 1)
        addProperty("endLine", endLine + 1)
        addProperty("endColumn", safeEndOffset - endLineStart + 1)
        addProperty("source", reflectMember(info, "type")?.toString() ?: "")
        addProperty("code", reflectMember(info, "problemGroup")?.toString() ?: "")
    }
}

internal fun highlightQuickFixActions(info: Any): Sequence<Any> {
    val ranges = reflectMember(info, "quickFixActionRanges") ?: return emptySequence()
    val items = when (ranges) {
        is Iterable<*> -> ranges.asSequence()
        is Array<*> -> ranges.asSequence()
        else -> emptySequence()
    }
    return items.mapNotNull { range ->
        val descriptor = reflectMember(range, "first") ?: reflectMember(range, "component1") ?: return@mapNotNull null
        reflectMember(descriptor, "action")
    }
}

private fun reflectMember(target: Any?, name: String): Any? {
    if (target == null) return null

    val accessorNames = buildList {
        add(name)
        add("get${name.replaceFirstChar { it.uppercase() }}")
        add("is${name.replaceFirstChar { it.uppercase() }}")
    }

    for (methodName in accessorNames) {
        val method = target.javaClass.methods.firstOrNull {
            it.name == methodName && it.parameterCount == 0
        }
        if (method != null) {
            try {
                return method.invoke(target)
            } catch (_: Exception) {
            }
        }
    }

    val fieldNames = buildList {
        add(name)
        add(name.replaceFirstChar { it.lowercase() })
    }

    for (fieldName in fieldNames) {
        val field = runCatching { target.javaClass.getField(fieldName) }.getOrNull()
            ?: runCatching { target.javaClass.getDeclaredField(fieldName) }.getOrNull()
        if (field != null) {
            try {
                field.isAccessible = true
                return field.get(target)
            } catch (_: Exception) {
            }
        }
    }

    return null
}
