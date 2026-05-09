# macOS launchd setup for the bridge

Make the local `claude-ide-bridge` and the SSH reverse tunnel to your
self-hosted dashboard persistent on your Mac:

- Auto-start at login
- Auto-restart on crash (bridge has its own `--watch` supervisor; launchd
  is the supervisor of the supervisor)
- Auto-reconnect on network change / sleep / wake (autossh)
- No tmux session to keep alive, no terminal to leave open

## One-time setup

1. **Install the patchwork CLI globally** (not via `npm link`). LaunchAgents
   run in a tighter sandbox; symlinked installs into `~/Documents` /
   `~/Desktop` / `~/Downloads` fail with `EPERM`:
   ```bash
   npm install -g patchwork-os
   # or, from a local repo:
   #   npm pack && npm install -g patchwork-os-*.tgz
   ```

2. **Make sure you can SSH to the VPS without a password prompt.** The
   tunnel runs unattended; if SSH would prompt for a key passphrase,
   add the key to your agent (`ssh-add ~/.ssh/id_ed25519`) or use a
   passphrase-less key.

3. **Run the installer** (interactive, prompts for VPS host):
   ```bash
   bash deploy/macos/install-mac-bridge.sh
   ```
   Or env-driven (idempotent re-install):
   ```bash
   VPS_HOST=bridge.your.tld VPS_USER=wesh \
   BRIDGE_PORT=63906 VPS_PORT=3285 \
   bash deploy/macos/install-mac-bridge.sh
   ```

4. **Sync the bridge token to the VPS** (the installer prints the exact
   `ssh … sed … pm2 restart` command — copy-paste).

## What runs after install

```
~/Library/LaunchAgents/com.patchwork.bridge.plist
~/Library/LaunchAgents/com.patchwork.tunnel.plist
```

Both are loaded into the per-user `gui/$UID` launchd domain at install
time and at every login.

```
[claude-ide-bridge --port 63906 --fixed-token <…> --watch]
        │
        │  127.0.0.1:63906
        ▼
[autossh -R 127.0.0.1:3285:localhost:63906]
        │
        │  encrypted SSH reverse tunnel
        ▼
VPS:3285 ──── nginx ──── dashboard `/api/bridge/*`
```

## Logs

```bash
tail -f ~/Library/Logs/patchwork-bridge.log
tail -f ~/Library/Logs/patchwork-tunnel.log
```

## Status

```bash
launchctl print gui/$UID/com.patchwork.bridge
launchctl print gui/$UID/com.patchwork.tunnel
```

## Restart manually

```bash
launchctl kickstart -k gui/$UID/com.patchwork.bridge
launchctl kickstart -k gui/$UID/com.patchwork.tunnel
```

## Uninstall

```bash
bash deploy/macos/uninstall-mac-bridge.sh
```

## Troubleshooting

- **`com.patchwork.bridge` exits with status 78 / `EPERM`** — the bridge
  CLI is installed via `npm link` and points into `~/Documents`. The
  macOS sandbox blocks LaunchAgents from reading that tree. Reinstall
  globally as a real package (see step 1).
- **`com.patchwork.tunnel` keeps respawning** — check the SSH key is
  added to `ssh-agent` (`ssh-add -l`). LaunchAgents run before the
  user's shell rc, so an interactive `ssh-add` from `.zshrc` doesn't
  apply. Use a passphrase-less key, or store the key in macOS Keychain
  with `ssh-add --apple-use-keychain`.
- **Tunnel succeeds but dashboard says offline** — VPS port already in
  use by an old leftover bridge. SSH to the VPS and `pkill -f "autossh\|sshd: .*\@notty"`,
  or pick a different `VPS_PORT`.
- **Dashboard 401s on every bridge call** — `PATCHWORK_BRIDGE_TOKEN`
  on the VPS doesn't match the `--fixed-token` value the bridge is
  using. Re-run the install script's printed `sed … pm2 restart`
  command.
