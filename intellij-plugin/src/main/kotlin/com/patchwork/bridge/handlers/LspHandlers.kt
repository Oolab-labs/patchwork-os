package com.patchwork.bridge.handlers

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.intellij.lang.folding.LanguageFolding
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.PsiRecursiveElementVisitor
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.refactoring.rename.RenameProcessor
import com.patchwork.bridge.BridgeHandler
import com.patchwork.bridge.InvalidParamsException

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

private fun getVfAndDoc(filePath: String, project: Project?) =
    if (project == null) null
    else LocalFileSystem.getInstance().findFileByPath(filePath)?.let { vf ->
        FileDocumentManager.getInstance().getDocument(vf)?.let { doc -> Pair(vf, doc) }
    }

private fun offsetToLocation(offset: Int, doc: com.intellij.openapi.editor.Document): JsonObject {
    val line0 = doc.getLineNumber(offset.coerceIn(0, doc.textLength))
    val lineStart = doc.getLineStartOffset(line0)
    val col1 = offset - lineStart + 1
    return JsonObject().apply {
        addProperty("line", line0 + 1)
        addProperty("column", col1)
    }
}

private fun rangeToJson(
    startOffset: Int,
    endOffset: Int,
    doc: com.intellij.openapi.editor.Document
): JsonObject {
    val s = offsetToLocation(startOffset, doc)
    val e = offsetToLocation(endOffset, doc)
    return JsonObject().apply {
        addProperty("startLine", s.get("line").asInt)
        addProperty("startColumn", s.get("column").asInt)
        addProperty("endLine", e.get("line").asInt)
        addProperty("endColumn", e.get("column").asInt)
    }
}

private fun elementLocation(el: PsiElement): JsonObject? {
    val vf = el.containingFile?.virtualFile ?: return null
    val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return null
    val nav = el.navigationElement
    val range = nav.textRange ?: return null
    val s = offsetToLocation(range.startOffset, doc)
    val e = offsetToLocation(range.endOffset, doc)
    return JsonObject().apply {
        addProperty("file", vf.path)
        addProperty("line", s.get("line").asInt)
        addProperty("column", s.get("column").asInt)
        addProperty("endLine", e.get("line").asInt)
        addProperty("endColumn", e.get("column").asInt)
    }
}

private fun elementKind(el: PsiElement): String {
    val name = el.javaClass.simpleName
    return when {
        name.contains("Class") || name.contains("Interface") || name.contains("Object") -> "Class"
        name.contains("Method") || name.contains("Function") || name.contains("Fun") -> "Method"
        name.contains("Field") -> "Field"
        name.contains("Property") -> "Property"
        name.contains("Variable") || name.contains("Parameter") -> "Variable"
        name.contains("Package") -> "Module"
        name.contains("Import") -> "Module"
        else -> "Object"
    }
}

private fun resolveElement(
    filePath: String,
    line1: Int,
    col1: Int,
    project: Project
): PsiElement? {
    return ReadAction.compute<PsiElement?, Exception> {
        val vf = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return@compute null
        val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@compute null
        val psiFile = PsiManager.getInstance(project).findFile(vf) ?: return@compute null
        val line0 = (line1 - 1).coerceAtLeast(0)
        val col0 = (col1 - 1).coerceAtLeast(0)
        val lineStart = doc.getLineStartOffset(line0.coerceIn(0, doc.lineCount - 1))
        val offset = (lineStart + col0).coerceIn(0, doc.textLength)
        psiFile.findElementAt(offset)
    }
}

private fun stripHtml(html: String): String =
    html.replace(Regex("<[^>]+>"), "").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&amp;", "&").replace("&nbsp;", " ").replace("&#39;", "'")
        .replace(Regex("\\s+"), " ").trim()

// ---------------------------------------------------------------------------
// 1. GoToDefinitionHandler
// ---------------------------------------------------------------------------

class GoToDefinitionHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonNull.INSTANCE
        val file = params?.get("file")?.asString ?: return JsonNull.INSTANCE
        val line = params.get("line")?.asInt ?: return JsonNull.INSTANCE
        val col = params.get("column")?.asInt ?: return JsonNull.INSTANCE

        val leaf = resolveElement(file, line, col, project) ?: return JsonNull.INSTANCE

        val targets = ReadAction.compute<List<PsiElement>, Exception> {
            val refs = leaf.references.ifEmpty {
                leaf.parent?.references ?: emptyArray()
            }
            refs.mapNotNull { it.resolve()?.navigationElement }
                .ifEmpty {
                    // fallback: try PsiTreeUtil walk up for a reference
                    var el: PsiElement? = leaf
                    val found = mutableListOf<PsiElement>()
                    while (el != null && found.isEmpty()) {
                        el.references.mapNotNullTo(found) { it.resolve()?.navigationElement }
                        el = el.parent
                    }
                    found
                }
        }

        if (targets.isEmpty()) return JsonNull.INSTANCE

        val arr = JsonArray()
        ReadAction.compute<Unit, Exception> {
            targets.forEach { t -> elementLocation(t)?.let { arr.add(it) } }
        }
        return if (arr.size() == 0) JsonNull.INSTANCE else arr
    }
}

// ---------------------------------------------------------------------------
// 2. FindReferencesHandler
// ---------------------------------------------------------------------------

class FindReferencesHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val empty = JsonObject().apply {
            add("references", JsonArray())
            addProperty("count", 0)
        }
        if (project == null) return empty
        val file = params?.get("file")?.asString ?: return empty
        val line = params.get("line")?.asInt ?: return empty
        val col = params.get("column")?.asInt ?: return empty

        val leaf = resolveElement(file, line, col, project) ?: return empty

        // Resolve to the named element if possible
        val target = ReadAction.compute<PsiElement, Exception> {
            leaf.references.firstOrNull()?.resolve() ?: leaf.parent ?: leaf
        }

        val refs = ReadAction.compute<Collection<com.intellij.psi.PsiReference>, Exception> {
            ReferencesSearch.search(target, GlobalSearchScope.projectScope(project)).findAll()
        }

        val arr = JsonArray()
        ReadAction.compute<Unit, Exception> {
            for (ref in refs) {
                val refEl = ref.element
                val vf = refEl.containingFile?.virtualFile ?: continue
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: continue
                val absRange = ref.absoluteRange
                val s = offsetToLocation(absRange.startOffset, doc)
                val e = offsetToLocation(absRange.endOffset, doc)
                arr.add(JsonObject().apply {
                    addProperty("file", vf.path)
                    addProperty("line", s.get("line").asInt)
                    addProperty("column", s.get("column").asInt)
                    addProperty("endLine", e.get("line").asInt)
                    addProperty("endColumn", e.get("column").asInt)
                })
            }
        }

        return JsonObject().apply {
            add("references", arr)
            addProperty("count", arr.size())
        }
    }
}

// ---------------------------------------------------------------------------
// 3. FindImplementationsHandler
// ---------------------------------------------------------------------------

class FindImplementationsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonNull.INSTANCE
        val file = params?.get("file")?.asString ?: return JsonNull.INSTANCE
        val line = params.get("line")?.asInt ?: return JsonNull.INSTANCE
        val col = params.get("column")?.asInt ?: return JsonNull.INSTANCE

        val leaf = resolveElement(file, line, col, project) ?: return JsonNull.INSTANCE
        val target = ReadAction.compute<PsiElement, Exception> {
            leaf.references.firstOrNull()?.resolve() ?: leaf.parent ?: leaf
        }

        // Use DefinitionsScopedSearch for cross-language impl search
        val impls = try {
            ReadAction.compute<Collection<PsiElement>, Exception> {
                com.intellij.psi.search.searches.DefinitionsScopedSearch
                    .search(target, GlobalSearchScope.projectScope(project)).findAll()
            }
        } catch (_: Exception) {
            emptyList()
        }

        val arr = JsonArray()
        ReadAction.compute<Unit, Exception> {
            impls.forEach { el -> elementLocation(el)?.let { arr.add(it) } }
        }

        return JsonObject().apply {
            addProperty("found", arr.size() > 0)
            add("implementations", arr)
            addProperty("count", arr.size())
        }
    }
}

// ---------------------------------------------------------------------------
// 4. GoToTypeDefinitionHandler
// ---------------------------------------------------------------------------

class GoToTypeDefinitionHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonNull.INSTANCE
        val file = params?.get("file")?.asString ?: return JsonNull.INSTANCE
        val line = params.get("line")?.asInt ?: return JsonNull.INSTANCE
        val col = params.get("column")?.asInt ?: return JsonNull.INSTANCE

        val leaf = resolveElement(file, line, col, project) ?: return JsonNull.INSTANCE

        // Try to get the type via PsiType for Java; fall back to definition navigation
        val typeTarget: PsiElement? = ReadAction.compute<PsiElement?, Exception> {
            try {
                // Try Java PsiExpression type via reflection to avoid hard dependency on java plugin
                val expr = PsiTreeUtil.getParentOfType(leaf, com.intellij.psi.PsiElement::class.java)
                val typeMethod = expr?.javaClass?.getMethod("getType")
                val psiType = typeMethod?.invoke(expr)
                val resolveMethod = psiType?.javaClass?.getMethod("resolve")
                val resolved = resolveMethod?.invoke(psiType) as? PsiElement
                resolved?.navigationElement
                    ?: leaf.references.firstOrNull()?.resolve()?.navigationElement
            } catch (_: Exception) {
                leaf.references.firstOrNull()?.resolve()?.navigationElement
            }
        }

        if (typeTarget == null) return JsonNull.INSTANCE

        val loc = ReadAction.compute<JsonObject?, Exception> { elementLocation(typeTarget) }
            ?: return JsonNull.INSTANCE

        return JsonObject().apply {
            addProperty("found", true)
            add("locations", JsonArray().apply { add(loc) })
        }
    }
}

// ---------------------------------------------------------------------------
// 5. GoToDeclarationHandler
// ---------------------------------------------------------------------------

class GoToDeclarationHandler : BridgeHandler {
    private val defHandler = GoToDefinitionHandler()
    override fun handle(params: JsonObject?, project: Project?): JsonElement =
        defHandler.handle(params, project)
}

// ---------------------------------------------------------------------------
// 6. GetHoverHandler
// ---------------------------------------------------------------------------

class GetHoverHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonNull.INSTANCE
        val file = params?.get("file")?.asString ?: return JsonNull.INSTANCE
        val line = params.get("line")?.asInt ?: return JsonNull.INSTANCE
        val col = params.get("column")?.asInt ?: return JsonNull.INSTANCE

        val leaf = resolveElement(file, line, col, project) ?: return JsonNull.INSTANCE

        val docHtml = ReadAction.compute<String?, Exception> {
            try {
                val mgr = Class.forName("com.intellij.lang.documentation.DocumentationManager")
                    .getMethod("getInstance", Project::class.java)
                    .invoke(null, project)
                mgr?.javaClass?.getMethod("generateDocumentation", PsiElement::class.java, PsiElement::class.java, Boolean::class.java)
                    ?.invoke(mgr, leaf, null, false) as? String
            } catch (_: Exception) { null }
        } ?: return JsonNull.INSTANCE

        val text = stripHtml(docHtml)
        if (text.isBlank()) return JsonNull.INSTANCE

        val range = ReadAction.compute<JsonObject?, Exception> {
            val vf = leaf.containingFile?.virtualFile ?: return@compute null
            val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@compute null
            val r = leaf.textRange ?: return@compute null
            rangeToJson(r.startOffset, r.endOffset, doc)
        }

        val contents = JsonArray().apply { add(text) }
        return JsonObject().apply {
            add("contents", contents)
            if (range != null) add("range", range)
        }
    }
}

// ---------------------------------------------------------------------------
// 7. GetCodeActionsHandler — stub (requires open editor)
// ---------------------------------------------------------------------------

class GetCodeActionsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement =
        JsonObject().apply { add("actions", JsonArray()) }
}

// ---------------------------------------------------------------------------
// 8. ApplyCodeActionHandler — stub
// ---------------------------------------------------------------------------

class ApplyCodeActionHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement =
        JsonObject().apply {
            addProperty("applied", false)
            addProperty("error", "Code actions require an open editor in IntelliJ")
        }
}

// ---------------------------------------------------------------------------
// 9. PreviewCodeActionHandler — stub
// ---------------------------------------------------------------------------

class PreviewCodeActionHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement =
        JsonObject().apply {
            addProperty("error", "Code action preview requires an open editor in IntelliJ")
        }
}

// ---------------------------------------------------------------------------
// 10. RenameSymbolHandler
// ---------------------------------------------------------------------------

class RenameSymbolHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val fail = { msg: String ->
            JsonObject().apply {
                addProperty("success", false)
                addProperty("error", msg)
            }
        }
        if (project == null) return fail("No project open")
        val file = params?.get("file")?.asString ?: return fail("missing file")
        val line = params.get("line")?.asInt ?: return fail("missing line")
        val col = params.get("column")?.asInt ?: return fail("missing column")
        val newName = params.get("newName")?.asString?.takeIf { it.isNotBlank() }
            ?: return fail("missing newName")

        val leaf = resolveElement(file, line, col, project) ?: return fail("Element not found")
        val target = ReadAction.compute<PsiElement?, Exception> {
            leaf.references.firstOrNull()?.resolve() ?: (leaf as? PsiNamedElement) ?: leaf.parent
        } ?: return fail("Cannot resolve rename target")

        // Find usages first (read action), then apply (EDT write)
        var applyError: String? = null
        val affectedMap = mutableMapOf<String, Int>()

        ApplicationManager.getApplication().invokeAndWait {
            try {
                val processor = RenameProcessor(project, target, newName, false, false)
                val usages = processor.findUsages()
                // Count by file
                for (usage in usages) {
                    val path = usage.virtualFile?.path ?: continue
                    affectedMap[path] = (affectedMap[path] ?: 0) + 1
                }
                processor.executeEx(usages)
            } catch (e: Exception) {
                applyError = e.message ?: "Rename failed"
            }
        }

        applyError?.let { return JsonObject().apply { addProperty("success", false); addProperty("error", it) } }

        val filesArr = JsonArray()
        affectedMap.forEach { (path, count) ->
            filesArr.add(JsonObject().apply {
                addProperty("file", path)
                addProperty("editCount", count)
            })
        }

        return JsonObject().apply {
            addProperty("success", true)
            addProperty("newName", newName)
            add("affectedFiles", filesArr)
            addProperty("totalEdits", affectedMap.values.sum())
        }
    }
}

// ---------------------------------------------------------------------------
// 11. SearchSymbolsHandler
// ---------------------------------------------------------------------------

class SearchSymbolsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val empty = JsonObject().apply {
            add("symbols", JsonArray())
            addProperty("count", 0)
            addProperty("truncated", false)
        }
        if (project == null) return empty
        val query = params?.get("query")?.asString?.takeIf { it.isNotBlank() } ?: return empty
        val maxResults = (params.get("maxResults")?.asInt ?: 50).coerceIn(1, 200)

        val symbols = JsonArray()
        var truncated = false

        // Use FilenameIndex to scan project files, then walk PSI for named elements matching query
        ReadAction.compute<Unit, Exception> {
            val scope = GlobalSearchScope.projectScope(project)
            val queryLower = query.lowercase()
            val psiManager = PsiManager.getInstance(project)

            val allFiles = com.intellij.psi.search.FilenameIndex
                .getAllFilesByExt(project, "kt", scope).toMutableList<com.intellij.openapi.vfs.VirtualFile>()
            allFiles += com.intellij.psi.search.FilenameIndex.getAllFilesByExt(project, "java", scope)

            for (vf in allFiles) {
                if (truncated) break
                val psiFile = psiManager.findFile(vf) ?: continue
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: continue
                psiFile.accept(object : PsiRecursiveElementVisitor() {
                    override fun visitElement(element: PsiElement) {
                        if (symbols.size() >= maxResults) { truncated = true; return }
                        if (element is PsiNamedElement) {
                            val eName = element.name ?: return super.visitElement(element)
                            if (eName.lowercase().contains(queryLower)) {
                                val range = element.textRange
                                if (range != null) {
                                    val s = offsetToLocation(range.startOffset, doc)
                                    val kind: String = elementKind(element)
                                    symbols.add(JsonObject().apply {
                                        addProperty("name", eName)
                                        addProperty("kind", kind)
                                        addProperty("file", vf.path)
                                        addProperty("line", s.get("line").asInt)
                                        addProperty("column", s.get("column").asInt)
                                        addProperty("containerName", "")
                                    })
                                }
                            }
                        }
                        super.visitElement(element)
                    }
                })
            }
        }

        return JsonObject().apply {
            add("symbols", symbols)
            addProperty("count", symbols.size())
            addProperty("truncated", truncated)
        }
    }
}

