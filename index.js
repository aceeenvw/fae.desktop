/**
 * fae.desktop — index.js
 * Main entry point for the SillyTavern extension "fae.desktop".
 *
 * Responsibilities:
 *   1. Guard against mobile viewports (< 768 px)
 *   2. Initialise settings with defaults
 *   3. Bootstrap the desktop orchestrator on APP_READY
 *   4. Register all /desktop slash commands
 *   5. Handle extension enable/disable lifecycle
 */

// ---------------------------------------------------------------------------
// Dynamic imports (ST extensions use ES modules; sub-modules are loaded here
// so that import.meta.url is available to derive paths at runtime)
// ---------------------------------------------------------------------------

const _imports = {};

async function _loadModules() {
    // We resolve paths relative to index.js via import.meta.url
    const base = new URL('./src/', import.meta.url).href;

    const names = ['utils', 'settings', 'desktop'];
    const results = await Promise.all(
        names.map((n) => import(`${base}${n}.js`).catch((e) => {
            console.error(`[fae.desktop] Failed to import src/${n}.js:`, e);
            return null;
        })),
    );

    [_imports.utils, _imports.settings, _imports.desktop] = results;
}

// ---------------------------------------------------------------------------
// Bootstrap (runs immediately when the module is evaluated by ST)
// ---------------------------------------------------------------------------

(async () => {
    // *** Always log bootstrap steps to console regardless of debug flag ***
    console.log('[fae.desktop] ========== BOOTSTRAP START ==========');

    // Load all sub-modules before doing anything else
    try {
        await _loadModules();
        console.log('[fae.desktop] Modules loaded:', Object.keys(_imports).filter(k => _imports[k] != null));
    } catch (e) {
        console.error('[fae.desktop] _loadModules() threw:', e);
        return;
    }

    const { log, warn, error } = _imports.utils || {};
    const {
        getSettings,
        saveSetting,
        readSetting,
        applySkin,
        applyColorPreset,
        exportSettings,
        importSettings,
        resetSettings,
        MODULE_NAME,
    } = _imports.settings || {};
    const desktop = _imports.desktop?.default || _imports.desktop || {};

    if (!getSettings || !desktop?.init) {
        console.error('[fae.desktop] Critical: core modules failed to load. Extension disabled.');
        console.error('[fae.desktop]   getSettings:', typeof getSettings);
        console.error('[fae.desktop]   desktop.init:', typeof desktop?.init);
        console.error('[fae.desktop]   _imports.desktop:', _imports.desktop);
        return;
    }

    console.log('[fae.desktop] Core modules OK ✓');

    // -----------------------------------------------------------------------
    // 1. Mobile guard (pre-flight check before even registering for APP_READY)
    // -----------------------------------------------------------------------

    if (window.innerWidth < 768) {
        _showToast(
            'fae.desktop requires a desktop browser (viewport ≥ 768 px). Extension inactive.',
            'warning',
        );
        console.warn('[fae.desktop] Mobile viewport detected — extension inactive.');
        return;
    }

    console.log('[fae.desktop] Viewport OK ✓ (', window.innerWidth, 'x', window.innerHeight, ')');

    // -----------------------------------------------------------------------
    // 2. Initialise settings (ensures defaults exist before APP_READY)
    // -----------------------------------------------------------------------

    try {
        getSettings();
        console.log('[fae.desktop] Settings initialised ✓');
    } catch (e) {
        console.error('[fae.desktop] getSettings() failed:', e);
    }

    // -----------------------------------------------------------------------
    // 3. Wait for APP_READY then bootstrap the desktop
    // -----------------------------------------------------------------------

    let ctx, eventSource, event_types;
    try {
        ctx = SillyTavern.getContext();
        eventSource = ctx?.eventSource;
        event_types = ctx?.event_types;
        console.log('[fae.desktop] SillyTavern context acquired ✓');
        console.log('[fae.desktop]   eventSource:', !!eventSource);
        console.log('[fae.desktop]   event_types.APP_READY:', event_types?.APP_READY);
    } catch (e) {
        console.error('[fae.desktop] SillyTavern.getContext() failed:', e);
        return;
    }

    if (!eventSource) {
        console.error('[fae.desktop] eventSource is falsy, cannot listen for APP_READY. Aborting.');
        return;
    }

    const APP_READY_EVENT = event_types?.APP_READY ?? 'app_ready';
    console.log('[fae.desktop] Listening for event:', APP_READY_EVENT);

    eventSource.on(APP_READY_EVENT, async () => {
        console.log('[fae.desktop] >>>>>> APP_READY fired <<<<<<');

        // Re-check viewport (browser might have resized between module load and APP_READY)
        if (window.innerWidth < 768) {
            _showToast(
                'fae.desktop is designed for desktop browsers (viewport ≥ 768 px).',
                'warning',
            );
            console.warn('[fae.desktop] APP_READY: viewport too small, skipping init');
            return;
        }

        try {
            console.log('[fae.desktop] Calling desktop.init()...');
            await desktop.init();
            console.log('[fae.desktop] desktop.init() completed ✓');

            _registerSlashCommands({ desktop, getSettings, saveSetting, readSetting, applySkin, applyColorPreset, exportSettings, importSettings, resetSettings });
            console.log('[fae.desktop] Slash commands registered ✓');

            _setupLifecycleHandlers({ desktop, eventSource, event_types, log, warn });
            console.log('[fae.desktop] Lifecycle handlers attached ✓');

            console.log('[fae.desktop] ========== BOOTSTRAP COMPLETE ==========');
        } catch (e) {
            error?.('APP_READY: bootstrap failed', e);
            console.error('[fae.desktop] Bootstrap error:', e);
        }
    });

    // -----------------------------------------------------------------------
    // 4. Settings UI: bind when the extension drawer is opened
    // -----------------------------------------------------------------------

    try {
        eventSource.on(event_types?.SETTINGS_UPDATED ?? 'settings_updated', () => {
            _imports.settings?.applyCustomCss?.();
        });
    } catch (e) {
        console.warn('[fae.desktop] Could not bind SETTINGS_UPDATED:', e);
    }

    console.log('[fae.desktop] index.js IIFE finished — waiting for APP_READY');
})();

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

