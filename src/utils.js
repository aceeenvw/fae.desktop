/**
 * fae.desktop — utils.js
 * Shared utility functions for the fae.desktop extension.
 * All helpers are pure / side-effect-free unless explicitly noted.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive the extension's base URL from this module's own import.meta.url.
 *  Works whether ST serves extensions from /extensions/… or /scripts/extensions/…
 *  because we resolve relative to ourselves at runtime.
 */
const _baseUrl = (() => {
    try {
        // import.meta.url → e.g. http://localhost:8000/scripts/extensions/fae.desktop/src/utils.js
        const url = new URL(import.meta.url);
        // Walk up one directory (from src/ to fae.desktop/)
        url.pathname = url.pathname.replace(/\/src\/utils\.js$/, '/');
        return url.href;
    } catch {
        // Fallback: try to derive from script tags (rare fallback)
        const scripts = document.querySelectorAll('script[src*="fae.desktop"]');
        if (scripts.length) {
            const src = scripts[scripts.length - 1].src;
            return src.replace(/\/[^/]+$/, '/');
        }
        return '/scripts/extensions/fae.desktop/';
    }
})();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[fae.desktop]';

/**
 * Console logger gated by the debug flag in extension settings.
 * Uses SillyTavern.getContext() to read the current debug flag so it always
 * reflects the live setting without needing a module restart.
 *
 * @param  {...any} args  — anything console.log accepts
 */
export function log(...args) {
    try {
        const ctx = SillyTavern.getContext();
        const settings = ctx?.extensionSettings?.fae_desktop;
        if (!settings?.advanced?.debug) return;
    } catch {
        // If context is not yet available, suppress unless forced
        return;
    }
    console.log(LOG_PREFIX, ...args);
}

/**
 * Always-visible warning logger (not gated by debug flag).
 * @param  {...any} args
 */
export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

/**
 * Always-visible error logger.
 * @param  {...any} args
 */
export function error(...args) {
    console.error(LOG_PREFIX, ...args);
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a value between min and max (inclusive).
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

// ---------------------------------------------------------------------------
// Function timing helpers
// ---------------------------------------------------------------------------

/**
 * Returns a debounced version of fn that delays invocation by `ms` milliseconds.
 * The timer resets on every call. The last invocation wins.
 *
 * @param {Function} fn
 * @param {number}   ms   — delay in milliseconds
 * @returns {Function}
 */
export function debounce(fn, ms) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, ms);
    };
}

/**
 * Returns a throttled version of fn that fires at most once per `ms` milliseconds.
 * The first call fires immediately; subsequent calls within the window are dropped.
 *
 * @param {Function} fn
 * @param {number}   ms   — minimum interval in milliseconds
 * @returns {Function}
 */
export function throttle(fn, ms) {
    let lastCall = 0;
    let timer = null;
    return function throttled(...args) {
        const now = Date.now();
        const remaining = ms - (now - lastCall);
        if (remaining <= 0) {
            clearTimeout(timer);
            timer = null;
            lastCall = now;
            fn.apply(this, args);
        } else if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                lastCall = Date.now();
                fn.apply(this, args);
            }, remaining);
        }
    };
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a random short alphanumeric ID (8 characters).
 * Uses crypto.getRandomValues when available for better entropy.
 *
 * @returns {string}  e.g. "k7x2mq9a"
 */
export function generateId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const len = 8;
    try {
        const arr = new Uint8Array(len);
        crypto.getRandomValues(arr);
        return Array.from(arr, (b) => chars[b % chars.length]).join('');
    } catch {
        // Fallback for environments without crypto
        let id = '';
        for (let i = 0; i < len; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }
}

// ---------------------------------------------------------------------------
// CSS injection
// ---------------------------------------------------------------------------

/**
 * Inject (or replace) a <style> element identified by `id`.
 * If a <style data-fae-id="id"> already exists it will be replaced in place,
 * preserving its position in <head> so cascade order stays stable.
 *
 * @param {string} id       — unique identifier for this style block
 * @param {string} cssText  — raw CSS text to inject
 */
export function injectCSS(id, cssText) {
    const attrKey = 'data-fae-id';
    let el = document.querySelector(`style[${attrKey}="${id}"]`);
    if (!el) {
        el = document.createElement('style');
        el.setAttribute(attrKey, id);
        document.head.appendChild(el);
    }
    el.textContent = cssText;
    log(`injectCSS: updated style block "${id}"`);
}

/**
 * Inject (or replace) a <link rel="stylesheet"> element for an external CSS file.
 * Useful for loading skin files by URL.
 *
 * @param {string} id    — unique identifier (data-fae-id attribute)
 * @param {string} href  — URL of the CSS file
 * @returns {Promise<void>} resolves when the stylesheet has loaded
 */