// ---------------------------------------------------------------------------
// 12. GetDocumentSymbolsHandler
// ---------------------------------------------------------------------------

class GetDocumentSymbolsHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val empty = JsonObject().apply {
            add("symbols", JsonArray())
            addProperty("count", 0)
        }
        if (project == null) return empty
        val file = params?.get("file")?.asString ?: return empty

        val symbols = JsonArray()

        ReadAction.compute<Unit, Exception> {
            val vf = LocalFileSystem.getInstance().findFileByPath(file) ?: return@compute
            val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@compute
            val psiFile = PsiManager.getInstance(project).findFile(vf) ?: return@compute

            psiFile.accept(object : PsiRecursiveElementVisitor() {
                override fun visitElement(element: PsiElement) {
                    if (element is PsiNamedElement) {
                        val name = element.name
                        if (!name.isNullOrBlank()) {
                            val range = element.textRange
                            val navRange = element.navigationElement.textRange ?: range
                            if (range != null) {
                                val s = offsetToLocation(range.startOffset, doc)
                                val e = offsetToLocation(range.endOffset, doc)
                                val sel = offsetToLocation(navRange.startOffset, doc)
                                symbols.add(JsonObject().apply {
                                    addProperty("name", name)
                                    addProperty("kind", elementKind(element))
                                    addProperty("line", s.get("line").asInt)
                                    addProperty("column", s.get("column").asInt)
                                    addProperty("endLine", e.get("line").asInt)
                                    addProperty("endColumn", e.get("column").asInt)
                                    addProperty("selectionLine", sel.get("line").asInt)
                                    addProperty("selectionColumn", sel.get("column").asInt)
                                })
                            }
                        }
                    }
                    super.visitElement(element)
                }
            })
        }

        return JsonObject().apply {
            add("symbols", symbols)
            addProperty("count", symbols.size())
        }
    }
}

// ---------------------------------------------------------------------------
// 13. GetCallHierarchyHandler
// ---------------------------------------------------------------------------

class GetCallHierarchyHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonNull.INSTANCE
        val file = params?.get("file")?.asString ?: return JsonNull.INSTANCE
        val line = params.get("line")?.asInt ?: return JsonNull.INSTANCE
        val col = params.get("column")?.asInt ?: return JsonNull.INSTANCE
        val direction = params.get("direction")?.asString ?: "both"
        val maxResults = (params.get("maxResults")?.asInt ?: 20).coerceIn(1, 100)

        val leaf = resolveElement(file, line, col, project) ?: return JsonNull.INSTANCE
        val target = ReadAction.compute<PsiElement, Exception> {
            leaf.references.firstOrNull()?.resolve() ?: leaf.parent ?: leaf
        }

        val symbolInfo = ReadAction.compute<JsonObject, Exception> {
            JsonObject().apply {
                addProperty("name", (target as? PsiNamedElement)?.name ?: "unknown")
                addProperty("kind", elementKind(target))
                addProperty("file", target.containingFile?.virtualFile?.path ?: file)
                val loc = elementLocation(target)
                addProperty("line", loc?.get("line")?.asInt ?: line)
                addProperty("column", loc?.get("column")?.asInt ?: col)
            }
        }

        val result = JsonObject().apply { add("symbol", symbolInfo) }

        if (direction == "incoming" || direction == "both") {
            val incoming = JsonArray()
            ReadAction.compute<Unit, Exception> {
                try {
                    val refs = ReferencesSearch.search(target, GlobalSearchScope.projectScope(project)).findAll()
                    var count = 0
                    for (ref in refs) {
                        if (count >= maxResults) break
                        val caller = ref.element.parent ?: ref.element
                        val loc = elementLocation(caller) ?: continue
                        incoming.add(JsonObject().apply {
                            addProperty("name", (caller as? PsiNamedElement)?.name ?: "caller")
                            addProperty("kind", elementKind(caller))
                            add("location", loc)
                        })
                        count++
                    }
                } catch (_: Exception) {}
            }
            result.add("incoming", incoming)
        }

        if (direction == "outgoing" || direction == "both") {
            val outgoing = JsonArray()
            ReadAction.compute<Unit, Exception> {
                try {
                    var count = 0
                    target.accept(object : PsiRecursiveElementVisitor() {
                        override fun visitElement(element: PsiElement) {
                            if (count >= maxResults) return
                            val refs = element.references
                            if (refs.isNotEmpty() && element !is PsiFile) {
                                val resolved = refs.firstOrNull()?.resolve()
                                if (resolved != null && resolved != target) {
                                    val loc = elementLocation(resolved)
                                    if (loc != null) {
                                        outgoing.add(JsonObject().apply {
                                            addProperty("name", (resolved as? PsiNamedElement)?.name ?: "callee")
                                            addProperty("kind", elementKind(resolved))
                                            add("location", loc)
                                        })
                                        count++
                                    }
                                }
                            }
                            super.visitElement(element)
                        }
                    })
                } catch (_: Exception) {}
            }
            result.add("outgoing", outgoing)
        }

        return result
    }
}