/**
 * Register all /desktop sub-commands.
 *
 * Usage overview:
 *   /desktop on|off
 *   /desktop skin [macos|frost|rose|moss|<filename>]
 *   /desktop layout [save|load|list] [name]
 *   /desktop align [left|right|center|full]
 *   /desktop widget [open|close|toggle] [widgetId]
 *   /desktop wallpaper [url|clear|fit <mode>|blur <0-20>|dim <0-100>]
 *   /desktop particles [on|off|style <name>|density <low|medium|high>]
 *   /desktop reset
 *
 * @param {object} deps  — injected module dependencies
 */
function _registerSlashCommands(deps) {
    const { desktop, getSettings, saveSetting, readSetting, applySkin, applyColorPreset, exportSettings, importSettings, resetSettings } = deps;

    const ctx = SillyTavern.getContext();

    // ST uses registerSlashCommand(name, callback, aliases, helpString, returnType, namedArgs)
    // Signature varies by ST version; we use the most common two-arg form and
    // guard with a try/catch.
    const register = ctx.registerSlashCommand || ctx.SlashCommandParser?.addCommandObject?.bind(ctx.SlashCommandParser);

    if (!register) {
        console.warn('[fae.desktop] registerSlashCommand not available in this ST version.');
        return;
    }

    /**
     * Helper: split "sub args..." from the command string.
     * e.g. "/desktop skin frost"  →  { sub: 'skin', rest: 'frost' }
     */
    function parse(args) {
        if (typeof args === 'string') {
            const [sub, ...rest] = args.trim().split(/\s+/);
            return { sub: (sub || '').toLowerCase(), rest: rest.join(' ').trim() };
        }
        // Named args object (newer ST versions)
        return { sub: String(args?.subcommand || args?._raw || '').toLowerCase(), rest: String(args?.args || '') };
    }

    // -----------------------------------------------------------------------
    // /desktop  (main dispatcher)
    // -----------------------------------------------------------------------

    try {
        register(
            'desktop',
            async (args) => {
                const raw = typeof args === 'string' ? args : (args?._raw ?? '');
                const { sub, rest } = parse(raw);

                switch (sub) {
                    // --- on/off ------------------------------------------------
                    case 'on':
                    case 'enable':
                        if (!desktop.isEnabled) await desktop.enable();
                        return 'fae.desktop: enabled.';

                    case 'off':
                    case 'disable':
                        if (desktop.isEnabled) await desktop.disable();
                        return 'fae.desktop: disabled.';

                    // --- skin --------------------------------------------------
                    case 'skin':
                        return await _cmdSkin(rest, { applySkin, applyColorPreset, saveSetting });

                    // --- layout ------------------------------------------------
                    case 'layout':
                        return _cmdLayout(rest, { getSettings, saveSetting });

                    // --- align -------------------------------------------------
                    case 'align':
                        return _cmdAlign(rest, { saveSetting, desktop });

                    // --- widget ------------------------------------------------
                    case 'widget':
                        return _cmdWidget(rest);

                    // --- wallpaper ---------------------------------------------
                    case 'wallpaper':
                        return _cmdWallpaper(rest, { saveSetting, desktop });

                    // --- particles ---------------------------------------------
                    case 'particles':
                        return _cmdParticles(rest, { saveSetting });

                    // --- reset -------------------------------------------------
                    case 'reset':
                        resetSettings();
                        if (desktop.isEnabled) {
                            await desktop.disable();
                            await desktop.init();
                        }
                        return 'fae.desktop: settings reset to defaults.';

                    // --- export/import -----------------------------------------
                    case 'export':
                        return exportSettings();

                    case 'import':
                        try {
                            importSettings(rest);
                            return 'fae.desktop: settings imported.';
                        } catch (e) {
                            return `fae.desktop error: ${e.message}`;
                        }

                    // --- help --------------------------------------------------
                    case '':
                    case 'help':
                    default:
                        return _desktopHelp();
                }
            },
            [],
            '/desktop [on|off|skin|layout|align|widget|wallpaper|particles|reset|export|import] — Control fae.desktop',
            true, // returns a value
        );
    } catch (e) {
        console.warn('[fae.desktop] Slash command registration failed:', e);
    }
}

