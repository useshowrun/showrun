#!/usr/bin/env bash
#
# ShowRun installer — curl -fsSL https://raw.githubusercontent.com/useshowrun/showrun/main/install.sh | bash
#
# Installs ShowRun and its dependencies:
#   1. Node.js check (nvm-aware, requires >= 20)
#   2. npm install -g showrun
#   3. Camoufox browser (anti-detect Firefox)
#   4. Global config directory setup
#
# Idempotent — safe to re-run.

set -euo pipefail

# ── Formatting ───────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { printf "${BLUE}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
error() { printf "${RED}[error]${NC} %s\n" "$*" >&2; }
step()  { printf "\n${BOLD}==> %s${NC}\n" "$*"; }

# ── Platform check ───────────────────────────────────────────────────────────

step "Checking platform"

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *)
    error "Unsupported platform: $OS (ShowRun supports Linux and macOS)"
    exit 1
    ;;
esac
ok "Platform: $PLATFORM ($(uname -m))"

# Check for required system tools
MISSING_TOOLS=()
for tool in git curl; do
  if ! command -v "$tool" &>/dev/null; then
    MISSING_TOOLS+=("$tool")
  fi
done

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
  error "Missing required tools: ${MISSING_TOOLS[*]}"
  if [ "$PLATFORM" = "linux" ]; then
    info "Install with: sudo apt install ${MISSING_TOOLS[*]}  (Debian/Ubuntu)"
    info "         or: sudo dnf install ${MISSING_TOOLS[*]}  (Fedora)"
    info "         or: sudo pacman -S ${MISSING_TOOLS[*]}  (Arch)"
  else
    info "Install with: xcode-select --install  (includes git)"
    info "         or: brew install ${MISSING_TOOLS[*]}"
  fi
  exit 1
fi

# Check for build tools (needed for native modules like better-sqlite3)
HAS_BUILD_TOOLS=true
for tool in make gcc g++; do
  if ! command -v "$tool" &>/dev/null; then
    HAS_BUILD_TOOLS=false
    break
  fi
done

if [ "$HAS_BUILD_TOOLS" = false ]; then
  warn "Build tools (make, gcc, g++) not found — native modules may fail to compile"
  if [ "$PLATFORM" = "linux" ]; then
    info "Install with: sudo apt install build-essential  (Debian/Ubuntu)"
    info "         or: sudo dnf groupinstall 'Development Tools'  (Fedora)"
    info "         or: sudo pacman -S base-devel  (Arch)"
  else
    info "Install with: xcode-select --install"
  fi
  info "Continuing anyway — prebuilt binaries may be available..."
  echo ""
fi

# ── Node.js detection ────────────────────────────────────────────────────────

step "Checking Node.js"

REQUIRED_NODE_MAJOR=20
NODE_CMD=""

