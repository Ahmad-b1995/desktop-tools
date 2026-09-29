# Changelog

## 2 (2026-09-29)

- Clip: works on GNOME 50. Super+V crashed because `Clutter.Grab.get_seat_state`
  and `Meta.Display.set_cursor` no longer exist; Clip now uses the GNOME 50
  equivalents and keeps the GNOME 49 path.
- Clip: an error while opening the popup or the region selector can no longer
  leave an invisible overlay holding the keyboard.

## 1 (2026-09-28)

First release.

- Clip: in-memory clipboard history with search, pinning and paste on select
- Clip: region text capture with Tesseract, frozen screen, English and Persian by default
- Clip: preferences to choose and install OCR languages
- pick: color picker with magnifier, HEX, RGB and HSL output, multi-monitor
