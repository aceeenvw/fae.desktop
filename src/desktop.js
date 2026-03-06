/**
 * fae.desktop — desktop.js
 * Main orchestrator.  Creates the desktop DOM scaffold, manages enable/disable
 * lifecycle, and coordinates all sub-systems.
 *
 * Public API:
 *   desktop.init()     — called once from index.js after APP_READY
 *   desktop.enable()   — show desktop mode (idempotent)
 *   desktop.disable()  — hide / teardown desktop mode (idempotent)
 *   desktop.destroy()  — full cleanup on extension unload
 *   desktop.isEnabled  — current state flag (read-only)
 */

import {
    log,
    warn,
    error,
    clamp,
    generateId,
    injectCSS,
    removeCSS,
    resolveExtensionPath,
    waitForElement,
    px,
    debounce,
} from './utils.js';

import {
    getSettings,
    saveSetting,
    readSetting,
    applySkin,
    applyColorPreset,
    applyCustomCss,
    MODULE_NAME,
} from './settings.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Whether desktop mode is currently active. */
let _isEnabled = false;

/** jQuery reference to #sheld (the ST chat panel). */
let _$sheld = null;

/** The jQuery-wrapped original parent of #sheld before we moved it. */
let _$originalSheldParent = null;

/** The jQuery-wrapped next sibling of #sheld before we moved it (for reinsertion). */
let _$originalSheldNextSibling = null;

/** Root desktop element — #fd-root. */
let _$root = null;

/** Wallpaper layer. */
let _$wallpaper = null;

/** Particles canvas layer. */
let _$particles = null;

/** Workspace (behind chat, holds widgets and windows). */
let _$workspace = null;

/** The fd-chat window element that wraps #sheld. */
let _$chatWindow = null;

/** Global z-index counter for window stacking. */
let _zCounter = 100;

/** Resize observer to re-check mobile breakpoint. */
let _resizeObserver = null;

/** Whether init() has already been called. */
let _initialized = false;

// Keep weak references to sub-module instances so destroy() can clean them up.
// Sub-modules are imported lazily to avoid circular dependency issues during init.
let _subModules = {};

// ---------------------------------------------------------------------------
// Public API object (exported as default)
// ---------------------------------------------------------------------------

const desktop = {
    get isEnabled() { return _isEnabled; },

    init,
    enable,
    disable,
    destroy,

    // Expose helpers for sub-modules
    getRoot() { return _$root; },
    getWorkspace() { return _$workspace; },
    nextZ() { return ++_zCounter; },
    resetZ() { _zCounter = 100; },
};

export default desktop;

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * One-time initialisation called from index.js after APP_READY.
 * Loads the skin, optionally enables desktop mode, and sets up listeners.
 */
export async function init() {
    if (_initialized) {
        warn('desktop.init: already initialised, skipping');
        return;
    }
    _initialized = true;

    console.log('[fae.desktop] desktop.init: starting');

    const settings = getSettings();
    console.log('[fae.desktop] desktop.init: settings.enabled =', settings.enabled, ', skin =', settings.skin);

    // Apply skin CSS
    try {
        await applySkin(settings.skin);
        console.log('[fae.desktop] desktop.init: skin loaded ✓');
    } catch (e) {
        console.error('[fae.desktop] desktop.init: skin load failed', e);
    }

    // Apply custom CSS (if any)
    applyCustomCss();

    // Watch for viewport resize (mobile check)
    _setupResizeWatcher();

    // If the extension was previously enabled, restore desktop mode
    if (settings.enabled) {
        console.log('[fae.desktop] desktop.init: calling enable()...');
        await enable();
    } else {
        console.log('[fae.desktop] desktop.init: extension disabled in settings, skipping enable()');
    }

    console.log('[fae.desktop] desktop.init: done');
}

// ---------------------------------------------------------------------------
// enable()
// ---------------------------------------------------------------------------

/**
 * Activate desktop mode:
 *   1. Build the #fd-root scaffold (wallpaper, particles, workspace, menubar, dock)
 *   2. Move #sheld into the fd-chat window inside the workspace
 *   3. Apply layout, skin and all per-setting visual adjustments
 *
 * Idempotent — calling while already enabled is a no-op.
 */
