/**
 * fae.desktop — chat-wrapper.js
 *
 * Wraps SillyTavern's #sheld chat panel in a macOS-style .fd-window
 * desktop window and manages chat-specific behaviour:
 *
 *   - wrapChat()     — moves #sheld into .fd-window#fd-chat
 *   - unwrapChat()   — restores #sheld to its original parent
 *   - setAlignment() — updates the window's data-fd-align attribute
 *   - updateTitle()  — syncs the window title to the current character name
 *
 * Special rules for the chat window:
 *   - NOT closable (traffic-light close button hidden)
 *   - Title tracks the current character name (updated on CHAT_CHANGED)
 *   - Double-click titlebar maximizes / restores (via the FDWindow instance)
 *   - Registered with windowManager so layout save/restore works
 *
 * Events emitted:
 *   fd:chat-wrapped      — after wrapChat() succeeds
 *   fd:chat-unwrapped    — after unwrapChat() succeeds
 *   fd:chat-align-changed — when setAlignment() is called
 *
 * Dependencies:
 *   window-manager.js (FDWindow, windowManager)
 *   utils.js (log, warn, px)
 *   settings.js (readSetting)
 */

import { log, warn, px } from './utils.js';
import { readSetting } from './settings.js';
import { FDWindow, windowManager } from './window-manager.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {FDWindow|null} The FDWindow instance wrapping #sheld. */
let _fdWindow = null;

/** @type {jQuery|null} The #sheld element. */
let _$sheld = null;

/** @type {jQuery|null} The original parent of #sheld before wrapping. */
let _$origParent = null;

/** @type {jQuery|null} The original next sibling of #sheld (for reinsertion). */
let _$origNext = null;

/** Whether the chat is currently wrapped in a desktop window. */
let _wrapped = false;

/** Settings passed to init(). */
let _settings = null;

// ---------------------------------------------------------------------------
// init / destroy
// ---------------------------------------------------------------------------

/**
 * Initialise the chat wrapper.
 * Called by desktop.js after the #fd-root scaffold is in the DOM.
 *
 * @param {object} settings  — extensionSettings.fae_desktop (or a subset)
 */
export function init(settings) {
    _settings = settings || {};
    log('chat-wrapper: init');
}

/**
 * Destroy: unwrap the chat (if still wrapped) and clean up listeners.
 */
export function destroy() {
    // Remove ST eventSource listener if we bound one
    if (_eventSource && _boundUpdateTitle && _chatChangedEvent) {
        try {
            _eventSource.removeListener?.(_chatChangedEvent, _boundUpdateTitle);
        } catch { /* ignore */ }
        _eventSource      = null;
        _boundUpdateTitle = null;
        _chatChangedEvent = null;
    }

    if (_wrapped) {
        unwrapChat();
    }
    $(document).off('.chat-wrapper');
    _settings = null;
    log('chat-wrapper: destroyed');
}

// ---------------------------------------------------------------------------
// wrapChat
// ---------------------------------------------------------------------------

/**
 * Move #sheld into a new .fd-window#fd-chat window inside #fd-workspace.
 *
 * Steps:
 *   1. Locate #sheld and stash its current parent + next sibling
 *   2. Create an FDWindow (not closable, resizable, special chat classes)
 *   3. Mount the FDWindow into #fd-workspace
 *   4. Move #sheld into .fd-window-content
 *   5. Register with windowManager
 *   6. Bind lifecycle event listeners
 */
