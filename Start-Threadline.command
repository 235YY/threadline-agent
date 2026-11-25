#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
NODE_BIN=""
if [ -x "$DIR/runtime/node/bin/node" ]; then
  NODE_BIN="$DIR/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "[Threadline Studio] 未检测到 Node.js，请下载懒人便携版或安装 Node.js 26.8+。"
  echo "国内镜像：https://npmmirror.com/mirrors/node/latest-v26.x/"
  read -r -p "按回车键退出..."
  exit 1
fi
exec "$NODE_BIN" scripts/launch.mjs --open
