#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
NODE_BIN=""
if [ -x "$DIR/runtime/node/bin/node" ]; then
  NODE_BIN="$DIR/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "[Threadline Studio] Node.js not found. Download the portable release or install Node.js 26.8+."
  exit 1
fi
exec "$NODE_BIN" scripts/launch.mjs --open
