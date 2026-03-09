# Deployment

## Docker

Build and run the bridge server in a container:

```bash
docker build -t claude-ide-bridge .
docker run -d \
  --name claude-ide-bridge \
  -p 127.0.0.1:18765:18765 \
  -v "$HOME/.claude:/data/claude" \
  -v "$PWD:/workspace:ro" \
  claude-ide-bridge
```

The bridge binds to `0.0.0.0` inside the container; the host binding above
restricts access to loopback only. Mount your project as `/workspace`.

> **Note on workspace mount mode:** The `:ro` (read-only) flag above restricts
> write tools such as `createFile`, `editText`, and `replaceBlock` — they will
> fail with a permission error. Use a read-only mount when you only need
> browse/search access. For full tool access use a writable mount:
>
> ```bash
> # Read-write (full tool access):
> -v "$PWD:/workspace"
> # Read-only (browse/search only — write tools will fail):
> -v "$PWD:/workspace:ro"
> ```

## systemd (per-user template)

Copy the unit file and enable it for a specific user:

```bash
sudo cp claude-ide-bridge@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-ide-bridge@$USER
sudo systemctl status claude-ide-bridge@$USER
journalctl -u claude-ide-bridge@$USER -f
```

The unit uses `%i` (instance name) as the user and `%h` as their home directory.
Node must be in PATH for the service user or use the full path to node.

## Multi-workspace

Run one bridge instance per top-level repository. For monorepos, pass the
repo root as `--workspace` — the VS Code extension will report all workspace
folders automatically.
