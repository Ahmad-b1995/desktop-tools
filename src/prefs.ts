// Clip preferences: shortcuts, OCR languages and history size.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Tesseract codes that are not human languages.
const SKIP = new Set(['osd', 'equ', 'snum']);

interface Language {
    name: string;
    pkg: string;
}

// A row that the language search filters, and the group it was added to.
interface ListedRow {
    row: Adw.PreferencesRow;
    group: Adw.PreferencesGroup;
    search?: string;
}

async function run(argv: string[]) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    return {ok: proc.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''};
}

// Installed traineddata codes, e.g. ['eng', 'fas', 'chi_sim'].
async function installedLanguages() {
    if (!GLib.find_program_in_path('tesseract'))
        return [];
    const {stdout} = await run(['tesseract', '--list-langs']);
    return stdout.split('\n').slice(1).map(s => s.trim())
        .filter(s => s && !SKIP.has(s) && !s.includes('/'));
}

// Every language package apt knows about: code -> {name, pkg}. Empty on
// distributions without apt.
async function availableLanguages() {
    const map = new Map<string, Language>();
    if (!GLib.find_program_in_path('apt-cache'))
        return map;
    const {stdout} = await run(['apt-cache', 'search', '--names-only', '^tesseract-ocr-[a-z]+(-[a-z]+)?$']);
    for (const line of stdout.split('\n')) {
        const m = line.match(/^tesseract-ocr-([a-z-]+) - .*?for (.+)$/);
        if (!m || m[1] === 'all' || m[1].startsWith('script'))
            continue;
        const code = m[1].replace(/-/g, '_');
        if (!SKIP.has(code))
            map.set(code, {name: m[2].trim(), pkg: `tesseract-ocr-${m[1]}`});
    }
    return map;
}

function copyToClipboard(text: string) {
    Gdk.Display.get_default()?.get_clipboard().set(text);
}

export default class ClipPreferences extends ExtensionPreferences {
    private _settings!: Gio.Settings;
    private _activeGroup!: Adw.PreferencesGroup;
    private _installGroup!: Adw.PreferencesGroup;
    private _filter!: Gtk.SearchEntry;
    private _rows: ListedRow[] = [];

