/* ---------------------------------------------------------------------------
 * The conversation with Santa.
 *
 * Santa works through a fixed list of questions about the person's interests
 * and hobbies. Their answers are kept alongside their name so that whoever
 * draws them has something to go on, and the last question becomes their
 * optional hint.
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  /**
   * Each step is one question.
   *   key       stored alongside the answer, and used to find it again on edit
   *   label     how the question is shown to the person who draws them
   *   selfLabel how it is shown to you when you edit your own answers
   *   ask       Santa's lines, delivered one bubble at a time
   *   chips     optional one-tap answers
   *   optional  may be skipped
   *   store     'name' | 'hint' | 'answer'  (answers go into the wishlist)
   */
  const SCRIPT = [
    {
      key: 'name',
      store: 'name',
      label: 'Name',
      ask: [
        'Ho ho ho! Welcome to the workshop.',
        "First things first — what name shall I put on your label?",
      ],
      placeholder: 'Your name',
      validate(value) {
        const name = value.trim().replace(/\s+/g, ' ');
        if (name.length < 2) return 'That is a little short for a label!';
        if (name.length > 40) return 'That is a lot of label. Shorter, please!';
        return null;
      },
      ack: ['Lovely to meet you, {name}.', 'Noted, {name}. The elves have your file open.'],
      mood: 'delighted',
    },
    {
      key: 'hobbies',
      store: 'answer',
      label: 'What they do outside work',
      selfLabel: 'What you do outside work',
      ask: ['So then, {name}. What do you get up to when you are not at work?'],
      placeholder: 'Walking the dog, baking, five-a-side...',
      ack: ['Wonderful. Writing that down.', 'The elves are scribbling furiously.'],
    },
    {
      key: 'obsession',
      store: 'answer',
      label: 'Currently obsessed with',
      selfLabel: 'What you are currently obsessed with',
      ask: ['Is there anything you are a bit obsessed with at the moment?', 'A game, a show, a team, a craft — anything at all.'],
      placeholder: 'A show, a game, a hobby...',
      ack: ['Marvellous.', 'Ah, a person of taste.'],
      mood: 'delighted',
    },
    {
      key: 'treat',
      store: 'answer',
      label: 'A treat they would never turn down',
      selfLabel: 'A treat you would never turn down',
      ask: ['Now then. What is a treat you would never turn down?'],
      chips: ['Chocolate', 'Coffee', 'A good book', 'Something fizzy'],
      placeholder: 'Go on, be specific',
      ack: ['An excellent answer.', 'A classic. Noted.'],
    },
    {
      key: 'sweetsavoury',
      store: 'answer',
      label: 'Sweet or savoury',
      selfLabel: 'Sweet or savoury',
      ask: ['Settle an argument in the workshop for me. Sweet or savoury?'],
      chips: ['Sweet', 'Savoury', 'Both, obviously'],
      placeholder: 'Sweet or savoury?',
      ack: ['The elves will be delighted.', 'Noted, and the argument continues.'],
    },
    {
      key: 'avoid',
      store: 'answer',
      label: 'Steer clear of',
      selfLabel: 'Things to steer clear of',
      optional: true,
      label_empty: 'Nothing to avoid',
      ask: [
        'Anything I should steer the elves away from?',
        'Allergies, pet hates, or anything you already own three of.',
      ],
      placeholder: 'Allergies, dislikes, duplicates...',
      ack: ['Good to know. Crossed off.', 'Understood. No such thing in your sack.'],
      mood: 'alarmed',
    },
    {
      key: 'hint',
      store: 'hint',
      label: 'Their hint',
      optional: true,
      ask: [
        'Last one, and it is the useful one.',
        'Is there anything specific you would love? This is the hint your Secret Santa sees.',
      ],
      placeholder: 'A hint for whoever draws you (optional)',
      ack: ['Perfect. That is a proper hint.', 'Splendid. They will be glad of that.'],
      mood: 'delighted',
    },
  ];

  const CLOSING = [
    'That is everything, {name}!',
    'Your name is in the sack with the others. On {when} I will tell you who you are buying for.',
  ];

  const SKIPPED = ['Not to worry.', 'Fair enough, we shall leave that one blank.'];

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function fill(text, vars) { return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''); }

  /** Roughly how long Santa would take to say a line, bounded so it never drags. */
  function readingTime(text) {
    return Math.min(1700, Math.max(550, text.length * 28));
  }

  class SantaChat {
    /**
     * @param {object} opts
     *   log, input, sendButton, skipButton, continueButton, chips, progress  DOM elements
     *   santa      a Santa instance to animate while talking
     *   onFinish   called with { name, hint, answers: [{key, q, a}] }
     */
    constructor(opts) {
      this.el = opts;
      this.santa = opts.santa;
      this.onFinish = opts.onFinish || (() => {});
      this.when = opts.when || 'the big day';   // the reveal date, as Santa says it
      this.step = 0;
      this.result = { name: '', hint: '', answers: [] };
      this._busy = false;

      this.el.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.submit();
        }
      });
      this.el.sendButton.addEventListener('click', () => this.submit());
      this.el.skipButton.addEventListener('click', () => this.skip());
    }

    get current() { return SCRIPT[this.step]; }

    async start() {
      await this.ask();
    }

    // --- rendering --------------------------------------------------------

    bubble(side, text) {
      const node = document.createElement('div');
      node.className = `bubble ${side}`;
      node.textContent = text;
      this.el.log.appendChild(node);
      this._scroll();
      return node;
    }

    typing() {
      const node = document.createElement('div');
      node.className = 'bubble santa typing';
      node.innerHTML = '<u></u><u></u><u></u>';
      node.setAttribute('aria-label', 'Santa is typing');
      this.el.log.appendChild(node);
      this._scroll();
      return node;
    }

    _scroll() {
      // Next frame, so the new bubble has been laid out.
      window.requestAnimationFrame(() => {
        this.el.log.scrollTop = this.el.log.scrollHeight;
      });
    }

    wait(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

    /** Shows the typing dots, then replaces them with the line. */
    async say(text) {
      const line = fill(text, { ...this.result, when: this.when });
      const dots = this.typing();
      const thinking = Math.min(900, 260 + line.length * 12);
      // Santa's mouth goes the whole time, from the typing dots to the end of the line.
      if (this.santa) this.santa.talk(thinking + readingTime(line));
      await this.wait(thinking);
      dots.remove();
      this.bubble('santa', line);
      await this.wait(readingTime(line) * 0.55);
    }

    // --- flow -------------------------------------------------------------

    async ask() {
      const step = this.current;
      if (!step) return this.finish();

      this._lock(true);
      for (const line of step.ask) await this.say(line);

      this.el.chips.replaceChildren();
      for (const chip of step.chips || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = chip;
        button.addEventListener('click', () => {
          this.el.input.value = chip;
          this.submit();
        });
        this.el.chips.appendChild(button);
      }

      this.el.input.placeholder = step.placeholder || 'Type your answer';
      this.el.skipButton.hidden = !step.optional;
      this._lock(false);
      this._progress();
      this.el.input.focus();
    }

    _lock(busy) {
      this._busy = busy;
      this.el.input.disabled = busy;
      this.el.sendButton.disabled = busy;
      this.el.skipButton.disabled = busy;
    }

    _progress() {
      const pct = Math.round((this.step / SCRIPT.length) * 100);
      this.el.progress.style.width = `${pct}%`;
      this.el.progress.parentElement.setAttribute('aria-valuenow', String(pct));
    }

    async submit() {
      if (this._busy) return;
      const step = this.current;
      if (!step) return;
      const value = this.el.input.value.trim();

      if (!value) {
        if (step.optional) return this.skip();
        this.el.input.focus();
        return;
      }
      if (step.validate) {
        const problem = step.validate(value);
        if (problem) {
          this._lock(true);
          await this.say(problem);
          this._lock(false);
          this.el.input.focus();
          return;
        }
      }

      this.el.input.value = '';
      this.el.chips.replaceChildren();
      this.bubble('me', value);
      this._record(step, value);

      this._lock(true);
      if (this.santa && step.mood === 'delighted') this.santa.delight();
      else if (this.santa && step.mood) this.santa.mood = step.mood;
      await this.say(pick(step.ack));
      if (this.santa) this.santa.mood = 'happy';

      this.step++;
      await this.ask();
    }

    async skip() {
      if (this._busy) return;
      const step = this.current;
      if (!step || !step.optional) return;
      this.el.input.value = '';
      this.el.chips.replaceChildren();
      this.bubble('me', 'Skip');
      this._record(step, '');
      this._lock(true);
      await this.say(pick(SKIPPED));
      this.step++;
      await this.ask();
    }

    _record(step, value) {
      if (step.store === 'name') this.result.name = value.replace(/\s+/g, ' ');
      else if (step.store === 'hint') this.result.hint = value;
      else {
        const existing = this.result.answers.find((a) => a.key === step.key);
        const entry = { key: step.key, q: step.label, a: value };
        if (existing) Object.assign(existing, entry);
        else this.result.answers.push(entry);
      }
    }

    /**
     * Santa signs off, then waits: the person reads at their own pace and
     * presses Continue when they are ready to be put in the hat.
     */
    async finish() {
      this._lock(true);
      this.el.skipButton.hidden = true;
      this.el.chips.replaceChildren();
      this.el.input.hidden = true;
      this.el.sendButton.hidden = true;
      for (const line of CLOSING) await this.say(line);
      if (this.santa) this.santa.delight(2400);
      this.el.progress.style.width = '100%';

      const result = {
        name: this.result.name,
        hint: this.result.hint,
        answers: this.result.answers.filter((a) => a.a.trim()),
      };
      if (this.el.continueButton) {
        this.el.continueButton.hidden = false;
        this.el.continueButton.focus();
        this.el.continueButton.addEventListener('click', () => {
          this.el.continueButton.disabled = true;
          this.onFinish(result);
        }, { once: true });
      } else {
        this.onFinish(result);
      }
    }
  }

  window.SantaChat = SantaChat;
  window.SANTA_SCRIPT = SCRIPT;
})();
