/**
 * fae.desktop — particles.js
 * Lightweight ambient particle system using a <canvas> element.
 *
 * Particle types: fireflies, snow, rain, embers, stars, dust, petals
 * Density:        low (30%), medium (base), high (200%)
 * Layer:          'behind' → z-index 1 | 'over' → z-index 8
 */

'use strict';

/* ─── Type definitions ─────────────────────────────────────────────────── */

/**
 * Base counts for each type at 'medium' density.
 * @type {Record<string, number>}
 */
const BASE_COUNTS = {
    fireflies: 40,
    snow:      120,
    rain:      180,
    embers:    60,
    stars:     80,
    dust:      90,
    petals:    35,
};

const DENSITY_MULTIPLIERS = {
    low:    0.3,
    medium: 1.0,
    high:   2.0,
};

/* ─── Particle type descriptors ────────────────────────────────────────── */

/**
 * Each descriptor factory returns an object that controls how particles
 * are initialized and updated. All coordinates are in canvas-pixel space.
 *
 * init(p, W, H)   — set initial position + per-particle state
 * update(p, W, H) — advance physics by one frame
 * draw(ctx, p)    — render the particle
 */
const TYPE_DESCRIPTORS = {

    /* ── Fireflies — warm dots that drift slowly and pulse opacity ─────── */
    fireflies: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = Math.random() * H;
            p.r     = 1.5 + Math.random() * 1.5;         // 1.5–3px
            p.vx    = (Math.random() - 0.5) * 0.4;
            p.vy    = (Math.random() - 0.5) * 0.4;
            p.phase = Math.random() * Math.PI * 2;       // for pulse
            p.speed = 0.015 + Math.random() * 0.02;      // pulse speed
            p.alpha = 0;
        },
        update(p, W, H) {
            p.phase += p.speed;
            // Smooth sinusoidal opacity, 0–0.85
            p.alpha = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(p.phase));
            // Gentle random walk
            p.vx += (Math.random() - 0.5) * 0.03;
            p.vy += (Math.random() - 0.5) * 0.03;
            // Clamp velocity
            p.vx = Math.max(-0.6, Math.min(0.6, p.vx));
            p.vy = Math.max(-0.6, Math.min(0.6, p.vy));
            p.x += p.vx;
            p.y += p.vy;
            // Wrap around canvas
            if (p.x < -p.r) p.x = W + p.r;
            if (p.x > W + p.r) p.x = -p.r;
            if (p.y < -p.r) p.y = H + p.r;
            if (p.y > H + p.r) p.y = -p.r;
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.beginPath();
            const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.5);
            grd.addColorStop(0, '#fff5b0');
            grd.addColorStop(0.4, '#ffe680');
            grd.addColorStop(1, 'rgba(255,230,60,0)');
            ctx.fillStyle = grd;
            ctx.arc(p.x, p.y, p.r * 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        },
    },

    /* ── Snow — white dots falling with gentle horizontal sway ─────────── */
    snow: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = Math.random() * H - H;              // start above viewport
            p.r     = 1 + Math.random() * 2.5;
            p.vy    = 0.4 + Math.random() * 0.8;
            p.phase = Math.random() * Math.PI * 2;
            p.sway  = 0.3 + Math.random() * 0.5;         // horizontal sway amplitude
            p.alpha = 0.5 + Math.random() * 0.4;
        },
        update(p, W, H) {
            p.phase += 0.01 + p.sway * 0.01;
            p.x += Math.sin(p.phase) * p.sway;
            p.y += p.vy;
            if (p.y > H + p.r) {
                p.y = -p.r;
                p.x = Math.random() * W;
            }
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.beginPath();
            ctx.fillStyle = '#ffffff';
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        },
    },

    /* ── Rain — thin vertical streaks falling fast ──────────────────────── */
    rain: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = Math.random() * H - H;
            p.len   = 8 + Math.random() * 12;             // streak length
            p.vy    = 8 + Math.random() * 6;
            p.alpha = 0.15 + Math.random() * 0.25;
        },
        update(p, W, H) {
            p.y += p.vy;
            if (p.y - p.len > H) {
                p.y = -p.len;
                p.x = Math.random() * W;
            }
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.strokeStyle = 'rgba(180,210,255,0.8)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.len * 0.15, p.y + p.len); // slight diagonal
            ctx.stroke();
            ctx.restore();
        },
    },

    /* ── Embers — orange-red dots rising upward ─────────────────────────── */
    embers: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = H + Math.random() * 20;
            p.r     = 0.8 + Math.random() * 1.8;
            p.vy    = -(0.5 + Math.random() * 1.2);       // upward
            p.vx    = (Math.random() - 0.5) * 0.4;
            p.life  = 0;
            p.maxLife = 80 + Math.random() * 80;          // frames
            p.alpha = 0;
        },
        update(p, W, H) {
            p.life++;
            p.x += p.vx + (Math.random() - 0.5) * 0.2;
            p.y += p.vy;
            // Fade in then out
            const t = p.life / p.maxLife;
            p.alpha = t < 0.2 ? t / 0.2 : t > 0.7 ? (1 - t) / 0.3 : 1;
            p.alpha *= 0.7;
            if (p.life >= p.maxLife) {
                // Reset
                p.x = Math.random() * W;
                p.y = H + Math.random() * 20;
                p.life = 0;
                p.maxLife = 80 + Math.random() * 80;
            }
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2);
            grd.addColorStop(0, '#fff0a0');
            grd.addColorStop(0.5, '#ff8000');
            grd.addColorStop(1, 'rgba(200,40,0,0)');
            ctx.beginPath();
            ctx.fillStyle = grd;
            ctx.arc(p.x, p.y, p.r * 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        },
    },

    /* ── Stars — tiny white dots that twinkle at fixed positions ────────── */
    stars: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = Math.random() * H;
            p.r     = 0.5 + Math.random() * 1.2;
            p.phase = Math.random() * Math.PI * 2;
            p.speed = 0.008 + Math.random() * 0.015;
            p.baseAlpha = 0.3 + Math.random() * 0.4;
        },
        update(p /*, W, H */) {
            p.phase += p.speed;
            p.alpha = p.baseAlpha * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(p.phase)));
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.beginPath();
            ctx.fillStyle = '#e8eeff';
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        },
    },

    /* ── Dust — very faint small particles drifting diagonally ─────────── */
    dust: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = Math.random() * H;
            p.r     = 0.5 + Math.random() * 1;
            p.vx    = 0.1 + Math.random() * 0.25;         // drift right + down
            p.vy    = 0.05 + Math.random() * 0.15;
            p.alpha = 0.04 + Math.random() * 0.1;
        },
        update(p, W, H) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x > W + p.r) { p.x = -p.r; p.y = Math.random() * H; }
            if (p.y > H + p.r) { p.y = -p.r; p.x = Math.random() * W; }
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.beginPath();
            ctx.fillStyle = '#d0c8b8';
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        },
    },

    /* ── Petals — pink-tinted, slightly larger, falling with rotation ───── */
    petals: {
        init(p, W, H) {
            p.x     = Math.random() * W;
            p.y     = Math.random() * H - H;
            p.w     = 4 + Math.random() * 5;              // petal width
            p.h     = 2 + Math.random() * 3;              // petal height
            p.vy    = 0.5 + Math.random() * 0.8;
            p.vx    = (Math.random() - 0.5) * 0.4;
            p.angle = Math.random() * Math.PI * 2;
            p.spin  = (Math.random() - 0.5) * 0.04;
            p.sway  = 0.2 + Math.random() * 0.4;
            p.phase = Math.random() * Math.PI * 2;
            p.alpha = 0.4 + Math.random() * 0.4;
        },
        update(p, W, H) {
            p.phase += 0.02;
            p.x += p.vx + Math.sin(p.phase) * p.sway;
            p.y += p.vy;
            p.angle += p.spin;
            if (p.y > H + p.h) {
                p.y = -p.h;
                p.x = Math.random() * W;
            }
        },
        draw(ctx, p) {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.beginPath();
            // Ellipse approximation as petal shape
            ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(240, 160, 180, 0.85)';
            ctx.fill();
            ctx.restore();
        },
    },
};

