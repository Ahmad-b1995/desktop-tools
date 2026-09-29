// Clip: clipboard history and screen text capture for GNOME Shell.
//
// Runs inside the compositor because on GNOME Wayland that is the only place
// a clipboard can be observed without polling or focus tricks. Nothing is
// written to disk except entries you pin, and nothing touches the network.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const MAX_TEXT_LENGTH = 512 * 1024;   // ignore anything bigger (logs, dumps)
const MAX_ROWS = 200;                 // rows rendered in the popup at once
const PREVIEW_LENGTH = 240;
const PASTE_DELAY_MS = 90;            // time for focus to return to the app
const PASSWORD_HINT = 'x-kde-passwordManagerHint';
const TERMINAL_CLASSES = /term|kitty|alacritty|foot|wezterm|ghostty|konsole|tilix|terminator|ptyxis|console/i;

// ---------------------------------------------------------------- history

class History {
    constructor(file, limit) {
        this._file = file;
        this.limit = limit;
        this.items = [];
        this._loadPinned();
    }

    add(text) {
        if (!text || !text.trim() || text.length > MAX_TEXT_LENGTH)
            return;
        const index = this.items.findIndex(item => item.text === text);
        const item = index >= 0 ? this.items.splice(index, 1)[0] : {text, pinned: false};
        item.time = Date.now();
        this.items.unshift(item);
        this._trim();
    }

    remove(item) {
        this.items = this.items.filter(i => i !== item);
        if (item.pinned)
            this._savePinned();
    }

    togglePin(item) {
        item.pinned = !item.pinned;
        this._trim();
        this._savePinned();
    }

    clearUnpinned() {
        this.items = this.items.filter(i => i.pinned);
    }

    _trim() {
        let unpinned = 0;
        this.items = this.items.filter(i => i.pinned || ++unpinned <= this.limit);
    }

    _loadPinned() {
        try {
            const [, bytes] = this._file.load_contents(null);
            for (const text of JSON.parse(new TextDecoder().decode(bytes))) {
                if (typeof text === 'string')
                    this.items.push({text, pinned: true, time: 0});
            }
        } catch {
            // No pinned file yet.
        }
    }

    _savePinned() {
        const pinned = this.items.filter(i => i.pinned).map(i => i.text);
        try {
            GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o700);
            this._file.replace_contents(
                new TextEncoder().encode(JSON.stringify(pinned)), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e, 'Clip: could not save pinned entries');
        }
    }
}

// ------------------------------------------------------------ small utils

function relativeTime(ms) {
    if (!ms)
        return '';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60)
        return 'now';
    if (s < 3600)
        return `${Math.floor(s / 60)}m`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

function matches(text, words) {
    const haystack = text.toLowerCase();
    return words.every(w => haystack.includes(w));
}

// GNOME 49 reports which devices a grab holds; GNOME 50 dropped that API and
// only tells whether the grab was revoked.
function grabbedKeyboard(grab) {
    if (typeof grab.get_seat_state === 'function')
        return (grab.get_seat_state() & Clutter.GrabState.KEYBOARD) !== 0;
    return !grab.is_revoked?.();
}

// GNOME 50 sets cursors per actor; GNOME 49 sets one for the whole display.
function setCrosshair(actor, on) {
    if (typeof actor.set_cursor_type === 'function' && Clutter.CursorType)
        actor.set_cursor_type(on ? Clutter.CursorType.CROSSHAIR : Clutter.CursorType.INHERIT);
    else
        global.display.set_cursor(on ? Meta.Cursor.CROSSHAIR : Meta.Cursor.DEFAULT);
}

// ------------------------------------------------------------ history popup

class HistoryPopup {
    constructor(history, onActivate, onSettings) {
        this._history = history;
        this._onActivate = onActivate;
        this._onSettings = onSettings;
        this._root = null;
    }

    get isOpen() {
        return this._root !== null;
    }

