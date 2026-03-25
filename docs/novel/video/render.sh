#!/usr/bin/env bash
# render.sh — build and render "The Awakening" as an MP4
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦  Installing dependencies..."
npm install

echo ""
echo "🎬  Rendering TheAwakening composition..."
mkdir -p out

npx remotion render \
  src/index.ts \
  TheAwakening \
  out/the-awakening.mp4 \
  --codec=h264 \
  --fps=30 \
  --width=1920 \
  --height=1080 \
  --jpeg-quality=90 \
  --log=verbose

echo ""
echo "✅  Render complete: out/the-awakening.mp4"
