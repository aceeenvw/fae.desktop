/**
 * fae.desktop — window-manager.js
 *
 * The heart of fae.desktop.  Manages every floating desktop window:
 *   - FDWindow class: DOM lifecycle, titlebar, traffic lights, drag, resize, snap
 *   - createWindowHTML(): returns the HTML string for a .fd-window element
 *   - windowManager singleton: register / focus / minimize / maximize / restore /
 *     close / snap / layout persistence helpers
 *
 * Conventions:
 *   - All CSS classes use the  fd-  prefix
 *   - jQuery ($) is used for DOM manipulation
 *   - Custom DOM events (fd:window-*) are dispatched on document
 *   - Smooth transitions use the CSS var --fd-transition-normal (250ms ease)
 */

import { log, warn, clamp, px } from './utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Starting z-index for user windows.  Menubar + Dock sit at 9999. */
const Z_BASE = 100;

/** Pixels from the workspace edge that trigger edge-snap. */
const SNAP_THRESHOLD = 10;

/** Resize handle hit-area (px) — thin invisible strip at each edge/corner. */
const RESIZE_HANDLE_SIZE = 6;

/** Minimum window dimensions (absolute fallback if options.minSize not given). */
const FALLBACK_MIN_SIZE = { w: 200, h: 120 };

// ---------------------------------------------------------------------------
// Global z-index counter (shared across all FDWindow instances)
// ---------------------------------------------------------------------------

let _zCounter = Z_BASE;

function _nextZ() { return ++_zCounter; }
function _getTopZ() { return _zCounter; }
function _resetZ() { _zCounter = Z_BASE; }

// ---------------------------------------------------------------------------
// Snap-preview overlay (singleton, created lazily)
// ---------------------------------------------------------------------------

let _$snapPreview = null;

function _getSnapPreview() {
    if (!_$snapPreview || !_$snapPreview.length) {
        _$snapPreview = $('<div>', { class: 'fd-snap-preview' });
        $('#fd-workspace').append(_$snapPreview);
    }
    return _$snapPreview;
}

function _showSnapPreview(rect) {
    const $p = _getSnapPreview();
    $p.css({
        display: 'block',
        left:    px(rect.left),
        top:     px(rect.top),
        width:   px(rect.width),
        height:  px(rect.height),
    });
}

function _hideSnapPreview() {
    if (_$snapPreview) _$snapPreview.css('display', 'none');
}

// ---------------------------------------------------------------------------
// Workspace geometry helpers
// ---------------------------------------------------------------------------

/**
 * Returns the bounding rect of #fd-workspace (the draggable area).
 * @returns {{ left:number, top:number, width:number, height:number }}
 */
function _workspaceBounds() {
    const el = document.getElementById('fd-workspace');
    if (!el) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return el.getBoundingClientRect();
}

// ---------------------------------------------------------------------------
// createWindowHTML
// ---------------------------------------------------------------------------

/**
 * Build the full HTML string for a .fd-window element.
 *
 * @param {string} id          — unique window id (becomes data-window-id)
 * @param {string} title       — titlebar label
 * @param {string} icon        — icon class suffix (fd-window-icon-<icon>)
 * @param {object} [options]   — { closable, resizable, minSize, defaultSize, defaultPosition }
 * @returns {string}           — HTML string ready for $(...) / innerHTML
 */
