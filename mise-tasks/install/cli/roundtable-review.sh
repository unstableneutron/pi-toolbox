#!/usr/bin/env bash
#MISE description="Link the repo-local roundtable-review CLI into ~/.local/bin for shell-wide use."
set -euo pipefail

node ./scripts/install-roundtable-review-bin.js "$@"