    fillPreferencesWindow(window: Adw.PreferencesWindow) {
        this._settings = this.getSettings();
        window.set_default_size(560, 720);
        window.set_search_enabled(true);

        const page = new Adw.PreferencesPage({title: 'Clip', icon_name: 'edit-paste-symbolic'});
        window.add(page);

        // Shortcuts: none by default, so that installing Clip never takes a key
        // that something else uses.
        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Type a shortcut such as <Super>v and press Enter. Leave empty to turn it off.',
        });
        shortcuts.add(this._shortcutRow('show-history', 'Open clipboard history', '<Super>v'));
        shortcuts.add(this._shortcutRow('capture-text', 'Copy text from the screen', '<Super><Shift>t'));
        page.add(shortcuts);

        // Languages used for OCR
        this._activeGroup = new Adw.PreferencesGroup({
            title: 'Text recognition languages',
            description: 'Languages used when copying text from the screen. Fewer languages means faster, more accurate results.',
        });
        page.add(this._activeGroup);

        // Languages that can be installed
        this._installGroup = new Adw.PreferencesGroup({
            title: 'Add a language',
            description: 'Copy the install command, run it in a terminal, then refresh.',
        });
        const header = new Gtk.Box({spacing: 6});
        this._filter = new Gtk.SearchEntry({placeholder_text: 'Search languages', hexpand: true});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Refresh', css_classes: ['flat']});
        refresh.connect('clicked', () => this._reload().catch(e => logError(e)));
        header.append(this._filter);
        header.append(refresh);
        this._installGroup.set_header_suffix(header);
        page.add(this._installGroup);
        this._filter.connect('search-changed', () => this._applyFilter());

        // History
        const general = new Adw.PreferencesGroup({title: 'Clipboard history'});
        const size = new Adw.SpinRow({
            title: 'Entries to keep',
            subtitle: 'Pinned entries are kept in addition to these',
            adjustment: new Gtk.Adjustment({lower: 10, upper: 1000, step_increment: 10}),
        });
        this._settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(size);
        page.add(general);

        this._reload().catch(e => logError(e));
        return Promise.resolve();
    }

    private _shortcutRow(key: string, title: string, example: string) {
        const row = new Adw.EntryRow({title, show_apply_button: true});
        row.set_text(this._settings.get_strv(key)[0] ?? '');
        row.set_tooltip_text(`For example ${example}`);
        row.connect('apply', () => {
            const accel = row.get_text().trim();
            if (accel === '') {
                this._settings.set_strv(key, []);
                row.remove_css_class('error');
                return;
            }
            const [ok, keyval] = Gtk.accelerator_parse(accel);
            if (!ok || keyval === 0) {
                row.add_css_class('error');
                return;
            }
            row.remove_css_class('error');
            this._settings.set_strv(key, [accel]);
        });
        return row;
    }

    private async _reload() {
        for (const {row, group} of this._rows)
            group.remove(row);
        this._rows = [];

        const [installed, available] = await Promise.all([installedLanguages(), availableLanguages()]);
        const active = new Set(this._settings.get_string('ocr-languages').split('+').filter(Boolean));

        if (installed.length === 0) {
            this._addRow(this._activeGroup, new Adw.ActionRow({
                title: 'Tesseract is not installed',
                subtitle: 'sudo apt install tesseract-ocr tesseract-ocr-eng',
            }));
        }

        const nameOf = (code: string) => available.get(code)?.name ?? code;
        for (const code of installed.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
            const row = new Adw.SwitchRow({title: nameOf(code), subtitle: code, active: active.has(code)});
            row.connect('notify::active', () => this._toggle(code, row));
            this._addRow(this._activeGroup, row);
        }

        const missing = [...available.entries()]
            .filter(([code]) => !installed.includes(code))
            .sort((a, b) => a[1].name.localeCompare(b[1].name));
        for (const [code, {name, pkg}] of missing) {
            const command = `sudo apt install ${pkg}`;
            const row = new Adw.ActionRow({title: name, subtitle: command});
            const button = new Gtk.Button({
                icon_name: 'edit-copy-symbolic', tooltip_text: 'Copy the install command',
                valign: Gtk.Align.CENTER, css_classes: ['flat'],
            });
            button.connect('clicked', () => {
                copyToClipboard(command);
                button.set_icon_name('object-select-symbolic');
            });
            row.add_suffix(button);
            this._addRow(this._installGroup, row, `${name} ${code}`.toLowerCase());
        }
        if (missing.length === 0 && available.size === 0 && installed.length > 0) {
            this._addRow(this._installGroup, new Adw.ActionRow({
                title: 'Install more languages with your package manager',
                subtitle: 'They are usually called tesseract-langpack-<code> or tesseract-data-<code>',
            }));
        }
        this._applyFilter();
    }

    private _addRow(group: Adw.PreferencesGroup, row: Adw.PreferencesRow, search?: string) {
        group.add(row);
        this._rows.push({row, group, search});
    }

    private _applyFilter() {
        const q = this._filter.get_text().trim().toLowerCase();
        for (const {row, search} of this._rows) {
            if (search !== undefined)
                row.visible = q === '' || search.includes(q);
        }
    }

    private _toggle(code: string, row: Adw.SwitchRow) {
        const langs = this._settings.get_string('ocr-languages').split('+').filter(Boolean);
        let next = row.active ? [...new Set([...langs, code])] : langs.filter(l => l !== code);
        if (next.length === 0) {
            // At least one language must stay on.
            row.active = true;
            return;
        }
        // Keep English first when present: it is the fallback for UI text.
        next = next.sort((a, b) => (a === 'eng' ? -1 : b === 'eng' ? 1 : 0));
        this._settings.set_string('ocr-languages', next.join('+'));
    }
}