// ---------------------------------------------------------------------------
// 14. PrepareRenameHandler
// ---------------------------------------------------------------------------

class PrepareRenameHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("canRename", false)
            addProperty("reason", "No project open")
        }
        val file = params?.get("file")?.asString ?: return JsonObject().apply {
            addProperty("canRename", false); addProperty("reason", "missing file")
        }
        val line = params.get("line")?.asInt ?: return JsonObject().apply {
            addProperty("canRename", false); addProperty("reason", "missing line")
        }
        val col = params.get("column")?.asInt ?: return JsonObject().apply {
            addProperty("canRename", false); addProperty("reason", "missing column")
        }

        val leaf = resolveElement(file, line, col, project)
            ?: return JsonObject().apply { addProperty("canRename", false); addProperty("reason", "Element not found") }

        return ReadAction.compute<JsonObject, Exception> {
            val named = leaf as? PsiNamedElement ?: leaf.parent as? PsiNamedElement
            if (named?.name == null) {
                JsonObject().apply {
                    addProperty("canRename", false)
                    addProperty("reason", "Element is not renameable")
                }
            } else {
                val vf = leaf.containingFile?.virtualFile
                val doc = vf?.let { FileDocumentManager.getInstance().getDocument(it) }
                val range = leaf.textRange
                val rangeObj = if (doc != null && range != null) rangeToJson(range.startOffset, range.endOffset, doc) else null
                JsonObject().apply {
                    addProperty("canRename", true)
                    addProperty("placeholder", named.name!!)
                    if (rangeObj != null) add("range", rangeObj)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 15. FormatRangeHandler
// ---------------------------------------------------------------------------

class FormatRangeHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        if (project == null) return JsonObject().apply {
            addProperty("formatted", false); addProperty("reason", "No project open")
        }
        val file = params?.get("file")?.asString ?: return JsonObject().apply {
            addProperty("formatted", false); addProperty("reason", "missing file")
        }
        val startLine1 = params.get("startLine")?.asInt ?: return JsonObject().apply {
            addProperty("formatted", false); addProperty("reason", "missing startLine")
        }
        val endLine1 = params.get("endLine")?.asInt ?: return JsonObject().apply {
            addProperty("formatted", false); addProperty("reason", "missing endLine")
        }

        val vf = LocalFileSystem.getInstance().findFileByPath(file) ?: return JsonObject().apply {
            addProperty("formatted", false); addProperty("reason", "File not found")
        }

        var result: JsonObject? = null
        ApplicationManager.getApplication().invokeAndWait {
            ApplicationManager.getApplication().runWriteAction {
                try {
                    val doc = FileDocumentManager.getInstance().getDocument(vf) ?: run {
                        result = JsonObject().apply { addProperty("formatted", false); addProperty("reason", "Cannot load document") }
                        return@runWriteAction
                    }
                    val psiFile = PsiManager.getInstance(project).findFile(vf) ?: run {
                        result = JsonObject().apply { addProperty("formatted", false); addProperty("reason", "Cannot load PSI file") }
                        return@runWriteAction
                    }
                    val line0s = (startLine1 - 1).coerceIn(0, doc.lineCount - 1)
                    val line0e = (endLine1 - 1).coerceIn(0, doc.lineCount - 1)
                    val startOffset = doc.getLineStartOffset(line0s)
                    val endOffset = doc.getLineEndOffset(line0e)
                    com.intellij.psi.codeStyle.CodeStyleManager.getInstance(project)
                        .reformatRange(psiFile, startOffset, endOffset)
                    result = JsonObject().apply {
                        addProperty("formatted", true)
                        addProperty("editCount", line0e - line0s + 1)
                    }
                } catch (e: Exception) {
                    result = JsonObject().apply { addProperty("formatted", false); addProperty("reason", e.message ?: "Format failed") }
                }
            }
        }

        return result ?: JsonObject().apply { addProperty("formatted", false); addProperty("reason", "Unknown error") }
    }
}

// ---------------------------------------------------------------------------
// 16. SignatureHelpHandler — stub (requires open editor)
// ---------------------------------------------------------------------------

class SignatureHelpHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement = JsonNull.INSTANCE
}

