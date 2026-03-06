/**
 * fae.desktop — wallpaper.js
 * Simple wallpaper manager.
 * Manages the #fd-wallpaper element: image source, fit, blur, and dim overlay.
 */

'use strict';

export class FaeWallpaper {
    /** @type {HTMLElement|null} */
    #wallpaperEl = null;
    /** @type {HTMLElement|null} */
    #dimEl = null;
    /** @type {MutationObserver|null} */
    #stBgObserver = null;
    /** @type {boolean} */
    #useSTBackground = false;
    /** Current settings snapshot */
    #settings = null;

    /* ── Public API ──────────────────────────────────────────────────────── */

    /**
     * Initialise wallpaper from settings on load.
     * @param {{ useSTBackground: boolean, customUrl: string, fit: string, blur: number, dim: number }} settings
     */
    init(settings = {}) {
        this.#settings = settings;
        this.#ensureElements();

        const s = settings;
        if (s.fit)       this.setFit(s.fit);
        if (s.blur != null)  this.setBlur(s.blur);
        if (s.dim  != null)  this.setDim(s.dim);

        if (s.useSTBackground) {
            this.useSTBackground();
        } else if (s.customUrl) {
            this.setWallpaper(s.customUrl);
        }
    }

    /**
     * Set the wallpaper to an arbitrary URL.
     * @param {string} url
     */
    setWallpaper(url) {
        this.#stopSTObserver();
        this.#useSTBackground = false;

        this.#ensureElements();
        if (!url) {
            this.#wallpaperEl.style.backgroundImage = 'none';
            return;
        }

        // Pre-check the image loads, then apply
        const img = new Image();
        img.onload  = () => {
            if (this.#wallpaperEl) {
                this.#wallpaperEl.style.backgroundImage = `url("${this.#sanitizeUrl(url)}")`;
            }
        };
        img.onerror = () => {
            console.warn('[fae.desktop] wallpaper.js: Failed to load image:', url);
        };
        img.src = url;
    }