export async function enable() {
    if (_isEnabled) {
        log('desktop.enable: already enabled');
        return;
    }

    console.log('[fae.desktop] desktop.enable: building desktop scaffold');

    // Ensure #sheld is present
    await waitForElement('#sheld').catch(() => {
        error('desktop.enable: #sheld not found in DOM');
    });

    _$sheld = $('#sheld');
    if (!_$sheld.length) {
        error('desktop.enable: #sheld missing, aborting enable');
        return;
    }

    // Stash original parent + sibling for later restore
    _$originalSheldParent = _$sheld.parent();
    _$originalSheldNextSibling = _$sheld.next();

    // -----------------------------------------------------------------------
    // 1. Build DOM scaffold
    // -----------------------------------------------------------------------

    _$root = $('<div>', { id: 'fd-root', class: 'fd-root' });

    // Wallpaper layer
    _$wallpaper = $('<div>', { id: 'fd-wallpaper', class: 'fd-wallpaper' });

    // Particles layer (canvas is injected by particles.js)
    _$particles = $('<div>', { id: 'fd-particles', class: 'fd-particles' });

    // Workspace — holds windows and widgets
    _$workspace = $('<div>', { id: 'fd-workspace', class: 'fd-workspace' });

    // Chat window inside workspace
    _$chatWindow = _buildChatWindow();
    _$workspace.append(_$chatWindow);

    // Assemble root
    _$root.append(_$wallpaper, _$particles, _$workspace);

    // -----------------------------------------------------------------------
    // 2. Menubar (injected inside #fd-root, above everything)
    // -----------------------------------------------------------------------

    const $menubar = _buildMenubar();
    _$root.prepend($menubar);

    // -----------------------------------------------------------------------
    // 3. Dock (injected inside #fd-root, below everything)
    // -----------------------------------------------------------------------

    const $dock = _buildDock();
    _$root.append($dock);

    // -----------------------------------------------------------------------
    // 4. Move #sheld into the chat window content area
    // -----------------------------------------------------------------------

    _$chatWindow.find('.fd-window-content').append(_$sheld);

    // -----------------------------------------------------------------------
    // 5. Mount #fd-root to body
    // -----------------------------------------------------------------------

    $('body').append(_$root);
    $('body').addClass('fd-active');

    console.log('[fae.desktop] desktop.enable: #fd-root appended to body ✓');
    console.log('[fae.desktop] desktop.enable: #fd-root in DOM:', !!document.getElementById('fd-root'));
    console.log('[fae.desktop] desktop.enable: body.fd-active:', document.body.classList.contains('fd-active'));

    // Remove re-enable button if it exists
    _removeReEnableButton();

    // -----------------------------------------------------------------------
    // 6. Apply per-settings visual state
    // -----------------------------------------------------------------------

    _applyWallpaper();
    _applyChatAlignment();
    _applyWindowOpacity();
    _applyChatSettings();
    _applyMenubarSettings();
    _applyDockSettings();

    // -----------------------------------------------------------------------
    // 7. Lazy-load sub-modules
    // -----------------------------------------------------------------------

    await _initSubModules();

    _isEnabled = true;
    saveSetting('enabled', true);

    console.log('[fae.desktop] desktop.enable: desktop mode ACTIVE ✓');

    // Emit a custom event so other modules can react
    document.dispatchEvent(new CustomEvent('fd:enabled', { detail: { desktop } }));
}

// ---------------------------------------------------------------------------
// disable()
// ---------------------------------------------------------------------------

/**
 * Deactivate desktop mode:
 *   1. Move #sheld back to its original parent
 *   2. Destroy all sub-modules
 *   3. Remove #fd-root from DOM
 *
 * Idempotent.
 */
