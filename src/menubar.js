/**
 * fae.desktop — menubar.js
 *
 * macOS-style menu bar at the top of #fd-root.
 *
 * Features:
 *   - Left side: 🍎 logo menu, app menus (Chat, Widgets, View)
 *   - Right side: character name, live clock, date
 *   - Dropdown menus with checkmarks / radio items
 *   - Classic macOS "hover-to-switch" menu behaviour when one menu is open
 *   - Clock updates via setInterval (every 30s; immediate first tick)
 *   - Dynamic Widgets menu: registered widgets appear as toggles
 *   - Cross-module communication via 'fd:menubar-action' CustomEvent
 *
 * Public API:
 *   menubar.init(container)
 *   menubar.destroy()
 *   menubar.updateClock()
 *   menubar.updateCharName()
 *   menubar.registerWidget(id, name, icon)
 *   menubar.unregisterWidget(id)
 *   menubar.setMenuItemState(menuId, itemId, state)
 */

import { log, warn } from './utils.js';
import { readSetting, getSettings } from './settings.js';

// ---------------------------------------------------------------------------
// Menu definitions
// ---------------------------------------------------------------------------

/**
 * Static menu structure.
 * type: 'item' | 'separator' | 'radio-group'
 * For radio-group, items[] holds the options (each with id, label).
 * checked / radioValue are live state — read/written at render time.
 */
