#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8767}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/server.py" "$PORT"
