/**
 * fae.desktop — settings.js
 * Settings manager: defaults, persistence, UI bindings, skin loading,
 * color presets, and JSON export/import.
 */

import {
    log,
    warn,
    error,
    deepSet,
    deepGet,
    deepMerge,
    injectCSSLink,
    injectCSS,
    removeCSS,
    resolveExtensionPath,
} from './utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MODULE_NAME = 'fae_desktop';

// ---------------------------------------------------------------------------
// Default settings (mirrors spec exactly)
// ---------------------------------------------------------------------------

export const defaultSettings = Object.freeze({
    enabled: true,
    skin: 'macos',
    chatAlign: 'left',

    dock: {
        position: 'bottom',
        autoHide: false,
        magnification: true,
        iconSize: 48,
        magnificationScale: 1.5,
    },

    menubar: {
        show: true,
        showClock: true,
        showDate: true,
        showCharName: true,
        showTokens: false,
        clockFormat: '24h',
    },

    chat: {
        avatarSize: 40,
        avatarShape: 'circle',
        messageDirection: 'classic',
        timestampsOnHover: false,
        compact: false,
    },

    wallpaper: {
        useSTBackground: true,
        customUrl: '',
        fit: 'cover',
        blur: 0,
        dim: 0,
    },

    particles: {
        enabled: false,
        style: 'fireflies',
        density: 'medium',
        layer: 'behind',
    },

    avatarOverrides: {},

    layouts: {
        default: { windows: {} },
    },
    activeLayout: 'default',
    rememberPerChar: false,
    snapToEdges: true,
    snapToWindows: true,
    windowOpacity: 100,

    widgetStates: {},
    widgetData: {},
    notes: {},

    advanced: {
        debug: false,
        exposeApi: false,
        customCss: '',
    },
});

// ---------------------------------------------------------------------------
// Color preset definitions
// ---------------------------------------------------------------------------

const COLOR_PRESETS = {
    frost: {
        '--fd-accent': '#5ba4cf',
        '--fd-accent-hover': '#4a93be',
        '--fd-accent-glow': 'rgba(91,164,207,0.3)',
        '--fd-text-accent': '#5ba4cf',
        '--fd-border-active': '#5ba4cf',
    },
    rose: {
        '--fd-accent': '#cf7b96',
        '--fd-accent-hover': '#be6a85',
        '--fd-accent-glow': 'rgba(207,123,150,0.3)',
        '--fd-text-accent': '#cf7b96',
        '--fd-border-active': '#cf7b96',
    },
    moss: {
        '--fd-accent': '#7baf6b',
        '--fd-accent-hover': '#6a9e5a',
        '--fd-accent-glow': 'rgba(123,175,107,0.3)',
        '--fd-text-accent': '#7baf6b',
        '--fd-border-active': '#7baf6b',
    },
};

// Skins that have their own built-in color (frost/rose/moss css files).
// For these we don't separately inject a color preset block; the skin file
// already contains all overrides.
const SKIN_NAMES = ['macos', 'frost', 'rose', 'moss'];

// ---------------------------------------------------------------------------
// Settings access
// ---------------------------------------------------------------------------

/**
 * Return the fae_desktop settings object, initialising it with defaults if it
 * doesn't exist yet.  Always returns a live reference to the settings object
 * stored inside ST's extensionSettings.
 *
 * @returns {object}
 */
export function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx?.extensionSettings) {
        warn('getSettings: SillyTavern context not available');
        return { ...defaultSettings };
    }

    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = {};
    }

    // Merge defaults for any missing keys (non-destructive)
    const settings = ctx.extensionSettings[MODULE_NAME];
    _applyDefaults(settings, defaultSettings);

    return settings;
}

/**
 * Recursively fill in missing keys from `defaults` into `target` without
 * overwriting keys that already exist.
 *
 * @param {object} target
 * @param {object} defaults
 */
