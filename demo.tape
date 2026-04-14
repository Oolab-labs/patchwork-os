# claude-ide-bridge demo — all output is echoed, no real commands run
Output demo.gif
Set FontSize 13
Set Width 780
Set Height 400
Set Theme "Dracula"
Set Padding 16
Set TypingSpeed 45ms
Set Framerate 20

# Clean prompt
Type "export PS1='$ '"
Enter
Sleep 100ms

# Step 1: install
Type "npm install -g claude-ide-bridge"
Enter
Sleep 100ms
Type "echo 'added 1 package in 3s'"
Enter
Sleep 600ms

# Step 2: init — use : (no-op) so the command name appears but nothing runs
Type ": claude-ide-bridge init"
Enter
Sleep 100ms
Type "echo '✓ Extension installed'"
Enter
Sleep 100ms
Type "echo '✓ CLAUDE.md updated'"
Enter
Sleep 100ms
Type "echo '✓ Registered as global MCP server'"
Enter
Sleep 600ms

# Step 3: bridge start — same trick
Type ": claude-ide-bridge --watch"
Enter
Sleep 100ms
Type "echo '[bridge] listening on ws://127.0.0.1:47000'"
Enter
Sleep 500ms

# Step 4: tool calls Claude can now make
Type "echo 'getDiagnostics  → 0 errors, 2 warnings'"
Enter
Sleep 150ms
Type "echo 'goToDefinition  → src/activityLog.ts:44'"
Enter
Sleep 150ms
Type "echo 'runTests        → 2211 passed in 68s'"
Enter
Sleep 150ms
Type "echo 'gitCommit       → feat: add percentiles  [main abc1234]'"
Enter
Sleep 1200ms