    open() {
        if (this._root)
            return;

        const monitor = Main.layoutManager.currentMonitor;
        this._root = new St.Widget({
            reactive: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height,
            style_class: 'clip-backdrop',
        });
        this._root.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });

        const panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clip-panel',
            reactive: true,
        });
        panel.connect('button-press-event', () => Clutter.EVENT_STOP);

        this._entry = new St.Entry({style_class: 'clip-search', hint_text: 'Search clipboard', can_focus: true});
        this._scroll = new St.ScrollView({
            style_class: 'clip-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'clip-list'});
        this._scroll.set_child(this._list);

        const footer = new St.BoxLayout({style_class: 'clip-footer'});
        footer.add_child(new St.Label({
            style_class: 'clip-hint', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            text: 'Enter paste    Shift+Enter copy    Ctrl+P pin    Del remove    Ctrl+Shift+Del clear',
        }));
        const gear = new St.Button({
            style_class: 'clip-gear', can_focus: false, accessible_name: 'Clip settings',
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
        });
        gear.connect('clicked', () => {
            this.close();
            this._onSettings();
        });
        footer.add_child(gear);

        panel.add_child(this._entry);
        panel.add_child(this._scroll);
        panel.add_child(footer);
        this._root.add_child(panel);

        const width = Math.min(620, monitor.width - 32);
        panel.set_width(width);
        panel.set_position(
            monitor.x + Math.floor((monitor.width - width) / 2),
            monitor.y + Math.floor(monitor.height * 0.16));

        Main.uiGroup.add_child(this._root);
        Main.uiGroup.set_child_above_sibling(this._root, null);

        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        try {
            if (!grabbedKeyboard(this._grab)) {
                this.close();
                return;
            }
        } catch (e) {
            this.close();
            throw e;
        }

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._refilter());
        text.connect('key-press-event', (_a, event) => this._onKey(event));
        global.stage.set_key_focus(text);
        this._refilter();
    }

    close() {
        if (!this._root)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._root.destroy();
        this._root = null;
        this._rows = [];
    }

    _refilter() {
        const words = this._entry.get_text().toLowerCase().split(/\s+/).filter(Boolean);
        this._shown = this._history.items.filter(i => matches(i.text, words)).slice(0, MAX_ROWS);
        this._list.destroy_all_children();
        this._rows = this._shown.map((item, index) => this._makeRow(item, index));
        if (this._rows.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'clip-empty',
                text: this._history.items.length ? 'No matches' : 'Nothing copied yet',
            }));
        }
        this._selected = -1;
        this._select(0);
    }

    _makeRow(item, index) {
        const row = new St.Button({style_class: 'clip-row', x_expand: true, reactive: true, can_focus: false});
        const box = new St.BoxLayout({x_expand: true});

        const preview = item.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
        const label = new St.Label({text: preview, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'clip-row-text'});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);

        const lines = item.text.split('\n').length;
        const meta = [lines > 1 ? `${lines} lines` : '', relativeTime(item.time)].filter(Boolean).join('  ·  ');
        if (meta)
            box.add_child(new St.Label({text: meta, y_align: Clutter.ActorAlign.CENTER, style_class: 'clip-row-meta'}));
        if (item.pinned)
            box.add_child(new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'clip-row-pin'}));
        if (index < 9)
            box.add_child(new St.Label({text: `Alt+${index + 1}`, y_align: Clutter.ActorAlign.CENTER, style_class: 'clip-row-key'}));

        row.set_child(box);
        row.connect('clicked', () => this._activate(index, true));
        row.connect('motion-event', () => {
            this._select(index, false);
            return Clutter.EVENT_PROPAGATE;
        });
        this._list.add_child(row);
        return row;
    }

    _select(index, scroll = true) {
        if (this._rows.length === 0)
            return;
        index = Math.max(0, Math.min(index, this._rows.length - 1));
        if (index === this._selected)
            return;
        this._rows[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = index;
        const row = this._rows[index];
        row.add_style_pseudo_class('selected');
        if (scroll)
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    _activate(index, paste) {
        const item = this._shown[index];
        if (!item)
            return;
        this.close();
        this._onActivate(item, paste);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        const item = this._shown[this._selected];

        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._select(this._selected - 8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._select(this._selected + 8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activate(this._selected, !shift);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
            if (ctrl && shift) {
                this._history.clearUnpinned();
                this._refilter();
                return Clutter.EVENT_STOP;
            }
            if (item && (ctrl || this._entry.get_text() === '')) {
                const keep = this._selected;
                this._history.remove(item);
                this._refilter();
                this._select(keep);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (ctrl && (key === Clutter.KEY_p || key === Clutter.KEY_P) && item) {
            const keep = this._selected;
            this._history.togglePin(item);
            this._refilter();
            this._select(keep);
            return Clutter.EVENT_STOP;
        }
        if (alt && key >= Clutter.KEY_1 && key <= Clutter.KEY_9) {
            this._activate(key - Clutter.KEY_1, true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

// ------------------------------------------------------- region selection

class RegionSelector {
    constructor() {
        this._root = null;
    }

    // Resolves with {texture, scale, x, y, width, height} in texture pixels,
    // or null if the user cancelled. The screen is frozen first, so menus and
    // tooltips that vanish on click can still be captured.
    async select(languages) {
        if (this._root)
            return null;

        const shooter = new Shell.Screenshot();
        const [content, scale] = await shooter.screenshot_stage_to_content();
        const {width, height} = global.stage;

        this._root = new St.Widget({reactive: true, x: 0, y: 0, width, height});
        this._root.add_child(new Clutter.Actor({content, width, height}));
        this._shades = [0, 1, 2, 3].map(() => {
            const shade = new St.Widget({style_class: 'clip-shade'});
            this._root.add_child(shade);
            return shade;
        });
        this._frame = new St.Widget({style_class: 'clip-frame', visible: false});
        this._size = new St.Label({style_class: 'clip-badge', visible: false});
        this._root.add_child(this._frame);
        this._root.add_child(this._size);

        const monitor = Main.layoutManager.currentMonitor;
        const tip = new St.Label({style_class: 'clip-badge clip-tip', text: `Drag over the text to copy    ${languages.replaceAll('+', ' + ')}    Esc to cancel`});
        this._root.add_child(tip);
        tip.connect('notify::width', () => tip.set_position(
            monitor.x + Math.floor((monitor.width - tip.width) / 2), monitor.y + 40));

        this._layout(0, 0, 0, 0);
        Main.uiGroup.add_child(this._root);
        Main.uiGroup.set_child_above_sibling(this._root, null);

        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        try {
            if (!grabbedKeyboard(this._grab)) {
                this._close();
                return null;
            }
            setCrosshair(this._root, true);
        } catch (e) {
            this._close();
            throw e;
        }

        return new Promise(resolve => {
            let start = null;
            let rect = null;
            const finish = result => {
                this._close();
                resolve(result);
            };
            this._root.connect('button-press-event', (_a, event) => {
                if (event.get_button() === Clutter.BUTTON_PRIMARY)
                    start = event.get_coords();
                else
                    finish(null);
                return Clutter.EVENT_STOP;
            });
            this._root.connect('motion-event', (_a, event) => {
                if (start) {
                    const [x, y] = event.get_coords();
                    rect = [Math.min(start[0], x), Math.min(start[1], y), Math.abs(x - start[0]), Math.abs(y - start[1])].map(Math.round);
                    this._layout(...rect);
                }
                return Clutter.EVENT_STOP;
            });
            this._root.connect('button-release-event', (_a, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY || !start)
                    return Clutter.EVENT_STOP;
                if (!rect || rect[2] < 4 || rect[3] < 4) {
                    finish(null);
                } else {
                    const [x, y, w, h] = rect.map(v => Math.round(v * scale));
                    finish({texture: content.get_texture(), scale, x, y, width: w, height: h, logicalHeight: rect[3]});
                }
                return Clutter.EVENT_STOP;
            });
            this._root.connect('key-press-event', (_a, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape)
                    finish(null);
                return Clutter.EVENT_STOP;
            });
            this._cancel = () => finish(null);
        });
    }

    cancel() {
        this._cancel?.();
    }

    _layout(x, y, w, h) {
        const {width: W, height: H} = global.stage;
        const [top, bottom, left, right] = this._shades;
        top.set_position(0, 0);
        top.set_size(W, y);
        bottom.set_position(0, y + h);
        bottom.set_size(W, Math.max(0, H - y - h));
        left.set_position(0, y);
        left.set_size(x, h);
        right.set_position(x + w, y);
        right.set_size(Math.max(0, W - x - w), h);

        const visible = w > 0 && h > 0;
        this._frame.visible = this._size.visible = visible;
        if (visible) {
            this._frame.set_position(x - 2, y - 2);
            this._frame.set_size(w + 4, h + 4);
            this._size.text = `${w} × ${h}`;
            this._size.set_position(x, y + h + 8 + 24 > H ? y - 30 : y + h + 8);
        }
    }

    _close() {
        if (!this._root)
            return;
        setCrosshair(this._root, false);
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._cancel = null;
        this._root.destroy();
        this._root = null;
    }
}

// ------------------------------------------------------------------ OCR

async function recognize(region, languages) {
    const pixbuf = await Shell.Screenshot.composite_to_stream(
        region.texture, region.x, region.y, region.width, region.height,
        region.scale, null, 0, 0, 1, Gio.MemoryOutputStream.new_resizable());

    // Screen text is ~96 dpi; Tesseract is tuned for ~300. Upscaling small
    // regions is the single biggest accuracy win.
    const factor = Math.max(1, Math.min(3, Math.floor(4000 / Math.max(region.width, region.height))));
    const scaled = factor > 1
        ? pixbuf.scale_simple(region.width * factor, region.height * factor, GdkPixbuf.InterpType.BILINEAR)
        : pixbuf;

    // Per-user tmpfs, mode 0700: the image never lands on a real disk.
    const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), `clip-ocr-${GLib.uuid_string_random()}.png`]);
    scaled.savev(path, 'png', [], []);
    try {
        const singleLine = region.logicalHeight < 42;
        let text = await tesseract(path, languages, singleLine ? '7' : '3');
        if (!text && !singleLine)
            text = await tesseract(path, languages, '6');
        return text;
    } finally {
        GLib.unlink(path);
    }
}

async function tesseract(path, languages, psm) {
    const proc = Gio.Subprocess.new(
        ['tesseract', path, 'stdout', '-l', languages, '--psm', psm],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful())
        throw new Error('tesseract failed');
    return (stdout ?? '')
        .replace(/\f/g, '')
        .split('\n').map(line => line.trimEnd()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ------------------------------------------------------------ extension

export default class ClipExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const pinnedFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'clip', 'pinned.json']));
        this._history = new History(pinnedFile, this._settings.get_int('history-size'));
        this._settings.connectObject('changed::history-size', () => {
            this._history.limit = this._settings.get_int('history-size');
        }, this);

        this._popup = new HistoryPopup(this._history, (item, paste) => this._use(item, paste),
            () => this.openPreferences());
        this._selector = new RegionSelector();
        this._keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        global.display.get_selection().connectObject(
            'owner-changed', (_sel, type, source) => this._onOwnerChanged(type, source), this);

        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('show-history', this._settings, Meta.KeyBindingFlags.NONE, modes,
            () => this._toggleHistory());
        Main.wm.addKeybinding('capture-text', this._settings, Meta.KeyBindingFlags.NONE, modes,
            () => this._captureText().catch(e => logError(e, 'Clip OCR')));
    }

    disable() {
        Main.wm.removeKeybinding('show-history');
        Main.wm.removeKeybinding('capture-text');
        global.display.get_selection().disconnectObject(this);
        this._settings.disconnectObject(this);
        this._popup.close();
        this._selector.cancel();
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._keyboard.run_dispose();
        this._pasteId = this._keyboard = this._popup = this._selector = null;
        this._history = this._settings = null;
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        const mimes = source.get_mimetypes();
        if (mimes.includes(PASSWORD_HINT))
            return;
        if (!mimes.some(m => m.startsWith('text/') || m === 'UTF8_STRING' || m === 'STRING'))
            return;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clip, text) => {
            this._history?.add(text);
        });
    }

    _toggleHistory() {
        if (this._popup.isOpen) {
            this._popup.close();
            return;
        }
        // Remember where the paste should go before our popup takes focus.
        const wmClass = global.display.focus_window?.get_wm_class() ?? '';
        this._pasteIntoTerminal = Main.inputMethod.content_purpose === Clutter.InputContentPurpose.TERMINAL ||
            TERMINAL_CLASSES.test(wmClass);
        this._popup.open();
    }

    _use(item, paste) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.text);
        if (!paste)
            return;
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            const keys = this._pasteIntoTerminal
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];
            const time = Clutter.get_current_event_time() * 1000;
            for (const key of keys)
                this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
            for (const key of keys.reverse())
                this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _captureText() {
        this._popup.close();
        const languages = this._settings.get_string('ocr-languages');
        const region = await this._selector.select(languages);
        if (!region)
            return;
        let text;
        try {
            text = await recognize(region, languages);
        } catch (e) {
            Main.notifyError('Could not read text', GLib.find_program_in_path('tesseract')
                ? e.message : 'Tesseract is not installed (sudo apt install tesseract-ocr).');
            return;
        }
        if (!text) {
            Main.notify('No text found', 'Try selecting a slightly larger area around the text.');
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        Main.notify(`Copied ${text.length} characters`, preview);
    }
}
