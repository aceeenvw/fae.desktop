/**
 * fae.desktop — widget-loader.js
 *
 * Discovers, loads, and manages both built-in and custom widgets.
 *
 * Widget directory layout (under widgets/<id>/):
 *   widget.json    — manifest: { id, name, icon, description, version, settings, defaultSize, minSize }
 *   content.html   — widget body HTML (sanitised with DOMPurify before injection)
 *   style.css      — optional; scoped to .fd-widget-<id>
 *   script.js      — optional; receives DesktopWidget API instance as argument
 *
 * Public API:
 *   widgetLoader.scanWidgets()               — discover + load all widgets
 *   widgetLoader.loadWidget(manifest, base)  — load one widget by manifest + base URL
 *   widgetLoader.importWidgetFromUrl(url)    — import from GitHub raw URL
 *   widgetLoader.getLoadedWidgets()          — Map<id, { manifest, window, api }>
 *   widgetLoader.unloadWidget(id)            — unload one widget cleanly
 *   widgetLoader.destroy()                   — unload all widgets
 *
 * Conventions:
 *   - jQuery ($) for DOM
 *   - ES module export
 *   - CSS classes / IDs use fd- prefix
 */

import { log, warn, error, injectCSS, removeCSS, resolveExtensionPath } from './utils.js';
import { getSettings, MODULE_NAME } from './settings.js';
import { FDWindow, windowManager }  from './window-manager.js';
import { createWidgetAPI }          from './widget-api.js';
import * as dock                    from './dock.js';
import * as menubar                 from './menubar.js';

// ---------------------------------------------------------------------------
// Built-in widget IDs — subfolders under widgets/
// ---------------------------------------------------------------------------

const BUILTIN_WIDGET_IDS = ['notes', 'gallery', 'clock', 'status', 'now-playing', 'quicklinks'];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Registry of all successfully loaded widgets.
 * @type {Map<string, { manifest: object, fdWindow: FDWindow, api: object, cssId: string|null }>}
 */
const _loaded = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve DOMPurify from SillyTavern.libs (preferred) or fall back to
 * the global  DOMPurify  if the extension ships with it.
 * @returns {object|null}  DOMPurify instance or null
 */
function _getDOMPurify() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.libs?.DOMPurify) return ctx.libs.DOMPurify;
    } catch { /* ignore */ }
    if (typeof DOMPurify !== 'undefined') return DOMPurify;
    warn('widget-loader: DOMPurify not available — widget HTML will not be sanitised');
    return null;
}

/**
 * Sanitise an HTML string with DOMPurify.
 * Falls back to the raw string if DOMPurify is unavailable (logs a warning).
 *
 * @param {string} html
 * @returns {string}
 */
function _sanitise(html) {
    const dp = _getDOMPurify();
    if (!dp) return html;
    return dp.sanitize(html, {
        // Allow basic inline styles and common attributes needed by widget UIs.
        ADD_TAGS:  ['style'],
        ADD_ATTR:  ['style', 'class', 'id', 'data-*'],
        FORBID_TAGS: ['script'],  // scripts are loaded separately, never via innerHTML
        FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
}

/**
 * Fetch a text resource.  Returns null on any network error (logged as warning).
 *
 * @param {string}  url
 * @param {boolean} [required=false]  — if true, errors are logged as errors not warnings
 * @returns {Promise<string|null>}
 */
async function _fetchText(url, required = false) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            if (required) {
                error(`widget-loader: failed to fetch "${url}" — HTTP ${resp.status}`);
            } else {
                log(`widget-loader: optional file not found at "${url}" (HTTP ${resp.status})`);
            }
            return null;
        }
        return await resp.text();
    } catch (e) {
        const logFn = required ? error : warn;
        logFn(`widget-loader: fetch error for "${url}"`, e);
        return null;
    }
}

/**
 * Fetch and parse a JSON resource.  Returns null on failure.
 *
 * @param {string} url
 * @returns {Promise<object|null>}
 */
async function _fetchJSON(url) {
    const text = await _fetchText(url, false);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        warn(`widget-loader: invalid JSON at "${url}"`, e);
        return null;
    }
}

/**
 * Ensure the widgetStates namespace for `id` exists in settings.
 * @param {string} id
 * @returns {{ open:boolean, x:number, y:number, w:number, h:number }}
 */
function _getWidgetState(id) {
    const settings = getSettings();
    if (!settings.widgetStates)     settings.widgetStates = {};
    if (!settings.widgetStates[id]) settings.widgetStates[id] = { open: false };
    return settings.widgetStates[id];
}