const _MENUS = [
    {
        id:    'apple',
        label: null,   // replaced by SVG logo
        items: [
            { id: 'about',           label: 'About fae.desktop',  type: 'item' },
            { id: 'preferences',     label: 'Preferences…',       type: 'item' },
            { type: 'separator' },
            { id: 'reload-desktop',  label: 'Reload Desktop',     type: 'item' },
        ],
    },
    {
        id:    'chat',
        label: 'Chat',
        items: [
            {
                id:         'chat-align',
                type:       'radio-group',
                label:      'Align',
                radioValue: 'left', // synced from settings at render time
                options: [
                    { id: 'align-left',   label: 'Align Left',   value: 'left' },
                    { id: 'align-right',  label: 'Align Right',  value: 'right' },
                    { id: 'align-center', label: 'Align Center', value: 'center' },
                    { id: 'align-full',   label: 'Full Width',   value: 'full' },
                ],
            },
            { type: 'separator' },
            { id: 'compact-messages', label: 'Compact Messages', type: 'toggle', checked: false },
        ],
    },
    {
        id:    'widgets',
        label: 'Widgets',
        items: [
            // Widget toggle items are injected here at runtime via registerWidget()
            { type: 'separator', class: 'fd-menu-sep-widgets-end' },
            { id: 'import-widget', label: 'Import Widget…', type: 'item' },
        ],
    },
    {
        id:    'view',
        label: 'View',
        items: [
            { id: 'toggle-dock',      label: 'Toggle Dock',       type: 'toggle', checked: true },
            { id: 'toggle-particles', label: 'Toggle Particles',  type: 'toggle', checked: false },
            { type: 'separator' },
            { id: 'layout-default',  label: 'Layout: Default',    type: 'item' },
            { id: 'layout-save',     label: 'Save Current…',      type: 'item' },
            { id: 'layout-reset',    label: 'Reset All',          type: 'item' },
        ],
    },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {jQuery|null} */
let _$menubar = null;

/** @type {jQuery|null} */
let _$container = null;

/** id of the currently open menu, or null. */
let _openMenuId = null;

/** @type {number|null} setInterval handle for the clock. */
let _clockInterval = null;

/** Map of widgetId → { name, icon } for registered widgets. */
const _widgets = new Map();

/** Live state map for toggle/radio items: { [itemId]: boolean | string } */
const _itemStates = {};

// ---------------------------------------------------------------------------
// init / destroy
// ---------------------------------------------------------------------------

/**
 * Create and mount the menu bar inside `container` (#fd-root).
 * @param {jQuery} $container
 */
export function init($container) {
    if (_$menubar) {
        warn('menubar.init: already initialised');
        return;
    }

    _$container = $container;

    // Sync initial state from settings
    _syncStateFromSettings();

    // Build DOM
    _$menubar = $('<div>', {
        id:    'fd-menubar',
        class: 'fd-menubar',
        role:  'menubar',
    });

    _$menubar.append(_buildLeft(), _buildRight());

    // Prepend to container (above workspace)
    $container.prepend(_$menubar);

    // Apply visibility settings
    _applyVisibilitySettings();

    // Start clock
    _startClock();

    // Global click → close open menu
    $(document).on('mousedown.menubar-close', (e) => {
        if (_openMenuId && !$(e.target).closest('#fd-menubar').length) {
            _closeAllMenus();
        }
    });

    // Listen for window-focused events to highlight the active window title
    $(document).on('fd:window-focused.menubar', _onWindowFocused);

    // Listen for chat-changed to refresh char name
    $(document).on('fd:chat-changed.menubar', () => updateCharName());

    log('menubar: initialised');
}

/**
 * Remove the menu bar and clean up.
 */
export function destroy() {
    if (!_$menubar) return;

    _stopClock();

    $(document).off('.menubar-close');
    $(document).off('.menubar');

    _$menubar.remove();
    _$menubar    = null;
    _$container  = null;
    _openMenuId  = null;

    log('menubar: destroyed');
}

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

function _buildLeft() {
    const $left = $('<div>', { class: 'fd-menubar-left' });

    _MENUS.forEach((menu) => {
        const $btn = _buildMenuButton(menu);
        $left.append($btn);
    });

    return $left;
}

function _buildMenuButton(menu) {
    const $btn = $('<button>', {
        class:            'fd-menubar-item',
        'data-fd-menu-id': menu.id,
        'aria-haspopup':  'true',
        'aria-expanded':  'false',
    });

    if (menu.id === 'apple') {
        $btn.addClass('fd-menubar-apple').html(_appleLogo()).attr('title', 'fae.desktop');
    } else {
        $btn.text(menu.label);
    }

    $btn.on('click.menubar', (e) => {
        e.stopPropagation();
        _onMenuButtonClick(menu.id);
    });

    $btn.on('mouseenter.menubar', () => {
        // If any menu is open, switch to this one immediately (macOS behavior)
        if (_openMenuId && _openMenuId !== menu.id) {
            _openMenu(menu.id);
        }
    });

    return $btn;
}

function _buildRight() {
    const $right = $('<div>', { class: 'fd-menubar-right' });

    $right.append(
        $('<span>', { id: 'fd-menubar-charname', class: 'fd-menubar-status-item fd-menubar-charname' }),
        $('<span>', { id: 'fd-menubar-date',     class: 'fd-menubar-status-item fd-menubar-date' }),
        $('<span>', { id: 'fd-menubar-clock',    class: 'fd-menubar-status-item fd-menubar-clock' }),
    );

    return $right;
}

// ---------------------------------------------------------------------------
// Menu open / close
// ---------------------------------------------------------------------------

function _onMenuButtonClick(menuId) {
    if (_openMenuId === menuId) {
        _closeAllMenus();
    } else {
        _openMenu(menuId);
    }
}

function _openMenu(menuId) {
    _closeAllMenus(false);

    const menu = _MENUS.find((m) => m.id === menuId);
    if (!menu) return;

    _openMenuId = menuId;

    // Mark button as active
    const $btn = _$menubar.find(`[data-fd-menu-id="${menuId}"]`);
    $btn.addClass('fd-menubar-item-active').attr('aria-expanded', 'true');

    // Build + position dropdown
    const $dropdown = _buildDropdown(menu);
    _$menubar.append($dropdown);

    // Position below the button
    const btnRect = $btn[0].getBoundingClientRect();
    const mbRect  = _$menubar[0].getBoundingClientRect();
    $dropdown.css({
        left: `${btnRect.left - mbRect.left}px`,
        top:  `${mbRect.height}px`,
    });

    // Focus first item for keyboard nav (optional, nice to have)
    requestAnimationFrame(() => {
        $dropdown.find('.fd-menu-item:first').trigger('focus');
    });
}

function _closeAllMenus(clear = true) {
    if (_$menubar) {
        _$menubar.find('.fd-menubar-item').removeClass('fd-menubar-item-active').attr('aria-expanded', 'false');
        _$menubar.find('.fd-dropdown').remove();
    }
    if (clear) _openMenuId = null;
}

// ---------------------------------------------------------------------------
// Dropdown builder
// ---------------------------------------------------------------------------

function _buildDropdown(menu) {
    const $dd = $('<div>', {
        class:            'fd-dropdown',
        role:             'menu',
        'data-fd-menu-id': menu.id,
    });

    // For widgets menu, merge dynamic widget items before the separator
    const items = menu.id === 'widgets' ? _buildWidgetsMenuItems(menu.items) : menu.items;

    items.forEach((item) => {
        $dd.append(_buildDropdownItem(item, menu.id));
    });

    return $dd;
}

/**
 * Insert registered widget toggles before the end separator in the Widgets menu.
 */
function _buildWidgetsMenuItems(staticItems) {
    const result = [];
    const endSepIdx = staticItems.findIndex((i) => i.class === 'fd-menu-sep-widgets-end');

    staticItems.forEach((item, idx) => {
        if (idx === endSepIdx) {
            // Insert widget items
            _widgets.forEach(({ name, icon }, id) => {
                result.push({
                    id:      `widget-toggle-${id}`,
                    label:   `${icon} ${name}`,
                    type:    'toggle',
                    checked: Boolean(_itemStates[`widget-toggle-${id}`]),
                    _widgetId: id,
                });
            });
        }
        result.push(item);
    });

    return result;
}

function _buildDropdownItem(item, menuId) {
    if (item.type === 'separator') {
        return $('<div>', { class: `fd-menu-separator${item.class ? ' ' + item.class : ''}` });
    }

    if (item.type === 'radio-group') {
        // Sync current radio value
        const currentValue = _itemStates[item.id] !== undefined
            ? _itemStates[item.id]
            : item.radioValue;

        const $group = $('<div>', { class: 'fd-menu-radio-group' });
        item.options.forEach((opt) => {
            const isChecked = opt.value === currentValue;
            const $opt = _buildDropdownItem({
                id:      opt.id,
                label:   opt.label,
                type:    'radio',
                checked: isChecked,
                _radioGroupId: item.id,
                _radioValue:   opt.value,
            }, menuId);
            $group.append($opt);
        });
        return $group;
    }

    const $item = $('<button>', {
        class:  'fd-menu-item',
        role:   item.type === 'toggle' ? 'menuitemcheckbox'
              : item.type === 'radio'  ? 'menuitemradio'
              : 'menuitem',
        'aria-checked': (item.type === 'toggle' || item.type === 'radio')
            ? String(Boolean(item.checked))
            : undefined,
        'data-fd-menu-item-id': item.id,
    });

    // Checkmark / radio dot
    const $indicator = $('<span>', { class: 'fd-menu-indicator' });
    if (item.type === 'toggle' && item.checked) {
        $indicator.text('✓');
    } else if (item.type === 'radio' && item.checked) {
        $indicator.text('•');
    }

    $item.append($indicator, $('<span>', { class: 'fd-menu-label', text: item.label }));

    $item.on('click.menubar', (e) => {
        e.stopPropagation();
        _onMenuItemClick(menuId, item);
    });

    return $item;
}

// ---------------------------------------------------------------------------
// Menu item click handler
// ---------------------------------------------------------------------------

function _onMenuItemClick(menuId, item) {
    _closeAllMenus();

    if (item.type === 'toggle') {
        const newState = !Boolean(_itemStates[item.id] !== undefined ? _itemStates[item.id] : item.checked);
        _itemStates[item.id] = newState;

        if (item._widgetId) {
            // Widget toggle
            _dispatch('fd:menubar-action', {
                action:   'toggle-widget',
                widgetId: item._widgetId,
                state:    newState,
            });
        } else {
            _dispatch('fd:menubar-action', {
                action: item.id,
                state:  newState,
                menuId,
            });
        }
        return;
    }

    if (item.type === 'radio') {
        _itemStates[item._radioGroupId] = item._radioValue;
        _dispatch('fd:menubar-action', {
            action:   item._radioGroupId,
            value:    item._radioValue,
            menuId,
        });
        return;
    }

    // Plain item
    _dispatch('fd:menubar-action', { action: item.id, menuId });
}

function _dispatch(name, detail) {
    document.dispatchEvent(new CustomEvent(name, {
        bubbles: false,
        cancelable: false,
        detail,
    }));
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function _startClock() {
    _stopClock();
    updateClock();
    _clockInterval = setInterval(updateClock, 30_000);
}

function _stopClock() {
    if (_clockInterval !== null) {
        clearInterval(_clockInterval);
        _clockInterval = null;
    }
}

/**
 * Refresh the clock and date display.
 * Called automatically by the interval; also callable externally.
 */
export function updateClock() {
    if (!_$menubar) return;

    const settings = getSettings();
    const mb       = settings.menubar;
    const now      = new Date();

    if (mb.showClock) {
        const fmt = mb.clockFormat === '12h'
            ? { hour: 'numeric', minute: '2-digit', hour12: true }
            : { hour: '2-digit', minute: '2-digit', hour12: false };
        _$menubar.find('#fd-menubar-clock').text(now.toLocaleTimeString([], fmt));
    }

    if (mb.showDate) {
        const dateFmt = { weekday: 'short', month: 'short', day: 'numeric' };
        _$menubar.find('#fd-menubar-date').text(now.toLocaleDateString([], dateFmt));
    }
}

// ---------------------------------------------------------------------------
// Character name
// ---------------------------------------------------------------------------

/**
 * Refresh the character name in the right status area.
 */
export function updateCharName() {
    if (!_$menubar) return;

    const settings = getSettings();
    if (!settings.menubar.showCharName) {
        _$menubar.find('#fd-menubar-charname').text('');
        return;
    }

    let name = '';
    try {
        const ctx = SillyTavern.getContext();
        name = ctx?.name2 || '';
    } catch { /* ignore */ }

    _$menubar.find('#fd-menubar-charname').text(name ? `✦ ${name}` : '');
}

// ---------------------------------------------------------------------------
// Widget registration
// ---------------------------------------------------------------------------

/**
 * Register a widget so it appears in Widgets menu as a toggle.
 * @param {string} id    — widget id
 * @param {string} name  — display name
 * @param {string} icon  — emoji / short string
 */
export function registerWidget(id, name, icon) {
    _widgets.set(id, { name, icon: icon || '🧩' });
    _itemStates[`widget-toggle-${id}`] = false;
    log(`menubar.registerWidget: "${id}"`);
}

/**
 * Remove a widget from the Widgets menu.
 * @param {string} id
 */
export function unregisterWidget(id) {
    _widgets.delete(id);
    delete _itemStates[`widget-toggle-${id}`];
    log(`menubar.unregisterWidget: "${id}"`);
}

// ---------------------------------------------------------------------------
// Live item state update (called by external modules)
// ---------------------------------------------------------------------------

/**
 * Update the checked / value state of a menu item.
 * The next time the dropdown is opened the item will reflect the new state.
 *
 * @param {string}           menuId   — e.g. 'chat', 'view'
 * @param {string}           itemId   — e.g. 'compact-messages', 'chat-align'
 * @param {boolean|string}   state    — boolean for toggles, string value for radios
 */
export function setMenuItemState(menuId, itemId, state) {
    _itemStates[itemId] = state;
    log(`menubar.setMenuItemState: [${menuId}] "${itemId}" = ${state}`);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _syncStateFromSettings() {
    const settings = getSettings();

    _itemStates['chat-align']        = settings.chatAlign || 'left';
    _itemStates['compact-messages']  = Boolean(settings.chat?.compact);
    _itemStates['toggle-dock']       = true;
    _itemStates['toggle-particles']  = Boolean(settings.particles?.enabled);
}

function _applyVisibilitySettings() {
    if (!_$menubar) return;

    const mb = readSetting('menubar');
    _$menubar.toggle(Boolean(mb.show));
    _$menubar.find('#fd-menubar-clock').toggle(Boolean(mb.showClock));
    _$menubar.find('#fd-menubar-date').toggle(Boolean(mb.showDate));
    _$menubar.find('#fd-menubar-charname').toggle(Boolean(mb.showCharName));
}

function _onWindowFocused(e) {
    // Optional: could highlight the window's menu name here if desired
    const nativeEvent = e.originalEvent || e;
    const id = nativeEvent?.detail?.id;
    if (id) {
        log(`menubar: window focused "${id}"`);
    }
}

// ---------------------------------------------------------------------------
// Apple logo SVG
// ---------------------------------------------------------------------------

function _appleLogo() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="17" viewBox="0 0 14 17" fill="currentColor" aria-hidden="true">
        <path d="M13.23 12.27c-.28.63-.41.91-.77 1.47-.5.76-1.21 1.71-2.08 1.72-.78.01-1-.51-2.07-.5-1.07 0-1.31.52-2.09.51-.87-.01-1.54-.87-2.04-1.63-1.4-2.14-1.55-4.65-.68-5.98.62-.95 1.59-1.5 2.51-1.5 1 0 1.63.52 2.46.52.8 0 1.29-.52 2.44-.52.82 0 1.69.45 2.31 1.22-.03.02-1.38.8-1.36 2.4.02 1.89 1.66 2.52 1.37 2.79zM9.24 2.13C9.66 1.6 9.98.82 9.87 0c-.72.05-1.56.5-2.05 1.07C7.37 1.6 7 2.36 7.13 3.1c.78.06 1.6-.4 2.11-1.0z"/>
    </svg>`;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default {
    init,
    destroy,
    updateClock,
    updateCharName,
    registerWidget,
    unregisterWidget,
    setMenuItemState,
};
