/**
 * fae.desktop — widget-api.js
 *
 * Factory function that creates a sandboxed DesktopWidget API instance for
 * each loaded widget.  Each instance is scoped to a single widgetId and can
 * only read/write its own data namespace inside extensionSettings.fae_desktop.
 *
 * Usage (inside widget-loader.js):
 *   const api = createWidgetAPI(widgetId, manifest, $contentElement);
 *   // pass `api` to the widget's script.js eval scope
 *   api.destroy(); // on unload — removes all registered listeners
 *
 * Conventions:
 *   - All ST interactions go through SillyTavern.getContext()
 *   - jQuery ($) is used for DOM work
 *   - ES module export
 */

import { log, warn } from './utils.js';
import { MODULE_NAME } from './settings.js';

// ---------------------------------------------------------------------------
// SillyTavern event name constants
// (ST dispatches these via its own eventSource / EventEmitter system)
// ---------------------------------------------------------------------------

/**
 * Best-effort resolution of ST's event name constants.
 * ST exposes them as  SillyTavern.getContext().eventTypes  (object) or via
 * the global  event_types  object in older builds.
 * We fall back to the known string values so the API works even if the
 * resolution path changes between ST versions.
 */
function _getEventTypes() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.eventTypes) return ctx.eventTypes;
    } catch { /* ignore */ }
    // Fallback string constants (verified against ST source)
    return {
        CHAT_CHANGED:               'chatChanged',
        MESSAGE_RECEIVED:           'messageReceived',
        CHARACTER_MESSAGE_RENDERED: 'characterMessageRendered',
        USER_MESSAGE_RENDERED:      'userMessageRendered',
        MESSAGE_DELETED:            'messageDeleted',
        MESSAGE_EDITED:             'messageEdited',
        APP_READY:                  'appReady',
        SETTINGS_UPDATED:           'settingsUpdated',
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the live fae_desktop settings object (never null — returns {} on error).
 * @returns {object}
 */
function _getSettings() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx?.extensionSettings?.[MODULE_NAME] ?? {};
    } catch {
        return {};
    }
}

/**
 * Ensure widgetData[widgetId] exists with both settings and data sub-objects.
 * @param {string} widgetId
 * @returns {{ settings: object, data: object }}
 */
function _ensureWidgetNamespace(widgetId) {
    const settings = _getSettings();
    if (!settings.widgetData) settings.widgetData = {};
    if (!settings.widgetData[widgetId]) {
        settings.widgetData[widgetId] = { settings: {}, data: {} };
    }
    const ns = settings.widgetData[widgetId];
    if (!ns.settings) ns.settings = {};
    if (!ns.data)     ns.data     = {};
    return ns;
}

/**
 * Call ST's saveSettingsDebounced (soft fail if unavailable).
 */
function _save() {
    try {
        const ctx = SillyTavern.getContext();
        ctx?.saveSettingsDebounced?.();
    } catch (e) {
        warn('widget-api: saveSettingsDebounced failed', e);
    }
}

// ---------------------------------------------------------------------------
// createWidgetAPI
// ---------------------------------------------------------------------------

/**
 * Factory — creates a sandboxed DesktopWidget API object for one widget.
 *
 * @param {string}      widgetId         — unique widget id (e.g. 'notes', 'clock')
 * @param {object}      widgetManifest   — parsed widget.json object
 * @param {jQuery}      $contentElement  — the .fd-window-content jQuery element
 * @returns {DesktopWidget}
 */
