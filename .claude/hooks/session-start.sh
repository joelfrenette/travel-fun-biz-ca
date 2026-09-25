#!/bin/bash
# SessionStart hook for Claude Code on the web: install project dependencies and the rtk CLI.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
pnpm install --prefer-offline

# rtk (token-saving command output filter). GitHub release downloads are blocked by the
# environment's network policy, so build from source; the container is cached after the hook,
# so this only pays the ~3.5 minute compile once.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
if ! command -v rtk >/dev/null 2>&1; then
  if command -v cargo >/dev/null 2>&1; then
    cargo install --git https://github.com/rtk-ai/rtk rtk --locked || echo "rtk build failed; continuing without it"
  else
    echo "cargo not available; skipping rtk install"
  fi
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

if command -v rtk >/dev/null 2>&1; then
  echo "rtk ready: $(rtk --version)"
fi
