#!/bin/bash
# Agent Orchestrator setup script
# Installs dependencies, builds packages, and links the CLI globally

set -e  # Exit on error

echo "🤖 Agent Orchestrator Setup"
echo ""

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found. Installing pnpm..."
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    # macOS installs to ~/Library/pnpm, Linux to ~/.local/share/pnpm
    if [ -d "$HOME/Library/pnpm" ]; then
        export PNPM_HOME="$HOME/Library/pnpm"
    else
        export PNPM_HOME="$HOME/.local/share/pnpm"
    fi
    export PATH="$PNPM_HOME:$PATH"
fi

echo "📦 Installing dependencies..."
pnpm install

echo "🧹 Cleaning stale build artifacts..."
rm -rf packages/web/.next

echo "🔨 Building all packages..."
pnpm build

echo "🔗 Linking CLI globally..."
cd packages/cli
pnpm link --global
cd ../..

echo ""
echo "✅ Setup complete! The 'ao' command is now available."
echo ""
echo "Next steps:"
echo "  1. cd /path/to/your/project"
echo "  2. ao init --auto"
echo "  3. gh auth login"
echo "  4. ao start"
echo ""
