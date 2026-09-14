#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install it first, then rerun this script." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  pnpm install
fi

echo "Starting 3D LabelMe at http://127.0.0.1:5173/"
exec pnpm run dev