// ---------------------------------------------------------------------------
// Slash command sub-handlers
// ---------------------------------------------------------------------------

async function _cmdSkin(rest, { applySkin, applyColorPreset, saveSetting }) {
    const name = rest.trim().toLowerCase();

    const validSkins = ['macos', 'frost', 'rose', 'moss'];

    if (!name) {
        const current = SillyTavern.getContext().extensionSettings?.fae_desktop?.skin ?? 'macos';
        return `Current skin: ${current}. Available: ${validSkins.join(', ')}`;
    }

    // Apply color preset separately for non-macos base skins
    const colorPresets = ['frost', 'rose', 'moss'];
    if (colorPresets.includes(name)) {
        applyColorPreset(name);
    } else {
        applyColorPreset(null);
    }

    await applySkin(name);
    saveSetting('skin', name);
    return `fae.desktop: skin set to "${name}".`;
}

function _cmdLayout(rest, { getSettings, saveSetting }) {
    const [action, layoutName] = rest.trim().split(/\s+/);
    const settings = getSettings();

    switch ((action || '').toLowerCase()) {
        case 'save': {
            const name = layoutName || 'default';
            if (!settings.layouts) settings.layouts = {};
            settings.layouts[name] = {
                windows: _captureWindowPositions(),
            };
            saveSetting('activeLayout', name);
            return `Layout "${name}" saved.`;
        }
        case 'load': {
            const name = layoutName || settings.activeLayout || 'default';
            const layout = settings.layouts?.[name];
            if (!layout) return `Layout "${name}" not found.`;
            saveSetting('activeLayout', name);
            _applyWindowPositions(layout.windows);
            return `Layout "${name}" loaded.`;
        }
        case 'list': {
            const names = Object.keys(settings.layouts || { default: {} });
            return `Layouts: ${names.join(', ')}`;
        }
        default:
            return 'Usage: /desktop layout [save|load|list] [name]';
    }
}