/* ─── FaeParticles class ────────────────────────────────────────────────── */

export class FaeParticles {
    /** @type {HTMLCanvasElement|null} */
    #canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    #ctx = null;
    /** @type {Array<Object>} */
    #particles = [];
    /** @type {number|null} */
    #rafId = null;
    /** @type {string} */
    #type = 'fireflies';
    /** @type {string} */
    #density = 'medium';
    /** @type {string} */
    #layer = 'behind';
    /** @type {boolean} */
    #running = false;
    /** @type {ResizeObserver|null} */
    #resizeObserver = null;
    /** Bound handler refs for cleanup */
    #onVisibilityChange = null;

    /* ── Public API ──────────────────────────────────────────────────────── */

    /**
     * Initialise the particle system.
     * @param {{ style?: string, density?: string, layer?: string }} settings
     */
    init(settings = {}) {
        this.#type    = settings.style   || 'fireflies';
        this.#density = settings.density || 'medium';
        this.#layer   = settings.layer   || 'behind';

        this.#ensureCanvas();
        this.#buildParticles();
        this.start();
    }

    /** Change the active particle type and rebuild. */
    setType(type) {
        if (!TYPE_DESCRIPTORS[type]) return;
        this.#type = type;
        this.#buildParticles();
    }

    /** Change density and rebuild. @param {'low'|'medium'|'high'} density */
    setDensity(density) {
        this.#density = density;
        this.#buildParticles();
    }