export async function disable() {
    if (!_isEnabled) {
        log('desktop.disable: already disabled');
        return;
    }

    log('desktop.disable: tearing down desktop mode');

    // Tear down sub-modules first (they may animate out)
    await _destroySubModules();

    // Move #sheld back to its original parent
    if (_$sheld && _$sheld.length) {
        if (_$originalSheldNextSibling && _$originalSheldNextSibling.length) {
            _$sheld.insertBefore(_$originalSheldNextSibling);
        } else if (_$originalSheldParent && _$originalSheldParent.length) {
            _$originalSheldParent.append(_$sheld);
        } else {
            // Last resort: put it back on body
            $('body').append(_$sheld);
        }
    }

    // Remove desktop root
    if (_$root) {
        _$root.remove();
        _$root = null;
    }

    // Remove body class
    $('body').removeClass('fd-active');

    // Clear state
    _$wallpaper = null;
    _$particles = null;
    _$workspace = null;
    _$chatWindow = null;
    _$sheld = null;
    _$originalSheldParent = null;
    _$originalSheldNextSibling = null;
    _zCounter = 100;

    _isEnabled = false;
    saveSetting('enabled', false);

    // Show a floating re-enable button so the user can get back
    _showReEnableButton();

    log('desktop.disable: desktop mode deactivated');

    document.dispatchEvent(new CustomEvent('fd:disabled', { detail: {} }));
}

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

/**
 * Full cleanup when the extension is unloaded or the page is closing.
 * Calls disable() then removes lingering CSS injections and event listeners.
 */
export async function destroy() {
    log('desktop.destroy: starting full cleanup');

    if (_isEnabled) {
        await disable();
    }

    // Remove skin/preset CSS
    removeCSS('fd-skin');
    removeCSS('fd-color-preset');
    removeCSS('fd-custom-css');

    // Disconnect resize observer
    if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
    }

    _initialized = false;
    log('desktop.destroy: cleanup complete');
}

// ---------------------------------------------------------------------------
// DOM Builders — private
// ---------------------------------------------------------------------------

/**
 * Build the fd-chat window element that will hold #sheld.
 * @returns {jQuery}
 */
function _buildChatWindow() {
    const settings = getSettings();
    const align = settings.chatAlign || 'left';

    const $win = $('<div>', {
        id: 'fd-chat',
        class: `fd-window fd-chat-window fd-chat-align-${align}`,
        attr: { 'data-window-id': 'chat' },
    });

    // Traffic lights (macOS-style window controls — decorative on chat window)
    const $titlebar = $('<div>', { class: 'fd-titlebar' }).append(
        _buildTrafficLights('chat'),
        $('<div>', { class: 'fd-titlebar-title', text: _getChatWindowTitle() }),
        $('<div>', { class: 'fd-titlebar-controls' }),
    );

    const $content = $('<div>', { class: 'fd-window-content fd-chat-content' });

    $win.append($titlebar, $content);

    // Focus/raise on click
    $win.on('mousedown', () => {
        $win.css('z-index', desktop.nextZ());
    });

    return $win;
}

/**
 * Build the macOS-style traffic light buttons.
 * @param {string} windowId
 * @returns {jQuery}
 */
function _buildTrafficLights(windowId) {
    const $group = $('<div>', { class: 'fd-traffic-lights' });

    const buttons = [
        { type: 'close',    title: 'Close',    action: 'close' },
        { type: 'minimize', title: 'Minimize', action: 'minimize' },
        { type: 'maximize', title: 'Maximize', action: 'maximize' },
    ];

    buttons.forEach(({ type, title, action }) => {
        $('<button>', {
            class: `fd-traffic fd-traffic-${type}`,
            title,
            attr: { 'data-action': action, 'data-window': windowId },
        }).appendTo($group);
    });

    return $group;
}

/**
 * Build the menu bar element.
 * @returns {jQuery}
 */
function _buildMenubar() {
    const $bar = $('<div>', { id: 'fd-menubar', class: 'fd-menubar', role: 'menubar' });

    // Left side — Apple logo + app menus
    const $left = $('<div>', { class: 'fd-menubar-left' });
    $left.append(
        $('<button>', {
            class: 'fd-menubar-item fd-menubar-apple',
            html: _appleLogoSVG(),
            title: 'fae.desktop',
            attr: { 'data-fd-menu': 'apple' },
        }),
        $('<button>', { class: 'fd-menubar-item fd-menubar-appname', text: 'SillyTavern', attr: { 'data-fd-menu': 'app' } }),
        $('<button>', { class: 'fd-menubar-item', text: 'View', attr: { 'data-fd-menu': 'view' } }),
        $('<button>', { class: 'fd-menubar-item', text: 'Windows', attr: { 'data-fd-menu': 'windows' } }),
    );

    // Right side — status items
    const $right = $('<div>', { class: 'fd-menubar-right' });

    // Clock + date (updated by _startMenubarClock)
    $right.append(
        $('<span>', { id: 'fd-menubar-date', class: 'fd-menubar-status-item fd-menubar-date' }),
        $('<span>', { id: 'fd-menubar-clock', class: 'fd-menubar-status-item fd-menubar-clock' }),
    );

    // Character name area
    $right.append(
        $('<span>', { id: 'fd-menubar-charname', class: 'fd-menubar-status-item fd-menubar-charname' }),
    );

    $bar.append($left, $right);

    // Wire up all menu items with dropdown functionality
    $bar.find('[data-fd-menu]').on('click', _onMenubarItemClick);

    // Close dropdowns on outside click
    $(document).on('mousedown.fd-menubar', (e) => {
        if (!$(e.target).closest('.fd-menubar-dropdown, .fd-menubar-item').length) {
            _closeMenubarDropdowns();
        }
    });

    // Start the clock
    _startMenubarClock($bar);

    return $bar;
}