export function wrapChat() {
    if (_wrapped) {
        warn('chat-wrapper.wrapChat: already wrapped');
        return;
    }

    _$sheld = $('#sheld');
    if (!_$sheld.length) {
        warn('chat-wrapper.wrapChat: #sheld not found, aborting');
        return;
    }

    // ---- 1. Stash original DOM position ----
    _$origParent = _$sheld.parent();
    _$origNext   = _$sheld.next();  // may be empty jQuery if sheld is last child

    // ---- 2. Determine initial settings ----
    const chatSettings = (_settings && _settings.chat) ? _settings.chat : readSetting('chat');
    const dockSettings = (_settings && _settings.dock) ? _settings.dock : readSetting('dock');
    const align        = (_settings && _settings.chatAlign) ? _settings.chatAlign : readSetting('chatAlign') || 'left';

    // ---- 3. Build FDWindow ----
    _fdWindow = new FDWindow('fd-chat', {
        title:   _getChatTitle(),
        icon:    '',          // we add avatar manually
        closable:  false,     // Chat window cannot be closed
        resizable: true,

        minSize: { w: 320, h: 300 },

        defaultSize: {
            w: Math.min(900, Math.floor(window.innerWidth * 0.55)),
            h: Math.floor(window.innerHeight * 0.85),
        },
        defaultPosition: { x: 40, y: 40 },

        onFocus:    () => { _dispatchEvent('fd:window-focused', { id: 'fd-chat' }); },
        onMaximize: () => { log('chat-wrapper: maximized'); },
        onRestore:  () => { log('chat-wrapper: restored'); },
    });

    // Mount into #fd-workspace
    const $workspace = $('#fd-workspace');
    _fdWindow.mount($workspace);

    // ---- 4. Customise the generated window DOM ----
    const $el = _fdWindow.$el;

    // Add semantic classes
    $el.addClass('fd-chat-window');
    $el.attr('data-fd-align', align);

    // Hide the close traffic light (not closable)
    $el.find('.fd-traffic-close').hide().attr('aria-hidden', 'true');

    // Insert avatar area in titlebar
    const $avatar = $('<div>', { class: 'fd-chat-avatar', 'aria-hidden': 'true' });
    $el.find('.fd-titlebar-center').prepend($avatar);

    // Update avatar from ST context
    _updateAvatar($avatar);

    // ---- 5. Move #sheld into the window content area ----
    const $content = _fdWindow.getContentElement();
    $content.addClass('fd-chat-content');
    $content.append(_$sheld);

    // ---- 6. Register with windowManager ----
    windowManager.register(_fdWindow);

    _wrapped = true;

    // ---- 7. Bind event listeners ----
    _bindListeners();

    // Dispatch wrapped event
    _dispatchEvent('fd:chat-wrapped', { windowId: 'fd-chat' });
    log('chat-wrapper: wrapped');
}

// ---------------------------------------------------------------------------
// unwrapChat
// ---------------------------------------------------------------------------

/**
 * Reverse wrapChat(): move #sheld back to its original DOM position,
 * destroy the FDWindow, unregister from windowManager.
 */
export function unwrapChat() {
    if (!_wrapped) {
        warn('chat-wrapper.unwrapChat: not currently wrapped');
        return;
    }

    // Move #sheld back
    if (_$sheld && _$sheld.length) {
        if (_$origNext && _$origNext.length && _$origNext[0].parentNode) {
            _$sheld.insertBefore(_$origNext);
        } else if (_$origParent && _$origParent.length) {
            _$origParent.append(_$sheld);
        } else {
            $('body').append(_$sheld);
        }
    }

    // Unregister + destroy FDWindow
    if (_fdWindow) {
        windowManager.unregister('fd-chat');
        // unregister calls fdWindow.destroy() which removes the DOM element
        _fdWindow = null;
    }

    _$sheld      = null;
    _$origParent = null;
    _$origNext   = null;
    _wrapped     = false;

    // Remove event listeners
    $(document).off('.chat-wrapper');

    _dispatchEvent('fd:chat-unwrapped', {});
    log('chat-wrapper: unwrapped');
}

// ---------------------------------------------------------------------------
// setAlignment
// ---------------------------------------------------------------------------

/**
 * Set the chat window's alignment preset.
 *
 * The data-fd-align attribute is used by CSS to position / size the window:
 *   left   — snapped to left, ~55% width
 *   right  — snapped to right, ~55% width
 *   center — centered, ~70% width
 *   full   — full workspace width
 *
 * @param {'left'|'right'|'center'|'full'} align
 */