    /** Change canvas z-index layer. @param {'behind'|'over'} layer */
    setLayer(layer) {
        this.#layer = layer;
        if (this.#canvas) {
            this.#canvas.style.zIndex = layer === 'over' ? '8' : '1';
        }
    }

    /** Start the animation loop. */
    start() {
        if (this.#running) return;
        this.#running = true;
        this.#loop();
        // Pause when tab is hidden
        this.#onVisibilityChange = () => {
            if (document.hidden) {
                this.#pauseLoop();
            } else {
                if (this.#running) this.#loop();
            }
        };
        document.addEventListener('visibilitychange', this.#onVisibilityChange);
    }

    /** Stop the animation loop without destroying the canvas. */
    stop() {
        this.#running = false;
        this.#pauseLoop();
        if (this.#onVisibilityChange) {
            document.removeEventListener('visibilitychange', this.#onVisibilityChange);
            this.#onVisibilityChange = null;
        }
    }

    /** Full cleanup — removes canvas and all event listeners. */
    destroy() {
        this.stop();
        if (this.#resizeObserver) {
            this.#resizeObserver.disconnect();
            this.#resizeObserver = null;
        }
        if (this.#canvas && this.#canvas.parentNode) {
            this.#canvas.parentNode.removeChild(this.#canvas);
        }
        this.#canvas     = null;
        this.#ctx        = null;
        this.#particles  = [];
    }

    /* ── Private helpers ─────────────────────────────────────────────────── */

    #ensureCanvas() {
        // Reuse existing canvas if present
        let canvas = document.getElementById('fd-particles');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'fd-particles';
        }
        // Positioning
        Object.assign(canvas.style, {
            position:       'fixed',
            top:            '0',
            left:           '0',
            width:          '100%',
            height:         '100%',
            pointerEvents:  'none',
            zIndex:         this.#layer === 'over' ? '8' : '1',
        });

        const parent = document.getElementById('fd-root') || document.body;
        if (!canvas.parentNode) parent.appendChild(canvas);

        this.#canvas = canvas;
        this.#ctx    = canvas.getContext('2d');
        this.#syncSize();

        // Keep canvas size in sync with viewport
        this.#resizeObserver = new ResizeObserver(() => this.#syncSize());
        this.#resizeObserver.observe(document.documentElement);
    }

    #syncSize() {
        if (!this.#canvas) return;
        const W = window.innerWidth;
        const H = window.innerHeight;
        if (this.#canvas.width !== W || this.#canvas.height !== H) {
            this.#canvas.width  = W;
            this.#canvas.height = H;
            // Rebuild particle positions after resize
            if (this.#particles.length) this.#buildParticles();
        }
    }

    #buildParticles() {
        const descriptor = TYPE_DESCRIPTORS[this.#type];
        if (!descriptor) return;

        const W     = this.#canvas ? this.#canvas.width  : window.innerWidth;
        const H     = this.#canvas ? this.#canvas.height : window.innerHeight;
        const base  = BASE_COUNTS[this.#type] || 60;
        const mult  = DENSITY_MULTIPLIERS[this.#density] || 1.0;
        const count = Math.round(base * mult);

        this.#particles = [];
        for (let i = 0; i < count; i++) {
            const p = {};
            descriptor.init(p, W, H);
            this.#particles.push(p);
        }
    }

    #loop() {
        if (!this.#running || !this.#canvas || !this.#ctx) return;
        const W   = this.#canvas.width;
        const H   = this.#canvas.height;
        const ctx = this.#ctx;
        const descriptor = TYPE_DESCRIPTORS[this.#type];

        ctx.clearRect(0, 0, W, H);

        if (descriptor) {
            for (const p of this.#particles) {
                descriptor.update(p, W, H);
                descriptor.draw(ctx, p);
            }
        }

        this.#rafId = requestAnimationFrame(() => this.#loop());
    }

    #pauseLoop() {
        if (this.#rafId !== null) {
            cancelAnimationFrame(this.#rafId);
            this.#rafId = null;
        }
    }
}

/* ─── Default singleton export ──────────────────────────────────────────── */
export const faeParticles = new FaeParticles();
export default faeParticles;
