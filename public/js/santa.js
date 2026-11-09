/* ---------------------------------------------------------------------------
 * Santa.
 *
 * The figure, the face parts and their positions come from Google Santa
 * Tracker's `santaselfie` scene (Apache-2.0). The barber-shop backdrop, the
 * tools and the beard canvas are left out: here Santa only sits and talks, at
 * a fraction of the size he is in that scene. The blink cadence (a random
 * 1-8s gap, eyes shut for 200ms) is the original's.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  const MOODS = ['happy', 'delighted', 'alarmed', 'sad', 'talking'];

  /** Santa Tracker's utils.randomLoop: run fn on a random interval forever. */
  function randomLoop(fn, min, max, stillAlive) {
    const tick = () => {
      if (!stillAlive()) return;
      fn();
      window.setTimeout(tick, min + Math.random() * (max - min));
    };
    window.setTimeout(tick, min + Math.random() * (max - min));
  }

  const MARKUP = `
    <div class="santa-figure">
      <div class="Body"></div>
      <div class="Face Face--happy">
        <div class="eye eye--left"></div>
        <div class="eye eye--right"></div>
        <div class="eyebrow eyebrow--left"></div>
        <div class="eyebrow eyebrow--right"></div>
        <div class="cheek cheek--left"></div>
        <div class="cheek cheek--right"></div>
        <canvas class="beard"></canvas>
        <div class="nose"></div>
        <div class="mouth"></div>
      </div>
    </div>`;

  class Santa {
    /** @param {HTMLElement} host an element with class `santa-window` */
    constructor(host) {
      this.host = host;
      this.host.innerHTML = MARKUP;
      this.face = host.querySelector('.Face');
      this.eyes = [...host.querySelectorAll('.eye')];
      this.eyebrows = [...host.querySelectorAll('.eyebrow')];
      this._mood = 'happy';
      this._talkTimer = 0;
      this._alive = true;

      // The beard is the santaselfie cloth simulation, settled and drawn once.
      this.beard = window.SantaBeard ? new window.SantaBeard(host.querySelector('.beard')) : null;
      this._onResize = () => { if (this.beard && this.host.isConnected) this.beard.render(); };
      window.addEventListener('resize', this._onResize);

      randomLoop(() => this.blink(), 1000, 8000, () => this._alive && this.host.isConnected);
    }

    blink() {
      if (this._mood === 'delighted') return;  // eyes are already shut
      for (const eye of this.eyes) {
        eye.classList.add('eye--blink');
        window.setTimeout(() => eye.classList.remove('eye--blink'), 200);
      }
    }

    raiseEyebrows() {
      for (const brow of this.eyebrows) {
        brow.classList.remove('eyebrow--raised');
        // Force a reflow so the animation restarts even if it is already on.
        void brow.offsetWidth;
        brow.classList.add('eyebrow--raised');
      }
    }

    /** One of happy | delighted | alarmed | sad | talking. */
    set mood(name) {
      const next = MOODS.includes(name) ? name : 'happy';
      for (const mood of MOODS) this.face.classList.remove(`Face--${mood}`);
      this.face.classList.add(`Face--${next}`);
      this._mood = next;
    }

    get mood() { return this._mood; }

    /**
     * Flaps the mouth open and shut for `duration` ms, then settles back into
     * a smile. Used while a message of Santa's is being delivered.
     */
    talk(duration = 900) {
      window.clearInterval(this._talkTimer);
      const settled = this._mood === 'talking' ? 'happy' : this._mood;
      let open = true;
      this.mood = 'talking';
      this._talkTimer = window.setInterval(() => {
        open = !open;
        this.mood = open ? 'talking' : settled;
      }, 160);
      window.setTimeout(() => {
        window.clearInterval(this._talkTimer);
        this._talkTimer = 0;
        this.mood = settled;
      }, duration);
    }

    /** A pleased reaction: shut eyes, rosy cheeks, raised brows. */
    delight(duration = 1600) {
      this.mood = 'delighted';
      window.setTimeout(() => { if (this._mood === 'delighted') this.mood = 'happy'; }, duration);
    }

    destroy() {
      this._alive = false;
      window.clearInterval(this._talkTimer);
      window.removeEventListener('resize', this._onResize);
    }
  }

  window.Santa = Santa;
})();
