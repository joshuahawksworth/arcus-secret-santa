/* ---------------------------------------------------------------------------
 * The raffle drum.
 *
 * Seen from the front: a reel of raffle tickets, one per name in the hat, that
 * flies upwards past a marked centre window and runs down to a stop with the
 * drawn name sitting in it. The reel is cyclic, so the strip never runs out
 * however many times it goes round.
 *
 * Until the reveal date the drum is still shown, names and all, but locked.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  const LOOPS = 7;            // full passes of the strip before it stops
  const DURATION = 6200;      // ms, start to stop
  const MIN_STRIP = 14;       // tickets in the strip, so short lists still fill it

  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

  class RaffleDrum {
    /**
     * @param {object} els
     *   drum     the frame
     *   tickets  the window the tickets scroll through
     *   lock     the locked overlay
     *   lockText the text inside it
     */
    constructor(els) {
      this.els = els;
      this.names = [];
      this.strip = [];        // { name, el } in strip order, with repeats
      this.pitch = 66;        // px from one ticket to the next
      this.ticketH = 56;      // px, one ticket
      this.height = 0;        // window height
      this.y = 0;             // how far the strip has travelled, px
      this._rAF = 0;
      this._spinning = false;
      this._measure = this._measure.bind(this);
      this._observer = new ResizeObserver(this._measure);
      this._observer.observe(els.tickets);
      window.addEventListener('resize', this._measure);
    }

    destroy() {
      this._observer.disconnect();
      window.removeEventListener('resize', this._measure);
      window.cancelAnimationFrame(this._rAF);
    }

    // --- set-up -----------------------------------------------------------

    setNames(names) {
      this.names = names.slice();
      this.els.tickets.replaceChildren();
      this.strip = [];
      if (!names.length) return;

      // Repeat the list until the strip is comfortably longer than the window.
      const repeats = Math.max(1, Math.ceil(MIN_STRIP / names.length));
      for (let r = 0; r < repeats; r++) {
        for (const name of names) {
          const el = document.createElement('div');
          el.className = 'ticket';
          const label = document.createElement('span');
          label.textContent = name;
          el.appendChild(label);
          el.title = name;
          this.els.tickets.appendChild(el);
          this.strip.push({ name, el });
        }
      }
      this.y = 0;
      this._measure();
    }

    setLocked(locked, text) {
      this.els.drum.classList.toggle('locked', Boolean(locked));
      if (text !== undefined) this.els.lockText.textContent = text;
    }

    _measure() {
      const h = this.els.tickets.clientHeight;
      if (!h) return;
      this.height = h;
      const sample = this.strip[0];
      if (sample) {
        const gap = parseFloat(window.getComputedStyle(this.els.tickets).getPropertyValue('--ticket-gap')) || 10;
        this.ticketH = sample.el.offsetHeight;
        this.pitch = this.ticketH + gap;
      }
      this._render();
    }

    get length() { return this.strip.length * this.pitch; }

    /** The y at which strip index `i` sits dead centre of the window. */
    _centreFor(i) {
      return i * this.pitch - (this.height - this.ticketH) / 2;
    }

    // --- the spin ---------------------------------------------------------

    /**
     * Runs the reel for a good while and brings it to rest on the named ticket.
     * Resolves with that ticket's element once it has stopped.
     */
    spin(winnerName) {
      if (this._spinning) return Promise.reject(new Error('already spinning'));
      const candidates = this.strip.map((t, i) => (t.name === winnerName ? i : -1)).filter((i) => i >= 0);
      if (!candidates.length) return Promise.reject(new Error('that name is not in the drum'));

      this._spinning = true;
      this.els.drum.classList.add('spinning');
      for (const t of this.strip) t.el.classList.remove('winner');

      // Land on whichever copy of the name is next after LOOPS full passes.
      const L = this.length;
      const start = this.y;
      const base = Math.ceil(start / L) * L + LOOPS * L;
      const target = candidates
        .map((i) => base + this._centreFor(i))
        .map((y) => (y < start + (LOOPS - 0.5) * L ? y + L : y))
        .sort((a, b) => a - b)[0];
      const winner = this.strip[candidates.find((i) => Math.abs(((target - this._centreFor(i)) % L + L) % L) < 0.5)]
        || this.strip[candidates[0]];

      const t0 = performance.now();
      return new Promise((resolve) => {
        const frame = (now) => {
          const p = Math.min(1, (now - t0) / DURATION);
          this.y = start + (target - start) * easeOutQuint(p);
          this._render(p);
          if (p < 1) { this._rAF = window.requestAnimationFrame(frame); return; }
          this.y = target;
          this._render(1);
          this._spinning = false;
          this.els.drum.classList.remove('spinning');
          winner.el.classList.add('winner');
          window.setTimeout(() => resolve(winner.el), 700);
        };
        this._rAF = window.requestAnimationFrame(frame);
      });
    }

    // --- rendering --------------------------------------------------------

    /** Places every ticket at its wrapped position; only the visible ones get a transform. */
    _render(progress = 1) {
      const L = this.length;
      if (!L) return;
      const H = this.height;
      const pitch = this.pitch;
      // Faster passes blur more; it eases off as the reel slows.
      const speed = this._spinning ? (1 - progress) : 0;
      this.els.drum.style.setProperty('--reel-blur', `${(speed * 3).toFixed(2)}px`);

      for (let i = 0; i < this.strip.length; i++) {
        const el = this.strip[i].el;
        let pos = ((i * pitch - this.y) % L + L) % L;   // 0 .. L
        if (pos > L - pitch) pos -= L;                   // let the top one peek in from above
        if (pos < -pitch || pos > H) {
          if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
          continue;
        }
        el.style.visibility = 'visible';
        // Towards the edges the drum curves away: a touch smaller and dimmer.
        const centre = (pos + this.ticketH / 2) - H / 2;
        const edge = Math.min(1, Math.abs(centre) / (H / 2));
        const scale = 1 - edge * 0.12;
        el.style.opacity = String(1 - edge * 0.45);
        el.style.transform = `translate3d(0, ${pos.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
      }
    }
  }

  window.RaffleDrum = RaffleDrum;
})();
