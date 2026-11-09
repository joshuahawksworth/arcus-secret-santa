# Arcus Secret Santa

An internal Secret Santa for the team. One snowy village, no scrolling, and a
Santa who asks you what you're into before putting your name in the hat.

On the 1st of December the hat closes, the names are drawn, and everyone comes
back to find out who they're buying for.

## Running it

No dependencies, no build step. Node 18 or newer:

```bash
npm start
```

Then open <http://localhost:3000>.

To run it for the team, put it on any box they can reach and leave it running
(`pm2`, `systemd`, a container — whatever you already use). The pool lives in a
single JSON file, so **back up `data/pool.json`** if you care about it.

### Settings

All optional, all environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `REVEAL_DATE` | 1 December of the current year | `YYYY-MM-DD`, midnight server time |
| `DATA_FILE` | `data/pool.json` | Where the pool is stored |
| `ADMIN_TOKEN` | *(unset)* | Enables the admin endpoints below. Leave unset and they stay off. |

```bash
PORT=8080 REVEAL_DATE=2026-12-01 ADMIN_TOKEN=some-long-secret npm start
```

## How it works

### Joining

"Join the pool" opens a chat with Santa. He asks for a name, then works through
a short list of questions about hobbies, interests and what they'd never turn
down, finishing with an optional hint. The answers are stored with the person
and are what their Secret Santa sees on reveal day.

The questions live in one array at the top of `public/js/chat.js` — add,
reword or remove them there and everything else follows, including the edit
form on the "My answers" screen.

### Remembering people

Joining returns an **elf code**: six characters, shown on the "You're in"
screen and again under "My answers".

* The browser remembers whoever joined on it, so coming back is automatic.
* On another device, or after clearing the browser, "I've been here before"
  takes a name and elf code and picks the profile back up.
* Answers and the hint can be changed at any time, before or after the draw.
  Whoever drew that person always sees the latest version.

Behind the scenes each person has a random token that the browser stores. The
reveal endpoint needs the id *and* the token, so knowing a colleague's name
isn't enough to see their match. This is a bit of fun on an internal network,
not a vault.

### The draw

The first request on or after the reveal date closes the hat and draws the
names. Nobody has to press anything.

`lib/draw.js` uses **Sattolo's algorithm**, which produces a uniformly random
*cyclic* permutation. That gives three things for free:

1. Everyone gives exactly one gift.
2. Everyone receives exactly one gift — it's a bijection, so no name can come
   up twice.
3. Nobody draws themselves — a cyclic permutation has no fixed points.

The result is one gifting circle: A → B → C → … → A. The draw is then re-checked
against those rules by `validateAssignments` before anything is written to disk,
so a bad draw can't be saved.

`test/draw.test.js` runs thousands of draws at various sizes and asserts all of
the above:

```bash
npm test
```

**On odd numbers:** the app shows whether the headcount is even or odd, because
you asked for it, but it doesn't block an odd pool. A one-to-one matching with
no self-draws exists for *any* number of people from 2 upwards — an even count
is only needed if you want everyone paired off *mutually* (A buys for B and B
buys for A), which this isn't.

### Admin

Only if `ADMIN_TOKEN` is set. Useful if you want to draw early or start over.

```bash
curl -s localhost:3000/api/admin/overview -H "x-admin-token: $ADMIN_TOKEN"
```

```bash
curl -s -X POST localhost:3000/api/admin/draw -H "x-admin-token: $ADMIN_TOKEN"
```

```bash
curl -s -X POST localhost:3000/api/admin/reset -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"emptyPool":false}'
```

`reset` clears the draw and lets people join again. Pass `{"emptyPool": true}`
to also delete everyone.

## Layout

```
server.js            zero-dependency HTTP server and JSON API
lib/draw.js          Sattolo's algorithm + validation
lib/store.js         the JSON file, read and written atomically
test/draw.test.js    the draw's guarantees, under node --test
public/
  index.html         the one page
  css/village.css    the village scene
  css/app.css        shell, transitions, Santa, UI
  css/fonts.css      Lobster, Google Sans, Roboto
  js/weather.js      falling snow and drifting clouds
  js/beard.js        Santa's beard, as a cloth simulation
  js/santa.js        Santa: blinking, breathing, talking
  js/chat.js         the questions, and the conversation engine
  js/app.js          screens, transitions, and the API client
  img/ fonts/        artwork and fonts
```

### The API

| | |
| --- | --- |
| `GET /api/state` | headcount, reveal date, whether the names are drawn |
| `POST /api/join` | `{name, hint, answers}` → the new person, with token and elf code |
| `POST /api/signin` | `{name, code}` → that person, with their token |
| `GET /api/me` | `?id=&token=` → the saved profile |
| `POST /api/me` | `{id, token, name?, hint?, answers?}` → the updated profile |
| `POST /api/leave` | `{id, token}` — only while the hat is open |
| `GET /api/match` | `?id=&token=` → who they're buying for. `423` before the reveal date. |

## Where the look comes from

Everything visual is taken from [Google Santa Tracker][st], which is open
source under Apache 2.0. Nothing here is generated artwork.

* **The village** — the `modvil-village` scene. The four parallax layers, the
  skiing elves, the bike pack, the elf in the deckchair, the glitching elf, the
  peekaboo tree, the fountain and the snowman are the site's own SVGs, with its
  own positions and keyframes. The scene is laid out at its native 1920×1050
  and scaled to cover the window.
* **The snow and clouds** — a port of the site's `santa-weather` element,
  including its three cloud SVGs.
* **Santa** — the `santaselfie` scene, at a fraction of the size. His beard is
  that scene's cloth simulation: the same grid, pinning, hair shape and physics,
  settled under gravity and drawn once. He breathes, blinks and moves his mouth
  as he does there.
* **The page transition** — the site's `santa-interlude`: four coloured layers
  sweep up over the screen in sequence, then carry on up and off, with the new
  screen rising in from the bottom.
* **The buttons, dialogs, cards and badges** — the site's `#play` button,
  `.uibutton`, `santa-overlay`, `santa-card`, `santa-badge` and `santa-notice`.
* **The fonts** — Lobster, Google Sans and Roboto, the same three the site
  loads, self-hosted in `public/fonts/` so the app needs no network.

Deliberately left out, as asked: Google branding, all sound, the countdown
clock, the family guide, the rest of the village modules, and Santa Selfie's
customisation tools.

Source files that were ported rather than copied carry a comment saying which
part of the site they came from.

[st]: https://santatracker.google.com/
