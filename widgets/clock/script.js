/**
 * clock/script.js — Decorative clock widget
 *
 * Settings used:
 *   format          "12h" | "24h"   (default "24h")
 *   showSeconds     boolean          (default false)
 *   showSessionTime boolean          (default true)
 *
 * Session time = time elapsed since this widget was first activated
 * in the current page session (reset on page reload, not persisted).
 */

(function initClockWidget() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM refs
    // ------------------------------------------------------------------
    const $root       = DesktopWidget.getElement();
    const $time       = $root.find('.fd-clock-time');
    const $ampm       = $root.find('.fd-clock-ampm');
    const $date       = $root.find('.fd-clock-date');
    const $sessionWrap= $root.find('.fd-clock-session-wrap');
    const $session    = $root.find('.fd-clock-session');

    // ------------------------------------------------------------------
    // Session start — recorded once on first activation
    // ------------------------------------------------------------------
    const SESSION_KEY = '__session_start__';
    let _sessionStart = DesktopWidget.getData(SESSION_KEY, null);

    if (!_sessionStart) {
        // Store as ISO string; use Date.now() for precision
        _sessionStart = Date.now();
        DesktopWidget.setData(SESSION_KEY, _sessionStart);
        DesktopWidget.saveData();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _pad(n) {
        return String(n).padStart(2, '0');
    }

    function _getSetting(key) {
        const val = DesktopWidget.getSetting(key);
        if (val === undefined || val === null) {
            // Return manifest defaults
            const defaults = { format: '24h', showSeconds: false, showSessionTime: true };
            return defaults[key];
        }
        return val;
    }

    // ------------------------------------------------------------------
    // Clock tick
    // ------------------------------------------------------------------

    function _tick() {
        const now    = new Date();
        const format = _getSetting('format');
        const showSec= _getSetting('showSeconds');
        const showSes= _getSetting('showSessionTime');

        // --- Time ---
        let hours   = now.getHours();
        const mins  = _pad(now.getMinutes());
        const secs  = _pad(now.getSeconds());

        let ampmText = '';
        if (format === '12h') {
            ampmText = hours >= 12 ? 'PM' : 'AM';
            hours    = hours % 12 || 12;
        }

        const timeStr = showSec
            ? `${_pad(hours)}:${mins}:${secs}`
            : `${_pad(hours)}:${mins}`;

        $time.text(timeStr);
        $ampm.text(ampmText);

        // --- Date ---
        const dateStr = now.toLocaleDateString(undefined, {
            weekday: 'short',
            month:   'short',
            day:     'numeric',
        });
        $date.text(dateStr);

        // --- Session timer ---
        if (showSes) {
            $sessionWrap.removeAttr('hidden');
            const elapsed  = Math.floor((Date.now() - _sessionStart) / 1000);
            const h        = Math.floor(elapsed / 3600);
            const m        = Math.floor((elapsed % 3600) / 60);
            const s        = elapsed % 60;
            const sessionStr = h > 0
                ? `${h}:${_pad(m)}:${_pad(s)}`
                : `${m}:${_pad(s)}`;
            $session.text(sessionStr);
        } else {
            $sessionWrap.attr('hidden', '');
        }
    }

    // ------------------------------------------------------------------
    // Interval management
    // ------------------------------------------------------------------

    let _intervalId = null;

    function _start() {
        if (_intervalId) return;
        _tick(); // immediate render
        _intervalId = setInterval(_tick, 1000);
    }

    function _stop() {
        if (_intervalId) {
            clearInterval(_intervalId);
            _intervalId = null;
        }
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    DesktopWidget.onActivate(() => {
        _start();
    });

    DesktopWidget.onDeactivate(() => {
        _stop();
    });

    // ------------------------------------------------------------------
    // Init (start immediately — clock should show right away)
    // ------------------------------------------------------------------

    _start();

})();
