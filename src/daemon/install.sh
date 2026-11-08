#!/bin/sh
# Installs boot autostart via Homebrew Channel's init.d and (re)starts the daemon.
# Run as root (the app does this through Homebrew Channel's exec service).
DIR="$(cd "$(dirname "$0")" && pwd)"
INITD=/var/lib/webosbrew/init.d

mkdir -p "$INITD" /var/lib/irbind
cat > "$INITD/irbind" <<EOF
#!/bin/sh
# IR Binder autostart (installed by com.anymote.irbind)
[ -f "$DIR/irbindd.js" ] || exit 0
sh "$DIR/start.sh"
EOF
chmod 755 "$INITD/irbind"

sh "$DIR/start.sh" restart