/**
 * Persist the open/closed state of a widget window.
 * @param {string}  id
 * @param {boolean} open
 */
function _saveWidgetOpenState(id, open) {
    try {
        const settings = getSettings();
        if (!settings.widgetStates)     settings.widgetStates = {};
        if (!settings.widgetStates[id]) settings.widgetStates[id] = {};
        settings.widgetStates[id].open = open;
        const ctx = SillyTavern.getContext();
        ctx?.saveSettingsDebounced?.();
    } catch (e) {
        warn('widget-loader: could not persist widget state', e);
    }
}

/**
 * Inject a scoped <style> block for a widget, prefixed with the scope selector.
 *
 * @param {string} widgetId
 * @param {string} cssText  — raw CSS from style.css
 * @returns {string}        — the CSS id used (for removal later)
 */
function _injectWidgetCSS(widgetId, cssText) {
    const scope  = `.fd-widget-${widgetId}`;
    const cssId  = `fd-widget-css-${widgetId}`;

    // Naïve scope injection: prefix every rule block that doesn't start with
    // @-rules (@keyframes, @media, etc.) with the scope selector.
    // For @media we inject the scope inside the block.
    const scoped = _scopeCSS(cssText, scope);
    injectCSS(cssId, scoped);
    return cssId;
}

/**
 * Scope raw CSS text to a given selector.
 * Handles @media blocks, @keyframes, and @supports.
 * Each non-at rule selector is prefixed with `scope`.
 *
 * @param {string} css
 * @param {string} scope  — e.g. '.fd-widget-clock'
 * @returns {string}
 */
function _scopeCSS(css, scope) {
    // We do a regex-based pass — sufficient for simple widget stylesheets.
    // This is intentionally basic; full CSSOM parsing would be over-engineered
    // for widget-level styles that are expected to be modest in complexity.

    const result = [];
    // Split on { and } to detect rule blocks
    // We track depth so @media nesting is handled
    let depth = 0;
    let buffer = '';
    let inAtBlock = false;     // inside @media / @supports outer block
    let atBlockScope = false;  // whether we need to scope inside this @block

    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
            depth++;
            if (depth === 1) {
                const selector = buffer.trim();
                buffer = '';
                if (/^@(media|supports|document)/i.test(selector)) {
                    // We're opening an @media / @supports block
                    inAtBlock     = true;
                    atBlockScope  = true;
                    result.push(selector + ' {');
                } else if (/^@/.test(selector)) {
                    // @keyframes etc. — pass through verbatim
                    inAtBlock    = true;
                    atBlockScope = false;
                    result.push(selector + ' {');
                } else {
                    // Regular rule — scope each comma-separated selector
                    const scopedSelector = selector
                        .split(',')
                        .map((s) => {
                            const trimmed = s.trim();
                            if (!trimmed) return '';
                            // :root and html selectors stay at global scope
                            if (/^(:root|html|body)/.test(trimmed)) return trimmed;
                            return `${scope} ${trimmed}`;
                        })
                        .filter(Boolean)
                        .join(', ');
                    result.push(scopedSelector + ' {');
                }
            } else if (inAtBlock && atBlockScope && depth === 2) {
                // Inside @media: scope the inner rule selectors
                const selector = buffer.trim();
                buffer = '';
                const scopedSelector = selector
                    .split(',')
                    .map((s) => {
                        const trimmed = s.trim();
                        if (!trimmed) return '';
                        if (/^(:root|html|body)/.test(trimmed)) return trimmed;
                        return `${scope} ${trimmed}`;
                    })
                    .filter(Boolean)
                    .join(', ');
                result.push(scopedSelector + ' {');
            } else {
                buffer += ch;
            }
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                result.push(buffer + '}');
                buffer = '';
                inAtBlock    = false;
                atBlockScope = false;
            } else if (inAtBlock && depth === 1) {
                result.push(buffer + '}');
                buffer = '';
            } else {
                buffer += ch;
            }
        } else {
            buffer += ch;
        }
    }

    return result.join('\n');
}

/**
 * Execute a widget's script.js in an isolated function scope.
 * The function receives the DesktopWidget API as its only argument.
 *
 * We use an indirect eval (via Function constructor) so:
 *   - The widget script can't access the widget-loader's own closure.
 *   - The widget script DOES have access to globals (window, $, etc.).
 *
 * @param {string} scriptText      — raw JS source from script.js
 * @param {string} widgetId        — for error messages
 * @param {object} DesktopWidget   — the API instance to pass in
 */