// ---------------------------------------------------------------------------
// 17. FoldingRangesHandler
// ---------------------------------------------------------------------------

class FoldingRangesHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val empty = JsonObject().apply { add("ranges", JsonArray()) }
        if (project == null) return empty
        val file = params?.get("file")?.asString ?: return empty

        val ranges = JsonArray()

        ReadAction.compute<Unit, Exception> {
            try {
                val vf = LocalFileSystem.getInstance().findFileByPath(file) ?: return@compute
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@compute
                val psiFile = PsiManager.getInstance(project).findFile(vf) ?: return@compute
                val language = psiFile.language
                val builders = LanguageFolding.INSTANCE.allForLanguage(language)
                val astNode = psiFile.node ?: return@compute

                for (builder in builders) {
                    val descriptors = try {
                        builder.buildFoldRegions(astNode, doc)
                    } catch (_: Exception) { continue }

                    for (desc in descriptors) {
                        val r = desc.range
                        val startLine1 = doc.getLineNumber(r.startOffset.coerceIn(0, doc.textLength)) + 1
                        val endLine1 = doc.getLineNumber(r.endOffset.coerceIn(0, doc.textLength)) + 1
                        if (endLine1 <= startLine1) continue
                        val psi = desc.element.psi
                        val kind = when {
                            psi?.javaClass?.simpleName?.contains("Comment") == true -> "comment"
                            psi?.javaClass?.simpleName?.contains("Import") == true -> "imports"
                            else -> null
                        }
                        ranges.add(JsonObject().apply {
                            addProperty("startLine", startLine1)
                            addProperty("endLine", endLine1)
                            if (kind != null) addProperty("kind", kind)
                        })
                    }
                }
            } catch (_: Exception) {}
        }

        return JsonObject().apply { add("ranges", ranges) }
    }
}

// ---------------------------------------------------------------------------
// 18. SelectionRangesHandler
// ---------------------------------------------------------------------------

class SelectionRangesHandler : BridgeHandler {
    override fun handle(params: JsonObject?, project: Project?): JsonElement {
        val empty = JsonObject().apply { add("ranges", JsonArray()) }
        if (project == null) return empty
        val file = params?.get("file")?.asString ?: return empty
        val line = params.get("line")?.asInt ?: return empty
        val col = params.get("column")?.asInt ?: return empty

        val ranges = JsonArray()

        ReadAction.compute<Unit, Exception> {
            val vf = LocalFileSystem.getInstance().findFileByPath(file) ?: return@compute
            val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@compute
            val psiFile = PsiManager.getInstance(project).findFile(vf) ?: return@compute
            val line0 = (line - 1).coerceAtLeast(0)
            val col0 = (col - 1).coerceAtLeast(0)
            val lineStart = doc.getLineStartOffset(line0.coerceIn(0, doc.lineCount - 1))
            val offset = (lineStart + col0).coerceIn(0, doc.textLength)

            var element: PsiElement? = psiFile.findElementAt(offset)
            val seen = mutableSetOf<com.intellij.openapi.util.TextRange>()

            while (element != null) {
                val r = element.textRange
                if (r != null && seen.add(r)) {
                    val s = offsetToLocation(r.startOffset, doc)
                    val e = offsetToLocation(r.endOffset, doc)
                    ranges.add(JsonObject().apply {
                        addProperty("startLine", s.get("line").asInt)
                        addProperty("startColumn", s.get("column").asInt)
                        addProperty("endLine", e.get("line").asInt)
                        addProperty("endColumn", e.get("column").asInt)
                    })
                }
                element = element.parent
            }
        }

        return JsonObject().apply { add("ranges", ranges) }
    }
}
