/**
 * gallery/script.js — Character image gallery widget
 *
 * Storage model (all per-character):
 *   widgetData.gallery.data[`images_${charId}`] = Array<{ id, src, label, isAvatar }>
 *
 * Features:
 *   - Shows character avatar as first (pinned) image
 *   - Drag & drop files → data URLs → stored per character
 *   - Click image → lightbox with prev/next
 *   - Right-click image → context menu with Delete
 *   - Add button → file picker (multi-select)
 */

(function initGalleryWidget() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM refs
    // ------------------------------------------------------------------
    const $root      = DesktopWidget.getElement();
    const $charName  = $root.find('.fd-gallery-char-name');
    const $count     = $root.find('.fd-gallery-count');
    const $grid      = $root.find('.fd-gallery-grid');
    const $empty     = $root.find('.fd-gallery-empty');
    const $dropzone  = $root.find('.fd-gallery-dropzone');
    const $gridWrap  = $root.find('.fd-gallery-grid-wrap');
    const $fileInput = $root.find('.fd-gallery-file-input');
    const $addBtn    = $root.find('.fd-gallery-add-btn');
    const $ctxMenu   = $root.find('.fd-gallery-ctx-menu');
    const $ctxDelete = $root.find('.fd-gallery-ctx-delete');
    const $lightbox  = $root.find('.fd-gallery-lightbox');
    const $lbImg     = $root.find('.fd-gallery-lb-img');
    const $lbClose   = $root.find('.fd-gallery-lb-close');
    const $lbPrev    = $root.find('.fd-gallery-lb-prev');
    const $lbNext    = $root.find('.fd-gallery-lb-next');
    const $lbCaption = $root.find('.fd-gallery-lb-caption');

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let _charId        = null;
    let _images        = [];   // { id, src, label, isAvatar }
    let _ctxTargetId   = null;
    let _lbIndex       = 0;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _imagesKey(charId) {
        return `images_${charId}`;
    }

    function _uid() {
        return Math.random().toString(36).slice(2, 10);
    }

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
    // Load gallery for current character
    // ------------------------------------------------------------------

    function _load() {
        _charId = DesktopWidget.getCharacterId();
        const char = DesktopWidget.getCharacter();

        $charName.text(char?.name || 'No character');

        if (_charId == null) {
            _images = [];
            _render();
            return;
        }

        // Stored images (non-avatar)
        const stored = DesktopWidget.getData(_imagesKey(_charId), []);
        _images = Array.isArray(stored) ? stored.slice() : [];

        // Prepend avatar image if available (not stored, derived live)
        const avatarUrl = _getAvatarUrl(char);
        if (avatarUrl) {
            // Keep avatar as index 0, not persisted
            _images = [{ id: '__avatar__', src: avatarUrl, label: 'Character avatar', isAvatar: true }, ..._images];
        }

        _render();
    }

    // ------------------------------------------------------------------
    // Render grid
    // ------------------------------------------------------------------

    function _render() {
        $grid.empty();

        const total = _images.length;
        $count.text(`${total} image${total !== 1 ? 's' : ''}`);

        if (total === 0) {
            $empty.addClass('visible');
            return;
        }

        $empty.removeClass('visible');

        _images.forEach((img, idx) => {
            const $item = $('<div class="fd-gallery-item">');
            const $img  = $('<img>').attr({ src: img.src, alt: img.label || '', loading: 'lazy' });
            $item.append($img);

            if (img.isAvatar) {
                $item.append('<span class="fd-gallery-item-badge">avatar</span>');
            }

            $item.on('click', () => _openLightbox(idx));
            $item.on('contextmenu', (e) => {
                e.preventDefault();
                if (!img.isAvatar) _showCtxMenu(e, img.id);
            });

            $grid.append($item);
        });
    }

    // ------------------------------------------------------------------
    // Add images
    // ------------------------------------------------------------------

    function _handleFiles(files) {
        if (!_charId) {
            DesktopWidget.showToast('No character selected', 'warning');
            return;
        }

        const toRead = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (!toRead.length) return;

        let processed = 0;
        toRead.forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const newImg = {
                    id: _uid(),
                    src: ev.target.result,
                    label: file.name,
                    isAvatar: false,
                };
                // Insert into _images (after avatar if present)
                const avatarOffset = _images[0]?.isAvatar ? 1 : 0;
                _images.splice(avatarOffset, 0, newImg);
                processed++;
                if (processed === toRead.length) {
                    _save();
                    _render();
                }
            };
            reader.readAsDataURL(file);
        });
    }

    function _save() {
        if (_charId == null) return;
        // Don't persist the avatar entry
        const toStore = _images.filter(img => !img.isAvatar);
        DesktopWidget.setData(_imagesKey(_charId), toStore);
        DesktopWidget.saveData();
    }

    // ------------------------------------------------------------------
    // Drag & drop
    // ------------------------------------------------------------------

    $gridWrap[0].addEventListener('dragenter', (e) => {
        e.preventDefault();
        $dropzone.removeAttr('hidden').addClass('active');
        $gridWrap.addClass('drag-over');
    });

    $gridWrap[0].addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    $gridWrap[0].addEventListener('dragleave', (e) => {
        // Only hide if leaving the wrap entirely
        if (!$gridWrap[0].contains(e.relatedTarget)) {
            $dropzone.attr('hidden', '').removeClass('active');
            $gridWrap.removeClass('drag-over');
        }
    });

    $gridWrap[0].addEventListener('drop', (e) => {
        e.preventDefault();
        $dropzone.attr('hidden', '').removeClass('active');
        $gridWrap.removeClass('drag-over');
        _handleFiles(e.dataTransfer.files);
    });

    // ------------------------------------------------------------------
    // File picker
    // ------------------------------------------------------------------

    $addBtn.on('click', () => $fileInput[0].click());

    $fileInput.on('change', function () {
        _handleFiles(this.files);
        this.value = ''; // reset so same file can be re-added
    });

    // ------------------------------------------------------------------
    // Context menu
    // ------------------------------------------------------------------

    function _showCtxMenu(e, imgId) {
        _ctxTargetId = imgId;
        $ctxMenu.css({ top: e.pageY, left: e.pageX }).removeAttr('hidden');
    }

    function _hideCtxMenu() {
        $ctxMenu.attr('hidden', '');
        _ctxTargetId = null;
    }

    $ctxDelete.on('click', () => {
        if (!_ctxTargetId) return;
        _images = _images.filter(img => img.id !== _ctxTargetId);
        _save();
        _render();
        _hideCtxMenu();
    });

    $(document).on('click.fd-gallery-ctx', (e) => {
        if (!$ctxMenu.is(':hidden') && !$ctxMenu[0].contains(e.target)) {
            _hideCtxMenu();
        }
    });

    // ------------------------------------------------------------------
    // Lightbox
    // ------------------------------------------------------------------

    function _openLightbox(idx) {
        _lbIndex = idx;
        _updateLightbox();
        $lightbox.removeAttr('hidden');
    }

    function _updateLightbox() {
        const img = _images[_lbIndex];
        if (!img) return;
        $lbImg.attr('src', img.src);
        $lbCaption.text(`${_lbIndex + 1} / ${_images.length}${img.label ? '  —  ' + img.label : ''}`);
        $lbPrev.toggle(_lbIndex > 0);
        $lbNext.toggle(_lbIndex < _images.length - 1);
    }

    $lbClose.on('click', () => $lightbox.attr('hidden', ''));

    $lbPrev.on('click', () => {
        if (_lbIndex > 0) { _lbIndex--; _updateLightbox(); }
    });

    $lbNext.on('click', () => {
        if (_lbIndex < _images.length - 1) { _lbIndex++; _updateLightbox(); }
    });

    // Close on backdrop click
    $lightbox.on('click', (e) => {
        if (e.target === $lightbox[0]) $lightbox.attr('hidden', '');
    });

    // Keyboard nav in lightbox
    $(document).on('keydown.fd-gallery-lb', (e) => {
        if ($lightbox.is(':hidden')) return;
        if (e.key === 'Escape')      $lightbox.attr('hidden', '');
        if (e.key === 'ArrowLeft')   $lbPrev.trigger('click');
        if (e.key === 'ArrowRight')  $lbNext.trigger('click');
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