/**
 * Build the dock element.
 * @returns {jQuery}
 */
function _buildDock() {
    const $dock = $('<div>', { id: 'fd-dock', class: 'fd-dock', role: 'toolbar', 'aria-label': 'Dock' });
    const $inner = $('<div>', { class: 'fd-dock-inner' });

    // Built-in dock items
    const dockItems = [
        { id: 'chat',       icon: 'chat',       label: 'Chat',       action: 'focus-chat' },
        { id: 'characters', icon: 'characters',  label: 'Characters', action: 'toggle-characters' },
        { id: 'settings',   icon: 'settings',    label: 'Settings',   action: 'open-settings' },
        { id: 'notes',      icon: 'notes',       label: 'Notes',      action: 'toggle-widget-notes' },
        { id: 'gallery',    icon: 'gallery',     label: 'Gallery',    action: 'toggle-widget-gallery' },
        { id: 'clock',      icon: 'clock',       label: 'Clock',      action: 'toggle-widget-clock' },
    ];

    dockItems.forEach(({ id, icon, label, action }) => {
        const $item = $('<div>', {
            class: 'fd-dock-item',
            title: label,
            attr: { 'data-dock-id': id, 'data-dock-action': action },
        }).append(
            $('<div>', { class: `fd-dock-icon fd-dock-icon-${icon}` }),
            $('<div>', { class: 'fd-dock-label', text: label }),
        );

        $item.on('click', (e) => _onDockItemClick(e, action));

        $inner.append($item);
    });

    $dock.append($inner);
    return $dock;
}

// ---------------------------------------------------------------------------
// Apply settings to DOM — private helpers
// ---------------------------------------------------------------------------

/**
 * Apply wallpaper settings to #fd-wallpaper.
 */
function _applyWallpaper() {
    if (!_$wallpaper) return;
    const wp = readSetting('wallpaper');
    const styles = {};

    if (wp.useSTBackground) {
        // Mirror ST's current background from --main-bg-color / body background
        const stBg = getComputedStyle(document.body).backgroundImage;
        if (stBg && stBg !== 'none') {
            styles['background-image'] = stBg;
            styles['background-color'] = getComputedStyle(document.body).backgroundColor;
        } else {
            styles['background-color'] = getComputedStyle(document.body).backgroundColor || '#1e1e2e';
        }
    } else if (wp.customUrl) {
        styles['background-image'] = `url("${wp.customUrl}")`;
    }

    styles['background-size'] = wp.fit === 'tile' ? 'auto' : wp.fit;
    styles['background-repeat'] = wp.fit === 'tile' ? 'repeat' : 'no-repeat';
    styles['background-position'] = 'center';

    if (wp.blur > 0) {
        styles['filter'] = `blur(${wp.blur}px)`;
    }

    _$wallpaper.css(styles);

    // Dim overlay via CSS variable
    _$root && _$root[0] && _$root[0].style.setProperty('--fd-wallpaper-dim', String(clamp(wp.dim, 0, 100) / 100));
}

/**
 * Apply chatAlign setting by toggling class on #fd-chat.
 */
function _applyChatAlignment() {
    if (!_$chatWindow) return;
    const align = readSetting('chatAlign', 'left');
    _$chatWindow
        .removeClass('fd-chat-align-left fd-chat-align-right fd-chat-align-center fd-chat-align-full')
        .addClass(`fd-chat-align-${align}`);
}