export function createWindowHTML(id, title, icon, options = {}) {
    const {
        closable   = true,
        resizable  = true,
        defaultSize     = { w: 480, h: 360 },
        defaultPosition = { x: 80,  y: 80  },
    } = options;

    const closableAttr = closable ? '' : ' data-fd-no-close="true"';
    const resizableAttr = resizable ? ' fd-resizable' : '';

    // Resize handles (8 directions)
    const resizeHandles = resizable ? `
        <div class="fd-resize-handle fd-resize-n"  data-dir="n"></div>
        <div class="fd-resize-handle fd-resize-s"  data-dir="s"></div>
        <div class="fd-resize-handle fd-resize-e"  data-dir="e"></div>
        <div class="fd-resize-handle fd-resize-w"  data-dir="w"></div>
        <div class="fd-resize-handle fd-resize-ne" data-dir="ne"></div>
        <div class="fd-resize-handle fd-resize-nw" data-dir="nw"></div>
        <div class="fd-resize-handle fd-resize-se" data-dir="se"></div>
        <div class="fd-resize-handle fd-resize-sw" data-dir="sw"></div>` : '';

    return `
<div class="fd-window${resizableAttr}"
     data-window-id="${id}"
     data-fd-state="normal"
     ${closableAttr}
     style="
         left: ${defaultPosition.x}px;
         top:  ${defaultPosition.y}px;
         width:  ${defaultSize.w}px;
         height: ${defaultSize.h}px;
         z-index: ${Z_BASE};
     ">

    <div class="fd-titlebar" data-fd-drag-handle>
        <div class="fd-traffic-lights">
            <div class="fd-traffic fd-traffic-close"    data-action="close"    title="Close"></div>
            <div class="fd-traffic fd-traffic-minimize" data-action="minimize" title="Minimize"></div>
            <div class="fd-traffic fd-traffic-maximize" data-action="maximize" title="Maximize/Restore"></div>
        </div>
        <div class="fd-titlebar-center">
            ${icon ? `<div class="fd-window-icon fd-window-icon-${icon}"></div>` : ''}
            <span class="fd-titlebar-title">${_escapeHtml(title)}</span>
        </div>
        <div class="fd-titlebar-right"></div>
    </div>

    <div class="fd-window-content"></div>

    ${resizeHandles}
</div>`.trim();
}

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

function _escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// FDWindow class
// ---------------------------------------------------------------------------

/**
 * Represents a single managed desktop window.
 *
 * State machine:
 *   'normal' ←→ 'maximized'
 *   'normal'  → 'minimized'  (hidden, notifies dock)
 *   'normal'  → 'snapped-left' | 'snapped-right'
 *   any       → 'normal'  (via restoreWindow)
 */
export class FDWindow {
    /**
     * @param {string} id
     * @param {object} options
     * @param {string}   options.title
     * @param {string}   [options.icon]
     * @param {string}   [options.content]       — HTML string injected into .fd-window-content
     * @param {boolean}  [options.closable=true]
     * @param {boolean}  [options.resizable=true]
     * @param {{ w:number, h:number }} [options.minSize]
     * @param {{ w:number, h:number }} [options.defaultSize]
     * @param {{ x:number, y:number }} [options.defaultPosition]
     * @param {Function} [options.onClose]        — called when the window is closed/hidden
     * @param {Function} [options.onFocus]        — called when window receives focus
     * @param {Function} [options.onMinimize]
     * @param {Function} [options.onMaximize]
     * @param {Function} [options.onRestore]
     */
    constructor(id, options = {}) {
        this.id = id;

        // Merge option defaults
        this.options = Object.assign({
            title:           'Window',
            icon:            '',
            content:         '',
            closable:        true,
            resizable:       true,
            minSize:         FALLBACK_MIN_SIZE,
            defaultSize:     { w: 480, h: 360 },
            defaultPosition: { x: 80, y: 80 },
            onClose:         null,
            onFocus:         null,
            onMinimize:      null,
            onMaximize:      null,
            onRestore:       null,
        }, options);

        /** @type {'normal'|'maximized'|'minimized'|'snapped-left'|'snapped-right'} */
        this.state = 'normal';

        /**
         * Saved geometry before maximize/snap so we can restore.
         * @type {{ x:number, y:number, w:number, h:number }|null}
         */
        this._savedGeometry = null;

        // DOM references
        /** @type {jQuery|null} */
        this.$el = null;

        // Internal drag / resize state
        this._drag  = null;   // active drag session
        this._resize = null;  // active resize session

        // Bound document-level event handlers (stored so we can .off() them)
        this._onDocMouseMove = this._handleDocMouseMove.bind(this);
        this._onDocMouseUp   = this._handleDocMouseUp.bind(this);

        log(`FDWindow "${id}" constructed`);
    }

    // -------------------------------------------------------------------------
    // Mount / unmount
    // -------------------------------------------------------------------------

    /**
     * Create the DOM element and inject it into #fd-workspace.
     * If content was provided in options it is placed into .fd-window-content.
     * @param {jQuery|null} [$container] — defaults to $('#fd-workspace')
     * @returns {FDWindow} this (for chaining)
     */
    mount($container) {
        if (this.$el && this.$el.length) {
            warn(`FDWindow "${this.id}" is already mounted`);
            return this;
        }

        const html = createWindowHTML(
            this.id,
            this.options.title,
            this.options.icon,
            {
                closable:        this.options.closable,
                resizable:       this.options.resizable,
                defaultSize:     this.options.defaultSize,
                defaultPosition: this.options.defaultPosition,
            },
        );

        this.$el = $(html);

        // Inject provided content
        if (this.options.content) {
            this.$el.find('.fd-window-content').html(this.options.content);
        }

        const $target = ($container && $container.length) ? $container : $('#fd-workspace');
        $target.append(this.$el);

        // Bind all interaction handlers
        this._bindEvents();

        log(`FDWindow "${this.id}" mounted`);
        return this;
    }

