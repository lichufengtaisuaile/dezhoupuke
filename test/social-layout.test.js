import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/social.js', import.meta.url), 'utf8'), scope);
const place = scope.window.findReactionPlacement;
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

function assertClear(input) {
  const position = place(input);
  assert.ok(position, 'a nearby visible location should exist');
  assert.ok(position.x >= 4 && position.y >= 4);
  assert.ok(position.x + input.width <= input.bounds.width - 4);
  assert.ok(position.y + input.height <= input.bounds.height - 4);
  for (const box of input.obstacles) {
    assert.ok(position.x + input.width <= box.left - 4 || position.x >= box.right + 4 || position.y + input.height <= box.top - 4 || position.y >= box.bottom + 4, 'reaction must not cover cards, player details, chips or another reaction');
  }
  return position;
}

test('own reaction sits beside the avatar rather than over desktop hole cards', () => {
  const input = {
    anchor: rect(520, 550, 44, 44), width: 44, height: 44, bounds: { width: 1280, height: 644 },
    obstacles: [rect(520, 544, 126, 56), rect(657, 536, 98, 68), rect(619, 508, 52, 28)],
  };
  const result = assertClear(input);
  assert.ok(result.x + input.width < input.anchor.left);
});

test('narrow phone reactions avoid adjacent seats, own cards and the action boundary', () => {
  const input = {
    anchor: rect(49, 257, 34, 34), width: 44, height: 44, bounds: { width: 320, height: 312 },
    obstacles: [rect(49, 254, 112, 46), rect(173, 247, 83, 58), rect(6, 208, 86, 46), rect(228, 208, 86, 46), rect(130, 222, 48, 24), rect(73, 100, 174, 79)],
  };
  assertClear(input);
});

test('phrases use their measured width and avoid cards above an upper phone seat', () => {
  const input = {
    anchor: rect(8, 143, 38, 38), width: 104, height: 40, bounds: { width: 390, height: 588 },
    obstacles: [rect(8, 138, 96, 50), rect(28, 109, 54, 31), rect(45, 205, 300, 130), rect(140, 67, 110, 50)],
  };
  assertClear(input);
});

test('short landscape table keeps reactions within the table and clear of both nearby players', () => {
  const input = {
    anchor: rect(60, 182, 31, 31), width: 44, height: 44, bounds: { width: 328, height: 248 },
    obstacles: [rect(60, 178, 103, 46), rect(172, 171, 79, 55), rect(9, 135, 88, 40), rect(230, 135, 88, 40), rect(86, 77, 157, 52)],
  };
  assertClear(input);
});

test('concurrent reactions occupy separate spaces and crowded layouts keep the feed available', () => {
  const input = {
    anchor: rect(150, 160, 44, 44), width: 44, height: 44, bounds: { width: 400, height: 300 },
    obstacles: [rect(150, 154, 126, 56), rect(281, 146, 88, 64)],
  };
  const first = assertClear(input);
  assertClear({ ...input, obstacles: [...input.obstacles, rect(first.x, first.y, 44, 44)] });
  assert.equal(place({ ...input, obstacles: [rect(0, 0, 400, 300)] }), null);
});

test('crowded emoji falls back to its avatar and resumes full size after seat rerender', () => {
  function element(box = rect(0, 0, 0, 0)) {
    const node = {
      box, children: [], style: { removeProperty(name) { delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; } },
      className: '', dataset: {}, hidden: false,
      addEventListener() {}, setAttribute() {}, hasAttribute: () => false,
      append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect() { return { ...this.box, width: this.box.right - this.box.left, height: this.box.bottom - this.box.top }; },
      get offsetWidth() { return parseFloat(this.style.width) || (this.className.includes('reaction-emoji') ? 44 : 104); },
      get offsetHeight() { return parseFloat(this.style.height) || (this.className.includes('reaction-emoji') ? 44 : 40); },
    };
    node.classList = { contains: name => node.className.split(' ').includes(name), remove() {} };
    return node;
  }
  const avatar = element(rect(60, 250, 34, 34));
  const body = element(rect(60, 245, 112, 46));
  const blocking = element(rect(0, 0, 320, 312));
  const seat = element();
  seat.dataset.playerId = 'alice';
  seat.querySelector = selector => selector === '.seat-avatar' ? avatar : body;
  const stage = element(rect(0, 0, 320, 312));
  stage.clientWidth = 320;
  stage.clientHeight = 312;
  let crowded = true;
  stage.querySelectorAll = selector => selector === '[data-player-id]' ? [seat] : crowded ? [blocking] : [body, avatar];
  const picker = element(), options = element(), feed = element();
  picker.hidden = true;
  const root = element();
  root.querySelector = selector => ({ '.social-picker': picker, '.social-options': options, '.social-feed': feed })[selector];
  const context = {
    window: { HOLDEM_REACTIONS: [{ id: 'smile', kind: 'emoji', symbol: ':)' }, { id: 'luck', kind: 'phrase', label: 'Good luck' }], addEventListener() {} },
    document: { hidden: false, createElement: () => element(), addEventListener() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: () => 1, clearTimeout() {},
  };
  vm.runInNewContext(readFileSync(new URL('../public/social.js', import.meta.url), 'utf8'), context);
  const social = context.window.createSocial({ root, stage });
  const state = { code: 'ROOM', selfId: 'alice', players: [{ id: 'alice', name: 'Alice', connected: true }] };
  social.update(state, true);
  social.receive({ code: 'ROOM', id: 'reaction1', fromId: 'alice', reactionId: 'smile' });
  const bubble = stage.children[0].children[0];
  assert.equal(bubble.style.visibility, 'visible');
  assert.equal(bubble.style.left, '60px');
  assert.equal(bubble.style.top, '250px');
  assert.equal(bubble.offsetWidth, 34);
  assert.equal(bubble.style.background, '#192c2b');
  social.update({ ...state }, true);
  assert.equal(bubble.offsetWidth, 34);
  assert.equal(bubble.style.left, '60px');
  crowded = false;
  avatar.box = rect(120, 220, 34, 34);
  body.box = rect(120, 215, 112, 46);
  social.update({ ...state }, true);
  assert.equal(bubble.offsetWidth, 44);
  assert.equal(bubble.offsetHeight, 44);
  assert.equal(bubble.style.background, undefined);
  assert.equal(bubble.style.borderRadius, undefined);
  assert.equal(bubble.style.fontSize, undefined);
  assert.equal(bubble.style.lineHeight, undefined);
  assert.equal(bubble.style.visibility, 'visible');
  assert.ok(parseFloat(bubble.style.left) + 44 < avatar.box.left);
  social.update({ ...state }, true);
  assert.equal(bubble.offsetWidth, 44);
});
