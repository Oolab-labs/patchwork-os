---
name: ide-explore
description: Deep codebase exploration using IDE bridge LSP tools. Maps architecture, traces call chains, discovers entry points, and builds a mental model of unfamiliar code. Use when onboarding to a new codebase or understanding a module.
context: fork
agent: Explore
argument-hint: "[module, file, or question about the codebase]"
---

# IDE Codebase Explorer

Explore and explain a codebase using the IDE bridge's full LSP capabilities. Produces a structured architectural overview.

## Workflow

### Phase 1: Overview

1. Use `getProjectInfo` to understand the project type, languages, and frameworks
2. Use `getFileTree` with depth 3 to see the directory structure
3. Use `getToolCapabilities` to see what language tooling is available
4. Identify the focus area from the argument: `$ARGUMENTS`
   - If a specific file: explore that file and its connections
   - If a module/directory: explore the module's public API and internal structure
   - If a question: search for relevant code to answer it

### Phase 2: Entry points and architecture

5. Use `searchWorkspace` to find entry points (main, index, app.listen, export default, etc.)
6. Use `getDocumentSymbols` on key files to list classes, functions, and exports
7. For the focus area, use `getTypeHierarchy` on major classes to understand inheritance
8. Use `getCallHierarchy` (outgoing) on entry points to trace the startup flow

### Phase 3: Dependency mapping

9. For the focus area's main exports:
   - Use `findReferences` to see who depends on them
   - Use `goToDefinition` on imports to trace dependencies
   - Use `getHover` on key functions to read their type signatures
10. Use `searchWorkspaceSymbols` to find related types and interfaces
11. Build a dependency map: what depends on what

### Phase 4: Code intelligence deep-dive

12. Use `getInlayHints` on complex functions to see inferred types
13. Use `getCallHierarchy` (incoming) on critical functions to understand data flow
14. Use `getHover` on any unfamiliar types or functions
15. Check `getAIComments` for any developer notes or TODOs in the focus area

### Phase 5: Report

Produce a structured overview:

```
## Architecture Overview

### Project: [name] ([type])
Languages: [list]
Frameworks: [list]

### Module: [focus area]

#### Purpose
[One paragraph explaining what this module does]

#### Key Files
- file.ts — [role]
- ...

#### Public API
- functionName(args): ReturnType — [description]
- ...

#### Internal Structure
[ASCII diagram showing relationships between key components]

#### Dependencies
- Depends on: [list of modules this imports from]
- Used by: [list of modules that import from this]

#### Call Flow
[Step-by-step trace of a typical operation through this module]

#### Notable Patterns
- [Pattern 1: description]
- ...

#### AI Comments / TODOs
- [Any AI: directives found]
```

## Guidelines

- Use LSP tools (hover, definitions, references) as your primary source of truth — don't guess
- Include file paths and line numbers for all references
- Draw ASCII diagrams for complex relationships
- If the codebase is too large, focus on the requested area and note what was excluded
