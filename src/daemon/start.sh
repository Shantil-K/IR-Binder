#!/bin/sh
# Start (or restart with "restart", or stop with "stop") the IR Binder daemon.
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE=/tmp/irbindd.pid
LOG=/tmp/irbindd.log

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  case "$1" in
    restart|stop) kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; sleep 1 ;;
    *) echo "irbindd already running"; exit 0 ;;
  esac
fi
[ "$1" = "stop" ] && exit 0

NODE="$(command -v node 2>/dev/null)"
[ -z "$NODE" ] && [ -x /usr/bin/node ] && NODE=/usr/bin/node
[ -z "$NODE" ] && { echo "node not found" >&2; exit 1; }

# Keep the log small.
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ] && mv "$LOG" "$LOG.old"

UV_THREADPOOL_SIZE=64 nohup "$NODE" "$DIR/irbindd.js" >>"$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "irbindd started (pid $!)"