/**
 * Apply windowOpacity setting as a CSS variable on #fd-root.
 */
function _applyWindowOpacity() {
    if (!_$root) return;
    const opacity = clamp(readSetting('windowOpacity', 100), 0, 100);
    _$root[0].style.setProperty('--fd-window-opacity', String(opacity / 100));
}

/**
 * Apply chat sub-settings (avatar size/shape, compact, etc.) as data- attrs
 * on #fd-root so they can be targeted by CSS.
 */
function _applyChatSettings() {
    if (!_$root) return;
    const chat = readSetting('chat');
    _$root
        .attr('data-fd-avatar-shape', chat.avatarShape)
        .attr('data-fd-message-dir', chat.messageDirection)
        .attr('data-fd-compact', chat.compact ? 'true' : 'false');

    _$root[0].style.setProperty('--fd-avatar-size', px(chat.avatarSize));
}

/**
 * Apply menubar show/hide and field visibility.
 */
function _applyMenubarSettings() {
    if (!_$root) return;
    const mb = readSetting('menubar');
    const $menubar = _$root.find('#fd-menubar');

    $menubar.toggle(Boolean(mb.show));
    $menubar.find('#fd-menubar-clock').toggle(Boolean(mb.showClock));
    $menubar.find('#fd-menubar-date').toggle(Boolean(mb.showDate));
    $menubar.find('#fd-menubar-charname').toggle(Boolean(mb.showCharName));
}

/**
 * Apply dock settings (icon size, magnification, auto-hide).
 */
function _applyDockSettings() {
    if (!_$root) return;
    const dock = readSetting('dock');
    const $dock = _$root.find('#fd-dock');

    $dock.toggleClass('fd-dock-autohide', Boolean(dock.autoHide));
    $dock.toggleClass('fd-dock-magnify', Boolean(dock.magnification));
    $dock[0] && $dock[0].style.setProperty('--fd-dock-icon-size-current', px(dock.iconSize));
    $dock[0] && $dock[0].style.setProperty('--fd-dock-magnification-scale', String(dock.magnificationScale));
}

// ---------------------------------------------------------------------------
// Menubar clock
// ---------------------------------------------------------------------------

let _clockInterval = null;

function _startMenubarClock($menubar) {
    _stopMenubarClock();

    function tick() {
        const settings = getSettings();
        const mb = settings.menubar;
        const now = new Date();

        if (mb.showClock) {
            const fmt = mb.clockFormat === '12h'
                ? { hour: 'numeric', minute: '2-digit', hour12: true }
                : { hour: '2-digit', minute: '2-digit', hour12: false };
            $menubar.find('#fd-menubar-clock').text(now.toLocaleTimeString([], fmt));
        }

        if (mb.showDate) {
            const dateFmt = { weekday: 'short', month: 'short', day: 'numeric' };
            $menubar.find('#fd-menubar-date').text(now.toLocaleDateString([], dateFmt));
        }

        if (mb.showCharName) {
            try {
                const ctx = SillyTavern.getContext();
                const name = ctx?.name2 || '';
                $menubar.find('#fd-menubar-charname').text(name ? `✦ ${name}` : '');
            } catch { /* ignore */ }
        }
    }

    tick();
    _clockInterval = setInterval(tick, 10_000); // update every 10 s
}

function _stopMenubarClock() {
    if (_clockInterval) {
        clearInterval(_clockInterval);
        _clockInterval = null;
    }
}

// ---------------------------------------------------------------------------
// Chat window title helper
// ---------------------------------------------------------------------------

function _getChatWindowTitle() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx?.name2 || 'Chat';
    } catch {
        return 'Chat';
    }
}

// ---------------------------------------------------------------------------
// Resize watcher (mobile guard)
// ---------------------------------------------------------------------------

function _setupResizeWatcher() {
    const handler = debounce(() => {
        if (window.innerWidth < 768 && _isEnabled) {
            warn('desktop: viewport < 768px, disabling desktop mode');
            _showMobileToast();
            disable();
        }
    }, 300);

    try {
        _resizeObserver = new ResizeObserver(handler);
        _resizeObserver.observe(document.body);
    } catch {
        window.addEventListener('resize', handler, { passive: true });
    }
}

