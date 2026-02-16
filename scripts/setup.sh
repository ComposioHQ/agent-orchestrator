#!/bin/bash
# Agent Orchestrator setup script
# Installs dependencies, builds packages, and links the CLI globally

set -e  # Exit on error

echo "🤖 Agent Orchestrator Setup"
echo ""

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found. Installing pnpm..."
    npm install -g pnpm
fi

echo "📦 Installing dependencies..."
pnpm install

echo "🔨 Building all packages..."
pnpm build

echo "🔗 Linking CLI globally..."
cd packages/cli
npm link
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
