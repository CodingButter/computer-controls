#!/bin/bash
# The cron entry point, kept as a shell script so the crontab line and the log
# path never had to change during the cutover.
#
# Everything it used to do inline now lives in scripts/factory_keeper/, where it
# can be tested. Rolling back is replacing this file with the original heredoc;
# nothing else moved.
#
# Install on the keeper host with:
#   ln -sf <repo>/scripts/factory-keeper.sh ~/bin/factory-keeper.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${FACTORY_KEEPER_PYTHON:-$REPO_ROOT/service/.venv/bin/python}"

if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
fi

cd "$REPO_ROOT/scripts"
exec "$PYTHON" -m factory_keeper.keeper "$@"
