// Clip preferences: OCR languages (choose, install) and history size.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Tesseract codes that are not human languages.
const SKIP = new Set(['osd', 'equ', 'snum']);

async function run(argv) {
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

// Every language package apt knows about: Map code -> {name, pkg}.
async function availableLanguages() {
    const {stdout} = await run(['apt-cache', 'search', '--names-only', '^tesseract-ocr-[a-z]+(-[a-z]+)?$']);
    const map = new Map();
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

export default class ClipPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        window.set_default_size(560, 720);
        window.set_search_enabled(true);

        const page = new Adw.PreferencesPage({title: 'Clip', icon_name: 'edit-paste-symbolic'});
        window.add(page);

        // Languages used for OCR
        this._activeGroup = new Adw.PreferencesGroup({
            title: 'Text recognition languages',
            description: 'Languages used by Super+Shift+T. Fewer languages means faster, more accurate results.',
        });
        page.add(this._activeGroup);

        // Languages that can be installed
        this._installGroup = new Adw.PreferencesGroup({
            title: 'Add a language',
            description: 'Installing asks for your password (it runs apt).',
        });
        this._filter = new Gtk.SearchEntry({placeholder_text: 'Search languages', hexpand: true});
        this._installGroup.set_header_suffix(this._filter);
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
        const keys = new Adw.ActionRow({title: 'Shortcuts', subtitle: 'Super+V history    Super+Shift+T copy text from screen'});
        general.add(keys);
        page.add(general);

        this._rows = [];
        this._reload().catch(e => logError(e));
    }

    async _reload() {
        for (const row of this._rows)
            row._group.remove(row);
        this._rows = [];

        const [installed, available] = await Promise.all([installedLanguages(), availableLanguages()]);
        const active = new Set(this._settings.get_string('ocr-languages').split('+').filter(Boolean));

        if (installed.length === 0) {
            this._addRow(this._activeGroup, new Adw.ActionRow({
                title: 'Tesseract is not installed',
                subtitle: 'sudo apt install tesseract-ocr tesseract-ocr-eng',
            }));
        }

        const nameOf = code => available.get(code)?.name ?? code;
        for (const code of installed.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
            const row = new Adw.SwitchRow({title: nameOf(code), subtitle: code, active: active.has(code)});
            row.connect('notify::active', () => this._toggle(code, row));
            this._addRow(this._activeGroup, row);
        }

        const missing = [...available.entries()]
            .filter(([code]) => !installed.includes(code))
            .sort((a, b) => a[1].name.localeCompare(b[1].name));
        for (const [code, {name, pkg}] of missing) {
            const row = new Adw.ActionRow({title: name, subtitle: code});
            const button = new Gtk.Button({label: 'Install', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            button.connect('clicked', () => this._install(pkg, code, row, button).catch(e => logError(e)));
            row.add_suffix(button);
            row._search = `${name} ${code}`.toLowerCase();
            this._addRow(this._installGroup, row);
        }
        this._applyFilter();
    }

    _addRow(group, row) {
        row._group = group;
        group.add(row);
        this._rows.push(row);
    }

    _applyFilter() {
        const q = this._filter.get_text().trim().toLowerCase();
        for (const row of this._rows) {
            if (row._search !== undefined)
                row.visible = q === '' || row._search.includes(q);
        }
    }

    _toggle(code, row) {
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

    async _install(pkg, code, row, button) {
        button.sensitive = false;
        const spinner = new Adw.Spinner();
        row.add_suffix(spinner);
        const {ok, stderr} = await run(['pkexec', 'apt-get', 'install', '-y', '--no-install-recommends', pkg]);
        row.remove(spinner);
        if (!ok) {
            button.sensitive = true;
            row.subtitle = /lock/i.test(stderr)
                ? `${code}: another install or upgrade is running, try again later`
                : `${code}: install failed or was cancelled`;
            return;
        }
        const langs = this._settings.get_string('ocr-languages').split('+').filter(Boolean);
        this._settings.set_string('ocr-languages', [...new Set([...langs, code])].join('+'));
        await this._reload();
    }
}
