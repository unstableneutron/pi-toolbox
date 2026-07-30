#!/bin/sh
# Compatibility wrapper — launches go through extensions/shared/native-pi-launcher.sh.
exec /bin/sh "$(CDPATH= cd -- "$(dirname "$0")/../shared" && pwd)/native-pi-launcher.sh" "$@"
