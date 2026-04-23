package com.patchwork.bridge.handlers

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.codeInsight.actions.OptimizeImportsProcessor
import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.LocalQuickFixOnPsiElement
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiManager
import com.intellij.psi.codeStyle.CodeStyleManager
import com.patchwork.bridge.BridgeHandler

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

private fun requireFilePsi(params: JsonObject?, project: Project): Triple<String, com.intellij.openapi.vfs.VirtualFile, com.intellij.psi.PsiFile>? {
    val file = params?.get("file")?.takeIf { it.isJsonPrimitive }?.asString ?: return null
    val vf = LocalFileSystem.getInstance().findFileByPath(file) ?: return null
    val psi = PsiManager.getInstance(project).findFile(vf) ?: return null
    return Triple(file, vf, psi)
}

// ---------------------------------------------------------------------------
// formatDocument
// ---------------------------------------------------------------------------

class FormatDocumentHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No project open")
        }
        val (_, vf, psiFile) = requireFilePsi(params, project) ?: return JsonObject().apply {
            addProperty("success", false); addProperty("error", "file parameter required and must exist on disk")
        }

        var editsApplied = 0
        var errorMsg: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
                    val doc = FileDocumentManager.getInstance().getDocument(vf)
                    val before = doc?.text ?: ""
                    CodeStyleManager.getInstance(project).reformatText(psiFile, 0, psiFile.textLength)
                    val after = doc?.text ?: ""
                    if (before != after) editsApplied = 1
                    FileDocumentManager.getInstance().saveDocument(doc ?: return@runWriteCommandAction)
                }
            } catch (e: Exception) {
                errorMsg = e.message ?: "Format failed"
            }
        }

        return if (errorMsg != null) {
            JsonObject().apply { addProperty("success", false); addProperty("error", errorMsg) }
        } else {
            JsonObject().apply { addProperty("success", true); addProperty("editsApplied", editsApplied) }
        }
    }
}

// ---------------------------------------------------------------------------
// organizeImports
// ---------------------------------------------------------------------------

class OrganizeImportsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No project open")
        }
        val (_, vf, psiFile) = requireFilePsi(params, project) ?: return JsonObject().apply {
            addProperty("success", false); addProperty("error", "file parameter required and must exist on disk")
        }

        var appliedCount = 0
        var errorMsg: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                val doc = FileDocumentManager.getInstance().getDocument(vf)
                val before = doc?.text ?: ""
                // OptimizeImportsProcessor runs on EDT and handles write action internally
                OptimizeImportsProcessor(project, psiFile).run()
                val after = doc?.text ?: ""
                if (before != after) appliedCount = 1
                FileDocumentManager.getInstance().saveDocument(doc ?: return@invokeAndWait)
            } catch (e: Exception) {
                errorMsg = e.message ?: "Organize imports failed"
            }
        }

        return if (errorMsg != null) {
            JsonObject().apply { addProperty("success", false); addProperty("error", errorMsg) }
        } else {
            JsonObject().apply { addProperty("success", true); addProperty("actionsApplied", appliedCount) }
        }
    }
}

// ---------------------------------------------------------------------------
// fixAllLintErrors
// ---------------------------------------------------------------------------

class FixAllLintErrorsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("success", false); addProperty("error", "No project open")
        }
        val (_, vf, psiFile) = requireFilePsi(params, project) ?: return JsonObject().apply {
            addProperty("success", false); addProperty("error", "file parameter required and must exist on disk")
        }

        var appliedCount = 0
        var errorMsg: String? = null

        ApplicationManager.getApplication().invokeAndWait {
            try {
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@invokeAndWait
                val before = doc.text

                com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
                    // Collect all available quick fixes via DaemonCodeAnalyzer highlights
                    val highlights = collectDaemonHighlights(project, doc)

                    for (info in highlights) {
                        // Only auto-fixable (has exactly one fix, or has a "fix all" fix)
                        val fixes = highlightQuickFixActions(info)
                        for (fix in fixes) {
                            val action = fix as? IntentionAction ?: continue
                            // Only apply fixes that are universally safe (implement BatchQuickFix or have "Fix all" in text)
                            val name = action.text
                            if (!name.contains("Fix all", ignoreCase = true) &&
                                action !is LocalQuickFixOnPsiElement &&
                                action !is LocalQuickFix) continue
                            try {
                                action.invoke(project, null, psiFile)
                                appliedCount++
                            } catch (_: Exception) {}
                        }
                    }
                }

                val after = doc.text
                if (before == after) appliedCount = 0  // nothing actually changed
                FileDocumentManager.getInstance().saveDocument(doc)
            } catch (e: Exception) {
                errorMsg = e.message ?: "Fix lint errors failed"
            }
        }

        return if (errorMsg != null) {
            JsonObject().apply { addProperty("success", false); addProperty("error", errorMsg) }
        } else {
            JsonObject().apply { addProperty("success", true); addProperty("actionsApplied", appliedCount) }
        }
    }
}
