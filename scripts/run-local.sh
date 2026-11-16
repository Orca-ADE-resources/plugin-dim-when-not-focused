#!/usr/bin/env sh
# Push the current source into the running Orca (no plugin reinstall, no Orca restart).
#   scripts/run-local.sh            -> reapply (replace the running version)
#   scripts/run-local.sh toggle     -> any command of scripts/dim.mjs
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-reapply}"
[ $# -gt 0 ] && shift
exec node "$DIR/dim.mjs" "$CMD" "$@"
