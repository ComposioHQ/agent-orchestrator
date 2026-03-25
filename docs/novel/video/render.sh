#!/usr/bin/env bash
# render.sh — build and render Remotion compositions
#
# Usage:
#   bash render.sh                    # render both compositions
#   bash render.sh TheAwakening       # render only TheAwakening
#   bash render.sh ThePantheon        # render only ThePantheon
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSITION="${1:-all}"

render_composition() {
  local id="$1"
  local outfile="$2"
  echo ""
  echo "🎬  Rendering ${id}..."
  npx remotion render \
    src/index.ts \
    "${id}" \
    "out/${outfile}" \
    --codec=h264 \
    --fps=30 \
    --width=1920 \
    --height=1080 \
    --jpeg-quality=90 \
    --log=verbose
  echo "✅  ${id} → out/${outfile}"
}

echo "📦  Installing dependencies..."
npm install

mkdir -p out

case "$COMPOSITION" in
  TheAwakening)
    render_composition TheAwakening the-awakening.mp4
    ;;
  ThePantheon)
    render_composition ThePantheon the-pantheon.mp4
    ;;
  all|"")
    render_composition TheAwakening the-awakening.mp4
    render_composition ThePantheon  the-pantheon.mp4
    ;;
  *)
    echo "❌  Unknown composition: $COMPOSITION"
    echo "    Valid options: TheAwakening | ThePantheon | all"
    exit 1
    ;;
esac

echo ""
echo "🏁  All renders complete. Output in: out/"
