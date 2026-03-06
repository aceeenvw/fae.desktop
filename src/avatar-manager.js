/**
 * fae.desktop — avatar-manager.js
 *
 * Manages avatar display overrides in Desktop Mode.
 *
 * Features:
 *   - Avatar size (32–128 px) — CSS injected into #fd-chat .avatar img
 *   - Avatar shape presets — circle / rounded / square / hexagon
 *   - Per-character URL overrides (including data-URLs from local uploads)
 *   - Context-menu on right-click of .avatar elements inside #fd-chat
 *     (Change Avatar…, Upload Image…, Reset Avatar)
 *   - Responds to CHARACTER_MESSAGE_RENDERED + USER_MESSAGE_RENDERED to
 *     re-apply overrides after each new message render
 *
 * Public API:
 *   avatarManager.init(settings)
 *   avatarManager.applyAvatarSize(size)
 *   avatarManager.applyAvatarShape(shape)
 *   avatarManager.setAvatarOverride(charId, url)
 *   avatarManager.clearAvatarOverride(charId)
 *   avatarManager.onMessageRendered(messageIndex)
 *   avatarManager.setupContextMenu()
 *   avatarManager.destroy()
 *
 * Conventions:
 *   - jQuery ($) for DOM
 *   - All CSS class/IDs use fd- prefix
 *   - ES module export
 */

import { log, warn, clamp, injectCSS, removeCSS } from './utils.js';
import { getSettings, MODULE_NAME } from './settings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVATAR_SIZE_CSS_ID   = 'fd-avatar-size';
const AVATAR_SHAPE_CSS_ID  = 'fd-avatar-shape';
const CONTEXT_MENU_ID      = 'fd-avatar-ctx-menu';

/** Clamp range for avatar size (px). */
const SIZE_MIN = 32;
const SIZE_MAX = 128;

/** Valid shape values. */
const VALID_SHAPES = ['circle', 'rounded', 'square', 'hexagon'];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Whether the module has been initialised. */
let _initialized = false;

/** Whether destroy() has been called. */
let _destroyed = false;

/**
 * The currently active jQuery context-menu element, if visible.
 * @type {jQuery|null}
 */
let _$ctxMenu = null;

/**
 * The charId that the last right-click targeted (for context menu actions).
 * @type {string|null}
 */
let _ctxTargetCharId = null;

/**
 * The .avatar jQuery element that was right-clicked.
 * @type {jQuery|null}
 */
let _$ctxTargetAvatar = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the fae_desktop settings object.
 * @returns {object}
 */
function _getSettings() {
    try {
        return getSettings();
    } catch {
        return {};
    }
}

/**
 * Persist settings via ST's saveSettingsDebounced.
 */
function _save() {
    try {
        const ctx = SillyTavern.getContext();
        ctx?.saveSettingsDebounced?.();
    } catch (e) {
        warn('avatar-manager: saveSettingsDebounced failed', e);
    }
}

/**
 * Retrieve a message object from the current chat by its 0-based index.
 * @param {number} messageIndex
 * @returns {object|null}
 */
function _getMessage(messageIndex) {
    try {
        const ctx = SillyTavern.getContext();
        return ctx?.chat?.[messageIndex] ?? null;
    } catch {
        return null;
    }
}

/**
 * Dismiss the current context menu if it is visible.
 */
function _dismissContextMenu() {
    if (_$ctxMenu && _$ctxMenu.length) {
        _$ctxMenu.remove();
        _$ctxMenu = null;
    }
    _ctxTargetCharId    = null;
    _$ctxTargetAvatar   = null;
}

/**
 * Show ST's built-in text-input popup (Popup.show.input or callPopup fallback).
 *
 * @param {string}   title
 * @param {string}   [placeholder]
 * @param {string}   [defaultValue]
 * @returns {Promise<string|null>}  resolves to the entered text or null if cancelled
 */
