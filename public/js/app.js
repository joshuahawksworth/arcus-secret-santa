/* ---------------------------------------------------------------------------
 * Arcus Secret Santa.
 *
 * One non-scrolling section: the village fills the window, and every screen is
 * a dialog over it. Moving between screens uses Santa Tracker's own interlude
 * transition (coloured layers sweep up over the page, then keep going up and
 * off) and the new screen rises in from the bottom behind them.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  const STAGE_WIDTH = 1920;
  const STAGE_HEIGHT = 1050;
  const ME_KEY = 'arcus-secret-santa:me';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function formatDate(iso) {
    const date = new Date(iso);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  }

  // --- the village stage ----------------------------------------------------

  /** Scale the 1920x1050 scene to cover the window, anchored bottom centre. */
  function sizeStage() {
    const scale = Math.max(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
    document.documentElement.style.setProperty('--stage-scale', String(scale));
  }

  // --- the interlude --------------------------------------------------------

  /**
   * Santa Tracker's `santa-interlude`, reduced to what this app needs: show()
   * resolves once the layers have covered the screen, hide() sends them on up
   * and out. The element's own CSS does the work.
   */
  class Interlude {
    constructor(host) {
      this.host = host;
      this.last = host.lastElementChild;
      this.first = host.firstElementChild;
      this._resolve = null;

      host.addEventListener('transitionend', (event) => {
        if (host.classList.contains('active')) {
          if (event.target === this.last && this._resolve) {
            const resolve = this._resolve;
            this._resolve = null;
            host.classList.add('direction');  // from here they travel upwards
            resolve();
          }
        } else if (event.target === this.first) {
          host.classList.remove('busy', 'direction');
        }
      });
    }

    show() {
      this.host.classList.add('busy');
      return new Promise((resolve) => {
        this._resolve = resolve;
        // Next frame, so the browser sees the starting transform before `active`.
        window.requestAnimationFrame(() => this.host.classList.add('active'));
        // Safety net: never leave the app behind a curtain if a transitionend
        // is missed (a backgrounded tab, say).
        window.setTimeout(() => {
          if (this._resolve === resolve) {
            this._resolve = null;
            this.host.classList.add('direction');
            resolve();
          }
        }, 1600);
      });
    }

    hide() { this.host.classList.remove('active'); }
  }

  // --- the server -----------------------------------------------------------

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  // --- remembering who you are ---------------------------------------------

  const identity = {
    load() {
      try {
        const raw = window.localStorage.getItem(ME_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    save(person) {
      try {
        window.localStorage.setItem(ME_KEY, JSON.stringify({
          id: person.id, token: person.token, name: person.name, code: person.code,
        }));
      } catch { /* private mode, nothing we can do */ }
    },
    clear() {
      try { window.localStorage.removeItem(ME_KEY); } catch { /* ignore */ }
    },
  };

  // --- app ------------------------------------------------------------------

  const app = {
    state: null,     // the public pool state
    me: null,        // our full profile, when we are known
    screen: 'home',
    chat: null,
    santa: null,
    drum: null,

    async boot() {
      sizeStage();
      window.addEventListener('resize', sizeStage);
      window.addEventListener('orientationchange', sizeStage);

      this.interlude = new Interlude($('#interlude'));
      $('#weather').setAttribute('active', '');

      this.glitchElf();
      this.workingElf();
      this.wire();
      await this.refresh();

      // Anyone we already know comes straight back to their own profile.
      const stored = identity.load();
      if (stored) {
        try {
          this.me = { ...(await api(`/api/me?id=${encodeURIComponent(stored.id)}&token=${encodeURIComponent(stored.token)}`)), token: stored.token };
          identity.save(this.me);
        } catch (err) {
          if (err.status === 404) identity.clear();   // removed from the pool
        }
      }

      this.renderHome();
      document.body.classList.remove('booting');
      this.setScreen('home');

      // The dev panel: only with ?dev in the address and DEV_TOOLS=1 on the server.
      if (window.DevTools && this.state.devTools && /[?&#]dev\b/.test(window.location.href)) {
        this.devtools = new window.DevTools(this);
      }
    },

    /** Takes on a signed-in person (used by the dev tools). */
    adopt(person) {
      this.me = person;
      identity.save(person);
    },

    /** Drops the remembered person without touching the pool. */
    forget() {
      identity.clear();
      this.me = null;
    },

    /** The Build & Bolt elf from the toymaking floor, tightening bolts on the drum. */
    workingElf() {
      const host = $('#reel-elf');
      if (!host || !window.lottie) return;
      // The card animation is a quick half-second tightening of a bolt. Here
      // it plays slowly, rests, and goes again, like someone actually working.
      const anim = window.lottie.loadAnimation({
        container: host,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        path: 'img/buildandbolt.json',
        rendererSettings: { preserveAspectRatio: 'xMidYMax meet' },
      });
      anim.setSpeed(0.45);
      anim.addEventListener('DOMLoaded', () => anim.goToAndPlay(0, true));
      anim.addEventListener('complete', () => {
        window.setTimeout(() => { if (host.isConnected) anim.goToAndPlay(0, true); }, 1800 + Math.random() * 1500);
      });
    },

    /** Santa Tracker's village toggles this elf's glitch on for 5s, off for 10s. */
    glitchElf() {
      for (const elf of $$('.elf-glitch')) {
        const tick = () => {
          const on = elf.classList.toggle('glitch');
          window.setTimeout(tick, on ? 5000 : 10000);
        };
        window.setTimeout(tick, 4000 + Math.random() * 6000);
      }
    },

    async refresh() {
      try {
        this.state = await api('/api/state');
      } catch {
        this.state = this.state || { count: 0, participants: [], revealed: false, poolOpen: true, revealDate: null };
      }
    },

    // --- navigation -------------------------------------------------------

    setScreen(name) {
      const next = $(`#screen-${name}`);
      if (!next) return;
      for (const screen of $$('.screen')) screen.classList.remove('current', 'leaving');
      next.classList.add('current');
      this.screen = name;
      const focusable = $('[data-autofocus]', next);
      if (focusable) window.setTimeout(() => focusable.focus(), 450);
    },

    /** Move to another screen behind the interlude curtain. */
    async go(name, prepare) {
      if (this._moving) return;
      this._moving = true;
      try {
        // The outgoing dialog slides up and away behind the curtain, the way
        // the site's overlay dismisses itself.
        const leaving = $('#screen-' + this.screen);
        if (leaving) leaving.classList.add('leaving');
        await this.interlude.show();
        if (prepare) await prepare();
        this.setScreen(name);
        this.interlude.hide();
      } finally {
        this._moving = false;
      }
    },

    notice(screenName, message) {
      const box = $(`#screen-${screenName} .notice`);
      if (!box) return;
      $('p', box).textContent = message || '';
      box.classList.toggle('shown', Boolean(message));
    },

    // --- wiring -----------------------------------------------------------

    wire() {
      for (const button of $$('[data-go]')) {
        button.addEventListener('click', () => {
          const target = button.dataset.go;
          this.go(target, () => this.prepare(target));
        });
      }

      $('#chat-restart').addEventListener('click', () => this.startChat());
      $('#join-form').addEventListener('submit', (event) => this.onSignIn(event));
      $('#profile-form').addEventListener('submit', (event) => this.onSaveProfile(event));
      $('#leave').addEventListener('click', () => this.onLeave());
      $('#forget').addEventListener('click', () => this.onForget());
      $('#drum-spin').addEventListener('click', () => this.onSpin());

      for (const box of $$('.codebox input')) {
        box.addEventListener('click', () => this.copyCode(box));
      }

      // Escape backs out of any dialog.
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || this.screen === 'home' || this._moving) return;
        this.go('home', () => this.prepare('home'));
      });

      this.drum = new window.RaffleDrum({
        drum: $('#drum'),
        tickets: $('#drum-tickets'),
        focus: $('#drum-focus'),
        lock: $('#drum-lock'),
        lockText: $('#drum-lock-text'),
      });
    },

    /** Per-screen data loading, run while the curtain is up. */
    async prepare(name) {
      await this.refresh();
      switch (name) {
        case 'home':    return this.renderHome();
        case 'chat':    return this.startChat();
        case 'result':  return this.renderResult();
        case 'profile': return this.renderProfile();
        case 'joined':  return this.renderJoined();
        default:        return undefined;
      }
    },

    // --- home -------------------------------------------------------------

    renderHome() {
      const { poolOpen } = this.state;
      const known = Boolean(this.me);

      $('#home-join').hidden = known || !poolOpen;
      $('#home-signin').hidden = known;
      $('#home-profile').hidden = !known;

      $('#home-greeting').textContent = known ? `Welcome back, ${this.me.name}.` : '';
      $('#home-status').hidden = !known;

      this.renderDrum();
    },

    // --- the chat ---------------------------------------------------------

    startChat() {
      const log = $('#chat-log');
      log.replaceChildren();
      $('#chat-chips').replaceChildren();
      $('#chat-progress').style.width = '0%';
      $('#chat-input').value = '';
      $('#chat-input').disabled = false;
      $('#chat-send').hidden = false;
      $('#chat-input').hidden = false;
      $('#chat-restart').hidden = true;
      this.notice('chat', '');

      if (this.santa) this.santa.destroy();
      this.santa = new window.Santa($('#chat-santa'));

      this.chat = new window.SantaChat({
        log,
        input: $('#chat-input'),
        sendButton: $('#chat-send'),
        skipButton: $('#chat-skip'),
        chips: $('#chat-chips'),
        progress: $('#chat-progress'),
        santa: this.santa,
        onFinish: (result) => this.onJoin(result),
      });
      this.chat.start();
    },

    async onJoin(result) {
      $('#chat-input').hidden = true;
      $('#chat-send').hidden = true;
      $('#chat-skip').hidden = true;
      try {
        const person = await api('/api/join', { method: 'POST', body: result });
        this.me = person;
        identity.save(person);
        await this.go('joined', () => this.prepare('joined'));
      } catch (err) {
        this.notice('chat', err.message);
        $('#chat-restart').hidden = false;
      }
    },

    renderJoined() {
      $('#joined-name').textContent = this.me.name;
      $('#joined-code').value = this.me.code;
      $('#joined-when').textContent = this.state.revealDate
        ? `The drum opens on ${formatDate(this.state.revealDate)}. Come back then and start the draw.`
        : '';
    },

    // --- signing back in --------------------------------------------------

    async onSignIn(event) {
      event.preventDefault();
      const name = $('#signin-name').value.trim();
      const code = $('#signin-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      this.notice('signin', '');
      if (!code) return this.notice('signin', 'Please enter your elf code.');
      try {
        const person = await api('/api/signin', { method: 'POST', body: { name, code } });
        this.me = person;
        identity.save(person);
        await this.go('profile', () => this.prepare('profile'));
      } catch (err) {
        this.notice('signin', err.message);
      }
    },

    // --- the drum ---------------------------------------------------------

    renderDrum() {
      const { participants, revealed, revealDate, drawn } = this.state;
      const names = participants.map((p) => p.name);
      const when = revealDate ? formatDate(revealDate) : 'the reveal';

      this.notice('home', '');
      $('#drum').classList.remove('done');
      $('#drum-spin').disabled = false;
      $('#drum-spin').hidden = false;
      $('#drum-details').hidden = true;
      $('#drum-actions').hidden = true;
      this.match = null;

      this.drum.setNames(names);

      if (!revealed) {
        this.drum.setLocked(true, names.length
          ? `Under construction \u00b7 opens ${when}`
          : `Nobody in the hat yet \u00b7 opens ${when}`);
        return;
      }

      this.drum.setLocked(false);
      if (!this.me) {
        this.notice('home', 'Sign in with your elf code and the drum will draw your name.');
      } else if (!drawn || !names.length) {
        this.notice('home', 'Not enough people in the hat to draw yet.');
      } else {
        $('#drum-actions').hidden = false;
      }
    },

    async onSpin() {
      if (!this.me) return;
      const button = $('#drum-spin');
      button.disabled = true;
      this.notice('home', '');

      let match;
      try {
        match = await api(`/api/match?id=${encodeURIComponent(this.me.id)}&token=${encodeURIComponent(this.me.token)}`);
      } catch (err) {
        button.disabled = false;
        this.notice('home', err.status === 423
          ? `Not yet! The drum opens on ${formatDate(err.data.revealDate || this.state.revealDate)}.`
          : err.message);
        return;
      }

      $('#drum-spin').hidden = true;
      try {
        await this.drum.spin(match.receiver.name);
      } catch {
        // The ticket was not in the drum (the pool changed under us): still show the result.
      }
      this.showMatch(match);
    },

    showMatch(match) {
      this.match = match;
      $('#match-name').textContent = match.receiver.name;
      // The reel blurs back and the winner's box comes forward, as on a real draw.
      $('#drum').classList.add('done');
      $('#drum-details').textContent = `What Santa knows about ${match.receiver.name}`;
      $('#drum-details').hidden = false;
      $('#drum-actions').hidden = false;
    },

    async renderResult() {
      let match = this.match;
      if (!match && this.me && this.state.revealed) {
        try {
          match = await api(`/api/match?id=${encodeURIComponent(this.me.id)}&token=${encodeURIComponent(this.me.token)}`);
          this.match = match;
        } catch { /* nothing to show yet */ }
      }
      $('#result-name').textContent = match ? match.receiver.name : '\u2014';
      $('#match-wishlist').replaceChildren();
      if (!match) return;
      $('#result-name').textContent = match.receiver.name;

      const list = $('#match-wishlist');
      list.replaceChildren();
      const rows = [...(match.receiver.answers || [])];
      if (match.receiver.hint) rows.unshift({ q: 'Their hint', a: match.receiver.hint });
      if (!rows.length) {
        const dd = document.createElement('dd');
        dd.innerHTML = '<em>They did not leave Santa any clues. You are on your own!</em>';
        list.appendChild(dd);
      }
      for (const row of rows) {
        const item = document.createElement('div');
        item.className = 'wish';
        const dt = document.createElement('dt');
        dt.textContent = row.q;
        const dd = document.createElement('dd');
        dd.textContent = row.a;
        item.append(dt, dd);
        list.appendChild(item);
      }
    },

    // --- your profile -----------------------------------------------------

    renderProfile() {
      if (!this.me) return;
      $('#profile-name').value = this.me.name;
      $('#profile-code').value = this.me.code || '';
      $('#profile-hint').value = this.me.hint || '';

      const answers = $('#profile-answers');
      answers.replaceChildren();

      // One editable row per question Santa asked, in script order, so an
      // unanswered question can be filled in later.
      const saved = new Map((this.me.answers || []).map((a) => [a.q, a.a]));
      for (const step of window.SANTA_SCRIPT) {
        if (step.store !== 'answer') continue;
        const field = document.createElement('div');
        field.className = 'field';
        const id = `profile-answer-${step.key}`;
        field.innerHTML = `<label for="${id}"></label><input type="text" id="${id}" data-question="">`;
        $('label', field).textContent = step.selfLabel || step.label;
        const input = $('input', field);
        input.dataset.question = step.label;
        input.value = saved.get(step.label) || '';
        input.placeholder = step.placeholder || '';
        answers.appendChild(field);
      }

      $('#profile-saved').hidden = true;
      this.notice('profile', '');
      $('#leave').hidden = !this.state.poolOpen;
      $('#profile-locked').hidden = this.state.poolOpen;
    },

    async onSaveProfile(event) {
      event.preventDefault();
      this.notice('profile', '');
      const answers = $$('#profile-answers input').map((input) => ({
        q: input.dataset.question,
        a: input.value.trim(),
      }));
      try {
        const updated = await api('/api/me', {
          method: 'POST',
          body: {
            id: this.me.id,
            token: this.me.token,
            name: $('#profile-name').value,
            hint: $('#profile-hint').value,
            answers,
          },
        });
        this.me = { ...updated, token: this.me.token };
        identity.save(this.me);
        $('#profile-saved').hidden = false;
        window.setTimeout(() => { $('#profile-saved').hidden = true; }, 2600);
      } catch (err) {
        this.notice('profile', err.message);
      }
    },

    async onLeave() {
      if (!window.confirm('Take your name out of the hat? Your answers will be deleted.')) return;
      try {
        await api('/api/leave', { method: 'POST', body: { id: this.me.id, token: this.me.token } });
        identity.clear();
        this.me = null;
        await this.go('home', () => this.prepare('home'));
      } catch (err) {
        this.notice('profile', err.message);
      }
    },

    onForget() {
      if (!window.confirm('Forget you on this device? You will need your elf code to get back in. Your name stays in the hat.')) return;
      identity.clear();
      this.me = null;
      this.go('home', () => this.prepare('home'));
    },

    // --- odds and ends ----------------------------------------------------

    /** The site's copy-to-clipboard field: it flips to inverse while copying. */
    copyCode(input) {
      input.select();
      const done = () => {
        input.classList.add('copy');
        window.setTimeout(() => input.classList.remove('copy'), 400);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, done);
      else { try { document.execCommand('copy'); } catch { /* ignore */ } done(); }
    },
  };

  window.addEventListener('DOMContentLoaded', () => {
    app.boot().catch((err) => {
      console.error(err);
      document.body.classList.remove('booting');
    });
    window.app = app;
  });
})();