function _execWidgetScript(scriptText, widgetId, DesktopWidget) {
    try {
        // Wrap in an IIFE that receives the API as `DesktopWidget`
        // eslint-disable-next-line no-new-func
        const fn = new Function('DesktopWidget', `"use strict";\n${scriptText}`);
        fn(DesktopWidget);
        log(`widget-loader [${widgetId}]: script executed`);
    } catch (e) {
        error(`widget-loader [${widgetId}]: script execution failed`, e);
    }
}

// ---------------------------------------------------------------------------
// scanWidgets
// ---------------------------------------------------------------------------

/**
 * Discover all built-in widgets from the widgets/ folder and load each one.
 * Also restores any previously imported custom widgets whose base paths are
 * stored in settings.
 *
 * @returns {Promise<void>}
 */
export async function scanWidgets() {
    log('widget-loader: scanning built-in widgets');

    const base = resolveExtensionPath('widgets');

    // Load built-in widgets in parallel
    const results = await Promise.allSettled(
        BUILTIN_WIDGET_IDS.map((id) => {
            const widgetBase = `${base}/${id}`;
            return _loadWidgetFromPath(widgetBase, id);
        }),
    );

    results.forEach((result, idx) => {
        if (result.status === 'rejected') {
            warn(`widget-loader: failed to load built-in widget "${BUILTIN_WIDGET_IDS[idx]}"`, result.reason);
        }
    });

    // Restore custom/imported widgets (stored in settings)
    const settings = getSettings();
    const customWidgets = settings.customWidgets ?? {};
    for (const [id, entry] of Object.entries(customWidgets)) {
        if (_loaded.has(id)) continue; // already loaded above (shouldn't happen)
        try {
            await _loadWidgetFromPath(entry.basePath, id);
        } catch (e) {
            warn(`widget-loader: failed to restore custom widget "${id}"`, e);
        }
    }

    log(`widget-loader: scan complete — ${_loaded.size} widget(s) loaded`);
}

// ---------------------------------------------------------------------------
// _loadWidgetFromPath (internal helper used by scanWidgets + importWidgetFromUrl)
// ---------------------------------------------------------------------------

/**
 * Load a widget given its base URL (folder URL, no trailing slash needed).
 * Fetches widget.json, then delegates to loadWidget().
 *
 * @param {string} basePath  — URL to the widget folder
 * @param {string} [hintId]  — optional id hint for logging (before manifest is parsed)
 * @returns {Promise<void>}
 */
async function _loadWidgetFromPath(basePath, hintId = '') {
    const normalBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    const manifestUrl = `${normalBase}/widget.json`;

    const manifest = await _fetchJSON(manifestUrl);
    if (!manifest) {
        warn(`widget-loader: no valid widget.json at "${manifestUrl}" — skipping "${hintId}"`);
        return;
    }

    if (!manifest.id) {
        warn(`widget-loader: widget.json missing "id" at "${manifestUrl}" — skipping`);
        return;
    }

    await loadWidget(manifest, normalBase);
}

// ---------------------------------------------------------------------------
// loadWidget
// ---------------------------------------------------------------------------

/**
 * Load a single widget:
 *   1. Fetch content.html → sanitise
 *   2. Create an FDWindow for it via window-manager
 *   3. Inject HTML into window content area
 *   4. If style.css exists, inject scoped CSS
 *   5. If script.js exists, create a DesktopWidget API and execute the script
 *   6. Register in dock + menubar
 *   7. Apply saved open/closed state from settings
 *
 * @param {object} manifest  — parsed widget.json
 * @param {string} basePath  — base URL for the widget's files (no trailing slash)
 * @returns {Promise<void>}
 */