function _cmdAlign(rest, { saveSetting, desktop }) {
    const align = rest.trim().toLowerCase();
    const valid = ['left', 'right', 'center', 'full'];
    if (!valid.includes(align)) {
        return `Invalid alignment "${align}". Choose from: ${valid.join(', ')}`;
    }
    saveSetting('chatAlign', align);
    // Update live if desktop is active
    if (desktop.isEnabled) {
        const $chat = $('#fd-chat');
        $chat.removeClass('fd-chat-align-left fd-chat-align-right fd-chat-align-center fd-chat-align-full')
             .addClass(`fd-chat-align-${align}`);
    }
    return `Chat alignment set to "${align}".`;
}

function _cmdWidget(rest) {
    const [action, widgetId] = rest.trim().split(/\s+/);
    if (!action || !widgetId) return 'Usage: /desktop widget [open|close|toggle] [widgetId]';

    // Delegate to widget-loader via custom event
    document.dispatchEvent(new CustomEvent('fd:widget-command', {
        detail: { action: action.toLowerCase(), widgetId },
    }));
    return `Widget "${widgetId}": ${action}.`;
}

function _cmdWallpaper(rest, { saveSetting, desktop }) {
    const parts = rest.trim().split(/\s+/);
    const sub = (parts[0] || '').toLowerCase();

    switch (sub) {
        case 'clear':
            saveSetting('wallpaper.customUrl', '');
            saveSetting('wallpaper.useSTBackground', true);
            _reapplyWallpaper(desktop);
            return 'Wallpaper cleared (using ST background).';

        case 'fit': {
            const mode = (parts[1] || 'cover').toLowerCase();
            const valid = ['cover', 'contain', 'tile'];
            if (!valid.includes(mode)) return `Invalid fit "${mode}". Use: ${valid.join(', ')}`;
            saveSetting('wallpaper.fit', mode);
            _reapplyWallpaper(desktop);
            return `Wallpaper fit set to "${mode}".`;
        }

        case 'blur': {
            const val = parseInt(parts[1] ?? '0', 10);
            saveSetting('wallpaper.blur', isNaN(val) ? 0 : val);
            _reapplyWallpaper(desktop);
            return `Wallpaper blur set to ${val}px.`;
        }

        case 'dim': {
            const val = parseInt(parts[1] ?? '0', 10);
            saveSetting('wallpaper.dim', isNaN(val) ? 0 : val);
            _reapplyWallpaper(desktop);
            return `Wallpaper dim set to ${val}%.`;
        }

        default: {
            // Treat the whole rest as a URL
            const url = rest.trim();
            if (!url) return 'Usage: /desktop wallpaper [url|clear|fit <mode>|blur <n>|dim <n>]';
            saveSetting('wallpaper.customUrl', url);
            saveSetting('wallpaper.useSTBackground', false);
            _reapplyWallpaper(desktop);
            return `Wallpaper set to "${url}".`;
        }
    }
}

function _cmdParticles(rest, { saveSetting }) {
    const parts = rest.trim().split(/\s+/);
    const sub = (parts[0] || '').toLowerCase();

    switch (sub) {
        case 'on':
        case 'enable':
            saveSetting('particles.enabled', true);
            document.dispatchEvent(new CustomEvent('fd:particles-update', { detail: { enabled: true } }));
            return 'Particles enabled.';

        case 'off':
        case 'disable':
            saveSetting('particles.enabled', false);
            document.dispatchEvent(new CustomEvent('fd:particles-update', { detail: { enabled: false } }));
            return 'Particles disabled.';

        case 'style': {
            const style = parts[1] || '';
            const valid = ['fireflies', 'snow', 'rain', 'embers', 'stars', 'dust', 'petals'];
            if (!valid.includes(style)) return `Invalid style "${style}". Use: ${valid.join(', ')}`;
            saveSetting('particles.style', style);
            document.dispatchEvent(new CustomEvent('fd:particles-update', { detail: { style } }));
            return `Particles style set to "${style}".`;
        }

        case 'density': {
            const density = parts[1] || '';
            const valid = ['low', 'medium', 'high'];
            if (!valid.includes(density)) return `Invalid density "${density}". Use: ${valid.join(', ')}`;
            saveSetting('particles.density', density);
            document.dispatchEvent(new CustomEvent('fd:particles-update', { detail: { density } }));
            return `Particles density set to "${density}".`;
        }

        default:
            return 'Usage: /desktop particles [on|off|style <name>|density <low|medium|high>]';
    }
}

