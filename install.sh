#!/bin/bash
# Installs Clip (clipboard history + screen text) and pick (color picker)
# for the current user. No root needed. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

UUID=clip@ahmadcodes.com
EXT_DIR=$HOME/.local/share/gnome-shell/extensions/$UUID
OLD=clipboard-indicator@tudmotu.com

for need in pkg-config:pkg-config gnome-extensions:gnome-shell glib-compile-schemas:libglib2.0-bin python3:python3; do
  command -v "${need%%:*}" >/dev/null || { echo "Missing ${need%%:*} (package ${need#*:})"; exit 1; }
done
pkg-config --exists gtk4 || { echo "Missing GTK 4 headers: sudo apt install libgtk-4-dev"; exit 1; }
command -v tesseract >/dev/null || echo "Note: tesseract is not installed, so Super+Shift+T will not work yet (sudo apt install tesseract-ocr)."

echo "== pick: build and install"
make -C pick -s
make -C pick -s install

# gsettings string lists, edited with Python so any existing order is handled
edit_list() {  # edit_list SCHEMA KEY add|remove VALUE
  local cur new
  cur=$(gsettings get "$1" "$2")
  new=$(python3 -c 'import ast,sys; c,op,v=sys.argv[1:]; l=[] if c.startswith("@as") else ast.literal_eval(c); l=[x for x in l if x!=v]+([v] if op=="add" else []); print(str(l))' "$cur" "$3" "$4")
  gsettings set "$1" "$2" "$new"
}

echo "== pick: allow screenshots"
# GTK registers pick with the portal as com.ahmadcodes.Pick. GNOME 50 refuses
# silent screenshots for an app id it has no permission for, and its dialog
# does not appear for a windowless request, so store the "Allow" answer.
gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore --object-path /org/freedesktop/impl/portal/PermissionStore --method org.freedesktop.impl.portal.PermissionStore.SetPermission screenshot true screenshot com.ahmadcodes.Pick "['yes']" >/dev/null \
  || echo "Could not store the permission; pick may be refused until it is granted."

echo "== pick: Super+Shift+C shortcut"
KB=org.gnome.settings-daemon.plugins.media-keys
KP=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/pick/
edit_list $KB custom-keybindings add "$KP"
gsettings set $KB.custom-keybinding:$KP name 'Pick color'
gsettings set $KB.custom-keybinding:$KP command "$HOME/.local/bin/pick"
gsettings set $KB.custom-keybinding:$KP binding '<Super><Shift>c'

echo "== Clip: install extension"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -r "$UUID"/. "$EXT_DIR"/
glib-compile-schemas "$EXT_DIR/schemas"

echo "== Remove the old clipboard manager and its plain-text history"
gnome-extensions disable $OLD 2>/dev/null || true
edit_list org.gnome.shell enabled-extensions remove "$OLD"
rm -rf "$HOME/.local/share/gnome-shell/extensions/$OLD" "$HOME/.cache/$OLD"

echo "== Enable Clip"
edit_list org.gnome.shell enabled-extensions add "$UUID"
gnome-extensions enable $UUID 2>/dev/null \
  && echo "Clip is active now." \
  || echo "Clip will start after you log out and back in (GNOME on Wayland loads new extensions at login)."

echo
echo "Super+V        clipboard history"
echo "Super+Shift+T  copy text from a screen region"
echo "Super+Shift+C  pick a color"
