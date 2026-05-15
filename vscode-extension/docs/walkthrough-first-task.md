## Run your first Claude task

The bridge exposes a queue for background Claude tasks: prompts you fire-and-forget while continuing other work. They show up in the Analytics panel and notify on completion.

### Two ways to start one

**From the sidebar:** click **+ New Task** in the Claude panel, type your prompt, hit Enter.

**From the CLI:**

```bash
claude-ide-bridge start-task "explain the architecture of src/bridge.ts"
```

### Preset tasks

For common workflows, use a preset instead of typing the prompt every time:

```bash
claude-ide-bridge quick-task explainCode    # uses the active editor
claude-ide-bridge quick-task fixErrors      # acts on current diagnostics
claude-ide-bridge quick-task addTests       # generates tests for active file
```

`claude-ide-bridge quick-task --help` lists all presets (`fixErrors`, `refactorFile`, `addTests`, `explainCode`, `optimizePerf`, `runTests`, `resumeLastCancelled`).

### Where the output goes

- Streaming text shows in the **Output → Claude IDE Bridge** channel
- Final answer is written to the Analytics panel
- If you want it in chat, switch to the regular Claude chat panel after the task completes and ask "what did that task return?"

Tasks are queued, not exclusive — fire multiple at once.
