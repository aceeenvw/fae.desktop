/**
 * notes/script.js — Per-character notepad widget
 *
 * API surface used:
 *   DesktopWidget.getCharacter()        — active character object
 *   DesktopWidget.getCharacterId()      — active character index
 *   DesktopWidget.getData(key, fb)      — read from widgetData.notes.data
 *   DesktopWidget.setData(key, value)   — write to widgetData.notes.data
 *   DesktopWidget.saveData()            — persist via saveSettingsDebounced
 *   DesktopWidget.onActivate(cb)        — called when window opens/focuses
 *   DesktopWidget.onChatChanged(cb)     — called when character/chat changes
 *   DesktopWidget.getContext()          — raw ST context
 *
 * The note storage key for each character is:
 *   widgetData.notes.data[`char_${charId}`]
 *
 * The notes widget also reads from the top-level settings.notes[charId]
 * as a legacy fallback so data from older saves isn't lost.
 */

(function initNotesWidget() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM references
    // ------------------------------------------------------------------

    const $root       = DesktopWidget.getElement();
    const $textarea   = $root.find('.fd-notes-textarea');
    const $preview    = $root.find('.fd-notes-preview');
    const $charName   = $root.find('.fd-notes-char-name');
    const $avatar     = $root.find('.fd-notes-avatar');
    const $count      = $root.find('.fd-notes-count');
    const $previewBtn = $root.find('.fd-notes-preview-btn');
    const $clearBtn   = $root.find('.fd-notes-clear-btn');
    const $indicator  = $root.find('.fd-notes-save-indicator');

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    let isPreviewing    = false;
    let saveTimer       = null;
    let saveIndicatorTimer = null;
    let _currentCharId  = null;

    // ------------------------------------------------------------------
    // Markdown renderer
    // ------------------------------------------------------------------

    function _renderMarkdown(text) {
        // Prefer showdown from SillyTavern.libs if available
        try {
            const ctx = DesktopWidget.getContext();
            const Showdown = ctx?.libs?.showdown ?? window.showdown;
            if (Showdown) {
                const converter = new Showdown.Converter({
                    tables: true,
                    simplifiedAutoLink: true,
                    strikethrough: true,
                    tasklists: true,
                    openLinksInNewWindow: true,
                });
                return converter.makeHtml(text || '');
            }
        } catch (e) { /* fall through */ }

        // Minimal fallback: escape HTML then handle bold/italic/code
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const lines = (text || '').split('\n');
        const html = lines.map((line) => {
            let l = esc(line);
            l = l.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            l = l.replace(/\*(.+?)\*/g,     '<em>$1</em>');
            l = l.replace(/`(.+?)`/g,       '<code>$1</code>');
            return `<p>${l}</p>`;
        }).join('');
        return html;
    }

    // ------------------------------------------------------------------
    // Key: per-character storage key
    // ------------------------------------------------------------------

    function _noteKey(charId) {
        return `char_${charId}`;
    }

    // ------------------------------------------------------------------
    // Load note for the currently active character
    // ------------------------------------------------------------------

    function _loadNote() {
        const charId = DesktopWidget.getCharacterId();
        _currentCharId = charId;

        const char = DesktopWidget.getCharacter();

        // Update header
        if (char) {
            $charName.text(char.name || 'Unknown');
            // Try to get avatar URL
            const avatarUrl = _getAvatarUrl(char);
            if (avatarUrl) {
                $avatar.attr('src', avatarUrl).show();
            } else {
                $avatar.attr('src', '').hide();
            }
        } else {
            $charName.text('No character');
            $avatar.attr('src', '').hide();
        }

        if (charId == null) {
            $textarea.val('').prop('disabled', true);
            _updateCount('');
            return;
        }

        $textarea.prop('disabled', false);

        // 1. Try per-widget data store (new storage)
        let note = DesktopWidget.getData(_noteKey(charId), null);

        // 2. Legacy fallback: top-level settings.notes[charId]
        if (note === null) {
            try {
                const ctx = DesktopWidget.getContext();
                const legacyNotes = ctx?.extensionSettings?.fae_desktop?.notes ?? {};
                if (charId in legacyNotes) {
                    note = legacyNotes[charId];
                }
            } catch { /* ignore */ }
        }

        const text = note || '';
        $textarea.val(text);
        _updateCount(text);

        if (isPreviewing) {
            $preview.html(_renderMarkdown(text));
        }
    }

    // ------------------------------------------------------------------
    // Avatar resolution
    // ------------------------------------------------------------------

    function _getAvatarUrl(char) {
        if (!char) return null;
        try {
            // ST stores avatar filenames in char.avatar
            const avatar = char.avatar;
            if (!avatar) return null;
            if (avatar.startsWith('data:') || avatar.startsWith('http')) return avatar;
            // ST serves character thumbnails from this path
            return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
        } catch { return null; }
    }

    // ------------------------------------------------------------------
    // Save note (debounced)
    // ------------------------------------------------------------------

    function _scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(_doSave, 500);
    }

    function _doSave() {
        const charId = _currentCharId;
        if (charId == null) return;

        const text = $textarea.val();
        DesktopWidget.setData(_noteKey(charId), text);
        DesktopWidget.saveData();

        _showSavedIndicator();
    }

    function _showSavedIndicator() {
        $indicator.text('saved').addClass('visible');
        clearTimeout(saveIndicatorTimer);
        saveIndicatorTimer = setTimeout(() => {
            $indicator.removeClass('visible');
        }, 1500);
    }

    // ------------------------------------------------------------------
    // Character count
    // ------------------------------------------------------------------

    function _updateCount(text) {
        const len = (text || '').length;
        $count.text(len > 0 ? `${len} chars` : '0 chars');
    }

    // ------------------------------------------------------------------
    // Preview toggle
    // ------------------------------------------------------------------

    function _togglePreview() {
        isPreviewing = !isPreviewing;
        $previewBtn.toggleClass('active', isPreviewing);

        if (isPreviewing) {
            const text = $textarea.val();
            $preview.html(_renderMarkdown(text));
            $textarea.hide();
            $preview.removeAttr('hidden').show();
        } else {
            $preview.hide();
            $textarea.show();
            $textarea.focus();
        }
    }

    // ------------------------------------------------------------------
    // Clear button
    // ------------------------------------------------------------------

    function _clearNote() {
        if (!$textarea.val()) return;
        // Simple confirmation
        if (!window.confirm('Clear this character\'s note?')) return;
        $textarea.val('');
        _updateCount('');
        _doSave();
    }

    // ------------------------------------------------------------------
    // Event wiring
    // ------------------------------------------------------------------

    $textarea.on('keyup input', function () {
        const text = $(this).val();
        _updateCount(text);
        _scheduleSave();
    });

    $previewBtn.on('click', _togglePreview);
    $clearBtn.on('click', _clearNote);

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    DesktopWidget.onActivate(() => {
        _loadNote();
        if (!isPreviewing) {
            setTimeout(() => $textarea.focus(), 50);
        }
    });

    DesktopWidget.onChatChanged(() => {
        _loadNote();
        if (!isPreviewing) {
            setTimeout(() => $textarea.focus(), 50);
        }
    });

    // ------------------------------------------------------------------
    // Initial load
    // ------------------------------------------------------------------

    _loadNote();

})();
