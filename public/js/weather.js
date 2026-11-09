/* ---------------------------------------------------------------------------
 * Falling snow and drifting clouds.
 *
 * A port of Google Santa Tracker's `santa-weather` custom element
 * (Apache-2.0). The flake/cloud counts, the wind model, the respawn edges and
 * the fade-out near the ground are all the original's; the cloud artwork is
 * the same three SVGs, saved out of the bundle into img/weather/.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  const CLOUD_SOURCES = [
    'img/weather/cloud1.svg',
    'img/weather/cloud2.svg',
    'img/weather/cloud3.svg',
  ];

  const cloudImages = CLOUD_SOURCES.map((src) => {
    const img = new Image();
    img.src = src;
    return img;
  });

  class SantaWeatherElement extends HTMLElement {
    static get observedAttributes() { return ['active']; }

    constructor() {
      super();
      this._draw = this._draw.bind(this);
      this._canvas = document.createElement('canvas');
      this._ctx = this._canvas.getContext('2d');
      this._rAF = 0;
      this.style.display = 'block';
      this.style.pointerEvents = 'none';
      this._canvas.style.display = 'block';

      this.wind = 0;
      this._currentWind = 0;
      this._windTimeout = 0;
      this._snowflakes = new Array(40).fill(null);
      this._clouds = new Array(6).fill(null);
    }

    get active() { return this.hasAttribute('active'); }
    set active(value) { this.toggleAttribute('active', Boolean(value)); }

    attributeChangedCallback() { this._maybeQueueDraw(); }

    connectedCallback() {
      this._maybeQueueDraw();
      this._chooseRandomWind();
      this.appendChild(this._canvas);
    }

    disconnectedCallback() {
      window.clearTimeout(this._windTimeout);
      if (this._rAF) window.cancelAnimationFrame(this._rAF);
      this._rAF = 0;
    }

    _maybeQueueDraw() {
      if (this._rAF || !this.active || !this.isConnected) return false;
      this._rAF = window.requestAnimationFrame(this._draw);
      return true;
    }

    _chooseRandomWind() {
      if (!this.isConnected) return false;
      this.wind = 0.25 - 0.5 * Math.random();
      this._windTimeout = window.setTimeout(
        this._chooseRandomWind.bind(this), 15000 * Math.random()
      );
      return true;
    }

    /** New flakes enter from the top; respawning ones mostly enter from the sides. */
    _makeSnowflakePosition(initial) {
      if (initial) return { x: Math.random(), y: Math.random() };
      const roll = Math.random();
      const edge = 1 / 3;
      if (roll < edge) return { x: -0.1, y: Math.random() };
      if (roll > 1 - edge) return { x: 1.1, y: Math.random() };
      return { x: Math.random(), y: 0 };
    }

    _draw() {
      const { offsetWidth: width, offsetHeight: height } = this;
      const dpr = window.devicePixelRatio || 1;

      if (this._canvas.width !== width * dpr || this._canvas.height !== height * dpr) {
        this._canvas.width = width * dpr;
        this._canvas.height = height * dpr;
        this._canvas.style.width = `${width}px`;
        this._canvas.style.height = `${height}px`;
      }

      this._rAF = 0;
      if (!this._maybeQueueDraw() || width === 0 || height === 0) return false;

      this._snowflakes = this._snowflakes.map((flake) => {
        if (flake !== null) {
          flake.x += 0.01 * this._currentWind * (1 / flake.d);
          flake.y += 0.0002 * flake.d * flake.ry;
          const gone = flake.y > 1 || flake.x < -0.1 || flake.x > 1.1;
          if (!gone) return flake;
        }
        const { x, y } = this._makeSnowflakePosition(flake === null);
        return {
          x, y,
          ry: 0.5 + Math.random(),
          d: 2 + 2 * Math.random(),
          o: 0.6 + 0.4 * Math.random(),
        };
      });

      this._clouds = this._clouds.map((cloud) => {
        if (cloud !== null) {
          cloud.x += 0.001 * this._currentWind * cloud.m;
          const blownRight = this.wind > 0 && cloud.x * width > width + cloud.w;
          const blownLeft = this.wind < 0 && cloud.x * width < -cloud.w;
          if (!blownRight && !blownLeft) return cloud;
        }
        const w = 50 + 100 * Math.random();
        const h = 0.6 * w;
        const margin = w / width / 2;
        const x = cloud === null ? Math.random() : (this.wind > 0 ? -margin : 1 + margin);
        return {
          img: Math.floor(Math.random() * cloudImages.length),
          w, h,
          m: 4 - w / 50,
          x,
          y: 0.4 * Math.random(),
          o: 0.2 + 0.7 * Math.random(),
        };
      });

      this._currentWind += (this.wind - this._currentWind) / 200;

      const ctx = this._ctx;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#fff';
      ctx.clearRect(0, 0, width, height);

      for (const flake of this._snowflakes) {
        // Fade flakes out over the last tenth so they settle rather than vanish.
        const fade = flake.y > 0.9 ? 1 - (flake.y - 0.9) / 0.1 : 1;
        ctx.globalAlpha = flake.o * fade;
        ctx.beginPath();
        ctx.arc(flake.x * width, flake.y * height, flake.d, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.fill();
      }

      for (const cloud of this._clouds) {
        const img = cloudImages[cloud.img];
        if (!img.complete || !img.naturalWidth) continue;
        ctx.globalAlpha = cloud.o;
        ctx.drawImage(img, width * cloud.x - cloud.w / 2, height * cloud.y - cloud.h / 2, cloud.w, cloud.h);
      }

      ctx.restore();
      return true;
    }
  }

  customElements.define('santa-weather', SantaWeatherElement);
})();
