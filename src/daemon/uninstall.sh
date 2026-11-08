#!/bin/sh
# Stops the daemon and removes boot autostart. Bindings in /var/lib/irbind are kept.
DIR="$(cd "$(dirname "$0")" && pwd)"
rm -f /var/lib/webosbrew/init.d/irbind
sh "$DIR/start.sh" stop
echo "irbindd stopped and autostart removed"
