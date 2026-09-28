#!/bin/bash
# Removes Clip and pick for the current user. Pinned clipboard entries in
# ~/.local/share/clip are kept unless you pass --purge.
set -uo pipefail

UUID=clip@ahmadcodes.com
KB=org.gnome.settings-daemon.plugins.media-keys
KP=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/pick/

edit_list() {  # edit_list SCHEMA KEY remove VALUE
  local cur new
  cur=$(gsettings get "$1" "$2")
  new=$(python3 -c 'import ast,sys; c,v=sys.argv[1:]; l=[] if c.startswith("@as") else ast.literal_eval(c); print(str([x for x in l if x!=v]))' "$cur" "$4")
  gsettings set "$1" "$2" "$new"
}

gnome-extensions disable $UUID 2>/dev/null
edit_list org.gnome.shell enabled-extensions remove "$UUID"
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"

pkill -x pick 2>/dev/null
rm -f "$HOME/.local/bin/pick" "$HOME/.local/share/applications/com.ahmadcodes.Pick.desktop"
edit_list $KB custom-keybindings remove "$KP"
gsettings reset-recursively $KB.custom-keybinding:$KP 2>/dev/null

[ "${1:-}" = --purge ] && rm -rf "$HOME/.local/share/clip"
echo "Removed. Log out and back in to unload the extension completely."