    /**
     * Read SillyTavern's current background and mirror it to #fd-wallpaper.
     * Also observes for changes (when the user changes the ST background).
     */
    useSTBackground() {
        this.#ensureElements();
        this.#useSTBackground = true;
        this.#applySTBackground();

        // Watch for ST background changes via MutationObserver on #bg_load_img
        this.#stopSTObserver();
        const stImg = document.getElementById('bg_load_img');
        if (stImg) {
            this.#stBgObserver = new MutationObserver(() => this.#applySTBackground());
            this.#stBgObserver.observe(stImg, { attributes: true, attributeFilter: ['src'] });
        }

        // Also watch #bg_custom if it exists
        const stCustom = document.querySelector('#bg_display img, #bg_custom');
        if (stCustom) {
            const obs2 = new MutationObserver(() => this.#applySTBackground());
            obs2.observe(stCustom, { attributes: true, subtree: true });
            this.#stBgObserver = this.#stBgObserver
                ? { disconnect: () => { this.#stBgObserver?.disconnect(); obs2.disconnect(); } }
                : obs2;
        }
    }

    /**
     * Set background-size / background-repeat for the given fit mode.
     * @param {'cover'|'contain'|'tile'} fit
     */
    setFit(fit) {
        this.#ensureElements();
        const el = this.#wallpaperEl;
        if (fit === 'cover') {
            el.style.backgroundSize   = 'cover';
            el.style.backgroundRepeat = 'no-repeat';
        } else if (fit === 'contain') {
            el.style.backgroundSize   = 'contain';
            el.style.backgroundRepeat = 'no-repeat';
        } else if (fit === 'tile') {
            el.style.backgroundSize   = 'auto';
            el.style.backgroundRepeat = 'repeat';
        }
        el.style.backgroundPosition = 'center center';
    }

    /**
     * Apply a CSS blur filter to the wallpaper element.
     * @param {number} px — blur radius in pixels (0 = no blur)
     */
    setBlur(px) {
        this.#ensureElements();
        const val = Math.max(0, parseFloat(px) || 0);
        this.#wallpaperEl.style.filter = val > 0 ? `blur(${val}px)` : '';
        // Compensate for blur edges — scale slightly when blurred
        this.#wallpaperEl.style.transform = val > 0
            ? `scale(${1 + val * 0.004})`
            : '';
    }

    /**
     * Set the dim overlay opacity.
     * @param {number} percent — 0–90
     */
    setDim(percent) {
        this.#ensureElements();
        const val = Math.max(0, Math.min(90, parseFloat(percent) || 0));
        this.#dimEl.style.opacity = String(val / 100);
    }

    /** Clean up observers and DOM elements. */
    destroy() {
        this.#stopSTObserver();
        if (this.#wallpaperEl && this.#wallpaperEl.parentNode) {
            this.#wallpaperEl.parentNode.removeChild(this.#wallpaperEl);
        }
        if (this.#dimEl && this.#dimEl.parentNode) {
            this.#dimEl.parentNode.removeChild(this.#dimEl);
        }
        this.#wallpaperEl = null;
        this.#dimEl       = null;
        this.#settings    = null;
    }

    /* ── Private ─────────────────────────────────────────────────────────── */

    #ensureElements() {
        const root = document.getElementById('fd-root') || document.body;

        // Wallpaper element
        if (!this.#wallpaperEl || !document.contains(this.#wallpaperEl)) {
            let el = document.getElementById('fd-wallpaper');
            if (!el) {
                el = document.createElement('div');
                el.id = 'fd-wallpaper';
                // Insert as first child so everything renders on top
                root.insertBefore(el, root.firstChild);
            }
            Object.assign(el.style, {
                position:           'fixed',
                inset:              '0',
                backgroundPosition: 'center center',
                backgroundSize:     'cover',
                backgroundRepeat:   'no-repeat',
                zIndex:             '0',
                willChange:         'transform',
                transition:         'opacity 0.4s ease, filter 0.4s ease',
            });
            this.#wallpaperEl = el;
        }

        // Dim overlay element
        if (!this.#dimEl || !document.contains(this.#dimEl)) {
            let dim = document.getElementById('fd-wallpaper-dim');
            if (!dim) {
                dim = document.createElement('div');
                dim.id = 'fd-wallpaper-dim';
                if (this.#wallpaperEl.parentNode) {
                    this.#wallpaperEl.parentNode.insertBefore(dim, this.#wallpaperEl.nextSibling);
                } else {
                    root.insertBefore(dim, root.children[1] || null);
                }
            }
            Object.assign(dim.style, {
                position:   'fixed',
                inset:      '0',
                background: '#000000',
                opacity:    '0',
                zIndex:     '0',
                pointerEvents: 'none',
                transition: 'opacity 0.3s ease',
            });
            this.#dimEl = dim;
        }
    }

    /**
     * Read SillyTavern's background from its DOM and apply to wallpaper element.
     * ST stores the background image on #bg_load_img (an <img>), or as a
     * CSS background-image on #bg_blurry / #bg_display.
     */
    #applySTBackground() {
        if (!this.#useSTBackground) return;

        // Try #bg_load_img first (most common in newer ST versions)
        const stImg = /** @type {HTMLImageElement|null} */ (document.getElementById('bg_load_img'));
        if (stImg && stImg.src && !stImg.src.endsWith('#')) {
            this.#wallpaperEl.style.backgroundImage = `url("${stImg.src}")`;
            return;
        }

        // Fallback: read computed background from #bg_blurry or body
        const candidates = ['#bg_blurry', '#bg_display', 'body'];
        for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el) {
                const bg = getComputedStyle(el).backgroundImage;
                if (bg && bg !== 'none') {
                    this.#wallpaperEl.style.backgroundImage = bg;
                    return;
                }
            }
        }

        // Nothing found — clear
        this.#wallpaperEl.style.backgroundImage = 'none';
    }

    #stopSTObserver() {
        if (this.#stBgObserver) {
            this.#stBgObserver.disconnect();
            this.#stBgObserver = null;
        }
    }

    /**
     * Basic URL sanitisation — strips dangerous protocols.
     * @param {string} url
     * @returns {string}
     */
    #sanitizeUrl(url) {
        try {
            const u = new URL(url, location.href);
            if (u.protocol === 'javascript:' || u.protocol === 'data:') return '';
            return url;
        } catch {
            return url;
        }
    }
}

/* ─── Default singleton export ──────────────────────────────────────────── */
export const faeWallpaper = new FaeWallpaper();
export default faeWallpaper;
