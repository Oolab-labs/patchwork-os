#!/usr/bin/env bash
# Install the claude-ide-bridge VS Code extension into a supported IDE.
#
# Usage:
#   bash scripts/install-extension.sh [--ide <ide>] [--build]
#
# Supported IDEs:
#   windsurf     Windsurf (default if detected)
#   cursor       Cursor
#   antigravity  Google Antigravity
#   code         VS Code
#
# Flags:
#   --ide <name>   Specify target IDE (auto-detects if omitted)
#   --build        Rebuild extension + VSIX before installing
#
# Example:
#   bash scripts/install-extension.sh --ide cursor
#   bash scripts/install-extension.sh --ide antigravity --build

set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VSIX_DIR="$BRIDGE_DIR/vscode-extension"
IDE=""
DO_BUILD=false

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ide)    IDE="$2"; shift 2 ;;
    --build)  DO_BUILD=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--ide <windsurf|cursor|antigravity|code>] [--build]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Auto-detect IDE if not specified ---
detect_ide() {
  for cmd in windsurf cursor antigravity ag code; do
    command -v "$cmd" >/dev/null 2>&1 && echo "$cmd" && return
  done
  echo ""
}

if [[ -z "$IDE" ]]; then
  IDE=$(detect_ide)
  if [[ -z "$IDE" ]]; then
    echo "Error: Could not auto-detect a supported IDE on PATH." >&2
    echo "Specify one with --ide <windsurf|cursor|antigravity|code>" >&2
    exit 1
  fi
  echo "Auto-detected IDE: $IDE"
fi

# Normalise alias
[[ "$IDE" == "ag" ]] && IDE="antigravity"

# --- Map IDE to its install CLI command ---
case "$IDE" in
  windsurf)    INSTALL_CMD="windsurf" ;;
  cursor)      INSTALL_CMD="cursor" ;;
  antigravity) INSTALL_CMD="antigravity" ;;
  code)        INSTALL_CMD="code" ;;
  *)
    echo "Error: Unsupported IDE '$IDE'. Use: windsurf | cursor | antigravity | code" >&2
    exit 1
    ;;
esac

# Verify the CLI is available
command -v "$INSTALL_CMD" >/dev/null 2>&1 || {
  echo "Error: '$INSTALL_CMD' not found on PATH." >&2
  echo "Make sure $IDE is installed and its CLI is on your PATH." >&2
  exit 1
}

# --- Build if requested ---
if $DO_BUILD; then
  echo "Building extension..."
  (cd "$VSIX_DIR" && npm run build && npm run package)
  echo ""
fi

# --- Find the VSIX ---
VSIX_COUNT=$(ls "$VSIX_DIR"/*.vsix 2>/dev/null | wc -l | tr -d ' ')
if [ "$VSIX_COUNT" -gt 1 ]; then
  echo "Warning: Found $VSIX_COUNT .vsix files — using newest. Run with --build to rebuild." >&2
fi
VSIX=$(ls -t "$VSIX_DIR"/*.vsix 2>/dev/null | head -1)
if [[ -z "$VSIX" ]]; then
  echo "Error: No .vsix file found in $VSIX_DIR" >&2
  echo "Run with --build to build it first, or: cd vscode-extension && npm run package" >&2
  exit 1
fi

echo "Installing $(basename "$VSIX") into $IDE..."
# --force reinstalls even if already installed (needed for upgrades)
"$INSTALL_CMD" --install-extension "$VSIX" --force

echo ""
echo "Done. To activate: restart your IDE, or open the Command Palette (Cmd+Shift+P on Mac / Ctrl+Shift+P on Windows/Linux) and run 'Developer: Reload Window'."
echo "The extension will auto-connect to any running bridge."