export async function loadWidget(manifest, basePath) {
    const { id, name, icon = '🔲', defaultSize, minSize } = manifest;

    if (!id) {
        warn('widget-loader: loadWidget called with manifest missing "id"');
        return;
    }

    if (_loaded.has(id)) {
        warn(`widget-loader: widget "${id}" is already loaded — skipping`);
        return;
    }

    log(`widget-loader: loading widget "${id}" from "${basePath}"`);

    const normalBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

    // -----------------------------------------------------------------------
    // 1. Fetch content.html
    // -----------------------------------------------------------------------

    const rawHtml = await _fetchText(`${normalBase}/content.html`, true);
    if (rawHtml === null) {
        warn(`widget-loader: "${id}" has no content.html — skipping`);
        return;
    }
    const safeHtml = _sanitise(rawHtml);

    // -----------------------------------------------------------------------
    // 2. Create FDWindow
    // -----------------------------------------------------------------------

    const savedState = _getWidgetState(id);

    const fdWindow = new FDWindow(id, {
        title:           name || id,
        icon:            '',               // widgets use emoji icon in dock
        content:         '',               // injected below after setup
        closable:        true,
        resizable:       true,
        minSize:         minSize   ?? { w: 200, h: 160 },
        defaultSize:     defaultSize ?? { w: 360, h: 300 },
        defaultPosition: { x: 100 + (_loaded.size * 30), y: 80 + (_loaded.size * 30) },
        onClose: () => _saveWidgetOpenState(id, false),
        onMinimize: () => _saveWidgetOpenState(id, false),
        onFocus: () => _saveWidgetOpenState(id, true),
    });

    // Mount into #fd-workspace
    fdWindow.mount($('#fd-workspace'));

    // -----------------------------------------------------------------------
    // 3. Inject sanitised HTML
    // -----------------------------------------------------------------------

    const $content = fdWindow.getContentElement();
    // Add scoped class to window content for CSS scoping
    $content.addClass(`fd-widget-${id}`);
    $content.html(safeHtml);

    // -----------------------------------------------------------------------
    // 4. Optional style.css — scoped to .fd-widget-<id>
    // -----------------------------------------------------------------------

    let cssId = null;
    const cssText = await _fetchText(`${normalBase}/style.css`, false);
    if (cssText) {
        cssId = _injectWidgetCSS(id, cssText);
        log(`widget-loader [${id}]: scoped CSS injected`);
    }

    // -----------------------------------------------------------------------
    // 5. Optional script.js — DesktopWidget API + eval
    // -----------------------------------------------------------------------

    const api = createWidgetAPI(id, manifest, $content);

    const scriptText = await _fetchText(`${normalBase}/script.js`, false);
    if (scriptText) {
        _execWidgetScript(scriptText, id, api);
    }

    // -----------------------------------------------------------------------
    // 6. Register in dock + menubar
    // -----------------------------------------------------------------------

    try {
        dock.addItem(id, icon, name || id, 'after-widgets-start');
    } catch (e) {
        warn(`widget-loader [${id}]: dock.addItem failed`, e);
    }

    try {
        menubar.registerWidget(id, name || id, icon);
    } catch (e) {
        warn(`widget-loader [${id}]: menubar.registerWidget failed`, e);
    }

    // -----------------------------------------------------------------------
    // 7. Apply saved open/closed state
    // -----------------------------------------------------------------------

    if (savedState.open) {
        fdWindow.show();
        // Restore geometry if saved
        if (savedState.x != null && savedState.w) {
            fdWindow._applyGeometry({
                x: savedState.x,
                y: savedState.y ?? 80,
                w: savedState.w,
                h: savedState.h ?? (defaultSize?.h ?? 300),
            }, false);
        }
        windowManager.register(fdWindow);
        dock.setActive(id);
    } else {
        fdWindow.hide();
        windowManager.register(fdWindow);
    }

    // Track geometry changes so we can persist them
    $(document).on(`fd:window-moved.wloader-${id}`, (e) => {
        const detail = (e.originalEvent || e).detail;
        if (detail?.id !== id) return;
        try {
            const settings = getSettings();
            if (!settings.widgetStates)    settings.widgetStates = {};
            if (!settings.widgetStates[id]) settings.widgetStates[id] = {};
            Object.assign(settings.widgetStates[id], {
                x: detail.x, y: detail.y, w: detail.w, h: detail.h,
            });
            const ctx = SillyTavern.getContext();
            ctx?.saveSettingsDebounced?.();
        } catch { /* non-critical */ }
    });

    // -----------------------------------------------------------------------
    // Register in loaded map
    // -----------------------------------------------------------------------

    _loaded.set(id, { manifest, fdWindow, api, cssId });

    log(`widget-loader: widget "${id}" loaded successfully`);
}

// ---------------------------------------------------------------------------
// importWidgetFromUrl
// ---------------------------------------------------------------------------

/**
 * Import a widget from a GitHub raw file URL (or any HTTP URL pointing to a
 * folder that follows the widget directory convention).
 *
 * For GitHub repository URLs of the form:
 *   https://github.com/user/repo/tree/main/my-widget
 * we convert them to the raw content base:
 *   https://raw.githubusercontent.com/user/repo/main/my-widget
 *
 * For already-raw URLs we use them directly.
 *
 * The function fetches widget.json from the resolved base URL and delegates
 * to loadWidget().  On success it persists the widget's base URL in settings
 * so it survives a page refresh.
 *
 * @param {string} githubUrl  — GitHub tree URL or raw base URL
 * @returns {Promise<{ success: boolean, id: string|null, error: string|null }>}
 */
