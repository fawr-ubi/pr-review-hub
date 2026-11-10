#!/usr/bin/env bash
# ==============================================================================
# sync-queue.sh
# Cross-platform CLI entry point for PR Review Hub queue synchronization.
# Delegates to the zero-dependency Node.js engine (`ui/lib/sync.mjs`) so no `jq`
# or BSD-specific `date` flags are required on macOS or Linux.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec node "${SKILL_ROOT}/ui/lib/sync.mjs" "$@"