function _desktopHelp() {
    return [
        'fae.desktop slash commands:',
        '  /desktop on|off             — Enable or disable desktop mode',
        '  /desktop skin <name>        — Apply a skin (macos, frost, rose, moss)',
        '  /desktop align <mode>       — Chat alignment (left, right, center, full)',
        '  /desktop layout save|load|list [name]',
        '  /desktop widget open|close|toggle <id>',
        '  /desktop wallpaper <url|clear|fit|blur|dim>',
        '  /desktop particles on|off|style <name>|density <level>',
        '  /desktop reset              — Reset all settings to defaults',
        '  /desktop export             — Export settings as JSON',
        '  /desktop import <json>      — Import settings from JSON',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Extension lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Wire up ST event listeners for chat/character changes so the desktop can
 * react (update titlebar, refresh wallpaper when ST background changes, etc.)
 *
 * @param {object} deps
 */
function _setupLifecycleHandlers({ desktop, eventSource, event_types, log, warn }) {
    if (!eventSource || !event_types) return;

    // Character loaded — update titlebar & character-specific layout
    const onCharLoad = () => {
        if (!desktop.isEnabled) return;
        _updateChatTitle(desktop);
        _maybeSwitchCharLayout(desktop);
    };

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED ?? 'character_message_rendered', onCharLoad);
    eventSource.on(event_types.CHAT_CHANGED ?? 'chat_changed', onCharLoad);

    // Chat cleared
    eventSource.on(event_types.CHAT_DELETED ?? 'chat_deleted', () => {
        _updateChatTitle(desktop);
    });

    // ST theme change — re-mirror wallpaper if useSTBackground is on
    eventSource.on(event_types.SETTINGS_UPDATED ?? 'settings_updated', () => {
        if (!desktop.isEnabled) return;
        const ctx = SillyTavern.getContext();
        const wp = ctx?.extensionSettings?.fae_desktop?.wallpaper;
        if (wp?.useSTBackground) {
            _reapplyWallpaper(desktop);
        }
    });

    log?.('lifecycle handlers registered');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Update the chat window title bar to reflect the current character.
 */
function _updateChatTitle(desktop) {
    if (!desktop.isEnabled) return;
    try {
        const ctx = SillyTavern.getContext();
        const name = ctx?.name2 || 'Chat';
        $('#fd-chat .fd-titlebar-title').text(name);
        $('#fd-menubar-charname').text(name ? `✦ ${name}` : '');
    } catch { /* ignore */ }
}

/**
 * If rememberPerChar is enabled, switch to the character-specific layout.
 */
function _maybeSwitchCharLayout(desktop) {
    const ctx = SillyTavern.getContext();
    const settings = ctx?.extensionSettings?.fae_desktop;
    if (!settings?.rememberPerChar) return;

    const charId = ctx?.characterId;
    if (!charId) return;

    const layoutName = `char_${charId}`;
    if (settings.layouts?.[layoutName]) {
        document.dispatchEvent(new CustomEvent('fd:layout-load', { detail: { name: layoutName } }));
    }
}

/**
 * Trigger wallpaper reapplication by emitting an event that desktop.js handles.
 */
function _reapplyWallpaper(desktop) {
    document.dispatchEvent(new CustomEvent('fd:wallpaper-update'));
}

/**
 * Capture current window positions (delegated to window-manager).
 * Returns an empty object if window-manager is not loaded.
 */
function _captureWindowPositions() {
    const positions = {};
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
    return positions;
}

/**
 * Apply saved window positions to live windows.
 */
function _applyWindowPositions(windows = {}) {
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
}

/**
 * Show a toast using ST's toastr if available, otherwise console fallback.
 *
 * @param {string} message
 * @param {'info'|'warning'|'error'|'success'} type
 */
function _showToast(message, type = 'info') {
    try {
        const t = window.toastr;
        if (t && typeof t[type] === 'function') {
            t[type](message, 'fae.desktop', { timeOut: 6000 });
            return;
        }
    } catch { /* ignore */ }
    console.warn(`[fae.desktop] ${message}`);
}