export function setAlignment(align) {
    const validAligns = ['left', 'right', 'center', 'full'];
    if (!validAligns.includes(align)) {
        warn(`chat-wrapper.setAlignment: unknown align "${align}"`);
        return;
    }

    if (_fdWindow && _fdWindow.$el) {
        _fdWindow.$el.attr('data-fd-align', align);
    }

    _dispatchEvent('fd:chat-align-changed', { align });
    log(`chat-wrapper: alignment set to "${align}"`);
}

// ---------------------------------------------------------------------------
// updateTitle
// ---------------------------------------------------------------------------

/**
 * Sync the chat window title bar text with the current character name.
 * Called automatically on CHAT_CHANGED; also callable externally.
 */
export function updateTitle() {
    if (!_fdWindow) return;

    const title = _getChatTitle();
    _fdWindow.setTitle(title);

    // Also update avatar
    if (_fdWindow.$el) {
        _updateAvatar(_fdWindow.$el.find('.fd-chat-avatar'));
    }

    log(`chat-wrapper: title updated to "${title}"`);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Return the chat window title string based on current ST context. */
function _getChatTitle() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx?.name2 || 'Chat';
    } catch {
        return 'Chat';
    }
}

/** Update the small avatar image in the chat window titlebar. */
function _updateAvatar($avatarEl) {
    if (!$avatarEl || !$avatarEl.length) return;

    try {
        const ctx = SillyTavern.getContext();

        // ST stores the current character avatar URL various places
        const avatarUrl =
            ctx?.characters?.[ctx?.characterId]?.avatar
            || ctx?.avatar
            || null;

        if (avatarUrl) {
            // Resolve relative URL
            const src = avatarUrl.startsWith('http') ? avatarUrl : `/characters/${avatarUrl}`;
            $avatarEl
                .css('background-image', `url("${src}")`)
                .css('display', 'block');
        } else {
            $avatarEl.css({ 'background-image': '', display: 'none' });
        }
    } catch {
        $avatarEl.css({ 'background-image': '', display: 'none' });
    }
}

/**
 * Bind document event listeners that the chat wrapper needs to respond to.
 * Uses namespace '.chat-wrapper' so they can be removed atomically.
 */
function _bindListeners() {
    // SillyTavern emits a custom event (or we poll) when the character changes.
    // The desktop orchestrator also fires 'fd:chat-changed' for us.
    $(document).on('fd:chat-changed.chat-wrapper', () => {
        updateTitle();
    });

    // If ST provides an event_types.CHAT_CHANGED constant we can hook it directly.
    // We try a few known ST event names gracefully.
    try {
        const ctx = SillyTavern.getContext();
        const eventSource = ctx?.eventSource;
        if (eventSource && typeof eventSource.on === 'function') {
            const CHAT_CHANGED = ctx?.event_types?.CHAT_CHANGED || 'chatLoaded';
            eventSource.on(CHAT_CHANGED, updateTitle);

            // Store reference for cleanup
            _eventSource = eventSource;
            _boundUpdateTitle = updateTitle;
            _chatChangedEvent = CHAT_CHANGED;
        }
    } catch { /* ST context not ready yet — fd:chat-changed covers us */ }

    // Focus chat window when fd:dock-action { action: 'focus', target: 'fd-chat' } arrives
    $(document).on('fd:dock-action.chat-wrapper', (e) => {
        const detail = (e.originalEvent || e).detail;
        if (detail?.action === 'focus' && detail?.target === 'fd-chat') {
            if (_fdWindow) _fdWindow.focus();
        }
    });
}

// ST eventSource references for cleanup
let _eventSource      = null;
let _boundUpdateTitle = null;
let _chatChangedEvent = null;

// eventSource cleanup is handled inside the destroy() function below.

// ---------------------------------------------------------------------------
// CustomEvent dispatch helper
// ---------------------------------------------------------------------------

function _dispatchEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, {
        bubbles:    false,
        cancelable: false,
        detail,
    }));
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default {
    init,
    destroy,
    wrapChat,
    unwrapChat,
    setAlignment,
    updateTitle,
};
