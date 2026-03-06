/**
 * fae.desktop — dock.js
 *
 * macOS-style dock at the bottom of the #fd-root container.
 *
 * Features:
 *   - System items: Chat 💬, Character 👤, Settings ⚙️
 *   - Separator, widget items (dynamic), separator, Trash 🗑️
 *   - Magnification effect with gaussian-ish falloff (requestAnimationFrame)
 *   - Bounce animation on icon (.fd-dock-bounce keyframe)
 *   - Auto-hide: slides off-screen; reappears when mouse nears bottom
 *   - Active window indicator dot under the focused window's icon
 *   - Cross-module communication via 'fd:dock-action' CustomEvent
 *
 * Public API:
 *   dock.init(container)
 *   dock.destroy()
 *   dock.addItem(id, icon, label, position)
 *   dock.removeItem(id)
 *   dock.setActive(id)
 *   dock.bounce(id)
 *   dock.updateMagnificationSettings(enabled, scale, iconSize)
 */

import { log, warn, clamp } from './utils.js';
import { readSetting } from './settings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pixels from the bottom viewport edge that trigger auto-hide reveal. */
const AUTOHIDE_TRIGGER_PX = 4;

/** Number of icon widths over which magnification falls off. */
const MAG_FALLOFF_ICONS = 3;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {jQuery|null} The #fd-dock element. */
let _$dock = null;

/** @type {jQuery|null} The .fd-dock-inner element. */
let _$inner = null;

/** @type {jQuery|null} The container passed to init(). */
let _$container = null;

/** @type {number|null} requestAnimationFrame handle. */
let _rafId = null;

/** @type {{ x: number, y: number }|null} Latest mouse position (relative to viewport). */
let _mouse = null;

/** @type {boolean} Whether a magnification rAF tick is pending. */
let _rafPending = false;

/** Whether auto-hide is currently engaged (dock is slid off-screen). */
let _isHidden = false;

/** Whether auto-hide mode is enabled at all. */
let _autoHide = false;

/** @type {number|null} setInterval id for auto-hide proximity check. */
let _autoHideCheckId = null;

/** Map of widgetId → dock item jQuery elements (for addItem/removeItem). */
const _widgetItems = new Map();

/** id of the currently "active" dock item. */
let _activeId = null;

// Magnification settings (live, updated by updateMagnificationSettings)
let _magEnabled  = true;
let _magScale    = 1.5;
let _iconSize    = 48;   // px — the base (un-magnified) icon size

// ---------------------------------------------------------------------------
// Dock HTML structure helpers
// ---------------------------------------------------------------------------

/**
 * Build a single dock item jQuery element.
 *
 * @param {string}  id
 * @param {string}  icon        — emoji or HTML string
 * @param {string}  label       — tooltip / visible label
 * @param {string}  [action]    — optional data-fd-action attribute
 * @param {boolean} [closable]  — if true item renders a small ×-indicator (trash)
 * @returns {jQuery}
 */
function _makeItem(id, icon, label, action, closable = false) {
    const $item = $('<div>', {
        class:  'fd-dock-item',
        'data-fd-id':     id,
        'data-fd-action': action || id,
        title:  label,
    });

    const $iconWrap = $('<div>', { class: 'fd-dock-icon-wrap' });
    const $icon     = $('<div>', { class: 'fd-dock-icon' }).html(icon);
    const $dot      = $('<div>', { class: 'fd-dock-active-dot' });
    const $label    = $('<div>', { class: 'fd-dock-label' }).text(label);

    $iconWrap.append($icon, $dot);
    $item.append($iconWrap, $label);

    return $item;
}

/** Build a separator element. */
function _makeSeparator() {
    return $('<div>', { class: 'fd-dock-separator' });
}

// ---------------------------------------------------------------------------
// init / destroy
// ---------------------------------------------------------------------------

/**
 * Create and mount the dock inside `container`.
 * @param {jQuery} $container  — should be #fd-root
 */
