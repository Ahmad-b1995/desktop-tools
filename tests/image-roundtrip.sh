#!/bin/bash
# Regression test for Clip's image re-copy (the crash fixed in version 5).
#
# Starts a nested GNOME Shell in a window with CLIP_SELFTEST=1, copies an
# image into it, lets Clip re-copy that image the way choosing it in the
# popup does, then reads the clipboard back and compares checksums.
# A crash only takes down the nested window, never your session.
#
#   tests/image-roundtrip.sh path/to/image.png
#
# Needs: gnome-shell (with --devkit, package mutter-dev-bin), wl-clipboard,
# and the extension installed (./install.sh).
set -u
IMG=${1:?usage: $0 image.png}
[ -f "$IMG" ] || { echo "no such file: $IMG"; exit 2; }
LOG=$(mktemp --suffix=.clip-test.log)

# Own process group, so cleanup stops the nested shell and everything it started.
CLIP_SELFTEST=1 setsid dbus-run-session -- gnome-shell --devkit --wayland >"$LOG" 2>&1 &
SHELL_PID=$!
cleanup() { kill -- -"$SHELL_PID" 2>/dev/null; sleep 1; kill -9 -- -"$SHELL_PID" 2>/dev/null; wait "$SHELL_PID" 2>/dev/null; }
trap cleanup EXIT

# Wait for the nested compositor to announce its Wayland display.
DISPLAY_NAME=
for _ in $(seq 1 60); do
  sleep 0.5
  DISPLAY_NAME=$(grep -o -m1 "Using Wayland display name 'wayland-[0-9]*'" "$LOG" | grep -o 'wayland-[0-9]*')
  [ -n "$DISPLAY_NAME" ] && break
done
[ -n "$DISPLAY_NAME" ] || { echo "FAIL: nested shell did not start"; tail -20 "$LOG"; exit 1; }
sleep 4   # let the shell finish starting and load extensions
echo "nested shell on $DISPLAY_NAME (log: $LOG)"

want=$(sha256sum <"$IMG" | cut -d' ' -f1)
WAYLAND_DISPLAY=$DISPLAY_NAME wl-copy --type image/png <"$IMG"

# Churn some allocations between capture and re-copy, like normal use would.
for i in 1 2 3 4 5; do
  sleep 0.3
  head -c 200000 /dev/urandom | base64 -w0 | WAYLAND_DISPLAY=$DISPLAY_NAME wl-copy
done
# The last text copy is now newest; Clip re-copies the image ~3 s after it was captured.
sleep 5

if ! kill -0 "$SHELL_PID" 2>/dev/null || grep -q 'crashed with signal' "$LOG"; then
  echo "FAIL: nested GNOME Shell crashed"
  grep -E 'CLIP_SELFTEST|crashed with signal|extension.js' "$LOG" | head -10
  exit 1
fi
grep -q 'CLIP_SELFTEST: re-copy returned' "$LOG" || { echo "FAIL: Clip never re-copied the image"; grep -i -E 'clip|JS ERROR' "$LOG" | tail -10; exit 1; }

OUT=$(mktemp --suffix=.clip-test.png)
WAYLAND_DISPLAY=$DISPLAY_NAME timeout 10 wl-paste --type image/png >"$OUT" 2>/dev/null
got=$(sha256sum <"$OUT" | cut -d' ' -f1)
echo "original $(stat -c %s "$IMG") bytes, clipboard now $(stat -c %s "$OUT") bytes ($OUT)"
if [ "$got" = "$want" ]; then
  echo "PASS: shell survived and the re-copied image is byte-identical"
  rm -f "$LOG" "$OUT"
else
  echo "FAIL: re-copied image differs from the original (corrupted data)"
  exit 1
fi