function _showMobileToast() {
    try {
        const ctx = SillyTavern.getContext();
        ctx?.toastr?.warning(
            'fae.desktop is designed for desktop browsers (viewport ≥ 768 px).',
            'fae.desktop',
            { timeOut: 6000 },
        );
    } catch {
        // Fallback — ST's toastr may not be available
        console.warn('[fae.desktop] fae.desktop is designed for desktop browsers.');
    }
}

// ---------------------------------------------------------------------------
// Menubar dropdown system
// ---------------------------------------------------------------------------

const _menuDefinitions = {
    apple: [
        { label: 'About fae.desktop', action: 'about' },
        { type: 'separator' },
        { label: 'Preferences...', action: 'open-settings', shortcut: '⌘,' },
        { type: 'separator' },
        { label: 'Disable Desktop Mode', action: 'disable', shortcut: '⌘D' },
    ],
    app: [
        { label: 'New Chat', action: 'new-chat', shortcut: '⌘N' },
        { type: 'separator' },
        { label: 'Character Panel', action: 'toggle-characters', shortcut: '⌘1' },
        { label: 'Extensions', action: 'open-settings', shortcut: '⌘2' },
    ],
    view: [
        { label: 'Align Left',   action: 'align-left' },
        { label: 'Align Right',  action: 'align-right' },
        { label: 'Align Center', action: 'align-center' },
        { label: 'Full Width',   action: 'align-full' },
        { type: 'separator' },
        { label: 'Skin: macOS',  action: 'skin-macos' },
        { label: 'Skin: Frost',  action: 'skin-frost' },
        { label: 'Skin: Rosé',   action: 'skin-rose' },
        { label: 'Skin: Moss',   action: 'skin-moss' },
    ],
    windows: [
        { label: 'Minimize Chat',  action: 'minimize-chat' },
        { label: 'Maximize Chat',  action: 'maximize-chat' },
        { type: 'separator' },
        { label: 'Close All Widgets', action: 'close-all-widgets' },
    ],
};

function _onMenubarItemClick(e) {
    e.stopPropagation();
    const $btn = $(e.currentTarget);
    const menuId = $btn.data('fd-menu');

    // If this dropdown is already open, close it
    if ($btn.hasClass('fd-menubar-active')) {
        _closeMenubarDropdowns();
        return;
    }

    _closeMenubarDropdowns();

    const items = _menuDefinitions[menuId];
    if (!items) return;

    $btn.addClass('fd-menubar-active');

    const $dropdown = $('<div>', { class: 'fd-menubar-dropdown' });

    items.forEach((item) => {
        if (item.type === 'separator') {
            $dropdown.append($('<div>', { class: 'fd-menubar-dropdown-separator' }));
            return;
        }

        const $item = $('<div>', { class: 'fd-menubar-dropdown-item' });
        $item.append($('<span>', { class: 'fd-menubar-dropdown-label', text: item.label }));
        if (item.shortcut) {
            $item.append($('<span>', { class: 'fd-menubar-dropdown-shortcut', text: item.shortcut }));
        }

        $item.on('click', () => {
            _closeMenubarDropdowns();
            _handleMenuAction(item.action);
        });

        $dropdown.append($item);
    });

    // Position below the button
    const rect = $btn[0].getBoundingClientRect();
    $dropdown.css({
        position: 'fixed',
        top: rect.bottom + 'px',
        left: rect.left + 'px',
        'z-index': 10000,
    });

    $('body').append($dropdown);
}

function _closeMenubarDropdowns() {
    $('.fd-menubar-dropdown').remove();
    $('.fd-menubar-active').removeClass('fd-menubar-active');
}