export function init($container) {
    if (_$dock) {
        warn('dock.init: already initialised, skipping');
        return;
    }

    _$container = $container;

    // Read initial settings
    const dockSettings = readSetting('dock');
    _autoHide   = Boolean(dockSettings.autoHide);
    _magEnabled = Boolean(dockSettings.magnification);
    _magScale   = Number(dockSettings.magnificationScale) || 1.5;
    _iconSize   = Number(dockSettings.iconSize) || 48;

    // Build DOM
    _$dock  = $('<div>', { id: 'fd-dock', class: 'fd-dock', role: 'toolbar', 'aria-label': 'Dock' });
    _$inner = $('<div>', { class: 'fd-dock-inner' });

    // ---- System items ----
    _$inner.append(_makeItem('fd-chat',     '💬', 'Chat',      'focus:fd-chat'));
    _$inner.append(_makeItem('fd-charinfo', '👤', 'Character', 'toggle:fd-charinfo'));
    _$inner.append(_makeItem('fd-settings', '⚙️', 'Settings',  'toggle:fd-settings'));

    // ---- Widget area (initially empty) ----
    _$inner.append(_makeSeparator().addClass('fd-dock-sep-widgets-start'));
    // (Widget items are inserted here dynamically)
    _$inner.append(_makeSeparator().addClass('fd-dock-sep-widgets-end'));

    // ---- Trash ----
    _$inner.append(_makeItem('fd-trash', '🗑️', 'Close All Windows', 'close-all-widgets'));

    _$dock.append(_$inner);
    $container.append(_$dock);

    // Apply dock CSS variables
    _applyCSSVars();

    // Auto-hide class
    _$dock.toggleClass('fd-dock-autohide', _autoHide);

    // ---- Event listeners ----
    _bindEvents();

    // ---- Auto-hide setup ----
    if (_autoHide) {
        _startAutoHide();
    }

    // Listen for window-focus events to update active dot
    $(document).on('fd:window-focused.dock', (e) => {
        _setActiveFromEvent(e.originalEvent || e);
    });

    // Listen for close/hide events to clear active dot
    $(document).on('fd:window-closed.dock fd:window-minimized.dock', (e) => {
        const id = (e.originalEvent || e).detail?.id;
        if (id && _activeId === id) {
            setActive(null);
        }
    });

    log('dock: initialised');
}

/**
 * Destroy the dock: remove DOM, cancel timers, unbind events.
 */
export function destroy() {
    if (!_$dock) return;

    _stopMagnification();
    _stopAutoHide();

    $(document).off('.dock');
    $(document).off('mousemove.dock-mag');

    _$dock.remove();
    _$dock   = null;
    _$inner  = null;
    _$container = null;
    _widgetItems.clear();
    _activeId = null;

    log('dock: destroyed');
}

// ---------------------------------------------------------------------------
// CSS variable helpers
// ---------------------------------------------------------------------------

