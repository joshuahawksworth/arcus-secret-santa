/* ---------------------------------------------------------------------------
 * Dev tools.
 *
 * A small panel for walking the app through every state without waiting for
 * December: seed a pool, lock or open the drum, run the draw, sign in as any
 * seeded person, start over. It only appears when the page is opened with
 * `?dev` AND the server was started with DEV_TOOLS=1, and the endpoints it
 * calls do not exist otherwise.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  async function call(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status}`);
    return data;
  }

  const PANEL = `
    <div class="devtools-head">
      <strong>Dev tools</strong>
      <span class="devtools-state" id="devtools-state"></span>
      <button type="button" class="devtools-close" data-dev="hide" title="Hide (press D to show)">&times;</button>
    </div>
    <div class="devtools-row">
      <span>Pool</span>
      <button type="button" data-dev="seed">Seed 8 people</button>
      <button type="button" data-dev="seed-odd">Seed 7</button>
      <button type="button" data-dev="empty">Empty</button>
    </div>
    <div class="devtools-row">
      <span>Drum</span>
      <button type="button" data-dev="locked">Lock</button>
      <button type="button" data-dev="open">Open &amp; draw</button>
      <button type="button" data-dev="draw">Redraw</button>
      <button type="button" data-dev="default">Real date</button>
    </div>
    <div class="devtools-row">
      <span>Me</span>
      <select id="devtools-person"><option value="">Sign in as&hellip;</option></select>
      <button type="button" data-dev="forget">Forget me</button>
    </div>
    <div class="devtools-row">
      <span>Go</span>
      <button type="button" data-dev="go:home">Home</button>
      <button type="button" data-dev="go:chat">Chat</button>
      <button type="button" data-dev="go:signin">Sign in</button>
      <button type="button" data-dev="go:joined">Joined</button>
      <button type="button" data-dev="go:profile">Profile</button>
      <button type="button" data-dev="go:result">Result</button>
    </div>
    <div class="devtools-log" id="devtools-log"></div>`;

  class DevTools {
    constructor(app) {
      this.app = app;
      this.panel = document.createElement('aside');
      this.panel.className = 'devtools';
      this.panel.innerHTML = PANEL;
      document.body.appendChild(this.panel);

      this.panel.addEventListener('click', (event) => {
        const button = event.target.closest('[data-dev]');
        if (button) this.run(button.dataset.dev).catch((err) => this.log(err.message, true));
      });
      $('#devtools-person', this.panel).addEventListener('change', (event) => {
        if (event.target.value) this.signInAs(event.target.value).catch((err) => this.log(err.message, true));
      });
      window.addEventListener('keydown', (event) => {
        if (event.key.toLowerCase() === 'd' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
          this.panel.classList.toggle('hidden');
        }
      });

      this.refresh();
    }

    log(message, isError = false) {
      const line = document.createElement('div');
      line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
      if (isError) line.className = 'err';
      const log = $('#devtools-log', this.panel);
      log.prepend(line);
      while (log.children.length > 6) log.lastChild.remove();
    }

    async refresh() {
      await this.app.refresh();
      const { state, me } = this.app;
      $('#devtools-state', this.panel).textContent =
        `${state.count} in · ${state.poolOpen ? 'joining open' : 'joining closed'} · ${state.revealed ? 'drum open' : 'drum locked'} · ${state.drawn ? 'drawn' : 'not drawn'} · ${me ? me.name : 'anonymous'}`;

      const { people } = await call('/api/dev/people');
      const select = $('#devtools-person', this.panel);
      const current = select.value;
      select.replaceChildren(new Option('Sign in as…', ''));
      for (const person of people) select.add(new Option(`${person.name} (${person.code})`, person.code));
      select.value = current;
    }

    async home() {
      await this.app.go('home', () => this.app.prepare('home'));
      await this.refresh();
    }

    async signInAs(code) {
      const person = await call('/api/signin', { code });
      this.app.adopt(person);
      this.log(`signed in as ${person.name}`);
      await this.home();
    }

    async run(action) {
      if (action.startsWith('go:')) {
        const screen = action.slice(3);
        await this.app.go(screen, () => this.app.prepare(screen));
        return;
      }
      switch (action) {
        case 'hide': this.panel.classList.add('hidden'); return;
        case 'seed': {
          const { added } = await call('/api/dev/seed', { count: 8 });
          this.log(`seeded ${added.length} (${added.map((p) => p.name).join(', ') || 'all already in'})`);
          break;
        }
        case 'seed-odd': {
          const { added } = await call('/api/dev/seed', { count: 7 });
          this.log(`seeded ${added.length}`);
          break;
        }
        case 'empty':
          await call('/api/dev/reset', { emptyPool: true });
          this.app.forget();
          this.log('pool emptied');
          break;
        case 'locked':
          await call('/api/dev/reveal', { mode: 'locked' });
          this.log('drum locked (reveal next year)');
          break;
        case 'open': {
          const r = await call('/api/dev/reveal', { mode: 'open' });
          this.log(r.drawn ? 'drum open and names drawn' : `drum open but not drawn: ${r.reason}`);
          break;
        }
        case 'draw':
          await call('/api/dev/draw', {});
          this.log('names redrawn (drum opened too, since a draw closes joining)');
          break;
        case 'default':
          await call('/api/dev/reveal', { mode: 'default' });
          this.log('reveal date back to the real one; test draw cleared, joining open');
          break;
        case 'forget':
          this.app.forget();
          this.log('forgotten on this device');
          break;
        default:
          return;
      }
      await this.home();
    }
  }

  window.DevTools = DevTools;
})();
