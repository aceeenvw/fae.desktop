/**
 * fae.desktop — layout-manager.js
 * Layout preset management — save, load, delete named window arrangements.
 * Optionally remembers a different layout per character (rememberPerChar).
 */

'use strict';

import { log, warn } from './utils.js';
import { getSettings, saveSetting, MODULE_NAME } from './settings.js';

/** Key used to store the "no character" layout. */
const GLOBAL_LAYOUT_KEY = '__global__';
/** Name of the built-in default layout — never deletable. */
const DEFAULT_LAYOUT_NAME = 'default';

export class FaeLayoutManager {
    /** @type {object|null} */
    #windowManager = null;
    /** Previous character ID (for per-char layout save-before-switch) */
    #prevCharId = null;
    /** Bound event handlers */
    #onChatChanged = null;
    /** Reference to ST eventSource */
    #eventSource = null;
    /** Reference to ST event_types */
    #eventTypes = null;

    /* ── Public API ──────────────────────────────────────────────────────── */

    /**
     * Initialise the layout manager.
     * @param {object} desktopRef — the desktop module reference
     */
    init(desktopRef) {
        // Try to get windowManager from desktop or just store desktop ref
        this.#windowManager = desktopRef;

        // Get ST context for events and settings
        try {
            const ctx = SillyTavern.getContext();
            this.#eventSource = ctx?.eventSource;
            this.#eventTypes = ctx?.event_types;
        } catch (e) {
            warn('layout-manager: could not get SillyTavern context', e);
        }

        this.#ensureDefaultLayout();
        this.#bindEvents();
        log('layout-manager: initialised');
    }

    /**
     * Returns all saved layout preset names.
     * @returns {string[]}
     */
    getLayouts() {
        return Object.keys(this.#settings.layouts || {});
    }

    /**
     * Save the current window arrangement under `name`.
     * @param {string} name
     */
    saveLayout(name) {
        if (!name || typeof name !== 'string') {
            warn('layout-manager: saveLayout — invalid name', name);
            return;
        }
        const positions = this.#capturePositions();
        const settings = this.#settings;
        if (!settings.layouts) settings.layouts = {};
        settings.layouts[name] = { windows: positions };
        this.#persist();
        log(`layout-manager: Layout saved: "${name}"`);
    }

    /**
     * Load a saved layout by name, applying positions via windowManager.
     * @param {string} name
     * @returns {boolean} true if layout was found and applied
     */
    loadLayout(name) {
        const preset = this.#settings.layouts?.[name];
        if (!preset) {
            warn('layout-manager: loadLayout — not found:', name);
            return false;
        }
        this.#restorePositions(preset.windows ?? {});
        this.setCurrentLayout(name);
        log(`layout-manager: Layout loaded: "${name}"`);
        return true;
    }

    /**
     * Delete a layout preset by name.
     * The built-in 'default' preset cannot be deleted.
     * @param {string} name
     * @returns {boolean} true if deleted
     */
    deleteLayout(name) {
        if (name === DEFAULT_LAYOUT_NAME) {
            warn('layout-manager: Cannot delete the default layout.');
            return false;
        }
        if (!this.#settings.layouts?.[name]) return false;

        delete this.#settings.layouts[name];

        // If deleting the active layout, fall back to default
        if (this.#settings.activeLayout === name) {
            this.#settings.activeLayout = DEFAULT_LAYOUT_NAME;
        }
        this.#persist();
        log(`layout-manager: Layout deleted: "${name}"`);
        return true;
    }

    /**
     * Get the currently active layout name.
     * @returns {string}
     */
    getCurrentLayoutName() {
        return this.#settings.activeLayout ?? DEFAULT_LAYOUT_NAME;
    }

    /**
     * Set the active layout name (does NOT apply positions — use loadLayout for that).
     * @param {string} name
     */
    setCurrentLayout(name) {
        saveSetting('activeLayout', name);
    }

    /**
     * Reset the 'default' layout to empty (all windows at default positions).
     */
    resetDefaultLayout() {
        const settings = this.#settings;
        if (!settings.layouts) settings.layouts = {};
        settings.layouts[DEFAULT_LAYOUT_NAME] = { windows: {} };
        if (settings.activeLayout === DEFAULT_LAYOUT_NAME) {
            this.#restorePositions({});
        }
        this.#persist();
        log('layout-manager: Default layout reset.');
    }

    /**
     * Get all per-character layout assignments.
     * @returns {Record<string, string>}
     */
    getCharLayouts() {
        return this.#settings.charLayouts ?? {};
    }

    /**
     * Assign a layout name to a specific character.
     * @param {string} charId
     * @param {string} layoutName
     */
    setCharLayout(charId, layoutName) {
        const settings = this.#settings;
        if (!settings.charLayouts) settings.charLayouts = {};
        settings.charLayouts[charId] = layoutName;
        this.#persist();
    }

    /** Cleanup: remove event listeners. */
    destroy() {
        if (this.#onChatChanged && this.#eventSource && this.#eventTypes) {
            try {
                this.#eventSource.removeListener(
                    this.#eventTypes.CHAT_CHANGED ?? 'chat_changed',
                    this.#onChatChanged,
                );
            } catch { /* ignore */ }
            this.#onChatChanged = null;
        }
        this.#windowManager = null;
        this.#prevCharId    = null;
        log('layout-manager: destroyed');
    }

    /* ── Private ─────────────────────────────────────────────────────────── */

    get #settings() {
        return getSettings();
    }

