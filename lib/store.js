'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'pool.json');

function emptyState() {
  return {
    version: 1,
    participants: [],   // { id, token, code, name, hint, answers: [{q, a}], joinedAt, updatedAt }
    assignments: null,  // { giverId: receiverId }
    drawnAt: null,
    seenBy: {},         // participantId -> ISO timestamp they first opened their match
  };
}

class Store {
  constructor(file = process.env.DATA_FILE || DEFAULT_FILE) {
    this.file = file;
    this.state = emptyState();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.state = Object.assign(emptyState(), JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.save();
    }
    return this.state;
  }

  /** Write via a temp file + rename so a crash mid-write cannot corrupt the pool. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // --- participants -------------------------------------------------------

  findByName(name) {
    const key = String(name).trim().toLowerCase();
    return this.state.participants.find((p) => p.name.toLowerCase() === key) || null;
  }

  findById(id) {
    return this.state.participants.find((p) => p.id === id) || null;
  }

  authenticate(id, token) {
    const person = this.findById(id);
    if (!person || !token) return null;
    const a = Buffer.from(String(person.token));
    const b = Buffer.from(String(token));
    if (a.length !== b.length) return null;
    return crypto.timingSafeEqual(a, b) ? person : null;
  }

  addParticipant({ name, hint, answers }) {
    const now = new Date().toISOString();
    const person = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      code: this.newCode(),
      name: String(name).trim(),
      hint: String(hint || '').trim(),
      answers: Array.isArray(answers) ? answers : [],
      joinedAt: now,
      updatedAt: now,
    };
    this.state.participants.push(person);
    this.save();
    return person;
  }

  updateParticipant(id, { name, hint, answers }) {
    const person = this.findById(id);
    if (!person) return null;
    if (name !== undefined) person.name = String(name).trim();
    if (hint !== undefined) person.hint = String(hint).trim();
    if (Array.isArray(answers)) person.answers = answers;
    person.updatedAt = new Date().toISOString();
    this.save();
    return person;
  }

  /**
   * A short code the person can use to pick their profile back up on another
   * device or after clearing their browser. Ambiguous characters (I, O, 0, 1)
   * are left out so it survives being read off a screen or a sticky note.
   */
  newCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 50; attempt++) {
      const bytes = crypto.randomBytes(6);
      const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
      if (!this.findByCode(code)) return code;
    }
    throw new Error('could not allocate a free elf code');
  }

  findByCode(code) {
    const key = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!key) return null;
    return this.state.participants.find((p) => p.code === key) || null;
  }

  /**
   * Signs someone back in from their name plus elf code. Both must match the
   * same person, so knowing a colleague's name alone is not enough to open
   * their profile or their match.
   */
  signIn(name, code) {
    const person = this.findByCode(code);
    if (!person) return null;
    const given = String(name || '').trim().toLowerCase();
    if (given && person.name.toLowerCase() !== given) return null;
    return person;
  }

  removeParticipant(id) {
    const before = this.state.participants.length;
    this.state.participants = this.state.participants.filter((p) => p.id !== id);
    if (this.state.participants.length === before) return false;
    this.save();
    return true;
  }

  // --- the draw -----------------------------------------------------------

  get isDrawn() {
    return Boolean(this.state.assignments);
  }

  setAssignments(assignments) {
    this.state.assignments = assignments;
    this.state.drawnAt = new Date().toISOString();
    this.save();
  }

  clearAssignments() {
    this.state.assignments = null;
    this.state.drawnAt = null;
    this.state.seenBy = {};
    this.save();
  }

  markSeen(id) {
    if (!this.state.seenBy[id]) {
      this.state.seenBy[id] = new Date().toISOString();
      this.save();
    }
  }
}

module.exports = { Store, emptyState };