async function _showInputPopup(title, placeholder = '', defaultValue = '') {
    try {
        const ctx = SillyTavern.getContext();
        // Prefer modern Popup API
        if (ctx?.Popup?.show?.input) {
            return await ctx.Popup.show.input(title, placeholder, defaultValue);
        }
        // Fallback: use callPopup with 'input' type (older ST builds)
        if (ctx?.callPopup) {
            return await ctx.callPopup(
                `<h3>${title}</h3><input id="fd-popup-input" type="text" value="${defaultValue}" placeholder="${placeholder}" style="width:100%;margin-top:8px"/>`,
                'confirm',
            ).then((confirmed) => {
                if (!confirmed) return null;
                return document.getElementById('fd-popup-input')?.value ?? null;
            });
        }
    } catch (e) {
        warn('avatar-manager: _showInputPopup failed', e);
    }
    // Final fallback: native browser prompt
    const result = window.prompt(title, defaultValue);
    return result; // null if cancelled
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * Initialise the avatar manager.
 * Applies saved settings (size, shape) and sets up event listeners.
 *
 * @param {object} [settings]  — fae_desktop settings object (optional; reads from
 *                               extensionSettings if omitted)
 */
export function init(settings) {
    if (_initialized) {
        warn('avatar-manager: already initialised');
        return;
    }
    _initialized = true;
    _destroyed   = false;

    const s = settings ?? _getSettings();

    // Apply persisted size/shape
    const avatarSize  = s?.chat?.avatarSize  ?? 40;
    const avatarShape = s?.chat?.avatarShape ?? 'circle';

    applyAvatarSize(avatarSize);
    applyAvatarShape(avatarShape);

    // Listen for ST message render events to apply overrides
    _bindSTEvents();

    // Set up right-click context menu
    setupContextMenu();

    log('avatar-manager: initialised');
}

// ---------------------------------------------------------------------------
// applyAvatarSize
// ---------------------------------------------------------------------------

/**
 * Override avatar image dimensions in the chat.
 * Injects a <style> block targeting  #fd-chat .avatar img.
 *
 * @param {number} size  — pixel size (clamped to 32–128)
 */
export function applyAvatarSize(size) {
    const clamped = clamp(Number(size) || 40, SIZE_MIN, SIZE_MAX);

    const css = `
#fd-chat .avatar img,
#fd-chat .mes_block .avatar img {
    width:      ${clamped}px !important;
    height:     ${clamped}px !important;
    min-width:  ${clamped}px !important;
    min-height: ${clamped}px !important;
    object-fit: cover !important;
}`;

    injectCSS(AVATAR_SIZE_CSS_ID, css);
    log(`avatar-manager: avatar size set to ${clamped}px`);
}

// ---------------------------------------------------------------------------
// applyAvatarShape
// ---------------------------------------------------------------------------

/**
 * Apply a shape style to all avatar images in the chat.
 *
 * @param {'circle'|'rounded'|'square'|'hexagon'} shape
 */
export function applyAvatarShape(shape) {
    if (!VALID_SHAPES.includes(shape)) {
        warn(`avatar-manager: unknown shape "${shape}" — defaulting to 'circle'`);
        shape = 'circle';
    }

    let shapeCSS = '';

    switch (shape) {
        case 'circle':
            shapeCSS = 'border-radius: 50% !important;';
            break;
        case 'rounded':
            shapeCSS = 'border-radius: 12px !important;';
            break;
        case 'square':
            shapeCSS = 'border-radius: 0 !important;';
            break;
        case 'hexagon':
            shapeCSS = [
                'border-radius: 0 !important;',
                'clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%) !important;',
            ].join('\n    ');
            break;
    }

    const css = `
#fd-chat .avatar img,
#fd-chat .mes_block .avatar img {
    ${shapeCSS}
}`;

    injectCSS(AVATAR_SHAPE_CSS_ID, css);
    log(`avatar-manager: avatar shape set to "${shape}"`);
}

// ---------------------------------------------------------------------------
// setAvatarOverride / clearAvatarOverride
// ---------------------------------------------------------------------------

/**
 * Store a custom avatar URL for a character.
 * Future message renders for this character will use this URL.
 *
 * @param {string|number} charId  — character index or id
 * @param {string}        url     — HTTP(S) URL or data: URL
 */
export function setAvatarOverride(charId, url) {
    if (!charId && charId !== 0) {
        warn('avatar-manager: setAvatarOverride — invalid charId');
        return;
    }
    const settings = _getSettings();
    if (!settings.avatarOverrides) settings.avatarOverrides = {};

    const key = String(charId);
    settings.avatarOverrides[key] = { url };
    _save();

    // Apply immediately to all rendered messages for this character
    _applyOverrideToAllMessages(key, url);

    log(`avatar-manager: override set for char "${key}"`);
}

/**
 * Remove the avatar override for a character, restoring the default ST avatar.
 *
 * @param {string|number} charId
 */
export function clearAvatarOverride(charId) {
    const key = String(charId);
    const settings = _getSettings();

    if (settings.avatarOverrides?.[key]) {
        delete settings.avatarOverrides[key];
        _save();
    }

    // Restore the original avatar src for all rendered messages of this character.
    // We mark the overridden elements with data-fd-original-src so we can restore.
    $(`#fd-chat .avatar img[data-fd-char="${key}"]`).each(function () {
        const $img = $(this);
        const original = $img.attr('data-fd-original-src');
        if (original) {
            $img.attr('src', original).removeAttr('data-fd-original-src');
        }
    });

    log(`avatar-manager: override cleared for char "${key}"`);
}

// ---------------------------------------------------------------------------
// onMessageRendered
// ---------------------------------------------------------------------------

/**
 * Called on CHARACTER_MESSAGE_RENDERED and USER_MESSAGE_RENDERED events.
 * Applies any active avatar override and re-applies size/shape CSS.
 *
 * ST passes the message index (0-based) as the event argument.
 *
 * @param {number} messageIndex
 */
export function onMessageRendered(messageIndex) {
    const message = _getMessage(messageIndex);
    if (!message) return;

    // Determine charId — use `character_id` for char messages, 'user' for user
    const charId = message.is_user
        ? null                           // user avatar uses ST's default; no override
        : String(message.character_id ?? message.charId ?? '');

    if (!charId) return;

    const settings = _getSettings();
    const override = settings.avatarOverrides?.[charId];

    if (!override?.url) return;

    // Find the message element in the DOM and apply the override to its avatar
    const $mes = $(`#fd-chat .mes[mesid="${messageIndex}"]`);
    if (!$mes.length) return;

    _applyOverrideToMessageElement($mes, charId, override.url);
}

// ---------------------------------------------------------------------------
// Internal: _applyOverrideToMessageElement
// ---------------------------------------------------------------------------

/**
 * Apply an override URL to the .avatar img inside a given message element.
 *
 * @param {jQuery}       $mes    — .mes element
 * @param {string}       charId  — for tagging the element
 * @param {string}       url     — override URL
 */
function _applyOverrideToMessageElement($mes, charId, url) {
    const $img = $mes.find('.avatar img');
    if (!$img.length) return;

    // Store original src on first override (for later restore via clearAvatarOverride)
    if (!$img.attr('data-fd-original-src')) {
        $img.attr('data-fd-original-src', $img.attr('src') || '');
    }

    $img
        .attr('src', url)
        .attr('data-fd-char', charId);
}

// ---------------------------------------------------------------------------
// Internal: _applyOverrideToAllMessages
// ---------------------------------------------------------------------------

/**
 * Apply an override URL to ALL currently rendered messages for a given charId.
 *
 * @param {string} charId
 * @param {string} url
 */
function _applyOverrideToAllMessages(charId, url) {
    // Each message element has a `ch_name` attribute or we rely on the message
    // being tagged.  Simplest approach: iterate all .mes elements and check if
    // their avatar data-fd-char matches, or re-derive charId from context.
    $(`#fd-chat .mes`).each(function () {
        const $mes    = $(this);
        const mesId   = parseInt($mes.attr('mesid'), 10);
        if (isNaN(mesId)) return;

        const message = _getMessage(mesId);
        if (!message || message.is_user) return;

        const mCharId = String(message.character_id ?? message.charId ?? '');
        if (mCharId !== charId) return;

        _applyOverrideToMessageElement($mes, charId, url);
    });
}

// ---------------------------------------------------------------------------
// ST event binding
// ---------------------------------------------------------------------------

/**
 * Subscribe to ST character/user message rendered events.
 */
function _bindSTEvents() {
    try {
        const ctx = SillyTavern.getContext();
        const types = ctx?.eventTypes ?? {
            CHARACTER_MESSAGE_RENDERED: 'characterMessageRendered',
            USER_MESSAGE_RENDERED:      'userMessageRendered',
        };

        const source = ctx?.eventSource;
        if (!source) {
            warn('avatar-manager: eventSource unavailable — message override will not auto-apply');
            return;
        }

        source.on(types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
        source.on(types.USER_MESSAGE_RENDERED,      onMessageRendered);

        log('avatar-manager: ST events bound');
    } catch (e) {
        warn('avatar-manager: failed to bind ST events', e);
    }
}

/**
 * Remove the ST event listeners.
 */
function _unbindSTEvents() {
    try {
        const ctx = SillyTavern.getContext();
        const types = ctx?.eventTypes ?? {
            CHARACTER_MESSAGE_RENDERED: 'characterMessageRendered',
            USER_MESSAGE_RENDERED:      'userMessageRendered',
        };

        const source = ctx?.eventSource;
        if (!source) return;

        source.removeListener(types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
        source.removeListener(types.USER_MESSAGE_RENDERED,      onMessageRendered);
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// setupContextMenu
// ---------------------------------------------------------------------------

/**
 * Attach a right-click handler to .avatar elements inside #fd-chat.
 * Shows a small popup with options:
 *   - Change Avatar… (URL input)
 *   - Upload Image…  (file picker → data URL)
 *   - Reset Avatar
 */
export function setupContextMenu() {
    // Remove any previous binding to avoid duplicates
    $(document).off('contextmenu.fd-avatar');
    $(document).off('click.fd-avatar-dismiss');

    $(document).on('contextmenu.fd-avatar', '#fd-chat .avatar', function (e) {
        e.preventDefault();
        e.stopPropagation();

        _dismissContextMenu();

        const $avatar = $(this);
        // Try to find the associated message element to determine charId
        const $mes   = $avatar.closest('.mes');
        const mesId  = parseInt($mes.attr('mesid'), 10);
        const message = isNaN(mesId) ? null : _getMessage(mesId);

        // charId: from message, or from data-fd-char on the img
        let charId = null;
        if (message && !message.is_user) {
            charId = String(message.character_id ?? message.charId ?? '');
        }
        if (!charId) {
            charId = $avatar.find('img').attr('data-fd-char') ?? null;
        }

        _ctxTargetCharId  = charId;
        _$ctxTargetAvatar = $avatar;

        // Build the menu
        const $menu = $('<div>', {
            id:    CONTEXT_MENU_ID,
            class: 'fd-ctx-menu',
            role:  'menu',
        });

        const _addMenuItem = (label, handler) => {
            const $item = $('<div>', { class: 'fd-ctx-menu-item', role: 'menuitem', tabindex: '0' })
                .text(label);
            $item.on('click', (ev) => {
                ev.stopPropagation();
                _dismissContextMenu();
                handler();
            });
            $item.on('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    $item.trigger('click');
                }
            });
            $menu.append($item);
        };

        _addMenuItem('Change Avatar…', _onChangeAvatar);
        _addMenuItem('Upload Image…',  _onUploadImage);

        if (charId) {
            const settings = _getSettings();
            const hasOverride = Boolean(settings.avatarOverrides?.[charId]?.url);
            if (hasOverride) {
                $menu.append($('<div>', { class: 'fd-ctx-menu-separator' }));
                _addMenuItem('Reset Avatar', _onResetAvatar);
            }
        }

        // Position the menu near the cursor, keeping it inside viewport
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;
        const MENU_W = 180; // approx
        const MENU_H = 120; // approx

        let left = e.clientX + 4;
        let top  = e.clientY + 4;
        if (left + MENU_W > viewW) left = e.clientX - MENU_W - 4;
        if (top  + MENU_H > viewH) top  = e.clientY - MENU_H - 4;
        left = Math.max(4, left);
        top  = Math.max(4, top);

        $menu.css({ position: 'fixed', left: `${left}px`, top: `${top}px`, zIndex: 99999 });

        $('body').append($menu);
        _$ctxMenu = $menu;

        // Focus first item for keyboard nav
        $menu.find('.fd-ctx-menu-item').first().trigger('focus');
    });

    // Dismiss on any click elsewhere
    $(document).on('click.fd-avatar-dismiss', (e) => {
        if (!_$ctxMenu) return;
        if (!$(e.target).closest(`#${CONTEXT_MENU_ID}`).length) {
            _dismissContextMenu();
        }
    });

    // Dismiss on Escape
    $(document).on('keydown.fd-avatar-dismiss', (e) => {
        if (e.key === 'Escape') _dismissContextMenu();
    });

    log('avatar-manager: context menu bound');
}

// ---------------------------------------------------------------------------
// Context menu action handlers
// ---------------------------------------------------------------------------

/**
 * "Change Avatar…" — prompt the user for a URL and apply it.
 */
async function _onChangeAvatar() {
    const charId = _ctxTargetCharId;
    if (!charId) {
        warn('avatar-manager: _onChangeAvatar — no charId');
        return;
    }

    const settings  = _getSettings();
    const existing  = settings.avatarOverrides?.[charId]?.url ?? '';

    const url = await _showInputPopup(
        'Enter avatar URL',
        'https://example.com/avatar.png',
        existing,
    );

    if (!url || !url.trim()) return;
    const trimmedUrl = url.trim();

    // Basic URL validation
    if (!trimmedUrl.startsWith('http') && !trimmedUrl.startsWith('data:') && !trimmedUrl.startsWith('/')) {
        try {
            if (typeof toastr !== 'undefined') {
                toastr.warning('Invalid URL format. Please enter a full URL starting with http(s)://');
            }
        } catch { /* ignore */ }
        return;
    }

    setAvatarOverride(charId, trimmedUrl);
}

/**
 * "Upload Image…" — open a file picker, read as data URL, apply it.
 */
function _onUploadImage() {
    const charId = _ctxTargetCharId;
    if (!charId) {
        warn('avatar-manager: _onUploadImage — no charId');
        return;
    }

    // Create a hidden file input
    const $input = $('<input>', {
        type:   'file',
        accept: 'image/*',
        style:  'display:none',
    });

    $('body').append($input);

    $input.on('change', function () {
        const file = this.files?.[0];
        if (!file) {
            $input.remove();
            return;
        }

        // Warn if the image is very large (data URL will be stored in settings)
        if (file.size > 2 * 1024 * 1024) { // > 2 MB
            try {
                if (typeof toastr !== 'undefined') {
                    toastr.warning('Large images may slow down settings save. Consider using a URL instead.');
                }
            } catch { /* ignore */ }
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target?.result;
            if (dataUrl) {
                setAvatarOverride(charId, dataUrl);
            }
            $input.remove();
        };
        reader.onerror = () => {
            warn('avatar-manager: FileReader error');
            $input.remove();
        };
        reader.readAsDataURL(file);
    });

    // Trigger file dialog
    $input[0].click();
}

/**
 * "Reset Avatar" — clear the override.
 */
function _onResetAvatar() {
    const charId = _ctxTargetCharId;
    if (!charId) return;
    clearAvatarOverride(charId);
}

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

/**
 * Remove all injected CSS, event listeners, and DOM elements created by this
 * module.
 */
export function destroy() {
    if (_destroyed) return;
    _destroyed   = true;
    _initialized = false;

    // Remove injected style blocks
    removeCSS(AVATAR_SIZE_CSS_ID);
    removeCSS(AVATAR_SHAPE_CSS_ID);

    // Remove context menu if visible
    _dismissContextMenu();

    // Remove context menu event bindings
    $(document).off('contextmenu.fd-avatar');
    $(document).off('click.fd-avatar-dismiss');
    $(document).off('keydown.fd-avatar-dismiss');

    // Unbind ST events
    _unbindSTEvents();

    // Remove override markup from DOM (restore original srcs)
    $(`#fd-chat .avatar img[data-fd-original-src]`).each(function () {
        const $img     = $(this);
        const original = $img.attr('data-fd-original-src');
        if (original !== undefined) {
            $img.attr('src', original)
                .removeAttr('data-fd-original-src')
                .removeAttr('data-fd-char');
        }
    });

    log('avatar-manager: destroyed');
}

// ---------------------------------------------------------------------------
// Default export (object API, mirrors module exports for convenience)
// ---------------------------------------------------------------------------

export default {
    init,
    applyAvatarSize,
    applyAvatarShape,
    setAvatarOverride,
    clearAvatarOverride,
    onMessageRendered,
    setupContextMenu,
    destroy,
};