    #persist() {
        try {
            const ctx = SillyTavern.getContext();
            ctx.saveSettingsDebounced?.();
        } catch { /* ignore */ }
    }

    #ensureDefaultLayout() {
        const s = this.#settings;
        if (!s.layouts) s.layouts = {};
        if (!s.layouts[DEFAULT_LAYOUT_NAME]) {
            s.layouts[DEFAULT_LAYOUT_NAME] = { windows: {} };
        }
        if (!s.activeLayout) {
            s.activeLayout = DEFAULT_LAYOUT_NAME;
        }
    }

    #bindEvents() {
        if (!this.#settings.rememberPerChar) return;
        if (!this.#eventSource || !this.#eventTypes) return;

        this.#onChatChanged = (data) => this.#handleChatChanged(data);
        const eventName = this.#eventTypes.CHAT_CHANGED ?? 'chat_changed';
        this.#eventSource.on(eventName, this.#onChatChanged);
    }

    /**
     * Called when SillyTavern switches to a different character/chat.
     */
    #handleChatChanged(data) {
        if (!this.#settings.rememberPerChar) return;

        const incomingId = String(
            data?.characterId ?? data?.character_id ?? GLOBAL_LAYOUT_KEY,
        );

        // 1. Save current layout for the previous character
        if (this.#prevCharId !== null) {
            const saveName = this.#charLayoutName(this.#prevCharId);
            this.saveLayout(saveName);
            this.setCharLayout(this.#prevCharId, saveName);
        }

        // 2. Load layout for the incoming character (if one was saved)
        const charLayouts = this.getCharLayouts();
        const savedName   = charLayouts[incomingId];

        if (savedName && this.#settings.layouts?.[savedName]) {
            this.loadLayout(savedName);
        } else {
            this.loadLayout(DEFAULT_LAYOUT_NAME);
        }

        this.#prevCharId = incomingId;
        log(`layout-manager: Chat changed → charId="${incomingId}", layout="${this.getCurrentLayoutName()}"`);
    }

    /**
     * Generate a stable per-character layout name.
     * @param {string} charId
     * @returns {string}
     */
    #charLayoutName(charId) {
        return `__char_${charId}__`;
    }

    /**
     * Capture current window positions from DOM.
     * @returns {Record<string, object>}
     */
    #capturePositions() {
        const positions = {};
        try {
            $('.fd-window[data-window-id]').each(function () {
                const id = $(this).data('window-id');
                const $el = $(this);
                positions[id] = {
                    x: parseInt($el.css('left'), 10) || 0,
                    y: parseInt($el.css('top'), 10) || 0,
                    w: $el.outerWidth() || 0,
                    h: $el.outerHeight() || 0,
                    z: parseInt($el.css('z-index'), 10) || 100,
                };
            });
        } catch (e) {
            warn('layout-manager: capturePositions failed', e);
        }
        return positions;
    }

    /**
     * Apply saved window positions to live windows.
     * @param {Record<string, object>} windows
     */
    #restorePositions(windows = {}) {
        try {
            for (const [id, pos] of Object.entries(windows)) {
                const $win = $(`.fd-window[data-window-id="${id}"]`);
                if (!$win.length) continue;
                $win.css({
                    left: pos.x,
                    top: pos.y,
                    width: pos.w || '',
                    height: pos.h || '',
                    'z-index': pos.z || 100,
                });
            }
        } catch (e) {
            warn('layout-manager: restorePositions failed', e);
        }
    }
}

/* ─── Default singleton export ──────────────────────────────────────────── */
export const faeLayoutManager = new FaeLayoutManager();
export default faeLayoutManager;
