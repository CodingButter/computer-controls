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

# Resolved through symlinks, because the documented install below is a symlink
# and `dirname "${BASH_SOURCE[0]}"` answers where the *link* lives. Installed as
# `~/bin/factory-keeper.sh -> <repo>/scripts/factory-keeper.sh`, the unresolved
# form makes REPO_ROOT `~`, and the keeper then looks for `~/scripts` and exits
# non-zero. Cron does not read exit codes out loud, so the failure looks exactly
# like a quiet fleet.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  # A relative link points relative to the directory holding the link.
  case "$SOURCE" in /*) ;; *) SOURCE="$LINK_DIR/$SOURCE" ;; esac
done
REPO_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
# The keeper imports nothing outside the standard library and reaches the
# database by shelling `docker exec`, so any python3 runs it. The repo's own
# interpreter is preferred when it exists — a keeper host that is also a
# checkout gets the version the tests ran against — and a bare python3 is a
# complete fallback rather than a degraded one.
#
# The path is `comcon/.venv`, and it was `service/.venv` until that directory
# was renamed. This line is why it is worth saying out loud: a rename inside the
# repo cannot break a caller that lives outside it, but it can absolutely break
# this file, which is the seam between the two.
PYTHON="${FACTORY_KEEPER_PYTHON:-$REPO_ROOT/comcon/.venv/bin/python}"

if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
fi

cd "$REPO_ROOT/scripts"
exec "$PYTHON" -m factory_keeper.keeper "$@"