function _applyDefaults(target, defaults) {
    for (const key of Object.keys(defaults)) {
        if (!(key in target)) {
            if (
                typeof defaults[key] === 'object' &&
                defaults[key] !== null &&
                !Array.isArray(defaults[key])
            ) {
                target[key] = {};
                _applyDefaults(target[key], defaults[key]);
            } else {
                target[key] = defaults[key];
            }
        } else if (
            typeof defaults[key] === 'object' &&
            defaults[key] !== null &&
            !Array.isArray(defaults[key]) &&
            typeof target[key] === 'object' &&
            target[key] !== null
        ) {
            _applyDefaults(target[key], defaults[key]);
        }
    }
}

// ---------------------------------------------------------------------------
// Saving a setting
// ---------------------------------------------------------------------------

/**
 * Save a setting by key (supports deep dot-paths like 'dock.autoHide') and
 * immediately persist via ST's saveSettingsDebounced.
 *
 * @param {string} key    — setting key or dot-path
 * @param {*}      value  — new value
 */
export function saveSetting(key, value) {
    const settings = getSettings();
    deepSet(settings, key, value);

    try {
        const ctx = SillyTavern.getContext();
        ctx.saveSettingsDebounced?.();
    } catch (e) {
        warn('saveSetting: could not persist settings', e);
    }

    log(`saveSetting: ${key} =`, value);
}

/**
 * Read a setting by dot-path.
 *
 * @param {string} key
 * @param {*}      [fallback]
 * @returns {*}
 */
export function readSetting(key, fallback = undefined) {
    return deepGet(getSettings(), key, fallback);
}

// ---------------------------------------------------------------------------
// Skin loading
// ---------------------------------------------------------------------------

const SKIN_CSS_ID = 'fd-skin';
const PRESET_CSS_ID = 'fd-color-preset';

/**
 * Load and apply the given skin by injecting its CSS file into <head>.
 * Removes the previously loaded skin first.
 *
 * @param {string} skinName  — 'macos' | 'frost' | 'rose' | 'moss' | custom filename
 * @returns {Promise<void>}
 */
export async function applySkin(skinName) {
    // Determine file name
    const fileName = SKIN_NAMES.includes(skinName) ? `${skinName}.css` : skinName;
    const href = resolveExtensionPath('skins', fileName);

    log(`applySkin: loading "${fileName}" from "${href}"`);

    // Remove existing skin link first to force a fresh load on skin switch
    removeCSS(SKIN_CSS_ID);

    try {
        await injectCSSLink(SKIN_CSS_ID, href);
        log(`applySkin: "${skinName}" applied`);
    } catch (e) {
        error(`applySkin: failed to load skin "${skinName}"`, e);
        console.error(`[fae.desktop] applySkin failed for "${skinName}":`, e);
        // Fall back to macos skin
        if (skinName !== 'macos') {
            warn('applySkin: falling back to macos skin');
            await applySkin('macos');
        }
    }

    // Built-in colour skins (frost/rose/moss) have their overrides baked in.
    // For the base macos skin we clear any lingering colour preset.
    if (skinName === 'macos') {
        removeCSS(PRESET_CSS_ID);
    }
}

// ---------------------------------------------------------------------------
// Color preset
// ---------------------------------------------------------------------------

/**
 * Apply one of the named colour presets (frost / rose / moss) as a
 * CSS variable override block on :root. Pass null to clear.
 *
 * @param {string|null} presetName  — 'frost' | 'rose' | 'moss' | null
 */
export function applyColorPreset(presetName) {
    if (!presetName || !COLOR_PRESETS[presetName]) {
        removeCSS(PRESET_CSS_ID);
        log('applyColorPreset: cleared');
        return;
    }

    const vars = COLOR_PRESETS[presetName];
    const cssText = `:root {\n${Object.entries(vars)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join('\n')}\n}`;

    injectCSS(PRESET_CSS_ID, cssText);
    log(`applyColorPreset: applied "${presetName}"`);
}

// ---------------------------------------------------------------------------
// Custom CSS
// ---------------------------------------------------------------------------

const CUSTOM_CSS_ID = 'fd-custom-css';

/**
 * (Re-)apply the user's custom CSS from settings.
 */
export function applyCustomCss() {
    const css = readSetting('advanced.customCss', '');
    if (css && css.trim()) {
        injectCSS(CUSTOM_CSS_ID, css);
    } else {
        removeCSS(CUSTOM_CSS_ID);
    }
}