function _handleMenuAction(action) {
    console.log('[fae.desktop] menu action:', action);
    switch (action) {
        case 'about':
            try { window.toastr?.info('fae.desktop v1.0.0 by aceeenvw', 'fae.desktop'); } catch {}
            break;
        case 'disable':
            desktop.disable();
            break;
        case 'open-settings': {
            const $btn = $('#extensions_settings_button, .drawer-toggle[data-drawer="extensions"], #extensionsMenuButton').first();
            if ($btn.length) $btn.trigger('click');
            break;
        }
        case 'new-chat': {
            // Try multiple known ST selectors for starting a new chat
            const $newChat = $('#option_new_chat, .option_new_chat, [id*="new_chat"]').first();
            if ($newChat.length) {
                $newChat.trigger('click');
            } else {
                try {
                    const ctx = SillyTavern.getContext();
                    if (typeof ctx?.newChat === 'function') {
                        ctx.newChat();
                    } else if (typeof ctx?.clearChat === 'function') {
                        ctx.clearChat();
                    }
                } catch {}
            }
            break;
        }
        case 'toggle-characters': {
            const $charBtn = $('#rm_button_characters, .drawer-toggle[data-drawer="characters"], #rm_button_selected_ch, [data-drawer-toggle="characters"]').first();
            if ($charBtn.length) {
                $charBtn.trigger('click');
            } else {
                try { $('#right-nav-panel, .right-nav-panel').toggle(); } catch {}
            }
            break;
        }
        case 'align-left':   saveSetting('chatAlign', 'left');   _applyChatAlignment(); break;
        case 'align-right':  saveSetting('chatAlign', 'right');  _applyChatAlignment(); break;
        case 'align-center': saveSetting('chatAlign', 'center'); _applyChatAlignment(); break;
        case 'align-full':   saveSetting('chatAlign', 'full');   _applyChatAlignment(); break;
        case 'skin-macos':   console.log('[fae.desktop] Switching skin to macos'); applySkin('macos'); applyColorPreset(null);    saveSetting('skin', 'macos'); break;
        case 'skin-frost':   console.log('[fae.desktop] Switching skin to frost'); applySkin('frost'); applyColorPreset('frost'); saveSetting('skin', 'frost'); break;
        case 'skin-rose':    console.log('[fae.desktop] Switching skin to rose');  applySkin('rose');  applyColorPreset('rose');  saveSetting('skin', 'rose');  break;
        case 'skin-moss':    console.log('[fae.desktop] Switching skin to moss');  applySkin('moss');  applyColorPreset('moss');  saveSetting('skin', 'moss');  break;
        case 'minimize-chat':
            _$chatWindow?.toggleClass('fd-window-minimized');
            break;
        case 'maximize-chat':
            _$chatWindow?.toggleClass('fd-window-maximized');
            break;
        case 'close-all-widgets':
            document.dispatchEvent(new CustomEvent('fd:close-all-widgets'));
            break;
    }
}

// ---------------------------------------------------------------------------
// Dock item handler
// ---------------------------------------------------------------------------

function _onDockItemClick(e, action) {
    e.stopPropagation();

    log(`dock: action "${action}"`);

    // Bounce animation on the clicked dock item
    const $icon = $(e.currentTarget).find('.fd-dock-icon');
    $icon.addClass('fd-dock-bounce');
    setTimeout(() => $icon.removeClass('fd-dock-bounce'), 700);

    switch (action) {
        case 'focus-chat':
            // Scroll chat to bottom and bring window to front
            _$chatWindow?.css('z-index', desktop.nextZ());
            const $chat = $('#chat');
            if ($chat.length) $chat.scrollTop($chat[0].scrollHeight);
            break;

        case 'toggle-characters': {
            // Toggle ST's character management panel via button click
            const $charBtn = $('#rm_button_characters, #character_popup_button, .drawer-toggle[data-drawer="characters"], #rm_button_selected_ch, [data-drawer-toggle="characters"]').first();
            if ($charBtn.length) {
                $charBtn.trigger('click');
            } else {
                // Fallback: toggle right panel visibility
                $('#right-nav-panel, .right-nav-panel').toggle();
            }
            break;
        }

        case 'open-settings': {
            // Click ST's extensions settings button
            const $extBtn = $('#extensions_settings_button, .drawer-toggle[data-drawer="extensions"], #extensionsMenuButton').first();
            if ($extBtn.length) {
                $extBtn.trigger('click');
            } else {
                // Fallback: try the context API
                try {
                    const ctx = SillyTavern.getContext();
                    ctx?.openDrawer?.('extensions');
                } catch { /* ignore */ }
            }
            break;
        }

        default:
            // Widget actions are handled by widget-loader.js listening for fd:dock-action
            document.dispatchEvent(new CustomEvent('fd:dock-action', {
                detail: { action, originalEvent: e },
            }));
    }
}

// ---------------------------------------------------------------------------
// Sub-module lifecycle
// ---------------------------------------------------------------------------

