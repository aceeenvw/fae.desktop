/**
 * quicklinks/script.js — Quick links list widget
 *
 * Storage model:
 *   Settings key "links" (from widget.json settings) holds a multi-line string
 *   formatted as:  emoji|label|url  (one entry per line).
 *   The user can configure this from Settings, OR use the in-widget Add form.
 *
 *   Runtime additions are stored in widgetData.quicklinks.data.extraLinks as
 *   an array of { id, emoji, label, url } objects.
 *   At render time: parsed settings.links + data.extraLinks are merged.
 *
 * Clicking a row opens the URL in a new tab.
 * Edit mode shows delete buttons on each row.
 */

(function initQuicklinksWidget() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM refs
    // ------------------------------------------------------------------
    const $root     = DesktopWidget.getElement();
    const $list     = $root.find('.fd-ql-list');
    const $empty    = $root.find('.fd-ql-empty');
    const $editBtn  = $root.find('.fd-ql-edit-btn');
    const $addBtn   = $root.find('.fd-ql-add-btn');
    const $form     = $root.find('.fd-ql-add-form');
    const $inputEmoji = $root.find('.fd-ql-input-emoji');
    const $inputLabel = $root.find('.fd-ql-input-label');
    const $inputUrl   = $root.find('.fd-ql-input-url');
    const $cancelBtn  = $root.find('.fd-ql-cancel-btn');
    const $saveLinkBtn= $root.find('.fd-ql-save-link-btn');

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let _isEditMode  = false;
    let _links       = [];   // Array<{ id, emoji, label, url }>

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _uid() {
        return 's_' + Math.random().toString(36).slice(2, 10);
    }

    function _normalizeUrl(url) {
        if (!url) return '';
        url = url.trim();
        if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) {
            url = 'https://' + url;
        }
        return url;
    }

    // ------------------------------------------------------------------
    // Parse the settings "links" string
    // ------------------------------------------------------------------

    function _parseSettingsLinks() {
        const raw = DesktopWidget.getSetting('links') ?? '';
        if (!raw.trim()) return [];

        return raw.split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map((line, i) => {
                const parts = line.split('|');
                const emoji = (parts[0] || '').trim() || '🔗';
                const label = (parts[1] || '').trim() || line;
                const url   = _normalizeUrl(parts[2] || parts[1] || '');
                return { id: `cfg_${i}`, emoji, label, url, _fromSettings: true };
            });
    }

    // ------------------------------------------------------------------
    // Load all links
    // ------------------------------------------------------------------

    function _load() {
        const fromSettings = _parseSettingsLinks();
        const extra        = DesktopWidget.getData('extraLinks', []);
        _links = [...fromSettings, ...Array.isArray(extra) ? extra : []];
        _render();
    }

    // ------------------------------------------------------------------
    // Save extra links (non-settings additions)
    // ------------------------------------------------------------------

    function _saveExtras() {
        const extras = _links.filter(l => !l._fromSettings);
        DesktopWidget.setData('extraLinks', extras);
        DesktopWidget.saveData();
    }

    // ------------------------------------------------------------------
    // Also update the settings "links" string to include user additions
    // (so they persist when the widget is reloaded from settings).
    // ------------------------------------------------------------------

    function _saveAllToSettings() {
        const settingsStr = _links
            .map(l => `${l.emoji}|${l.label}|${l.url}`)
            .join('\n');
        DesktopWidget.setSetting('links', settingsStr);
    }

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    function _render() {
        $list.empty();

        if (_links.length === 0) {
            $empty.removeClass('hidden');
            return;
        }

        $empty.addClass('hidden');
        $list.toggleClass('edit-mode', _isEditMode);

        _links.forEach((link) => {
            const $li = $('<li class="fd-ql-row">');

            const $emoji  = $('<span class="fd-ql-row-emoji">').text(link.emoji || '🔗');
            const $label  = $('<span class="fd-ql-row-label">').text(link.label || link.url);
            const $arrow  = $('<span class="fd-ql-row-arrow">').text('→');
            const $del    = $('<button class="fd-ql-row-delete" title="Delete">✕</button>');

            $li.append($emoji, $label, $arrow, $del);

            // Click → open URL (not in edit mode, not on delete)
            $li.on('click', (e) => {
                if (_isEditMode) return;
                if (e.target === $del[0]) return;
                if (link.url) {
                    window.open(link.url, '_blank', 'noopener,noreferrer');
                }
            });

            // Delete button
            $del.on('click', (e) => {
                e.stopPropagation();
                _links = _links.filter(l => l.id !== link.id);
                _saveExtras();
                _saveAllToSettings();
                _render();
            });

            $list.append($li);
        });
    }

    // ------------------------------------------------------------------
    // Edit mode toggle
    // ------------------------------------------------------------------

    $editBtn.on('click', () => {
        _isEditMode = !_isEditMode;
        $editBtn.toggleClass('active', _isEditMode);
        $editBtn.text(_isEditMode ? 'Done' : 'Edit');
        $list.toggleClass('edit-mode', _isEditMode);
    });

    // ------------------------------------------------------------------
    // Add form
    // ------------------------------------------------------------------

    function _showForm() {
        $form.removeClass('hidden');
        $inputEmoji.val('');
        $inputLabel.val('');
        $inputUrl.val('');
        setTimeout(() => $inputEmoji.focus(), 30);
    }

    function _hideForm() {
        $form.addClass('hidden');
    }

    $addBtn.on('click', _showForm);
    $cancelBtn.on('click', _hideForm);

    $saveLinkBtn.on('click', () => {
        const emoji = $inputEmoji.val().trim() || '🔗';
        const label = $inputLabel.val().trim();
        const url   = _normalizeUrl($inputUrl.val().trim());

        if (!label && !url) {
            DesktopWidget.showToast('Please enter a label and URL', 'warning');
            return;
        }

        const newLink = { id: _uid(), emoji, label: label || url, url };
        _links.push(newLink);
        _saveExtras();
        _saveAllToSettings();
        _render();
        _hideForm();
    });

    // Allow Enter key in form to submit
    $form.on('keydown', (e) => {
        if (e.key === 'Enter') $saveLinkBtn.trigger('click');
        if (e.key === 'Escape') _hideForm();
    });

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    DesktopWidget.onActivate(_load);

    // Re-render when settings change (e.g., user edits the links string in settings panel)
    DesktopWidget.on('settingsUpdated', _load);

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    _load();

})();
