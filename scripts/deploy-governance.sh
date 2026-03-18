#!/usr/bin/env bash
# deploy-governance.sh — Deploy AO governance contracts to Base
#
# Prerequisites:
#   - foundry installed (forge, cast)
#   - DEPLOYER_PRIVATE_KEY set in environment
#   - BASE_RPC_URL set (defaults to https://mainnet.base.org)
#   - BASESCAN_API_KEY set (for contract verification)
#
# Usage:
#   ./scripts/deploy-governance.sh                  # Deploy + verify
#   ./scripts/deploy-governance.sh --dry-run        # Simulate only (no broadcast)
#   INITIAL_MAINTAINER=0x... ./scripts/deploy-governance.sh  # Custom maintainer

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Defaults
BASE_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run]"
      echo ""
      echo "Environment variables:"
      echo "  DEPLOYER_PRIVATE_KEY  (required) Private key for deployment"
      echo "  BASE_RPC_URL          RPC endpoint (default: https://mainnet.base.org)"
      echo "  BASESCAN_API_KEY      API key for contract verification on Basescan"
      echo "  INITIAL_MAINTAINER    Address of first maintainer (default: deployer)"
      echo "  CI_ATTESTER           Address authorized for CI attestations (default: deployer)"
      exit 0
      ;;
  esac
done

# Validate prerequisites
if ! command -v forge &>/dev/null; then
  echo "Error: forge not found. Install Foundry: https://getfoundry.sh"
  exit 1
fi

if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "Error: DEPLOYER_PRIVATE_KEY must be set"
  exit 1
fi

echo "=== AO Governance Deployment ==="
echo "Chain: Base (8453)"
echo "RPC:   $BASE_RPC_URL"
echo "Dry run: $DRY_RUN"
echo ""

# Install Solidity dependencies if needed
if [ ! -d "node_modules/@openzeppelin" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Build contracts
echo "Building contracts..."
forge build

# Run deployment
FORGE_ARGS=(
  script contracts/script/Deploy.s.sol:Deploy
  --rpc-url "$BASE_RPC_URL"
  -vvvv
)

if [ "$DRY_RUN" = false ]; then
  FORGE_ARGS+=(--broadcast)

  if [ -n "${BASESCAN_API_KEY:-}" ]; then
    FORGE_ARGS+=(--verify --etherscan-api-key "$BASESCAN_API_KEY")
  else
    echo "Warning: BASESCAN_API_KEY not set — skipping contract verification"
  fi
fi

echo ""
echo "Running: forge ${FORGE_ARGS[*]}"
echo ""

forge "${FORGE_ARGS[@]}"

if [ "$DRY_RUN" = false ]; then
  echo ""
  echo "Deployment complete."
  echo "Update governance.config.json with the contract addresses from the output above."
  echo ""
  echo "Next steps:"
  echo "  1. Copy contract addresses into governance.config.json"
  echo "  2. Commit governance.config.json with the addresses"
  echo "  3. Verify contracts on Basescan if not already verified"
fi