/**
 * Lazily import and init all sub-modules that depend on the desktop scaffold
 * being in the DOM.
 */
async function _initSubModules() {
    const basePath = resolveExtensionPath('src');

    // Sub-modules that should NOT be loaded because desktop.js already builds
    // the menubar, dock, and chat window DOM. Loading these would create duplicates.
    const skip = new Set(['menubar', 'dock', 'chat-wrapper']);

    const modules = [
        'wallpaper',
        'particles',
        'widget-loader',
        'layout-manager',
        'avatar-manager',
    ];

    for (const name of modules) {
        if (skip.has(name)) continue;
        try {
            const mod = await import(`${basePath}/${name}.js`);
            _subModules[name] = mod;

            // Class-based singletons (wallpaper, particles, layout-manager)
            // expose .init() on the default export instance
            if (typeof mod.default?.init === 'function') {
                await mod.default.init(desktop);
            } else if (typeof mod.init === 'function') {
                await mod.init(desktop);
            }
            log(`sub-module "${name}" initialised`);
        } catch (e) {
            // Non-fatal: sub-modules may not be written yet
            warn(`sub-module "${name}" failed to load:`, e?.message || e);
        }
    }
}

/**
 * Gracefully shut down all running sub-modules.
 */
async function _destroySubModules() {
    for (const [name, mod] of Object.entries(_subModules)) {
        try {
            if (typeof mod.default?.destroy === 'function') {
                await mod.default.destroy();
            } else if (typeof mod.destroy === 'function') {
                await mod.destroy();
            }
        } catch (e) {
            warn(`sub-module "${name}" destroy failed:`, e?.message || e);
        }
    }
    _subModules = {};
    _stopMenubarClock();
}

// ---------------------------------------------------------------------------
// Re-enable floating button (shown after disabling desktop mode)
// ---------------------------------------------------------------------------

function _showReEnableButton() {
    // Remove any existing button first
    $('#fd-reenable-btn').remove();

    const $btn = $('<button>', {
        id: 'fd-reenable-btn',
        title: 'Re-enable fae.desktop',
        html: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
    }).css({
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        width: '44px',
        height: '44px',
        'border-radius': '50%',
        border: '1px solid rgba(255,255,255,0.15)',
        background: 'rgba(30,30,35,0.85)',
        'backdrop-filter': 'blur(16px)',
        color: '#fff',
        cursor: 'pointer',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        'z-index': 99999,
        'box-shadow': '0 4px 16px rgba(0,0,0,0.4)',
        transition: 'transform 200ms ease, background 200ms ease',
    });

    $btn.on('mouseenter', () => $btn.css({ transform: 'scale(1.1)', background: 'rgba(50,50,60,0.9)' }));
    $btn.on('mouseleave', () => $btn.css({ transform: 'scale(1)', background: 'rgba(30,30,35,0.85)' }));

    $btn.on('click', async () => {
        $btn.remove();
        // Reset initialized flag so init() can run again, or just call enable()
        _initialized = true; // already initialized, just re-enable
        await enable();
    });

    $('body').append($btn);
}

function _removeReEnableButton() {
    $('#fd-reenable-btn').remove();
}

// ---------------------------------------------------------------------------
// Apple logo SVG (inline, no external fetch)
// ---------------------------------------------------------------------------

function _appleLogoSVG() {
    // Simplified  logo silhouette
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="17" viewBox="0 0 14 17" fill="currentColor" aria-hidden="true">
        <path d="M13.23 12.27c-.28.63-.41.91-.77 1.47-.5.76-1.21 1.71-2.08 1.72-.78.01-1-.51-2.07-.5-1.07 0-1.31.52-2.09.51-.87-.01-1.54-.87-2.04-1.63-1.4-2.14-1.55-4.65-.68-5.98.62-.95 1.59-1.5 2.51-1.5 1 0 1.63.52 2.46.52.8 0 1.29-.52 2.44-.52.82 0 1.69.45 2.31 1.22-.03.02-1.38.8-1.36 2.4.02 1.89 1.66 2.52 1.37 2.79zM9.24 2.13C9.66 1.6 9.98.82 9.87 0c-.72.05-1.56.5-2.05 1.07C7.37 1.6 7 2.36 7.13 3.1c.78.06 1.6-.4 2.11-1.0z"/>
    </svg>`;
}


