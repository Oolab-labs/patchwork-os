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

3. **(Recommended) Pin the SSH target in `~/.ssh/config` first.** Using
   the public domain as the SSH target is fragile — DNS drifts during
   redeploys (CDN edges, transient IPs), so SSH lands on a different
   machine and the host key changes. Add an alias once and use it
   everywhere:

   ```ssh-config
   # ~/.ssh/config
   Host pw-bridge
       HostName 185.167.97.141       # your VPS IP — stable across DNS shifts
       User wesh                      # or root, whatever your VPS allows
       IdentityFile ~/.ssh/id_ed25519
       ServerAliveInterval 30
       ServerAliveCountMax 3
       UserKnownHostsFile ~/.ssh/known_hosts.patchwork
   ```

   Verify it works once: `ssh pw-bridge "echo ok"`. The host key is
   accepted into the dedicated `known_hosts.patchwork` file and stays
   there even if you `ssh-keygen -R` your global known_hosts later.

4. **Run the installer** with the alias (cleanest):
   ```bash
   VPS_HOST=pw-bridge bash deploy/macos/install-mac-bridge.sh
   ```
   The installer detects the alias via `ssh -G` and lets ssh_config
   own user + identity + hostname resolution. On a VPS rebuild, you
   only update `~/.ssh/config` — the LaunchAgents pick it up.

   Without an alias (interactive, prompts for VPS host):
   ```bash
   bash deploy/macos/install-mac-bridge.sh
   # → prompts; recommend the IP (185.167.97.141) over the domain
   ```
   Or fully env-driven:
   ```bash
   VPS_HOST=185.167.97.141 VPS_USER=root \
   BRIDGE_PORT=63906 VPS_PORT=3285 \
   bash deploy/macos/install-mac-bridge.sh
   ```

5. **Sync the bridge token to the VPS** (the installer prints the exact
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
- **`Host key for X has changed and you have requested strict
  checking`** every now and then — the SSH target is moving. Two
  causes:
  1. **DNS drift.** The public domain resolves to a different IP than
     it did last time (CDN edge, redeploy churn). `dig +short
     bridge.your.tld` vs your known VPS IP — if those differ, switch
     the `VPS_HOST` to the IP or a `~/.ssh/config` alias and re-run
     the installer.
  2. **VPS rebuild.** A reimage regenerates `/etc/ssh/ssh_host_*_key`
     files. Either back them up before the rebuild and restore after,
     or accept the new key once with `ssh-keygen -R <host> && ssh
     <host>`. The launchd tunnel uses `StrictHostKeyChecking=accept-new`
     (only auto-trusts on first connect, not after change), so you'll
     see the warning, accept the new key interactively once, and the
     tunnel resumes.