function _applyCSSVars() {
    if (!_$dock || !_$dock[0]) return;
    _$dock[0].style.setProperty('--fd-dock-icon-size-current', `${_iconSize}px`);
    _$dock[0].style.setProperty('--fd-dock-mag-scale', String(_magScale));
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function _bindEvents() {
    if (!_$dock) return;

    // Click dispatch
    _$dock.on('click.dock', '.fd-dock-item', _onItemClick);

    // Magnification
    _$dock.on('mouseenter.dock', () => {
        if (_magEnabled) _startMagnification();
    });

    _$dock.on('mouseleave.dock', () => {
        _stopMagnification();
        _resetItemScales();
    });

    // Mouse position tracking for magnification
    $(document).on('mousemove.dock-mag', (e) => {
        _mouse = { x: e.clientX, y: e.clientY };
        if (_magEnabled && !_rafPending && _$dock && _$dock.is(':hover')) {
            _rafPending = true;
            _rafId = requestAnimationFrame(_tickMagnification);
        }
    });

    // Auto-hide: show dock when mouse near bottom
    $(document).on('mousemove.dock-autohide', (e) => {
        if (!_autoHide) return;
        const distFromBottom = window.innerHeight - e.clientY;
        if (_isHidden && distFromBottom <= AUTOHIDE_TRIGGER_PX + _iconSize + 20) {
            _showDock();
        } else if (!_isHidden && distFromBottom > _iconSize + 40) {
            // hide if mouse moved well away from dock area
            _hideDock();
        }
    });
}

// ---------------------------------------------------------------------------
// Click handler
// ---------------------------------------------------------------------------

function _onItemClick(e) {
    e.stopPropagation();

    const $item  = $(e.currentTarget);
    const action = $item.data('fd-action') || '';
    const id     = $item.data('fd-id') || '';

    if (!action) return;

    // Parse action string: "focus:fd-chat", "toggle:fd-charinfo", "close-all-widgets"
    if (action === 'close-all-widgets') {
        _dispatch('fd:dock-action', { action: 'close-all-widgets' });
        return;
    }

    const colonIdx = action.indexOf(':');
    if (colonIdx !== -1) {
        const verb   = action.slice(0, colonIdx);   // 'focus' | 'toggle'
        const target = action.slice(colonIdx + 1);  // e.g. 'fd-chat'
        _dispatch('fd:dock-action', { action: verb, target });
    } else {
        // Widget items: action === widgetId → emit toggle
        _dispatch('fd:dock-action', { action: 'toggle', target: action });
    }
}

function _dispatch(eventName, detail) {
    document.dispatchEvent(new CustomEvent(eventName, {
        bubbles: false,
        cancelable: false,
        detail,
    }));
}

// ---------------------------------------------------------------------------
// Magnification
// ---------------------------------------------------------------------------

function _startMagnification() {
    if (_rafPending) return;
    _rafPending = true;
    _rafId = requestAnimationFrame(_tickMagnification);
}

function _stopMagnification() {
    if (_rafId !== null) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
    }
    _rafPending = false;
}

/**
 * One rAF tick: read current mouse position, compute per-item scale,
 * apply CSS transform to each .fd-dock-icon-wrap.
 */
function _tickMagnification() {
    _rafPending = false;

    if (!_$dock || !_$inner || !_mouse) return;
    if (!_magEnabled) { _resetItemScales(); return; }

    const items = _$inner.find('.fd-dock-item').toArray();
    if (!items.length) return;

    // The falloff radius: MAG_FALLOFF_ICONS * current icon size
    const radius = MAG_FALLOFF_ICONS * _iconSize;

    items.forEach((el) => {
        const $el   = $(el);
        const rect  = el.getBoundingClientRect();
        const cx    = rect.left + rect.width  / 2;
        const cy    = rect.top  + rect.height / 2;

        const dist  = Math.hypot(_mouse.x - cx, _mouse.y - cy);

        // Gaussian-ish falloff: scale = 1 + (maxExtra) * e^(-dist²/(2σ²))
        // where σ = radius/2 gives a natural bell curve over the falloff range.
        const sigma    = radius / 2;
        const extra    = _magScale - 1.0;
        const scale    = 1.0 + extra * Math.exp(-(dist * dist) / (2 * sigma * sigma));

        $el.find('.fd-dock-icon-wrap').css('transform', `scale(${scale.toFixed(4)})`);

        // Also nudge the icon upward proportionally (classic macOS dock lift)
        const lift = (_iconSize * (scale - 1)) * 0.5;
        $el.find('.fd-dock-icon-wrap').css('transform-origin', 'bottom center');
        $el.find('.fd-dock-icon-wrap').css({
            transform: `scale(${scale.toFixed(4)}) translateY(${(-lift).toFixed(1)}px)`,
        });
    });

    // Schedule next tick if mouse is still over the dock
    if (_$dock.is(':hover')) {
        _rafPending = true;
        _rafId = requestAnimationFrame(_tickMagnification);
    }
}

function _resetItemScales() {
    if (!_$inner) return;
    _$inner.find('.fd-dock-icon-wrap').css({ transform: '', 'transform-origin': '' });
}

// ---------------------------------------------------------------------------
// Auto-hide
// ---------------------------------------------------------------------------

function _startAutoHide() {
    _autoHide = true;
    _$dock && _$dock.addClass('fd-dock-autohide');
    // Initially hide if mouse is not near bottom
    const distFromBottom = window.innerHeight - (_mouse?.y ?? 0);
    if (distFromBottom > _iconSize + 40) {
        _hideDock();
    }
}