export function injectCSSLink(id, href) {
    return new Promise((resolve, reject) => {
        const attrKey = 'data-fae-id';
        let el = document.querySelector(`link[${attrKey}="${id}"]`);

        // Compare normalized URLs — el.href is fully resolved, href may be relative.
        // Use URL constructor to normalize both for reliable comparison.
        if (el) {
            try {
                const existingUrl = new URL(el.href, document.baseURI).href;
                const newUrl = new URL(href, document.baseURI).href;
                if (existingUrl === newUrl) {
                    resolve();
                    return;
                }
            } catch {
                // If URL parsing fails, fall through to replacement
            }
            el.remove();
        }

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute(attrKey, id);
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`fae.desktop: failed to load CSS "${href}"`));
        document.head.appendChild(link);
        log(`injectCSSLink: loading "${href}"`);
    });
}

/**
 * Remove a previously injected style block or link element by its fae id.
 *
 * @param {string} id
 */
export function removeCSS(id) {
    const attrKey = 'data-fae-id';
    const el = document.querySelector(`[${attrKey}="${id}"]`);
    if (el) {
        el.remove();
        log(`removeCSS: removed style block "${id}"`);
    }
}

// ---------------------------------------------------------------------------
// DOM / CSS value helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a value has a 'px' suffix.
 * Accepts numbers or strings. If the value already ends in a CSS unit, it is
 * returned unchanged. If it is a plain number or numeric string, 'px' is appended.
 *
 * @param {number|string} val
 * @returns {string}  e.g. px(40) → "40px", px("100%") → "100%"
 */
export function px(val) {
    if (typeof val === 'number') return `${val}px`;
    if (typeof val === 'string') {
        // Already has a unit (px, em, rem, %, vh, vw, etc.)
        if (/[a-z%]+$/i.test(val.trim())) return val.trim();
        const num = parseFloat(val);
        return isNaN(num) ? val : `${num}px`;
    }
    return String(val);
}

// ---------------------------------------------------------------------------
// Extension path
// ---------------------------------------------------------------------------

/**
 * Returns the base URL path for the fae.desktop extension.
 * Used for constructing asset URLs (skin CSS files, widget HTML, etc.).
 * Trailing slash is always included.
 *
 * @returns {string}  e.g. "http://localhost:8000/scripts/extensions/fae.desktop/"
 */
export function getExtensionPath() {
    return _baseUrl;
}

/**
 * Resolve a path relative to the extension's base directory.
 *
 * @param  {...string} parts  — path segments to join
 * @returns {string}          — full URL
 *
 * @example
 *   resolveExtensionPath('skins', 'macos.css')
 *   // → "http://localhost:8000/scripts/extensions/fae.desktop/skins/macos.css"
 */
export function resolveExtensionPath(...parts) {
    const base = _baseUrl.endsWith('/') ? _baseUrl : _baseUrl + '/';
    const relative = parts.join('/').replace(/^\/+/, '');
    return base + relative;
}

// ---------------------------------------------------------------------------
// Misc DOM helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the DOM to contain an element matching `selector`.
 * Polls every `interval` ms, resolves after at most `timeout` ms.
 *
 * @param {string} selector
 * @param {number} [timeout=5000]
 * @param {number} [interval=50]
 * @returns {Promise<Element>}
 */
export function waitForElement(selector, timeout = 5000, interval = 50) {
    return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) { resolve(el); return; }
        const start = Date.now();
        const timer = setInterval(() => {
            const found = document.querySelector(selector);
            if (found) {
                clearInterval(timer);
                resolve(found);
            } else if (Date.now() - start >= timeout) {
                clearInterval(timer);
                reject(new Error(`fae.desktop: waitForElement timed out for "${selector}"`));
            }
        }, interval);
    });
}

/**
 * Deep-set a value on a nested object using a dot-separated key path.
 * Creates intermediate objects as needed.
 *
 * @param {object} obj   — target object (mutated in place)
 * @param {string} path  — e.g. 'dock.autoHide'
 * @param {*}      value — value to assign
 */
export function deepSet(obj, path, value) {
    const parts = path.split('.');
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (cursor[key] === null || typeof cursor[key] !== 'object') {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
}

/**
 * Deep-get a value from a nested object using a dot-separated key path.
 *
 * @param {object} obj
 * @param {string} path
 * @param {*}      [fallback=undefined]
 * @returns {*}
 */
export function deepGet(obj, path, fallback = undefined) {
    const parts = path.split('.');
    let cursor = obj;
    for (const key of parts) {
        if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) {
            return fallback;
        }
        cursor = cursor[key];
    }
    return cursor;
}

/**
 * Deep merge source into target (mutates target).
 * Only plain objects are merged recursively; arrays and primitives are overwritten.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object} target
 */
export function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (
            source[key] !== null &&
            typeof source[key] === 'object' &&
            !Array.isArray(source[key]) &&
            target[key] !== null &&
            typeof target[key] === 'object' &&
            !Array.isArray(target[key])
        ) {
            deepMerge(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}