# Try nvm first
if [ -d "${NVM_DIR:-$HOME/.nvm}" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    info "Found nvm at $NVM_DIR"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"

    # Try to use an existing node >= 20
    if nvm use 24 --silent 2>/dev/null; then
      NODE_CMD="$(command -v node)"
    elif nvm use 22 --silent 2>/dev/null; then
      NODE_CMD="$(command -v node)"
    elif nvm use 20 --silent 2>/dev/null; then
      NODE_CMD="$(command -v node)"
    else
      info "No suitable Node.js version found via nvm, installing v24..."
      if nvm install 24; then
        nvm use 24 --silent
        NODE_CMD="$(command -v node)"
      else
        error "Failed to install Node.js v24 via nvm"
        exit 1
      fi
    fi
  fi
fi

# Fall back to node in PATH
if [ -z "$NODE_CMD" ] && command -v node &>/dev/null; then
  NODE_CMD="$(command -v node)"
fi

if [ -z "$NODE_CMD" ]; then
  error "Node.js not found"
  info "Install Node.js >= $REQUIRED_NODE_MAJOR from https://nodejs.org"
  info "  or via nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  exit 1
fi

# Check version
NODE_VERSION="$("$NODE_CMD" -v)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"

if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  error "Node.js $NODE_VERSION is too old (need >= v$REQUIRED_NODE_MAJOR)"
  info "Update Node.js: https://nodejs.org or use nvm"
  exit 1
fi

ok "Node.js $NODE_VERSION ($NODE_CMD)"

# ── npm check ────────────────────────────────────────────────────────────────

step "Checking npm"

if ! command -v npm &>/dev/null; then
  error "npm not found (should be bundled with Node.js)"
  exit 1
fi

NPM_VERSION="$(npm -v)"
ok "npm v$NPM_VERSION"

# ── Install ShowRun ──────────────────────────────────────────────────────────

step "Installing ShowRun"

if command -v showrun &>/dev/null; then
  CURRENT_VERSION="$(showrun --version 2>/dev/null || echo 'unknown')"
  info "ShowRun already installed ($CURRENT_VERSION), updating..."
fi

info "Running: npm install -g showrun"
npm install -g showrun

if ! command -v showrun &>/dev/null; then
  # npm global bin might not be in PATH
  NPM_GLOBAL_BIN="$(npm config get prefix)/bin"
  if [ -x "$NPM_GLOBAL_BIN/showrun" ]; then
    warn "showrun installed to $NPM_GLOBAL_BIN but it's not in your PATH"
    warn "Add this to your shell profile: export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
    # Use full path for the rest of the script
    SHOWRUN_CMD="$NPM_GLOBAL_BIN/showrun"
  else
    error "Installation failed — showrun not found after npm install"
    exit 1
  fi
else
  SHOWRUN_CMD="showrun"
fi

# Trigger the auto-build now (the wrapper builds on first run if dist is missing)
info "Running initial build (this may take a minute)..."
if "$SHOWRUN_CMD" --help >/dev/null 2>&1; then
  ok "ShowRun built and ready"
else
  warn "Initial build may have failed — try running: showrun --help"
fi

# ── Camoufox browser ─────────────────────────────────────────────────────────

step "Downloading Camoufox browser"

info "This may take a few minutes on first install..."
if npx camoufox-js fetch 2>/dev/null; then
  ok "Camoufox browser ready"
else
  warn "Camoufox download failed — ShowRun will fall back to Chromium"
  info "You can retry later with: npx camoufox-js fetch"
fi

# ── Config setup ─────────────────────────────────────────────────────────────

step "Setting up configuration"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/showrun"

if [ -f "$CONFIG_DIR/config.json" ]; then
  ok "Config already exists at $CONFIG_DIR/config.json"
else
  info "Creating global config..."
  if "$SHOWRUN_CMD" config init --global 2>/dev/null; then
    ok "Config created at $CONFIG_DIR"
  else
    # Fallback: create manually
    info "Creating config directory manually..."
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_DIR/config.json" << 'CONFIGEOF'
{
  "llm": {
    "provider": "anthropic",
    "anthropic": { "apiKey": "", "model": "", "baseUrl": "" },
    "openai": { "apiKey": "", "model": "", "baseUrl": "" }
  },
  "agent": {
    "maxBrowserRounds": 0,
    "debug": false,
    "transcriptLogging": false
  },
  "prompts": {
    "teachChatSystemPrompt": "",
    "explorationAgentPromptPath": ""
  }
}
CONFIGEOF
    ok "Config created at $CONFIG_DIR/config.json"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

step "Installation complete!"

echo ""
printf "${GREEN}${BOLD}ShowRun is ready.${NC}\n"
echo ""
echo "  Quick start:"
echo "    showrun dashboard --packs ./my-taskpacks    # Start web UI"
echo "    showrun run ./my-pack --inputs '{}'          # Run a task pack"
echo "    showrun config show                          # View configuration"
echo ""
echo "  Configure your LLM API key:"
echo "    Edit $CONFIG_DIR/config.json"
echo "    Set llm.anthropic.apiKey (or use ANTHROPIC_API_KEY env var)"
echo ""

# Check if showrun is reachable without full path
if ! command -v showrun &>/dev/null; then
  NPM_GLOBAL_BIN="$(npm config get prefix)/bin"
  warn "showrun is not in your PATH"
  echo ""

  SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
  case "$SHELL_NAME" in
    zsh)
      echo "  Add to ~/.zshrc:"
      echo "    export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
      ;;
    fish)
      echo "  Add to ~/.config/fish/config.fish:"
      echo "    set -gx PATH $NPM_GLOBAL_BIN \$PATH"
      ;;
    *)
      echo "  Add to ~/.bashrc:"
      echo "    export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
      ;;
  esac
  echo ""
  echo "  Then restart your shell or run: source ~/.<shell>rc"
fi