// ---------------------------------------------------------------------------
// Settings UI — two-way binding
// ---------------------------------------------------------------------------

/**
 * Bind all inputs inside the settings panel to their corresponding settings
 * paths. Two-way: reads current value → sets input, and listens for changes
 * → calls saveSetting.
 *
 * Inputs must carry a `data-fd-setting` attribute whose value is the dot-path.
 * Optionally `data-fd-callback` can name a module-level callback to invoke
 * after the setting is saved (e.g. 'applySkin', 'reloadLayout').
 *
 * @param {HTMLElement|jQuery} container  — the settings panel root element
 * @param {object}             callbacks  — map of callbackName → function
 */
export function bindSettingsUI(container, callbacks = {}) {
    const $container = $(container);

    // --- Populate inputs from current settings ---
    $container.find('[data-fd-setting]').each(function () {
        const $el = $(this);
        const path = $el.data('fd-setting');
        const value = readSetting(path);

        if (value === undefined) return;

        const tag = this.tagName.toLowerCase();
        const type = ($el.attr('type') || '').toLowerCase();

        if (tag === 'input' && type === 'checkbox') {
            $el.prop('checked', Boolean(value));
        } else if (tag === 'input' && type === 'range') {
            $el.val(value);
            // Update paired display element if present
            const displayId = $el.data('fd-display');
            if (displayId) $(`#${displayId}`).text(value);
        } else if (tag === 'select' || tag === 'input' || tag === 'textarea') {
            $el.val(value);
        }
    });

    // --- Listen for changes → save ---
    $container.on('change input', '[data-fd-setting]', function (e) {
        const $el = $(this);
        const path = $el.data('fd-setting');
        const tag = this.tagName.toLowerCase();
        const type = ($el.attr('type') || '').toLowerCase();

        let value;
        if (tag === 'input' && type === 'checkbox') {
            value = this.checked;
        } else if (tag === 'input' && type === 'range') {
            value = Number(this.value);
            // Update paired display element
            const displayId = $el.data('fd-display');
            if (displayId) $(`#${displayId}`).text(value);
        } else if (tag === 'input' && type === 'number') {
            value = Number(this.value);
        } else {
            value = this.value;
        }

        saveSetting(path, value);
        log(`UI binding: ${path} =`, value);

        // Fire optional callback
        const cbName = $el.data('fd-callback');
        if (cbName && typeof callbacks[cbName] === 'function') {
            callbacks[cbName](value, path);
        }
    });

    log('bindSettingsUI: bindings attached');
}

// ---------------------------------------------------------------------------
// Settings export / import
// ---------------------------------------------------------------------------

/**
 * Export all fae_desktop settings as a formatted JSON string.
 * @returns {string}
 */
export function exportSettings() {
    const settings = getSettings();
    return JSON.stringify(settings, null, 2);
}

/**
 * Import settings from a JSON string.  Deep-merges into the current settings
 * so only provided keys are overwritten (unknown keys are preserved).
 * Persists immediately.
 *
 * @param {string} json  — JSON string produced by exportSettings()
 * @throws {Error}       if json is not valid JSON
 */
export function importSettings(json) {
    const incoming = JSON.parse(json); // throws on invalid JSON
    const settings = getSettings();
    deepMerge(settings, incoming);

    try {
        const ctx = SillyTavern.getContext();
        ctx.saveSettingsDebounced?.();
    } catch (e) {
        warn('importSettings: could not persist settings', e);
    }

    log('importSettings: settings imported', incoming);
}

/**
 * Reset all fae_desktop settings back to defaults.
 * @returns {object} the freshly reset settings object
 */
export function resetSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx?.extensionSettings) {
        warn('resetSettings: no context available');
        return { ...defaultSettings };
    }

    // Deep clone defaults so the stored object is independent
    ctx.extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultSettings));

    try {
        ctx.saveSettingsDebounced?.();
    } catch (e) {
        warn('resetSettings: could not persist', e);
    }

    log('resetSettings: settings reset to defaults');
    return ctx.extensionSettings[MODULE_NAME];
}
