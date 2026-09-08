import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/table-layout.js', import.meta.url), 'utf8');

function harness() {
  const elements = new Map();
  const doc = { activeElement: null, listeners: new Map(), getElementById: id => elements.get(id) };
  function events(target) {
    target.addEventListener = (name, listener) => {
      const list = target.listeners.get(name) || [];
      list.push(listener);
      target.listeners.set(name, list);
    };
    target.fire = (name, event = {}) => {
      const value = { target, preventDefault() { this.prevented = true; }, ...event };
      for (const listener of target.listeners.get(name) || []) listener(value);
      return value;
    };
  }
  events(doc);
  class Element {
    constructor(id, parent = null, control = true) {
      this.id = id;
      this.parent = parent;
      this.control = control;
      this.ownerDocument = doc;
      this.hidden = false;
      this.disabled = false;
      this.isConnected = true;
      this.cssHidden = false;
      this.listeners = new Map();
      this.attributes = new Map();
      this.classes = new Set();
      this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)) };
      events(this);
      elements.set(id, this);
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    contains(node) { return node === this || Boolean(node?.parent && this.contains(node.parent)); }
    closest() { return this.hidden ? this : this.parent?.closest() || null; }
    getClientRects() { return this.cssHidden ? [] : [{}]; }
    querySelectorAll() { return [...elements.values()].filter(node => node !== this && this.contains(node) && node.control && !node.disabled); }
    focus() { doc.activeElement = this; doc.fire('focusin', { target: this }); }
    blur() { doc.activeElement = doc.body; }
    click() { this.focus(); this.fire('click'); }
  }
  const root = new Element('game-view', null, false);
  doc.body = new Element('body', null, false);
  doc.activeElement = doc.body;
  for (const name of ['room', 'result', 'raise']) {
    new Element(`${name}-toggle`, root);
    const panel = new Element(name === 'raise' ? 'raise-editor' : `${name}-drawer`, root, false);
    new Element(`${name}-backdrop`, root, false);
    new Element(`close-${name}`, panel);
    new Element(`${name}-action`, panel);
  }
  const scope = { listeners: new Map() };
  events(scope);
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(script, scope);
  const layout = scope.createTableLayout({ root });
  const state = {
    code: 'TABLE1', phase: 'playing', selfId: 'alice', handNumber: 1, turnId: 1, turnSeat: 0,
    players: [{ id: 'alice', seat: 0 }], legal: { actions: ['fold', 'call', 'raise'] }, result: [],
  };
  layout.update(state);
  return { layout, state, doc, window: scope, get: id => elements.get(id) };
}

test('room drawer traps keyboard focus and restores its trigger after Escape', () => {
  const { get, doc } = harness();
  get('room-toggle').click();
  assert.equal(get('room-drawer').hidden, false);
  assert.equal(doc.activeElement, get('close-room'));
  const backward = doc.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(backward.prevented, true);
  assert.equal(doc.activeElement, get('room-action'));
  doc.fire('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(doc.activeElement, get('close-room'));
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(get('room-drawer').hidden, true);
  assert.equal(doc.activeElement, get('room-toggle'));
  assert.equal(doc.body.classes.has('table-overlay-open'), false);
});

test('raise editor preserves an in-progress wager through broadcasts and closes on a new turn', () => {
  const { layout, state, get } = harness();
  get('raise-toggle').click();
  assert.equal(get('raise-editor').hidden, false);
  layout.update({ ...state, players: [...state.players] });
  assert.equal(get('raise-editor').hidden, false);
  layout.update({ ...state, turnId: 2 });
  assert.equal(get('raise-editor').hidden, true);
  layout.update({ ...state, legal: { actions: ['fold', 'call'] } });
  get('raise-toggle').click();
  assert.equal(get('raise-editor').hidden, true);
  layout.update(state);
  get('raise-toggle').disabled = true;
  get('raise-toggle').fire('click');
  assert.equal(get('raise-editor').hidden, true);
});

test('result details open on request, replace the room drawer, and close on the next hand', () => {
  const { layout, state, get } = harness();
  const finished = { ...state, phase: 'finished', result: [{ id: 'alice' }] };
  layout.update(finished);
  assert.equal(get('result-drawer').hidden, true);
  get('room-toggle').click();
  get('result-toggle').fire('click');
  assert.equal(get('room-drawer').hidden, true);
  assert.equal(get('result-drawer').hidden, false);
  layout.update({ ...finished });
  assert.equal(get('result-drawer').hidden, false);
  layout.update({ ...state, handNumber: 2 });
  assert.equal(get('result-drawer').hidden, true);
});

test('outside clicks, resize and leaving do not leave focus in a hidden editor', () => {
  const { layout, doc, window, get } = harness();
  get('raise-toggle').click();
  doc.fire('pointerdown', { target: get('game-view') });
  assert.equal(get('raise-editor').hidden, true);
  assert.equal(doc.activeElement, get('raise-toggle'));
  get('raise-toggle').click();
  get('raise-editor').cssHidden = true;
  window.fire('resize');
  assert.equal(get('raise-editor').hidden, true);
  assert.equal(doc.activeElement, get('raise-toggle'));
  get('room-toggle').click();
  layout.reset();
  assert.equal(get('room-drawer').hidden, true);
  assert.equal(get('room-backdrop').hidden, true);
  assert.equal(doc.body.classes.size, 0);
  get('room-toggle').click();
  assert.equal(get('room-drawer').hidden, true);
});
