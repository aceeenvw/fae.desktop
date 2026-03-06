/**
 * now-playing/script.js — Decorative music player widget
 *
 * Settings:
 *   songTitle   string  (default "untitled track")
 *   artist      string  (default "unknown artist")
 *   duration    string  (default "3:24")  — format "M:SS"
 *   audioUrl    string  (default "")      — if set, plays real audio
 *   albumArt    string  (default "")      — album art URL
 *
 * Modes:
 *   Decorative (no audioUrl): fake progress loops over duration, plays animation
 *   Functional (audioUrl set): uses an <audio> element for real playback
 */

(function initNowPlayingWidget() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM refs
    // ------------------------------------------------------------------
    const $root      = DesktopWidget.getElement();
    const $title     = $root.find('.fd-np-title');
    const $artist    = $root.find('.fd-np-artist');
    const $current   = $root.find('.fd-np-current');
    const $total     = $root.find('.fd-np-total');
    const $fill      = $root.find('.fd-np-progress-fill');
    const $thumb     = $root.find('.fd-np-progress-thumb');
    const $track     = $root.find('.fd-np-progress-track');
    const $ppBtn     = $root.find('.fd-np-playpause');
    const $iconPlay  = $root.find('.fd-np-icon-play');
    const $iconPause = $root.find('.fd-np-icon-pause');
    const $artImg    = $root.find('.fd-np-art-img');
    const $artPH     = $root.find('.fd-np-art-placeholder');
    const $audio     = $root.find('.fd-np-audio');

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let _playing      = false;
    let _fakeSeconds  = 0;       // current fake playback position in seconds
    let _durationSec  = 204;     // parsed duration in seconds
    let _tickTimer    = null;
    let _isReal       = false;   // true when audioUrl is set and audio is loaded

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _parseDuration(str) {
        if (!str || typeof str !== 'string') return 204;
        const parts = str.split(':').map(Number);
        if (parts.length === 2) return (parts[0] * 60 + parts[1]) || 204;
        if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) || 204;
        return 204;
    }

    function _formatTime(sec) {
        const s = Math.floor(sec);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, '0')}`;
    }

    function _pct(current, total) {
        if (!total) return 0;
        return Math.min(100, (current / total) * 100);
    }

    function _getSetting(key, fallback) {
        const v = DesktopWidget.getSetting(key);
        return (v === undefined || v === null || v === '') ? fallback : v;
    }

    // ------------------------------------------------------------------
    // Apply settings
    // ------------------------------------------------------------------

    function _applySettings() {
        const title      = _getSetting('songTitle', 'untitled track');
        const artist     = _getSetting('artist', 'unknown artist');
        const durStr     = _getSetting('duration', '3:24');
        const audioUrl   = _getSetting('audioUrl', '');
        const albumArt   = _getSetting('albumArt', '');

        $title.text(title).attr('title', title);
        $artist.text(artist).attr('title', artist);

        _durationSec = _parseDuration(durStr);
        $total.text(durStr);

        // Album art
        if (albumArt) {
            $artImg.attr('src', albumArt).removeClass('hidden');
            $artPH.addClass('hidden');
            $artImg.off('error').on('error', () => {
                $artImg.addClass('hidden');
                $artPH.removeClass('hidden');
            });
        } else {
            $artImg.addClass('hidden').attr('src', '');
            $artPH.removeClass('hidden');
        }

        // Functional mode
        if (audioUrl) {
            _isReal = true;
            const audioEl = $audio[0];
            if (audioEl.src !== audioUrl) {
                audioEl.src = audioUrl;
                audioEl.load();
            }
        } else {
            _isReal = false;
            $audio[0].src = '';
        }
    }

    // ------------------------------------------------------------------
    // UI update
    // ------------------------------------------------------------------

    function _updateUI(positionSec) {
        $current.text(_formatTime(positionSec));
        const pct = _pct(positionSec, _durationSec);
        $fill.css('width', `${pct}%`);
        $thumb.css('left', `${pct}%`);
    }

    function _setPlayingUI(playing) {
        $iconPlay.attr('hidden', playing ? '' : null);
        $iconPause.attr('hidden', playing ? null : '');
    }

    // ------------------------------------------------------------------
    // Fake (decorative) playback
    // ------------------------------------------------------------------

    function _startFakeTick() {
        if (_tickTimer) return;
        _tickTimer = setInterval(() => {
            _fakeSeconds++;
            if (_fakeSeconds >= _durationSec) {
                _fakeSeconds = 0; // loop
            }
            _updateUI(_fakeSeconds);
        }, 1000);
    }

    function _stopFakeTick() {
        clearInterval(_tickTimer);
        _tickTimer = null;
    }

    // ------------------------------------------------------------------
    // Real audio event wiring
    // ------------------------------------------------------------------

    const audioEl = $audio[0];

    audioEl.addEventListener('timeupdate', () => {
        if (_isReal) _updateUI(audioEl.currentTime);
    });

    audioEl.addEventListener('ended', () => {
        audioEl.currentTime = 0;
        audioEl.play().catch(() => {});
    });

    audioEl.addEventListener('error', () => {
        // Fall back to decorative mode silently
        _isReal = false;
        DesktopWidget.showToast('Could not load audio — using decorative mode', 'warning');
        if (_playing) _startFakeTick();
    });

    // ------------------------------------------------------------------
    // Play / pause
    // ------------------------------------------------------------------

    function _play() {
        _playing = true;
        _setPlayingUI(true);
        if (_isReal) {
            audioEl.play().catch(() => {
                // fallback to fake if autoplay blocked
                _isReal = false;
                _startFakeTick();
            });
        } else {
            _startFakeTick();
        }
    }

    function _pause() {
        _playing = false;
        _setPlayingUI(false);
        if (_isReal) {
            audioEl.pause();
        } else {
            _stopFakeTick();
        }
    }

    $ppBtn.on('click', () => {
        if (_playing) _pause(); else _play();
    });

    // ------------------------------------------------------------------
    // Progress bar scrubbing (decorative mode: seek in fake time)
    // ------------------------------------------------------------------

    $track.on('click', function (e) {
        const rect = this.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const newPos = pct * _durationSec;

        if (_isReal) {
            audioEl.currentTime = newPos;
        } else {
            _fakeSeconds = Math.floor(newPos);
            _updateUI(_fakeSeconds);
        }
    });

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    DesktopWidget.onActivate(() => {
        _applySettings();
        _updateUI(_isReal ? audioEl.currentTime : _fakeSeconds);
    });

    DesktopWidget.onDeactivate(() => {
        // Keep playing in background but stop fake tick to save CPU
        if (!_isReal) _stopFakeTick();
    });

    // ------------------------------------------------------------------
    // Init — auto-start in decorative mode
    // ------------------------------------------------------------------

    _applySettings();
    _updateUI(0);

    // Auto-start fake playback when widget loads (decorative feel)
    if (!_isReal) {
        _play();
    }

})();
