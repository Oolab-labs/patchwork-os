# claude-ide-bridge demo
Output demo.gif
Set FontSize 13
Set Width 780
Set Height 400
Set Theme "Dracula"
Set Padding 16
Set TypingSpeed 45ms
Set Framerate 20

# Clean prompt — no personal info
Type "export PS1='$ '"
Enter
Sleep 150ms

# Install
Type "npm install -g claude-ide-bridge"
Enter
Sleep 150ms
Type "# added 1 package in 3s"
Enter
Sleep 600ms

# Init
Type "claude-ide-bridge init"
Enter
Sleep 150ms
Type "# ✓ Extension installed  ✓ CLAUDE.md updated"
Enter
Sleep 150ms
Type "# ✓ Registered as global MCP server"
Enter
Sleep 600ms

# Start
Type "claude-ide-bridge --watch &"
Enter
Sleep 150ms
Type "# [bridge] listening on ws://127.0.0.1:47000"
Enter
Sleep 500ms

# Show tools
Type "# Claude now has live IDE context:"
Enter
Sleep 150ms
Type "# getDiagnostics → 0 errors"
Enter
Sleep 150ms
Type "# goToDefinition → src/activityLog.ts:44"
Enter
Sleep 150ms
Type "# runTests → 2211 passed"
Enter
Sleep 150ms
Type "# gitCommit → pushed to main"
Enter
Sleep 1200ms