function _stopAutoHide() {
    _autoHide = false;
    if (_autoHideCheckId !== null) {
        clearInterval(_autoHideCheckId);
        _autoHideCheckId = null;
    }
    $(document).off('mousemove.dock-autohide');
    _showDock();
    _$dock && _$dock.removeClass('fd-dock-autohide');
}

function _hideDock() {
    if (_isHidden || !_$dock) return;
    _isHidden = true;
    _$dock.addClass('fd-dock-hidden');
}

function _showDock() {
    if (!_isHidden || !_$dock) return;
    _isHidden = false;
    _$dock.removeClass('fd-dock-hidden');
}

// ---------------------------------------------------------------------------
// Active indicator
// ---------------------------------------------------------------------------

function _setActiveFromEvent(nativeEvent) {
    if (!nativeEvent?.detail?.id) return;
    setActive(nativeEvent.detail.id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a widget dock item.
 *
 * @param {string} id       — widget id (also used as action target)
 * @param {string} icon     — emoji or HTML
 * @param {string} label    — tooltip text
 * @param {number} [position]  — 0-based insertion index within widget area;
 *                               defaults to appending before the end separator
 */
export function addItem(id, icon, label, position) {
    if (!_$inner) { warn('dock.addItem: dock not initialised'); return; }
    if (_widgetItems.has(id)) { warn(`dock.addItem: item "${id}" already exists`); return; }

    const $item = _makeItem(id, icon, label, id);
    _widgetItems.set(id, $item);

    const $endSep = _$inner.find('.fd-dock-sep-widgets-end');

    if (typeof position === 'number') {
        // Count existing widget items
        const $existing = _$inner.find('.fd-dock-item[data-fd-widget]');
        if (position >= $existing.length) {
            $endSep.before($item);
        } else {
            $existing.eq(position).before($item);
        }
    } else {
        $endSep.before($item);
    }

    $item.attr('data-fd-widget', 'true');

    log(`dock.addItem: added "${id}"`);
}

/**
 * Remove a widget dock item by id.
 * @param {string} id
 */
export function removeItem(id) {
    const $item = _widgetItems.get(id);
    if (!$item) return;
    $item.remove();
    _widgetItems.delete(id);
    if (_activeId === id) setActive(null);
    log(`dock.removeItem: removed "${id}"`);
}

/**
 * Mark a dock item as active (show the indicator dot).
 * Pass null / undefined to clear all active states.
 *
 * @param {string|null} id
 */
export function setActive(id) {
    _activeId = id || null;
    if (!_$inner) return;

    _$inner.find('.fd-dock-item').each(function () {
        const $el = $(this);
        const isActive = $el.data('fd-id') === id;
        $el.toggleClass('fd-dock-item-active', isActive);
        $el.find('.fd-dock-active-dot').toggleClass('fd-dock-dot-visible', isActive);
    });
}

/**
 * Trigger the bounce animation on an item (e.g. Chat on new message).
 * @param {string} id
 */
export function bounce(id) {
    if (!_$inner) return;
    const $item = _$inner.find(`.fd-dock-item[data-fd-id="${CSS.escape(id)}"]`);
    if (!$item.length) return;

    // Remove class, force reflow, re-add for re-trigger
    $item.removeClass('fd-dock-bounce');
    void $item[0].offsetWidth; // reflow
    $item.addClass('fd-dock-bounce');

    $item.one('animationend', () => {
        $item.removeClass('fd-dock-bounce');
    });

    log(`dock.bounce: "${id}"`);
}

/**
 * Update magnification settings at runtime.
 * @param {boolean} enabled
 * @param {number}  scale       — e.g. 1.5
 * @param {number}  iconSize    — base icon size in px
 */
export function updateMagnificationSettings(enabled, scale, iconSize) {
    _magEnabled = Boolean(enabled);
    _magScale   = Number(scale)    || 1.5;
    _iconSize   = Number(iconSize) || 48;

    _applyCSSVars();

    if (!_magEnabled) {
        _stopMagnification();
        _resetItemScales();
    }
}

// ---------------------------------------------------------------------------
// Default export (module object)
// ---------------------------------------------------------------------------

export default {
    init,
    destroy,
    addItem,
    removeItem,
    setActive,
    bounce,
    updateMagnificationSettings,
};