    /**
     * Remove the DOM element and clean up all event listeners.
     */
    destroy() {
        this._unbindEvents();

        if (this.$el && this.$el.length) {
            this.$el.remove();
            this.$el = null;
        }

        log(`FDWindow "${this.id}" destroyed`);
    }

    // -------------------------------------------------------------------------
    // Event binding
    // -------------------------------------------------------------------------

    _bindEvents() {
        const $el = this.$el;
        if (!$el) return;

        // Bring to front on any mousedown inside the window
        $el.on('mousedown.fdwin', (e) => {
            // Don't intercept resize handle mousedowns here — they have their own handler
            if (!$(e.target).hasClass('fd-resize-handle')) {
                this._bringToFront();
            }
        });

        // Traffic light buttons
        $el.on('click.fdwin', '.fd-traffic-close',    (e) => { e.stopPropagation(); this._onClose(); });
        $el.on('click.fdwin', '.fd-traffic-minimize', (e) => { e.stopPropagation(); this._onMinimize(); });
        $el.on('click.fdwin', '.fd-traffic-maximize', (e) => { e.stopPropagation(); this._onMaximize(); });

        // Double-click titlebar → toggle maximize
        $el.on('dblclick.fdwin', '.fd-titlebar', (e) => {
            // Ignore double-clicks originating from traffic lights
            if ($(e.target).hasClass('fd-traffic') || $(e.target).closest('.fd-traffic-lights').length) return;
            this._onMaximize();
        });

        // Titlebar drag — mousedown initiates (not on traffic lights)
        $el.on('mousedown.fdwin', '.fd-titlebar', (e) => {
            if ($(e.target).closest('.fd-traffic-lights').length) return;
            if (e.button !== 0) return; // left button only
            this._startDrag(e);
        });

        // Resize handle mousedown
        if (this.options.resizable) {
            $el.on('mousedown.fdwin', '.fd-resize-handle', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                const dir = $(e.currentTarget).data('dir');
                this._startResize(e, dir);
            });
        }
    }

    _unbindEvents() {
        if (this.$el) {
            this.$el.off('.fdwin');
        }
        // Remove document-level listeners if active
        $(document).off('mousemove.fdwin-' + this.id);
        $(document).off('mouseup.fdwin-'   + this.id);
    }

    // -------------------------------------------------------------------------
    // Traffic light actions
    // -------------------------------------------------------------------------

    _onClose() {
        if (!this.options.closable) return; // Chat window — close is disabled

        this.$el && this.$el.hide();
        this.state = 'normal'; // reset visual state

        _dispatchWindowEvent('fd:window-closed', this.id, this._getGeometry());

        if (typeof this.options.onClose === 'function') {
            this.options.onClose(this);
        }

        log(`FDWindow "${this.id}" closed`);
    }

    _onMinimize() {
        if (this.state === 'minimized') {
            this.restore();
            return;
        }

        this._savedGeometry = this._getGeometry();
        this.state = 'minimized';

        this.$el && this.$el
            .attr('data-fd-state', 'minimized')
            .addClass('fd-window-minimizing')
            .one('transitionend', () => {
                this.$el
                    .removeClass('fd-window-minimizing')
                    .hide();
            });

        _dispatchWindowEvent('fd:window-minimized', this.id, this._savedGeometry);

        if (typeof this.options.onMinimize === 'function') {
            this.options.onMinimize(this);
        }

        log(`FDWindow "${this.id}" minimized`);
    }

    _onMaximize() {
        if (this.state === 'maximized') {
            this.restore();
        } else {
            this.maximize();
        }
    }

    // -------------------------------------------------------------------------
    // Maximize
    // -------------------------------------------------------------------------

    maximize() {
        if (this.state === 'maximized') return;

        // Save current geometry before maximizing
        if (this.state === 'normal' || this.state === 'snapped-left' || this.state === 'snapped-right') {
            this._savedGeometry = this._getGeometry();
        }

        this.state = 'maximized';

        const ws = _workspaceBounds();

        this.$el && this.$el
            .attr('data-fd-state', 'maximized')
            .css({
                transition: 'left var(--fd-transition-normal), top var(--fd-transition-normal), width var(--fd-transition-normal), height var(--fd-transition-normal)',
                left:   0,
                top:    0,
                width:  ws.width,
                height: ws.height,
                'border-radius': 0,
            });

        _dispatchWindowEvent('fd:window-maximized', this.id, this._getGeometry());

        if (typeof this.options.onMaximize === 'function') {
            this.options.onMaximize(this);
        }

        log(`FDWindow "${this.id}" maximized`);
    }

    // -------------------------------------------------------------------------
    // Restore
    // -------------------------------------------------------------------------

    restore() {
        const prevState = this.state;

        if (prevState === 'minimized') {
            // Show the element first, then animate in
            this.$el && this.$el
                .show()
                .attr('data-fd-state', 'normal')
                .addClass('fd-window-restoring')
                .one('transitionend', () => {
                    this.$el && this.$el.removeClass('fd-window-restoring');
                });
        }

        this.state = 'normal';

        if (this._savedGeometry) {
            const g = this._savedGeometry;
            this.$el && this.$el.css({
                transition: 'left var(--fd-transition-normal), top var(--fd-transition-normal), width var(--fd-transition-normal), height var(--fd-transition-normal)',
                left:         px(g.x),
                top:          px(g.y),
                width:        px(g.w),
                height:       px(g.h),
                'border-radius': '',
            });
        }

        this.$el && this.$el.attr('data-fd-state', 'normal');

        _dispatchWindowEvent('fd:window-restored', this.id, this._getGeometry());

        if (typeof this.options.onRestore === 'function') {
            this.options.onRestore(this);
        }

        this._bringToFront();
        log(`FDWindow "${this.id}" restored from "${prevState}"`);
    }

    // -------------------------------------------------------------------------
    // Snap
    // -------------------------------------------------------------------------

    /**
     * Snap window to left or right half of workspace.
     * @param {'left'|'right'} side
     */
    snap(side) {
        const ws = _workspaceBounds();
        const halfW = Math.floor(ws.width / 2);

        if (this.state === 'normal') {
            this._savedGeometry = this._getGeometry();
        }

        this.state = side === 'left' ? 'snapped-left' : 'snapped-right';

        const newLeft = side === 'left' ? 0 : halfW;

        this.$el && this.$el
            .attr('data-fd-state', this.state)
            .css({
                transition: 'left var(--fd-transition-normal), top var(--fd-transition-normal), width var(--fd-transition-normal), height var(--fd-transition-normal)',
                left:   px(newLeft),
                top:    0,
                width:  px(halfW),
                height: px(ws.height),
                'border-radius': 0,
            });

        _dispatchWindowEvent('fd:window-moved', this.id, this._getGeometry());
        log(`FDWindow "${this.id}" snapped to ${side}`);
    }

    // -------------------------------------------------------------------------
    // Focus
    // -------------------------------------------------------------------------

    focus() {
        this._bringToFront();

        if (this.state === 'minimized') {
            this.restore();
            return;
        }

        this.$el && this.$el.show();

        _dispatchWindowEvent('fd:window-focused', this.id, this._getGeometry());

        if (typeof this.options.onFocus === 'function') {
            this.options.onFocus(this);
        }
    }

    _bringToFront() {
        if (!this.$el) return;
        const z = _nextZ();
        this.$el.css('z-index', z);
        log(`FDWindow "${this.id}" brought to front (z=${z})`);
    }

    // -------------------------------------------------------------------------
    // Geometry helpers
    // -------------------------------------------------------------------------

    /**
     * Read the window's current geometry from the DOM.
     * @returns {{ x:number, y:number, w:number, h:number, state:string }}
     */
    _getGeometry() {
        if (!this.$el) return { x: 0, y: 0, w: 0, h: 0, state: this.state };
        return {
            x: parseInt(this.$el.css('left'),  10) || 0,
            y: parseInt(this.$el.css('top'),   10) || 0,
            w: this.$el.outerWidth()  || 0,
            h: this.$el.outerHeight() || 0,
            state: this.state,
        };
    }

    /**
     * Apply a geometry object directly to the window's CSS.
     * @param {{ x:number, y:number, w:number, h:number }} geom
     * @param {boolean} [animate=false]
     */
    _applyGeometry(geom, animate = false) {
        if (!this.$el) return;
        const css = {
            left:   px(geom.x),
            top:    px(geom.y),
            width:  px(geom.w),
            height: px(geom.h),
        };
        if (animate) {
            css.transition = 'left var(--fd-transition-normal), top var(--fd-transition-normal), width var(--fd-transition-normal), height var(--fd-transition-normal)';
        } else {
            css.transition = 'none';
        }
        this.$el.css(css);
    }

    // -------------------------------------------------------------------------
    // Drag
    // -------------------------------------------------------------------------

    _startDrag(e) {
        e.preventDefault();

        // Cannot drag a maximized window until it is un-maximized first
        // (we handle that in _handleDocMouseMove below)

        const $el = this.$el;
        const offset = $el.offset();
        const wsRect = _workspaceBounds();
        const wsOff  = { left: wsRect.left, top: wsRect.top };

        this._drag = {
            startMouseX:   e.clientX,
            startMouseY:   e.clientY,
            startWinX:     offset.left - wsOff.left,
            startWinY:     offset.top  - wsOff.top,
            wsWidth:       wsRect.width,
            wsHeight:      wsRect.height,
            wasMaximized:  this.state === 'maximized',
            // Cursor offset within titlebar when dragging out of maximized state
            relX: null,
            relY: null,
            snapping: null, // 'left' | 'right' | 'top' | null
        };

        $(document)
            .on('mousemove.fdwin-' + this.id, this._onDocMouseMove)
            .on('mouseup.fdwin-'   + this.id, this._onDocMouseUp);

        $('body').addClass('fd-dragging');
        log(`FDWindow "${this.id}" drag started`);
    }

    _handleDocMouseMove(e) {
        if (this._drag) {
            this._tickDrag(e);
        } else if (this._resize) {
            this._tickResize(e);
        }
    }

    _handleDocMouseUp(e) {
        if (this._drag) {
            this._endDrag(e);
        } else if (this._resize) {
            this._endResize(e);
        }
    }

    _tickDrag(e) {
        const d = this._drag;
        const wsRect = _workspaceBounds();

        // If we started dragging from a maximized window, first un-maximize it
        // and recalculate the start position so the window "grabs" naturally
        if (d.wasMaximized) {
            const moved = Math.abs(e.clientX - d.startMouseX) + Math.abs(e.clientY - d.startMouseY);
            if (moved < 4) return; // wait for a real drag gesture

            // Restore to saved (or default) size before repositioning
            const g = this._savedGeometry || { w: this.options.defaultSize.w, h: this.options.defaultSize.h };

            // Horizontal offset: keep cursor at ~30% of title bar width (feels natural)
            const titleW = g.w;
            d.relX = Math.min(e.clientX - wsRect.left, titleW * 0.3);
            d.relY = 16; // approx middle of titlebar

            // Cancel maximized state without animation (we are about to drag)
            this.state = 'normal';
            this.$el.attr('data-fd-state', 'normal').css({
                transition: 'none',
                width:  px(g.w),
                height: px(g.h),
                'border-radius': '',
            });

            // Update drag origin so subsequent moves are smooth
            d.startMouseX = e.clientX;
            d.startMouseY = e.clientY;
            d.startWinX   = e.clientX - wsRect.left - d.relX;
            d.startWinY   = e.clientY - wsRect.top  - d.relY;
            d.wsWidth     = wsRect.width;
            d.wsHeight    = wsRect.height;
            d.wasMaximized = false;
        }

        const dx = e.clientX - d.startMouseX;
        const dy = e.clientY - d.startMouseY;

        let newX = d.startWinX + dx;
        let newY = d.startWinY + dy;

        const winW = this.$el.outerWidth();
        const winH = this.$el.outerHeight();

        // Clamp to workspace bounds
        newX = clamp(newX, 0, d.wsWidth  - winW);
        newY = clamp(newY, 0, d.wsHeight - winH);

        // Apply position immediately (no transition during drag)
        this.$el.css({ transition: 'none', left: px(newX), top: px(newY) });

        // --- Edge snap preview ---
        const absX = newX; // relative to workspace
        const absY = newY;

        let snapping = null;

        if (absX <= SNAP_THRESHOLD) {
            snapping = 'left';
        } else if (absX + winW >= d.wsWidth - SNAP_THRESHOLD) {
            snapping = 'right';
        } else if (absY <= SNAP_THRESHOLD) {
            snapping = 'top';
        }

        d.snapping = snapping;

        if (snapping === 'left') {
            _showSnapPreview({ left: 0, top: 0, width: Math.floor(d.wsWidth / 2), height: d.wsHeight });
        } else if (snapping === 'right') {
            _showSnapPreview({ left: Math.floor(d.wsWidth / 2), top: 0, width: Math.ceil(d.wsWidth / 2), height: d.wsHeight });
        } else if (snapping === 'top') {
            _showSnapPreview({ left: 0, top: 0, width: d.wsWidth, height: d.wsHeight });
        } else {
            _hideSnapPreview();
        }
    }

    _endDrag(e) {
        $(document)
            .off('mousemove.fdwin-' + this.id)
            .off('mouseup.fdwin-'   + this.id);

        $('body').removeClass('fd-dragging');

        const d = this._drag;
        this._drag = null;

        _hideSnapPreview();

        if (!d) return;

        // Apply snapping if we were hovering an edge
        if (d.snapping === 'left') {
            this._savedGeometry = this._getGeometry();
            this.snap('left');
        } else if (d.snapping === 'right') {
            this._savedGeometry = this._getGeometry();
            this.snap('right');
        } else if (d.snapping === 'top') {
            this._savedGeometry = this._getGeometry();
            this.maximize();
        } else {
            this.state = 'normal';
            this.$el && this.$el.attr('data-fd-state', 'normal').css('border-radius', '');
        }

        // Emit position change event
        _dispatchWindowEvent('fd:window-moved', this.id, this._getGeometry());

        log(`FDWindow "${this.id}" drag ended`);
    }

    // -------------------------------------------------------------------------
    // Resize
    // -------------------------------------------------------------------------

    /**
     * @param {MouseEvent} e
     * @param {'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'} dir
     */
    _startResize(e, dir) {
        if (!this.options.resizable) return;
        if (this.state !== 'normal' && this.state !== 'snapped-left' && this.state !== 'snapped-right') return;

        e.preventDefault();

        const $el = this.$el;
        const offset = $el.offset();
        const wsRect = _workspaceBounds();

        this._resize = {
            dir,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            startX: offset.left - wsRect.left,
            startY: offset.top  - wsRect.top,
            startW: $el.outerWidth(),
            startH: $el.outerHeight(),
            wsWidth:  wsRect.width,
            wsHeight: wsRect.height,
        };

        $(document)
            .on('mousemove.fdwin-' + this.id, this._onDocMouseMove)
            .on('mouseup.fdwin-'   + this.id, this._onDocMouseUp);

        $('body').addClass('fd-resizing');
        log(`FDWindow "${this.id}" resize started (${dir})`);
    }

    _tickResize(e) {
        const r = this._resize;
        if (!r || !this.$el) return;

        const dx = e.clientX - r.startMouseX;
        const dy = e.clientY - r.startMouseY;
        const minW = (this.options.minSize && this.options.minSize.w) || FALLBACK_MIN_SIZE.w;
        const minH = (this.options.minSize && this.options.minSize.h) || FALLBACK_MIN_SIZE.h;

        let newX = r.startX;
        let newY = r.startY;
        let newW = r.startW;
        let newH = r.startH;

        const dir = r.dir;

        // Horizontal
        if (dir.includes('e')) {
            newW = Math.max(minW, r.startW + dx);
        }
        if (dir.includes('w')) {
            const proposedW = Math.max(minW, r.startW - dx);
            newX = r.startX + (r.startW - proposedW);
            newW = proposedW;
        }

        // Vertical
        if (dir.includes('s')) {
            newH = Math.max(minH, r.startH + dy);
        }
        if (dir.includes('n')) {
            const proposedH = Math.max(minH, r.startH - dy);
            newY = r.startY + (r.startH - proposedH);
            newH = proposedH;
        }

        // Clamp to workspace
        newX = Math.max(0, newX);
        newY = Math.max(0, newY);
        newW = Math.min(r.wsWidth  - newX, newW);
        newH = Math.min(r.wsHeight - newY, newH);

        this.$el.css({
            transition: 'none',
            left:   px(newX),
            top:    px(newY),
            width:  px(newW),
            height: px(newH),
        });
    }

    _endResize(e) {
        $(document)
            .off('mousemove.fdwin-' + this.id)
            .off('mouseup.fdwin-'   + this.id);

        $('body').removeClass('fd-resizing');
        this._resize = null;

        // Emit position/size change
        _dispatchWindowEvent('fd:window-moved', this.id, this._getGeometry());

        log(`FDWindow "${this.id}" resize ended`);
    }

    // -------------------------------------------------------------------------
    // Visibility helpers
    // -------------------------------------------------------------------------

    show() {
        this.$el && this.$el.show();
    }

    hide() {
        this.$el && this.$el.hide();
    }

    isVisible() {
        return this.$el ? this.$el.is(':visible') : false;
    }

    // -------------------------------------------------------------------------
    // Title / content update helpers
    // -------------------------------------------------------------------------

    setTitle(title) {
        this.options.title = title;
        this.$el && this.$el.find('.fd-titlebar-title').text(title);
    }

    setContent(html) {
        this.$el && this.$el.find('.fd-window-content').html(html);
    }

    getContentElement() {
        return this.$el ? this.$el.find('.fd-window-content') : null;
    }
}