export function createWidgetAPI(widgetId, widgetManifest, $contentElement) {
    if (!widgetId || typeof widgetId !== 'string') {
        throw new Error('createWidgetAPI: widgetId must be a non-empty string');
    }

    // -----------------------------------------------------------------------
    // Internal state for this instance
    // -----------------------------------------------------------------------

    /** @type {Array<{ eventName: string, callback: Function }>} */
    const _listeners = [];

    /** @type {Function|null} */
    let _onActivateCb   = null;

    /** @type {Function|null} */
    let _onDeactivateCb = null;

    /** Whether destroy() has been called. */
    let _destroyed = false;

    // -----------------------------------------------------------------------
    // Internal helpers scoped to this instance
    // -----------------------------------------------------------------------

    /**
     * Get the ST eventSource (the EventEmitter used for listening to ST events).
     * Returns null if unavailable.
     * @returns {object|null}
     */
    function _getEventSource() {
        try {
            const ctx = SillyTavern.getContext();
            return ctx?.eventSource ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Register an ST event listener and track it for cleanup.
     * @param {string}   eventName
     * @param {Function} callback
     */
    function _addListener(eventName, callback) {
        if (_destroyed) {
            warn(`widget-api [${widgetId}]: on() called after destroy()`);
            return;
        }
        const source = _getEventSource();
        if (!source) {
            warn(`widget-api [${widgetId}]: eventSource unavailable — cannot listen to "${eventName}"`);
            return;
        }
        source.on(eventName, callback);
        _listeners.push({ eventName, callback });
        log(`widget-api [${widgetId}]: registered listener for "${eventName}"`);
    }

    /**
     * Remove a previously registered ST event listener (both from ST and our
     * internal tracking array).
     * @param {string}   eventName
     * @param {Function} callback
     */
    function _removeListener(eventName, callback) {
        const source = _getEventSource();
        if (source) {
            try {
                source.removeListener(eventName, callback);
            } catch (e) {
                warn(`widget-api [${widgetId}]: removeListener failed for "${eventName}"`, e);
            }
        }
        const idx = _listeners.findIndex(
            (l) => l.eventName === eventName && l.callback === callback,
        );
        if (idx !== -1) _listeners.splice(idx, 1);
    }

    // -----------------------------------------------------------------------
    // Window open/close callbacks — fired by widget-loader when window is
    // shown/hidden via fd:window-focused / fd:window-closed events.
    // -----------------------------------------------------------------------

    /**
     * Called by widget-loader when this widget's window is opened/focused.
     * @internal
     */
    function _fireActivate() {
        if (typeof _onActivateCb === 'function') {
            try { _onActivateCb(); } catch (e) {
                warn(`widget-api [${widgetId}]: onActivate callback threw`, e);
            }
        }
    }

    /**
     * Called by widget-loader when this widget's window is closed/minimized.
     * @internal
     */
    function _fireDeactivate() {
        if (typeof _onDeactivateCb === 'function') {
            try { _onDeactivateCb(); } catch (e) {
                warn(`widget-api [${widgetId}]: onDeactivate callback threw`, e);
            }
        }
    }

    // Listen for fd:window events on document so the API fires lifecycle hooks
    // even when the widget-loader doesn't call _fireActivate/_fireDeactivate directly.
    const _onWindowFocused = (e) => {
        const detail = (e.originalEvent || e).detail;
        if (detail?.id === widgetId) _fireActivate();
    };
    const _onWindowClosed = (e) => {
        const detail = (e.originalEvent || e).detail;
        if (detail?.id === widgetId) _fireDeactivate();
    };
    const _onWindowMinimized = (e) => {
        const detail = (e.originalEvent || e).detail;
        if (detail?.id === widgetId) _fireDeactivate();
    };

    $(document).on(`fd:window-focused.wapi-${widgetId}`,   _onWindowFocused);
    $(document).on(`fd:window-closed.wapi-${widgetId}`,    _onWindowClosed);
    $(document).on(`fd:window-minimized.wapi-${widgetId}`, _onWindowMinimized);

    // -----------------------------------------------------------------------
    // The public DesktopWidget object
    // -----------------------------------------------------------------------

    const DesktopWidget = {

        // -------------------------------------------------------------------
        // Settings helpers
        // -------------------------------------------------------------------

        /**
         * Read a setting from the widget manifest's defaults, with user
         * overrides applied on top.
         *
         * Lookup order:
         *   1. extensionSettings.fae_desktop.widgetData[id].settings[key]
         *   2. widgetManifest.settings[key]  (the manifest default)
         *   3. undefined
         *
         * @param {string} key
         * @returns {*}
         */
        getSetting(key) {
            const ns = _ensureWidgetNamespace(widgetId);
            if (key in ns.settings) return ns.settings[key];
            // Fall through to manifest defaults
            const manifestSettings = widgetManifest?.settings ?? {};
            return manifestSettings[key];
        },

        /**
         * Save a user setting override for this widget.
         * Stored under extensionSettings.fae_desktop.widgetData[id].settings[key].
         *
         * @param {string} key
         * @param {*}      value
         */
        setSetting(key, value) {
            const ns = _ensureWidgetNamespace(widgetId);
            ns.settings[key] = value;
            _save();
            log(`widget-api [${widgetId}]: setSetting ${key} =`, value);
        },

        // -------------------------------------------------------------------
        // ST context helpers
        // -------------------------------------------------------------------

        /**
         * Returns the raw SillyTavern context object.
         * @returns {object}
         */
        getContext() {
            try {
                return SillyTavern.getContext();
            } catch (e) {
                warn(`widget-api [${widgetId}]: getContext() failed`, e);
                return {};
            }
        },

        /**
         * Returns the currently active character object, or null.
         * @returns {object|null}
         */
        getCharacter() {
            try {
                const ctx = SillyTavern.getContext();
                const charId = ctx?.characterId;
                if (charId == null) return null;
                return ctx?.characters?.[charId] ?? null;
            } catch {
                return null;
            }
        },

        /**
         * Returns the index/ID of the currently active character, or null.
         * @returns {number|string|null}
         */
        getCharacterId() {
            try {
                const ctx = SillyTavern.getContext();
                return ctx?.characterId ?? null;
            } catch {
                return null;
            }
        },

        // -------------------------------------------------------------------
        // Event subscription
        // -------------------------------------------------------------------

        /**
         * Subscribe to an ST event by name.
         * The listener is tracked and will be removed automatically on destroy().
         *
         * @param {string}   eventName  — ST event name (see _getEventTypes())
         * @param {Function} callback
         */
        on(eventName, callback) {
            if (typeof callback !== 'function') {
                warn(`widget-api [${widgetId}]: on() — callback is not a function`);
                return;
            }
            _addListener(eventName, callback);
        },

        /**
         * Remove a previously registered ST event listener.
         *
         * @param {string}   eventName
         * @param {Function} callback
         */
        off(eventName, callback) {
            _removeListener(eventName, callback);
        },

        // -------------------------------------------------------------------
        // Lifecycle shorthands
        // -------------------------------------------------------------------

        /**
         * Register a callback to be fired when this widget's window is opened
         * or focused.
         * @param {Function} callback
         */
        onActivate(callback) {
            if (typeof callback !== 'function') return;
            _onActivateCb = callback;
        },

        /**
         * Register a callback to be fired when this widget's window is closed
         * or minimized.
         * @param {Function} callback
         */
        onDeactivate(callback) {
            if (typeof callback !== 'function') return;
            _onDeactivateCb = callback;
        },

        /**
         * Shorthand for listening to the CHAT_CHANGED ST event.
         * @param {Function} callback  — receives no arguments (chat context changed)
         */
        onChatChanged(callback) {
            const types = _getEventTypes();
            this.on(types.CHAT_CHANGED, callback);
        },

        /**
         * Shorthand for listening to the MESSAGE_RECEIVED ST event.
         * The callback receives the message object as its first argument.
         *
         * @param {Function} callback  — receives (messageObject)
         */
        onMessage(callback) {
            const types = _getEventTypes();
            this.on(types.MESSAGE_RECEIVED, callback);
        },

        // -------------------------------------------------------------------
        // DOM
        // -------------------------------------------------------------------

        /**
         * Returns the widget's content container as a jQuery element.
         * This is the same element that was passed as $contentElement.
         *
         * @returns {jQuery}
         */
        getElement() {
            return $contentElement;
        },

        // -------------------------------------------------------------------
        // Persistent data store
        // -------------------------------------------------------------------

        /**
         * Read a value from this widget's persistent data namespace.
         * Stored under extensionSettings.fae_desktop.widgetData[id].data[key].
         *
         * @param {string} key
         * @param {*}      [fallback]
         * @returns {*}
         */
        getData(key, fallback = undefined) {
            const ns = _ensureWidgetNamespace(widgetId);
            return key in ns.data ? ns.data[key] : fallback;
        },

        /**
         * Write a value into this widget's persistent data namespace.
         * Call saveData() afterwards if you want to debounce multiple writes.
         *
         * @param {string} key
         * @param {*}      value
         */
        setData(key, value) {
            const ns = _ensureWidgetNamespace(widgetId);
            ns.data[key] = value;
            log(`widget-api [${widgetId}]: setData ${key} =`, value);
        },

        /**
         * Persist all pending data/setting changes via saveSettingsDebounced.
         */
        saveData() {
            _save();
        },

        // -------------------------------------------------------------------
        // Notifications
        // -------------------------------------------------------------------

        /**
         * Show a toast notification via toastr (ST's built-in notification lib).
         *
         * @param {string} message
         * @param {'info'|'success'|'warning'|'error'} [type='info']
         */
        showToast(message, type = 'info') {
            const validTypes = ['info', 'success', 'warning', 'error'];
            const toastType = validTypes.includes(type) ? type : 'info';
            try {
                if (typeof toastr !== 'undefined' && typeof toastr[toastType] === 'function') {
                    toastr[toastType](message);
                } else {
                    // Fallback: alert-style via ST's context if toastr unavailable
                    const ctx = SillyTavern.getContext();
                    if (ctx?.callPopup) {
                        ctx.callPopup(message, 'text');
                    } else {
                        console.info(`[fae.desktop widget: ${widgetId}]`, message);
                    }
                }
            } catch (e) {
                warn(`widget-api [${widgetId}]: showToast failed`, e);
            }
        },

        // -------------------------------------------------------------------
        // Internal lifecycle hooks (called by widget-loader)
        // -------------------------------------------------------------------

        /** @internal — called by widget-loader on window open */
        _fireActivate,

        /** @internal — called by widget-loader on window close */
        _fireDeactivate,

        // -------------------------------------------------------------------
        // Cleanup
        // -------------------------------------------------------------------

        /**
         * Remove all registered ST event listeners and DOM event handlers.
         * Called automatically by widget-loader when the widget is unloaded.
         */
        destroy() {
            if (_destroyed) return;
            _destroyed = true;

            // Remove all tracked ST event listeners
            const source = _getEventSource();
            if (source) {
                for (const { eventName, callback } of _listeners) {
                    try {
                        source.removeListener(eventName, callback);
                    } catch {
                        /* ignore errors during cleanup */
                    }
                }
            }
            _listeners.length = 0;

            // Remove document-level fd:window-* listeners
            $(document).off(`.wapi-${widgetId}`);

            // Clear lifecycle callbacks
            _onActivateCb   = null;
            _onDeactivateCb = null;

            log(`widget-api [${widgetId}]: destroyed`);
        },
    };

    log(`widget-api [${widgetId}]: created`);
    return DesktopWidget;
}