export async function importWidgetFromUrl(githubUrl) {
    if (!githubUrl || typeof githubUrl !== 'string') {
        return { success: false, id: null, error: 'Invalid URL' };
    }

    let baseUrl = githubUrl.trim();

    // Convert github.com/…/tree/… → raw.githubusercontent.com/…
    const ghTreeMatch = baseUrl.match(
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/,
    );
    if (ghTreeMatch) {
        const [, user, repo, branch, path] = ghTreeMatch;
        baseUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`;
    }

    // Ensure no trailing slash
    baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

    log(`widget-loader: importing widget from "${baseUrl}"`);

    // Fetch manifest
    const manifest = await _fetchJSON(`${baseUrl}/widget.json`);
    if (!manifest || !manifest.id) {
        const msg = `Could not fetch a valid widget.json from "${baseUrl}"`;
        warn('widget-loader:', msg);
        return { success: false, id: null, error: msg };
    }

    const { id } = manifest;

    if (_loaded.has(id)) {
        const msg = `Widget "${id}" is already loaded`;
        warn('widget-loader:', msg);
        return { success: false, id, error: msg };
    }

    try {
        await loadWidget(manifest, baseUrl);
    } catch (e) {
        const msg = `Failed to load widget "${id}": ${e?.message ?? e}`;
        error('widget-loader:', msg, e);
        return { success: false, id, error: msg };
    }

    // Persist the custom widget entry so it reloads on next init
    try {
        const settings = getSettings();
        if (!settings.customWidgets) settings.customWidgets = {};
        settings.customWidgets[id] = { basePath: baseUrl, importedAt: Date.now() };
        const ctx = SillyTavern.getContext();
        ctx?.saveSettingsDebounced?.();
    } catch (e) {
        warn('widget-loader: could not persist custom widget entry', e);
    }

    return { success: true, id, error: null };
}

// ---------------------------------------------------------------------------
// getLoadedWidgets
// ---------------------------------------------------------------------------

/**
 * Returns the map of all successfully loaded widgets.
 *
 * @returns {Map<string, { manifest: object, fdWindow: FDWindow, api: object, cssId: string|null }>}
 */
export function getLoadedWidgets() {
    return _loaded;
}

// ---------------------------------------------------------------------------
// unloadWidget
// ---------------------------------------------------------------------------

/**
 * Fully unload a widget:
 *   - Destroy its DesktopWidget API (clears all event listeners)
 *   - Remove its FDWindow from the DOM
 *   - Remove its scoped CSS
 *   - Unregister from dock + menubar
 *   - Remove it from the loaded registry
 *
 * @param {string} id
 */
export function unloadWidget(id) {
    const entry = _loaded.get(id);
    if (!entry) {
        warn(`widget-loader: unloadWidget — "${id}" is not loaded`);
        return;
    }

    const { fdWindow, api, cssId } = entry;

    // Destroy API (removes ST event listeners)
    try { api.destroy(); } catch (e) {
        warn(`widget-loader [${id}]: api.destroy() failed`, e);
    }

    // Remove from window manager + DOM
    try { windowManager.unregister(id); } catch { /* may already be gone */ }
    try { fdWindow.destroy(); } catch { /* may already be gone */ }

    // Remove scoped CSS
    if (cssId) {
        try { removeCSS(cssId); } catch { /* ignore */ }
    }

    // Remove geometry tracking listener
    $(document).off(`.wloader-${id}`);

    // Unregister from dock
    try { dock.removeItem(id); } catch (e) {
        warn(`widget-loader [${id}]: dock.removeItem() failed`, e);
    }

    // Unregister from menubar
    try { menubar.unregisterWidget(id); } catch (e) {
        warn(`widget-loader [${id}]: menubar.unregisterWidget() failed`, e);
    }

    _loaded.delete(id);
    log(`widget-loader: widget "${id}" unloaded`);
}

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

/**
 * Unload all currently loaded widgets.
 * Called by desktop.disable() / desktop.destroy().
 */
export function destroy() {
    const ids = [..._loaded.keys()];
    for (const id of ids) {
        unloadWidget(id);
    }
    log('widget-loader: all widgets unloaded');
}
