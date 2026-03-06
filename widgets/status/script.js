/**
 * status/script.js — Character status HUD card
 *
 * Settings:
 *   injectToPrompt  boolean   (default false) — registers {{fae_status}} macro
 *   fields          string    (default "mood,location,outfit") — comma-separated list
 *
 * Storage model (per character):
 *   widgetData.status.data[`fields_${charId}`] = { mood: "...", location: "...", ... }
 *
 * Macro: {{fae_status}} → XML block consumed by the AI:
 *   <fae_status>
 *     <mood>happy</mood>
 *     ...
 *   </fae_status>
 *
 * Auto-parse: listens for AI messages containing  [status:field=value]  tags.
 */

(function initStatusWidget() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM refs
    // ------------------------------------------------------------------
    const $root       = DesktopWidget.getElement();
    const $avatar     = $root.find('.fd-status-avatar');
    const $placeholder= $root.find('.fd-status-avatar-placeholder');
    const $charName   = $root.find('.fd-status-char-name');
    const $injectBadge= $root.find('.fd-status-inject-badge');
    const $fields     = $root.find('.fd-status-fields');
    const $parseHint  = $root.find('.fd-status-parse-hint');
    const $copyBtn    = $root.find('.fd-status-copy-btn');

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let _charId          = null;
    let _fieldNames      = [];      // ['mood', 'location', 'outfit']
    let _fieldValues     = {};      // { mood: '...', ... }
    let _macroRegistered = false;

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------

    function _getFieldNames() {
        const raw = DesktopWidget.getSetting('fields') ?? 'mood,location,outfit';
        return raw.split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
    }

    function _isInjectOn() {
        const v = DesktopWidget.getSetting('injectToPrompt');
        return v === true || v === 'true';
    }

    // ------------------------------------------------------------------
    // Storage keys
    // ------------------------------------------------------------------

    function _fieldsKey(charId) {
        return `fields_${charId}`;
    }

    // ------------------------------------------------------------------
    // Load
    // ------------------------------------------------------------------

    function _load() {
        _charId    = DesktopWidget.getCharacterId();
        const char = DesktopWidget.getCharacter();

        // --- Avatar ---
        const avatarUrl = _getAvatarUrl(char);
        if (avatarUrl) {
            $avatar.attr('src', avatarUrl);
            $placeholder.addClass('hidden');
            $avatar.on('error', () => {
                $avatar.removeAttr('src');
                $placeholder.removeClass('hidden');
            });
        } else {
            $avatar.removeAttr('src');
            $placeholder.removeClass('hidden');
        }

        // --- Name ---
        $charName.text(char?.name || 'No character');

        // --- Field names ---
        _fieldNames = _getFieldNames();

        // --- Field values ---
        _fieldValues = {};
        if (_charId != null) {
            const stored = DesktopWidget.getData(_fieldsKey(_charId), {});
            _fieldValues = typeof stored === 'object' && stored !== null ? { ...stored } : {};
        }

        // --- Inject badge ---
        if (_isInjectOn()) {
            $injectBadge.removeAttr('hidden');
            $parseHint.removeAttr('hidden');
        } else {
            $injectBadge.attr('hidden', '');
            $parseHint.attr('hidden', '');
        }

        _renderFields();
        _syncMacro();
    }

    // ------------------------------------------------------------------
    // Avatar URL
    // ------------------------------------------------------------------

    function _getAvatarUrl(char) {
        if (!char) return null;
        try {
            const av = char.avatar;
            if (!av) return null;
            if (av.startsWith('data:') || av.startsWith('http')) return av;
            return `/thumbnail?type=avatar&file=${encodeURIComponent(av)}`;
        } catch { return null; }
    }

    // ------------------------------------------------------------------
    // Render fields
    // ------------------------------------------------------------------

    function _renderFields() {
        $fields.empty();

        if (!_charId || _fieldNames.length === 0) return;

        _fieldNames.forEach(name => {
            const val = _fieldValues[name] || '';

            const $row   = $('<div class="fd-status-field">');
            const $label = $('<span class="fd-status-field-label">').text(name);
            const $val   = $('<div class="fd-status-field-value" contenteditable="true" spellcheck="false">');

            $val.attr('data-placeholder', '—');
            $val.attr('data-field', name);
            $val.text(val);

            // Focus → mark editing
            $val.on('focus', function () {
                $(this).addClass('editing');
            });

            // Blur → save
            $val.on('blur', function () {
                $(this).removeClass('editing');
                const newVal = $(this).text().trim();
                _fieldValues[name] = newVal;
                _saveFields();
                _syncMacro();
            });

            // Enter key → blur (save)
            $val.on('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    $(this).blur();
                }
            });

            $row.append($label, $val);
            $fields.append($row);
        });
    }

    // ------------------------------------------------------------------
    // Save
    // ------------------------------------------------------------------

    function _saveFields() {
        if (_charId == null) return;
        DesktopWidget.setData(_fieldsKey(_charId), _fieldValues);
        DesktopWidget.saveData();
    }

    // ------------------------------------------------------------------
    // XML builder
    // ------------------------------------------------------------------

    function _buildXml() {
        if (_fieldNames.length === 0) return '';
        const inner = _fieldNames.map(name => {
            const v = (_fieldValues[name] || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `  <${name}>${v}</${name}>`;
        }).join('\n');
        return `<fae_status>\n${inner}\n</fae_status>`;
    }

    // ------------------------------------------------------------------
    // {{fae_status}} macro management
    // ------------------------------------------------------------------

    function _syncMacro() {
        if (!_isInjectOn()) {
            _unregisterMacro();
            return;
        }

        // Register (or update) the macro. ST macros are registered via
        // SillyTavern.getContext().registerMacro(name, fn)
        try {
            const ctx = DesktopWidget.getContext();
            if (typeof ctx?.registerMacro === 'function') {
                ctx.registerMacro('fae_status', () => _buildXml());
                _macroRegistered = true;
            } else {
                // Fallback: monkey-patch the macro resolver if available
                if (typeof window !== 'undefined' && window.fae_desktop_macros) {
                    window.fae_desktop_macros['fae_status'] = () => _buildXml();
                }
            }
        } catch (e) { /* ignore */ }
    }

    function _unregisterMacro() {
        if (!_macroRegistered) return;
        try {
            const ctx = DesktopWidget.getContext();
            if (typeof ctx?.unregisterMacro === 'function') {
                ctx.unregisterMacro('fae_status');
            }
        } catch { /* ignore */ }
        _macroRegistered = false;
    }

    // ------------------------------------------------------------------
    // Auto-parse AI messages for [status:field=value] tags
    // ------------------------------------------------------------------

    function _parseMessageForStatus(messageText) {
        if (!messageText || typeof messageText !== 'string') return false;
        // Pattern: [status:field=value]  (case-insensitive)
        const re = /\[status:([a-z_]+)=([^\]]*)\]/gi;
        let matched = false;
        let m;
        while ((m = re.exec(messageText)) !== null) {
            const field = m[1].toLowerCase();
            const value = m[2].trim();
            if (_fieldNames.includes(field)) {
                _fieldValues[field] = value;
                matched = true;
            }
        }
        if (matched) {
            _saveFields();
            _renderFields();
            _syncMacro();
        }
        return matched;
    }

    DesktopWidget.onMessage((msg) => {
        if (!_isInjectOn()) return;
        // msg may be a string or object depending on ST version
        const text = typeof msg === 'string' ? msg : (msg?.mes || msg?.text || '');
        _parseMessageForStatus(text);
    });

    // ------------------------------------------------------------------
    // Copy XML button
    // ------------------------------------------------------------------

    $copyBtn.on('click', () => {
        const xml = _buildXml();
        if (!xml) return;
        try {
            navigator.clipboard.writeText(xml).then(() => {
                DesktopWidget.showToast('Status XML copied!', 'success');
            });
        } catch {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = xml;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            DesktopWidget.showToast('Copied!', 'success');
        }
    });

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    DesktopWidget.onActivate(_load);
    DesktopWidget.onChatChanged(_load);

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    _load();

})();