// ---------------------------------------------------------------------------
// Custom event dispatch helper
// ---------------------------------------------------------------------------

/**
 * Dispatch a namespaced fd:window-* event on document.
 * @param {string} eventName
 * @param {string} windowId
 * @param {{ x:number, y:number, w:number, h:number, state:string }} geometry
 */
function _dispatchWindowEvent(eventName, windowId, geometry) {
    document.dispatchEvent(new CustomEvent(eventName, {
        bubbles:    false,
        cancelable: false,
        detail: {
            id:    windowId,
            x:     geometry.x,
            y:     geometry.y,
            w:     geometry.w,
            h:     geometry.h,
            state: geometry.state,
        },
    }));
}

// ---------------------------------------------------------------------------
// windowManager singleton
// ---------------------------------------------------------------------------

/**
 * Central registry and controller for all FDWindow instances.
 *
 * Usage:
 *   windowManager.register(myWindow);
 *   windowManager.focusWindow('notes');
 *   windowManager.minimizeWindow('gallery');
 *   const layout = windowManager.getAllPositions();
 *   windowManager.restorePositions(savedLayout);
 */
export const windowManager = {

    /** @type {Map<string, FDWindow>} */
    windows: new Map(),

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Register an FDWindow instance.
     * The window must already be mounted in the DOM (or will be mounted here
     * if $container is provided).
     *
     * @param {FDWindow}    fdWindow    — instance to register
     * @param {jQuery|null} [$container] — optional mounting target
     * @returns {FDWindow}
     */
    register(fdWindow, $container) {
        if (!(fdWindow instanceof FDWindow)) {
            warn('windowManager.register: argument is not an FDWindow instance');
            return fdWindow;
        }

        if (this.windows.has(fdWindow.id)) {
            warn(`windowManager.register: window "${fdWindow.id}" is already registered`);
            return fdWindow;
        }

        // Auto-mount if not yet in the DOM
        if (!fdWindow.$el || !fdWindow.$el.length) {
            fdWindow.mount($container);
        }

        this.windows.set(fdWindow.id, fdWindow);
        log(`windowManager: registered "${fdWindow.id}"`);

        return fdWindow;
    },

    /**
     * Unregister and destroy a window by id.
     * @param {string} id
     */
    unregister(id) {
        const win = this.windows.get(id);
        if (!win) return;
        win.destroy();
        this.windows.delete(id);
        log(`windowManager: unregistered "${id}"`);
    },

    /**
     * Get a registered FDWindow by id.
     * @param {string} id
     * @returns {FDWindow|undefined}
     */
    getWindow(id) {
        return this.windows.get(id);
    },

    // -----------------------------------------------------------------------
    // Window control
    // -----------------------------------------------------------------------

    /**
     * Bring a window to the front and call its focus() method.
     * @param {string} id
     */
    focusWindow(id) {
        const win = this.windows.get(id);
        if (!win) { warn(`windowManager.focusWindow: "${id}" not found`); return; }
        win.focus();
    },

    /**
     * Minimize a window by id.
     * @param {string} id
     */
    minimizeWindow(id) {
        const win = this.windows.get(id);
        if (!win) return;
        win._onMinimize();
    },

    /**
     * Maximize a window by id.
     * @param {string} id
     */
    maximizeWindow(id) {
        const win = this.windows.get(id);
        if (!win) return;
        win.maximize();
    },

    /**
     * Restore a window to its normal state by id.
     * @param {string} id
     */
    restoreWindow(id) {
        const win = this.windows.get(id);
        if (!win) return;
        win.restore();
    },

    /**
     * Close (hide) a window by id.
     * @param {string} id
     */
    closeWindow(id) {
        const win = this.windows.get(id);
        if (!win) return;
        win._onClose();
    },

    // -----------------------------------------------------------------------
    // Z-order
    // -----------------------------------------------------------------------

    /** @returns {number} current top z-index */
    getTopZIndex() {
        return _getTopZ();
    },

    /**
     * Bring a registered window to the top of the stack.
     * @param {string} id
     */
    bringToFront(id) {
        const win = this.windows.get(id);
        if (!win) return;
        win._bringToFront();
    },

    // -----------------------------------------------------------------------
    // Snap
    // -----------------------------------------------------------------------

    /**
     * Snap a window to one half of the workspace.
     * @param {string}         id
     * @param {'left'|'right'} side
     */
    snapWindow(id, side) {
        const win = this.windows.get(id);
        if (!win) return;
        win.snap(side);
    },

    // -----------------------------------------------------------------------
    // Layout persistence
    // -----------------------------------------------------------------------

    /**
     * Capture the current position/size/state of every registered window.
     * @returns {{ [id: string]: { x:number, y:number, w:number, h:number, state:string } }}
     */
    getAllPositions() {
        const out = {};
        this.windows.forEach((win, id) => {
            out[id] = win._getGeometry();
        });
        return out;
    },

    /**
     * Apply a previously captured layout object to currently registered windows.
     * Windows not present in the layout are left untouched.
     *
     * @param {{ [id: string]: { x:number, y:number, w:number, h:number, state:string } }} layout
     */
    restorePositions(layout) {
        if (!layout || typeof layout !== 'object') return;

        for (const [id, pos] of Object.entries(layout)) {
            const win = this.windows.get(id);
            if (!win || !win.$el) continue;

            // Restore state
            switch (pos.state) {
                case 'maximized':
                    win._savedGeometry = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
                    win.maximize();
                    break;

                case 'minimized':
                    win._savedGeometry = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
                    win._onMinimize();
                    break;

                case 'snapped-left':
                    win._savedGeometry = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
                    win.snap('left');
                    break;

                case 'snapped-right':
                    win._savedGeometry = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
                    win.snap('right');
                    break;

                default: {
                    // normal — apply geometry directly (no transition)
                    win.state = 'normal';
                    win.$el.attr('data-fd-state', 'normal');
                    win._applyGeometry({ x: pos.x, y: pos.y, w: pos.w, h: pos.h }, false);
                    break;
                }
            }
        }

        log('windowManager: positions restored from layout');
    },

    /**
     * Reset all registered windows to their default positions/sizes.
     * Restores any minimized/maximized windows to 'normal' state first.
     */
    resetAll() {
        _resetZ();

        this.windows.forEach((win) => {
            if (win.state !== 'normal') {
                // Force normal state without animation
                win.state = 'normal';
                win.$el && win.$el
                    .attr('data-fd-state', 'normal')
                    .show()
                    .css('border-radius', '');
            }

            const def = win.options;
            win._applyGeometry(
                {
                    x: def.defaultPosition.x,
                    y: def.defaultPosition.y,
                    w: def.defaultSize.w,
                    h: def.defaultSize.h,
                },
                true, // animate
            );

            win.$el && win.$el.css('z-index', Z_BASE);
        });

        log('windowManager: all windows reset to defaults');
    },

    // -----------------------------------------------------------------------
    // Bulk show / hide (used by desktop enable/disable lifecycle)
    // -----------------------------------------------------------------------

    /** Show all registered windows that are not minimized. */
    showAll() {
        this.windows.forEach((win) => {
            if (win.state !== 'minimized') win.show();
        });
    },

    /** Hide all registered windows. */
    hideAll() {
        this.windows.forEach((win) => win.hide());
    },

    /**
     * Destroy every registered window and clear the registry.
     * Called by desktop.disable() / desktop.destroy().
     */
    destroyAll() {
        this.windows.forEach((win) => win.destroy());
        this.windows.clear();
        _resetZ();
        log('windowManager: all windows destroyed');
    },
};
