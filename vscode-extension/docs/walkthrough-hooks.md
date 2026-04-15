## Configure an Automation Hook

Add this to your `automation-policy.json` to auto-fix errors when Claude detects diagnostics:

```json
{
  "onDiagnosticsError": {
    "enabled": true,
    "prompt": "Fix the TypeScript error in {{file}}: {{diagnostics}}",
    "cooldownMs": 30000
  }
}
```

Run `claude-ide-bridge init --workspace .` to create a starter policy file.

See the [full automation docs](https://github.com/Oolab-labs/claude-ide-bridge/blob/main/documents/automation.md) for all available hooks.
