#!/bin/sh
# Start Dropbear as /data/nam/ssh/state says (written by the TMP NAM app):
#   enabled=1  run it; anything else (or no file) leaves SSH off
#   mode=key   public keys only, password logins disabled (-s)
#   mode=none  root login with a blank password (-B)
# Client keys are in /data/nam/ssh/authorized_keys (root's ~/.ssh/authorized_keys
# points there).
state=/data/nam/ssh/state
enabled=0
mode=key
if [ -f "$state" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      enabled) enabled=$value ;;
      mode) mode=$value ;;
    esac
  done < "$state"
fi
[ "$enabled" = 1 ] || exit 0
if [ "$mode" = none ]; then
  auth=-B
else
  auth=-s
fi
exec /data/nam/bin/dropbear -F -r /data/nam/ssh/ed25519 "$auth" -p 22 -P /data/nam/dropbear.pid
