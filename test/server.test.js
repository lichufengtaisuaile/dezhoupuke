import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { describeHand } from '../hand-description.js';

const WAIT_MS = 5000;

async function fixture(t, options = {}) {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', requireAuth: false, dbPath: ':memory:', npcTables: 0, ...options });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.disconnect();
    await server.close();
  });

  async function connect() {
    const socket = io(`http://127.0.0.1:${server.port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
    });
    const client = { socket, state: null, states: [], identity: null, lobby: null, lobbies: [], reactions: [] };
    socket.on('room:state', (state) => {
      client.state = state;
      client.states.push(state);
    });
    socket.on('lobby:state', (state) => {
      client.lobby = state;
      client.lobbies.push(state);
    });
    socket.on('room:reaction', reaction => client.reactions.push(reaction));
    clients.push(client);
    const connected = once(socket, 'connect', { signal: AbortSignal.timeout(WAIT_MS) });
    socket.connect();
    await connected;
    return client;
  }

  async function room(count = 2, settings = {}) {
    const host = await connect();
    host.identity = await success(host, 'room:create', {
      name: 'Host', smallBlind: 10, bigBlind: 20, buyIn: 2000, ...settings,
    });
    const seated = [host];
    for (let i = 1; i < count; i++) {
      const client = await connect();
      client.identity = await success(client, 'room:join', {
        code: host.identity.code, name: `Player ${i + 1}`,
      });
      seated.push(client);
    }
    await stateWhere(host, (state) => state.players.length === count);
    return seated;
  }

  return { server, clients, connect, room };
}

function request(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.socket.timeout(WAIT_MS).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function success(client, event, payload = {}) {
  const response = await request(client, event, payload);
  assert.equal(response?.ok, true, `${event}: ${JSON.stringify(response)}`);
  return response;
}

async function rejected(client, event, payload = {}) {
  const response = await request(client, event, payload);
  assert.equal(response?.ok, false, `${event} must reject ${JSON.stringify(payload)}`);
  assert.equal(typeof response.error, 'string');
  assert.ok(response.error.length > 0);
  return response;
}

function stateWhere(client, predicate, timeout = WAIT_MS) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off('room:state', listener);
      reject(new Error(`Timed out waiting for room state: ${JSON.stringify(client.state)}`));
    }, timeout);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      client.socket.off('room:state', listener);
      resolve(state);
    }
    client.socket.on('room:state', listener);
  });
}

function self(client) {
  return client.state.players.find((player) => player.id === client.identity.playerId);
}

function lobbyWhere(client, predicate, timeout = WAIT_MS) {
  if (client.lobby && predicate(client.lobby.rooms)) return Promise.resolve(client.lobby.rooms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off('lobby:state', listener);
      reject(new Error(`Timed out waiting for lobby: ${JSON.stringify(client.lobby)}`));
    }, timeout);
    function listener(state) {
      if (!predicate(state.rooms)) return;
      clearTimeout(timer);
      client.socket.off('lobby:state', listener);
      resolve(state.rooms);
    }
    client.socket.on('lobby:state', listener);
  });
}

function movePayload(state, action, amount) {
  return {
    action,
    ...(amount === undefined ? {} : { amount }),
    handNumber: state.handNumber,
    turnId: state.turnId,
  };
}

async function nextTurn(clients, observer = clients[0]) {
  const current = observer.state;
  assert.equal(current.phase, 'playing');
  const actor = clients.find((client) => self(client)?.seat === current.turnSeat);
  assert.ok(actor, `No client at acting seat ${current.turnSeat}`);
  await stateWhere(actor, (state) => state.turnId === current.turnId && state.legal !== null);
  return actor;
}

async function passiveHand(clients, { bots = false } = {}) {
  const observer = clients[0];
  const rounds = new Set();
  for (let moves = 0; moves < 100; moves++) {
    const state = observer.state;
    rounds.add(state.round);
    if (state.phase === 'finished') return { state, rounds };
    assert.equal(state.phase, 'playing');
    const actor = clients.find((client) => self(client)?.seat === state.turnSeat);
    if (!actor) {
      assert.ok(bots, 'Only a bot may act without an attached test client');
      await stateWhere(observer, (next) => next.turnId !== state.turnId || next.phase === 'finished');
      continue;
    }
    await stateWhere(actor, (next) => next.turnId === state.turnId && next.legal !== null);
    const legal = actor.state.legal.actions;
    const action = legal.includes('check') ? 'check' : legal.includes('call') ? 'call' : 'all-in';
    assert.ok(legal.includes(action) || (action === 'all-in' && actor.state.legal.canAllIn));
    await success(actor, 'game:action', movePayload(actor.state, action));
    await stateWhere(observer, (next) => next.turnId !== state.turnId || next.phase === 'finished');
  }
  assert.fail('Hand did not finish within 100 turns');
}

async function foldHeadsUp(clients) {
  const actor = await nextTurn(clients);
  await success(actor, 'game:action', movePayload(actor.state, 'fold'));
  return stateWhere(clients[0], (state) => state.phase === 'finished');
}

test('rooms seat two through six people and enforce capacity and host permissions', async (t) => {
  const context = await fixture(t);
  const players = await context.room(6);
  const [host, guest] = players;
  assert.equal(host.state.maxPlayers, 6);
  assert.equal(host.state.hostId, host.identity.playerId);
  assert.equal(new Set(host.state.players.map((player) => player.seat)).size, 6);
  assert.equal(new Set(players.map((player) => player.identity.token)).size, 6);
  for (const player of players) assert.equal(player.state.selfId, player.identity.playerId);

  const excess = await context.connect();
  await rejected(excess, 'room:join', { code: host.identity.code, name: 'Seventh' });
  await rejected(guest, 'room:start');
  await rejected(guest, 'room:bot');
  await rejected(host, 'room:bot');
  await success(host, 'room:start');
  await stateWhere(guest, (state) => state.phase === 'playing');
  assert.equal(host.state.players.filter((player) => player.inHand).length, 6);
});

test('each connection sees only its own hole cards and no resume credentials', async (t) => {
  const context = await fixture(t);
  const players = await context.room(3);
  await success(players[0], 'room:start');
  const dealt = [];
  for (const client of players) {
    await stateWhere(client, (state) => state.phase === 'playing');
    assert.equal(self(client).cards.length, 2);
    assert.deepEqual(client.state.selfHand, describeHand(self(client).cards));
    assert.equal(client.state.selfHand.complete, false);
    assert.equal(client.state.canShowCards, false);
    dealt.push(...self(client).cards.map((card) => `${card.rank}:${card.suit}`));
    for (const player of client.state.players) {
      assert.equal(player.hasCards, true);
      assert.equal(Object.hasOwn(player, 'hand'), false, 'opponent hand descriptions are never included');
      if (player.id !== client.identity.playerId) assert.equal(player.cards, null);
    }
    const wireStates = JSON.stringify(client.states);
    for (const player of players) assert.equal(wireStates.includes(player.identity.token), false);
    assert.equal(/"(?:token|socketId|resumeToken)"/.test(wireStates), false);
  }
  assert.equal(new Set(dealt).size, 6);
});

test('out-of-turn, stale and invalid numeric wagers cannot change the hand', async (t) => {
  const context = await fixture(t);
  const players = await context.room(3);
  await success(players[0], 'room:start');
  const actor = await nextTurn(players);
  const other = players.find((player) => player !== actor);
  const before = actor.state;
  await rejected(other, 'game:action', movePayload(before, 'fold'));
  await rejected(actor, 'game:action', { ...movePayload(before, 'call'), handNumber: before.handNumber - 1 });
  await rejected(actor, 'game:action', { ...movePayload(before, 'call'), turnId: 'stale-turn' });
  const wagerAction = before.legal.actions.includes('raise') ? 'raise' : 'bet';
  for (const amount of [-1, 1.5, '200', null, Number.POSITIVE_INFINITY]) {
    await rejected(actor, 'game:action', movePayload(before, wagerAction, amount));
  }
  assert.equal(actor.state.turnId, before.turnId);
  assert.equal(actor.state.pot, before.pot);
  assert.deepEqual(actor.state.players.map(({ stack, bet }) => ({ stack, bet })),
    before.players.map(({ stack, bet }) => ({ stack, bet })));

  const action = before.legal.actions.includes('call') ? 'call' : 'check';
  await success(actor, 'game:action', movePayload(before, action));
  await stateWhere(players[0], (state) => state.turnId !== before.turnId);
  const next = await nextTurn(players);
  await rejected(next, 'game:action', movePayload(before, 'fold'));
});

test('call/check play deals every street, settles winners and conserves chips', async (t) => {
  const context = await fixture(t);
  const players = await context.room(3);
  await success(players[0], 'room:start');
  const { state, rounds } = await passiveHand(players);
  assert.equal(state.board.length, 5);
  assert.ok(rounds.size >= 4, `Expected four streets, saw ${[...rounds]}`);
  assert.equal(state.players.reduce((total, player) => total + player.stack, 0), 6000);
  assert.ok(state.result.length >= 1);
  assert.equal(state.result.reduce((total, winner) => total + winner.amount, 0), 60);
  const cards = [...state.board, ...state.players.flatMap((player) => player.cards || [])];
  assert.equal(cards.length, 11);
  assert.equal(new Set(cards.map((card) => `${card.rank}:${card.suit}`)).size, 11);

  const dealer = state.dealerSeat;
  await success(players[0], 'room:start');
  assert.equal(players[0].state.handNumber, state.handNumber + 1);
  assert.notEqual(players[0].state.dealerSeat, dealer);
  assert.equal(players[0].state.board.length, 0);
});

test('all-in heads-up runs out the board and pays the complete pot', async (t) => {
  const context = await fixture(t);
  const players = await context.room(2);
  await success(players[0], 'room:start');
  const first = await nextTurn(players);
  const previous = first.state.turnId;
  assert.equal(first.state.legal.canAllIn, true);
  await success(first, 'game:action', movePayload(first.state, 'all-in'));
  await stateWhere(players[0], (state) => state.turnId !== previous);
  const second = await nextTurn(players);
  await success(second, 'game:action', movePayload(second.state, 'call'));
  const state = await stateWhere(players[0], (next) => next.phase === 'finished');
  assert.equal(state.board.length, 5);
  assert.equal(state.players.reduce((total, player) => total + player.stack, 0), 4000);
  assert.equal(state.result.reduce((total, winner) => total + winner.amount, 0), 4000);
});

test('a mid-hand arrival waits until the next deal', async (t) => {
  const context = await fixture(t);
  const players = await context.room(2);
  await success(players[0], 'room:start');
  const newcomer = await context.connect();
  newcomer.identity = await success(newcomer, 'room:join', {
    code: players[0].identity.code, name: 'Late player',
  });
  assert.equal(self(newcomer).inHand, false);
  assert.equal(self(newcomer).hasCards, false);
  assert.equal(self(newcomer).cards, null);
  assert.equal(newcomer.state.selfHand, null);
  assert.equal(newcomer.state.canShowCards, false);
  assert.equal(newcomer.state.legal, null);
  await stateWhere(players[0], (state) => state.players.length === 3);
  await passiveHand(players);
  assert.equal(self(newcomer).stack, 2000);
  await success(players[0], 'room:start');
  await stateWhere(newcomer, (state) => state.handNumber === 2);
  assert.equal(self(newcomer).inHand, true);
  assert.equal(self(newcomer).cards.length, 2);
});

test('disconnect transfers hosting and a valid token restores the same seat, stack and cards', async (t) => {
  const context = await fixture(t);
  const [host, guest] = await context.room(2);
  await success(host, 'room:start');
  const previous = structuredClone(self(host));
  const identity = host.identity;
  host.socket.disconnect();
  await stateWhere(guest, (state) => state.hostId === guest.identity.playerId
    && state.players.find((player) => player.id === identity.playerId)?.connected === false);
  const resumed = await context.connect();
  await rejected(resumed, 'room:resume', { code: identity.code, token: 'incorrect-token' });
  resumed.identity = await success(resumed, 'room:resume', { code: identity.code, token: identity.token });
  assert.equal(resumed.identity.playerId, identity.playerId);
  assert.equal(resumed.state.players.length, 2);
  assert.equal(self(resumed).seat, previous.seat);
  assert.equal(self(resumed).stack, previous.stack);
  assert.equal(self(resumed).bet, previous.bet);
  assert.deepEqual(self(resumed).cards, previous.cards);
  assert.equal(self(resumed).connected, true);
  assert.equal(resumed.state.hostId, guest.identity.playerId);
  await passiveHand([guest, resumed]);
});

test('host can add and remove practice bots, finish a hand, and deal the next', async (t) => {
  const context = await fixture(t, { botDelayMs: 5 });
  const [host] = await context.room(1);
  await rejected(host, 'room:start');
  await success(host, 'room:bot');
  const bot = host.state.players.find((player) => player.isBot);
  assert.ok(bot);
  await success(host, 'room:remove-bot', { id: bot.id });
  assert.equal(host.state.players.length, 1);
  await success(host, 'room:bot');
  await success(host, 'room:start');
  const { state } = await passiveHand([host], { bots: true });
  assert.equal(state.players.reduce((total, player) => total + player.stack, 0), 4000);
  assert.ok(state.result.length > 0);
  if (self(host).stack === 0) await success(host, 'room:rebuy');
  await success(host, 'room:start');
  assert.equal(host.state.handNumber, 2);
  assert.equal(host.state.phase, 'playing');
});

test('a replacement player does not inherit the departed player\'s cards', async (t) => {
  const context = await fixture(t);
  const players = await context.room(2);
  await success(players[0], 'room:start');
  const departing = await nextTurn(players);
  const remaining = players.find((player) => player !== departing);
  const seat = self(departing).seat;
  await success(departing, 'game:action', movePayload(departing.state, 'fold'));
  await stateWhere(remaining, (state) => state.phase === 'finished');
  await success(departing, 'room:leave');
  const replacement = await context.connect();
  replacement.identity = await success(replacement, 'room:join', {
    code: remaining.identity.code, name: 'Replacement',
  });
  assert.equal(self(replacement).seat, seat);
  assert.equal(self(replacement).inHand, false);
  assert.equal(self(replacement).hasCards, false);
  assert.equal(self(replacement).cards, null);
  assert.equal(replacement.state.selfHand, null);
  assert.equal(replacement.state.canShowCards, false);
});

test('showdown results expose each winner hole cards, best five and Chinese hand description', async (t) => {
  const context = await fixture(t);
  const players = await context.room(3);
  await success(players[0], 'room:auto-next', { enabled: false });
  await success(players[0], 'room:start');
  const folding = await nextTurn(players);
  await success(folding, 'game:action', movePayload(folding.state, 'fold'));
  await stateWhere(players[0], state => state.players.some(player => player.id === folding.identity.playerId && player.folded));
  const { state } = await passiveHand(players);
  for (const client of players) {
    await stateWhere(client, next => next.phase === 'finished');
    assert.equal(client.state.canShowCards, false);
    assert.deepEqual(client.state.result, state.result);
    assert.deepEqual(client.state.selfHand, describeHand(self(client).cards, state.board));
    for (const winner of client.state.result) {
      assert.equal(winner.reason, 'showdown');
      assert.equal(winner.revealed, true);
      assert.equal(winner.cards.length, 2);
      assert.equal(winner.hand.complete, true);
      assert.equal(winner.hand.cards.length, 5);
      assert.deepEqual(winner.hand, describeHand(winner.cards, state.board));
      assert.equal(winner.hand.name, winner.handName);
    }
    if (client !== folding) assert.equal(client.state.players.find(player => player.id === folding.identity.playerId).cards, null);
    await rejected(client, 'game:show-cards', { handNumber: state.handNumber });
  }
});

test('an all-in folds winner can voluntarily reveal without changing chips or the result', async (t) => {
  const context = await fixture(t);
  const players = await context.room(2);
  const [host] = players;
  const outsider = await context.connect();
  await rejected(outsider, 'game:show-cards', { handNumber: 1 });
  await rejected(host, 'game:show-cards', { handNumber: 0 });
  await success(host, 'room:auto-next', { enabled: false });
  await success(host, 'room:start');
  const winner = await nextTurn(players);
  const turnId = winner.state.turnId;
  await rejected(winner, 'game:show-cards', { handNumber: winner.state.handNumber });
  await success(winner, 'game:action', movePayload(winner.state, 'all-in'));
  await stateWhere(host, state => state.turnId !== turnId);
  const loser = await nextTurn(players);
  await success(loser, 'game:action', movePayload(loser.state, 'fold'));
  await stateWhere(winner, state => state.phase === 'finished');
  await stateWhere(loser, state => state.phase === 'finished');
  const handNumber = winner.state.handNumber;
  const holeCards = structuredClone(self(winner).cards);
  const moneyBefore = winner.state.players.map(({ id, stack, bet }) => ({ id, stack, bet }));
  const potBefore = winner.state.pot;
  const awardBefore = winner.state.result[0].amount;
  assert.equal(winner.state.canShowCards, true);
  assert.equal(loser.state.canShowCards, false);
  assert.equal(loser.state.players.find(player => player.id === winner.identity.playerId).cards, null);
  assert.equal(loser.state.result[0].cards, null);
  assert.equal(loser.state.result[0].hand, null);
  assert.equal(loser.state.result[0].reason, 'folds');
  assert.equal(loser.state.result[0].handName, '其余玩家弃牌');
  assert.equal(loser.state.result[0].revealed, false);
  assert.deepEqual(winner.state.result[0].cards, holeCards);
  await rejected(loser, 'game:show-cards', { handNumber, playerId: winner.identity.playerId });
  await rejected(winner, 'game:show-cards', { handNumber: handNumber - 1 });
  await rejected(winner, 'game:show-cards', { handNumber: String(handNumber) });
  await success(winner, 'game:show-cards', { handNumber });
  await stateWhere(loser, state => state.result[0]?.revealed);
  for (const client of players) {
    assert.equal(client.state.canShowCards, false);
    assert.deepEqual(client.state.players.find(player => player.id === winner.identity.playerId).cards, holeCards);
    assert.deepEqual(client.state.result[0].cards, holeCards);
    assert.deepEqual(client.state.result[0].hand, describeHand(holeCards));
    assert.equal(client.state.result[0].reason, 'folds');
    assert.equal(client.state.result[0].amount, awardBefore);
    assert.equal(client.state.pot, potBefore);
    assert.deepEqual(client.state.players.map(({ id, stack, bet }) => ({ id, stack, bet })), moneyBefore);
    assert.equal(client.state.nextHandAt, null, 'revealing respects paused auto-dealing');
  }
  const revealedState = structuredClone(winner.state);
  await success(winner, 'game:show-cards', { handNumber });
  assert.deepEqual(winner.state, revealedState, 'a repeated show is harmless');
  const resumed = await context.connect();
  resumed.identity = await success(resumed, 'room:resume', loser.identity);
  assert.deepEqual(resumed.state.result[0].cards, holeCards);
  assert.equal(resumed.state.result[0].revealed, true);
  const activeHost = host === loser ? resumed : host;
  await success(activeHost, 'room:start');
  await stateWhere(winner, state => state.handNumber === handNumber + 1);
  assert.equal(winner.state.canShowCards, false);
  assert.deepEqual(winner.state.result, []);
  assert.equal(winner.state.players.find(player => player.id === loser.identity.playerId).cards, null);
  await rejected(winner, 'game:show-cards', { handNumber });
});

test('showing an ordinary folds win restarts the next-hand countdown only once', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 250 });
  const players = await context.room(2);
  await success(players[0], 'room:start');
  const finished = await foldHeadsUp(players);
  const winner = players.find(client => client.identity.playerId === finished.result[0].id);
  await stateWhere(winner, state => state.phase === 'finished');
  await new Promise(resolve => setTimeout(resolve, 40));
  await success(winner, 'game:show-cards', { handNumber: 1 });
  const deadline = winner.state.nextHandAt;
  assert.ok(deadline > finished.nextHandAt);
  await success(winner, 'game:show-cards', { handNumber: 1 });
  assert.equal(winner.state.nextHandAt, deadline);
  const next = await stateWhere(winner, state => state.handNumber === 2);
  assert.equal(next.canShowCards, false);
  assert.deepEqual(next.result, []);
  assert.equal(next.players.find(player => player.id !== winner.identity.playerId).cards, null);
});

test('a replacement at a revealed winner seat never inherits its cards or private hand', async (t) => {
  const context = await fixture(t);
  const players = await context.room(2);
  await success(players[0], 'room:auto-next', { enabled: false });
  await success(players[0], 'room:start');
  const state = await foldHeadsUp(players);
  const winner = players.find(client => client.identity.playerId === state.result[0].id);
  const remaining = players.find(client => client !== winner);
  await stateWhere(winner, next => next.phase === 'finished');
  const seat = self(winner).seat;
  await success(winner, 'game:show-cards', { handNumber: 1 });
  await success(winner, 'room:leave');
  const replacement = await context.connect();
  replacement.identity = await success(replacement, 'room:join', { code: remaining.identity.code, name: 'New seat' });
  assert.equal(self(replacement).seat, seat);
  assert.equal(self(replacement).cards, null);
  assert.equal(self(replacement).hasCards, false);
  assert.equal(replacement.state.selfHand, null);
  assert.equal(replacement.state.canShowCards, false);
  assert.equal(replacement.state.result[0].id, winner.identity.playerId);
  await rejected(replacement, 'game:show-cards', { handNumber: 1 });
});

test('an unattended turn expires without blocking the table or losing chips', async (t) => {
  const context = await fixture(t, { turnTimeoutMs: 80 });
  const [host] = await context.room(2);
  await success(host, 'room:start');
  const state = await stateWhere(host, (next) => next.phase === 'finished');
  assert.equal(state.players.filter((player) => player.folded).length, 1);
  assert.equal(state.players.reduce((total, player) => total + player.stack, 0), 4000);
  assert.equal(state.turnSeat, null);
  assert.equal(state.turnDeadline, null);
});

test('a finished hand retains its result until one automatic next hand starts', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 140 });
  const players = await context.room(2);
  const [host] = players;
  assert.equal(host.state.autoNext, true);
  assert.equal(host.state.nextHandAt, null);
  assert.equal(context.server.rooms.get(host.identity.code).nextHandTimer, null);
  await success(host, 'room:start');
  const finished = await foldHeadsUp(players);
  assert.equal(finished.handNumber, 1);
  assert.ok(finished.result.length > 0);
  assert.ok(finished.nextHandAt > Date.now());
  assert.ok(finished.nextHandAt <= Date.now() + 140);
  await success(host, 'room:auto-next', { enabled: true });
  assert.equal(host.state.nextHandAt, finished.nextHandAt);
  assert.deepEqual(host.state.result, finished.result);
  const next = await stateWhere(host, (state) => state.handNumber === 2);
  assert.equal(next.phase, 'playing');
  assert.equal(next.nextHandAt, null);
  assert.notEqual(next.dealerSeat, finished.dealerSeat);
  assert.deepEqual(next.result, []);
  assert.equal(next.players.reduce((total, player) => total + player.stack + player.bet, 0), 4000);
  assert.equal(context.server.rooms.get(host.identity.code).nextHandTimer, null);
});

test('only the host can pause automatic dealing and manual start cancels the pending timer', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 100 });
  const players = await context.room(2);
  const [host, guest] = players;
  await rejected(guest, 'room:auto-next', { enabled: false });
  await rejected(host, 'room:auto-next', { enabled: 'false' });
  await success(host, 'room:start');
  await foldHeadsUp(players);
  await success(host, 'room:auto-next', { enabled: false });
  assert.equal(host.state.autoNext, false);
  assert.equal(host.state.nextHandAt, null);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(host.state.phase, 'finished');
  assert.equal(host.state.handNumber, 1);
  await success(host, 'room:auto-next', { enabled: true });
  assert.ok(host.state.nextHandAt > Date.now());
  await success(host, 'room:start');
  assert.equal(host.state.nextHandAt, null);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(host.state.handNumber, 2);
  assert.equal(host.state.phase, 'playing');
});

test('disconnect pauses a pending deal and resuming starts a fresh countdown', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 120 });
  const players = await context.room(2);
  const [host, guest] = players;
  await success(host, 'room:start');
  const finished = await foldHeadsUp(players);
  guest.socket.disconnect();
  await stateWhere(host, (state) => state.nextHandAt === null
    && state.players.some(player => player.id === guest.identity.playerId && !player.connected));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(host.state.handNumber, 1);
  assert.deepEqual(host.state.result, finished.result);
  const resumed = await context.connect();
  resumed.identity = await success(resumed, 'room:resume', guest.identity);
  assert.ok(resumed.state.nextHandAt > finished.nextHandAt);
  const next = await stateWhere(host, (state) => state.handNumber === 2);
  assert.equal(next.players.filter(player => player.inHand).length, 2);
});

test('leave, bot changes and a new arrival re-evaluate who can play next', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 150 });
  const players = await context.room(2);
  const [host, guest] = players;
  await success(host, 'room:start');
  await foldHeadsUp(players);
  await success(guest, 'room:leave');
  await stateWhere(host, (state) => state.players.length === 1);
  assert.equal(host.state.nextHandAt, null);
  await success(host, 'room:bot');
  const bot = host.state.players.find(player => player.isBot);
  assert.ok(host.state.nextHandAt > Date.now());
  await success(host, 'room:remove-bot', { id: bot.id });
  assert.equal(host.state.nextHandAt, null);
  const newcomer = await context.connect();
  newcomer.identity = await success(newcomer, 'room:join', { code: host.identity.code, name: 'New arrival' });
  assert.ok(newcomer.state.nextHandAt > Date.now());
  const next = await stateWhere(newcomer, (state) => state.handNumber === 2);
  assert.equal(next.players.find(player => player.id === newcomer.identity.playerId).inHand, true);
});

test('rebuy restarts a countdown when a settled player has no chips', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 100 });
  const players = await context.room(2);
  const [host, guest] = players;
  await success(host, 'room:auto-next', { enabled: false });
  await success(host, 'room:start');
  await foldHeadsUp(players);
  const room = context.server.rooms.get(host.identity.code);
  const busted = room.players.find(player => player.id === guest.identity.playerId);
  // Set a settled bust without relying on a random showdown winner.
  room.players.find(player => player.id === host.identity.playerId).stack += busted.stack;
  busted.stack = 0;
  await success(host, 'room:auto-next', { enabled: true });
  assert.equal(host.state.nextHandAt, null);
  await success(guest, 'room:rebuy');
  assert.ok(guest.state.nextHandAt > Date.now());
  const next = await stateWhere(host, (state) => state.handNumber === 2);
  assert.equal(next.players.reduce((total, player) => total + player.stack + player.bet, 0), 6000);
});

test('deleting a room cancels its pending next hand', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 100, botDelayMs: 1000 });
  const [host] = await context.room(1);
  await success(host, 'room:bot');
  await success(host, 'room:start');
  const room = context.server.rooms.get(host.identity.code);
  await success(host, 'game:action', movePayload(host.state, 'fold'));
  assert.ok(room.nextHandTimer);
  await success(host, 'room:leave');
  assert.equal(context.server.rooms.has(host.identity.code), false);
  assert.equal(room.nextHandTimer, null);
  assert.equal(room.nextHandAt, null);
});

test('an empty bot stack is replenished when the next hand starts automatically', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 100, botDelayMs: 1000 });
  const [host] = await context.room(1);
  await success(host, 'room:bot');
  await success(host, 'room:auto-next', { enabled: false });
  await success(host, 'room:start');
  await success(host, 'game:action', movePayload(host.state, 'fold'));
  const room = context.server.rooms.get(host.identity.code);
  const bot = room.players.find(player => player.isBot);
  room.players.find(player => !player.isBot).stack += bot.stack;
  bot.stack = 0;
  await success(host, 'room:auto-next', { enabled: true });
  assert.ok(host.state.nextHandAt > Date.now());
  const next = await stateWhere(host, (state) => state.handNumber === 2);
  const seatedBot = next.players.find(player => player.isBot);
  assert.equal(seatedBot.stack + seatedBot.bet, next.buyIn);
  assert.equal(seatedBot.inHand, true);
});

test('server shutdown clears next-hand timers before disconnect notifications', async (t) => {
  const context = await fixture(t, { nextHandDelayMs: 100 });
  const players = await context.room(2);
  const [host] = players;
  await success(host, 'room:start');
  await foldHeadsUp(players);
  const room = context.server.rooms.get(host.identity.code);
  assert.ok(room.nextHandTimer);
  await context.server.close();
  assert.equal(room.nextHandTimer, null);
  assert.equal(room.nextHandAt, null);
  assert.equal(context.server.rooms.size, 0);
});

test('lobby lists public summaries and follows occupancy, host and hand changes', async (t) => {
  const context = await fixture(t);
  const observer = await context.connect();
  await lobbyWhere(observer, rooms => rooms.length === 0);
  assert.deepEqual(await success(observer, 'lobby:list'), { ok: true, rooms: [] });
  const players = await context.room(2);
  const [host, guest] = players;
  let list = await lobbyWhere(observer, rooms => rooms[0]?.playerCount === 2);
  assert.deepEqual(list, [{
    code: host.identity.code, hostName: 'Host', playerCount: 2, onlineCount: 2,
    maxPlayers: 6, phase: 'lobby', smallBlind: 10, bigBlind: 20, buyIn: 2000,
  }]);
  const seatedLobbyCount = host.lobbies.length;
  await success(host, 'room:start');
  await lobbyWhere(observer, rooms => rooms[0]?.phase === 'playing');
  assert.equal(host.lobbies.length, seatedLobbyCount, 'seated clients do not receive lobby updates');
  await foldHeadsUp(players);
  await lobbyWhere(observer, rooms => rooms[0]?.phase === 'finished');
  host.socket.disconnect();
  list = await lobbyWhere(observer, rooms => rooms[0]?.onlineCount === 1);
  assert.equal(list[0].hostName, 'Player 2');
  assert.equal(list[0].playerCount, 2, 'the disconnected seat remains reserved');
  const resumed = await context.connect();
  resumed.identity = await success(resumed, 'room:resume', host.identity);
  await lobbyWhere(observer, rooms => rooms[0]?.onlineCount === 2);
  await success(guest, 'room:auto-next', { enabled: false });
  await success(resumed, 'room:leave');
  await lobbyWhere(resumed, rooms => rooms[0]?.playerCount === 1);
  await success(guest, 'room:leave');
  await lobbyWhere(observer, rooms => rooms.length === 0);
  await lobbyWhere(guest, rooms => rooms.length === 0);
  const wire = JSON.stringify(observer.lobbies);
  for (const player of players) {
    assert.equal(wire.includes(player.identity.token), false);
    assert.equal(wire.includes(player.identity.playerId), false);
  }
  assert.equal(/"(?:cards|holeCards|board|socketId|token|players|selfId)"/.test(wire), false);
});

test('lobby capacity reflects bots and reserved seats, and bot-only rooms disappear', async (t) => {
  const context = await fixture(t);
  const observer = await context.connect();
  const [host] = await context.room(1);
  for (let i = 0; i < 5; i++) await success(host, 'room:bot');
  await lobbyWhere(observer, rooms => rooms[0]?.playerCount === 6 && rooms[0]?.onlineCount === 6);
  await rejected(observer, 'room:join', { code: host.identity.code, name: 'Full room guest' });
  assert.equal(context.server.rooms.get(host.identity.code).players.length, 6);
  const bot = host.state.players.find(player => player.isBot);
  await success(host, 'room:remove-bot', { id: bot.id });
  await lobbyWhere(observer, rooms => rooms[0]?.playerCount === 5);
  observer.identity = await success(observer, 'room:join', { code: host.identity.code, name: 'New guest' });
  await success(observer, 'room:leave');
  await success(host, 'room:leave');
  await lobbyWhere(observer, rooms => rooms.length === 0);
  assert.equal(context.server.rooms.size, 0);
});

test('reactions reach only current room members without changing cards, chips or hand history', async (t) => {
  const context = await fixture(t);
  const [host, guest] = await context.room(2);
  const [otherRoom] = await context.room(1);
  const outsider = await context.connect();
  await rejected(outsider, 'room:react', { reactionId: 'smile', targetId: null });
  await success(host, 'room:start');
  await stateWhere(guest, state => state.phase === 'playing');
  const before = structuredClone(host.state);
  const stateCount = host.states.length;
  const received = once(guest.socket, 'room:reaction', { signal: AbortSignal.timeout(WAIT_MS) });
  await success(host, 'room:react', { reactionId: 'inspect', targetId: guest.identity.playerId });
  const [event] = await received;
  assert.deepEqual(Object.keys(event).sort(), ['code', 'createdAt', 'fromId', 'id', 'reactionId', 'targetId']);
  assert.equal(event.code, host.identity.code);
  assert.equal(event.fromId, host.identity.playerId);
  assert.equal(event.targetId, guest.identity.playerId);
  assert.equal(event.reactionId, 'inspect');
  assert.equal(typeof event.id, 'string');
  assert.ok(Number.isSafeInteger(event.createdAt));
  assert.deepEqual(host.reactions, [event]);
  await success(otherRoom, 'lobby:list');
  await success(outsider, 'lobby:list');
  assert.equal(otherRoom.reactions.length, 0);
  assert.equal(outsider.reactions.length, 0);
  assert.deepEqual(host.state, before);
  assert.equal(host.states.length, stateCount, 'a reaction does not broadcast a new hand snapshot');
  assert.equal(guest.state.players.find(player => player.id === host.identity.playerId).cards, null);
  guest.socket.disconnect();
  await stateWhere(host, state => !state.players.find(player => player.id === guest.identity.playerId).connected);
  const resumed = await context.connect();
  resumed.identity = await success(resumed, 'room:resume', guest.identity);
  assert.equal(resumed.reactions.length, 0, 'old interactions are not replayed on reconnect');
  assert.equal(JSON.stringify(resumed.state).includes(event.id), false);
});

test('invalid reactions and targets are rejected before cooldown or state changes', async (t) => {
  const context = await fixture(t);
  const players = await context.room(3);
  const [host, guest, departing] = players;
  const [otherRoom] = await context.room(1);
  for (const payload of [null, [], { reactionId: 'unknown' }, { reactionId: 1 },
    { reactionId: 'smile', targetId: {} }, { reactionId: 'smile', targetId: '' },
    { reactionId: 'smile', targetId: otherRoom.identity.playerId },
    { reactionId: 'rose', targetId: null }, { reactionId: 'rose', targetId: host.identity.playerId }]) {
    await rejected(host, 'room:react', payload);
  }
  guest.socket.disconnect();
  await stateWhere(host, state => !state.players.find(player => player.id === guest.identity.playerId).connected);
  await rejected(host, 'room:react', { reactionId: 'rose', targetId: guest.identity.playerId });
  await success(host, 'room:start');
  await stateWhere(departing, state => state.phase === 'playing');
  await success(departing, 'room:leave');
  await rejected(host, 'room:react', { reactionId: 'smile', targetId: departing.identity.playerId });
  const event = once(host.socket, 'room:reaction', { signal: AbortSignal.timeout(WAIT_MS) });
  await success(host, 'room:react', { reactionId: 'luck', targetId: null });
  assert.equal((await event)[0].targetId, null);
  assert.equal(host.reactions.length, 1, 'invalid requests neither emit events nor consume the valid send');
});

test('reaction cooldown survives reconnect and gifts reach the selected player', async (t) => {
  const context = await fixture(t);
  const [host, guest] = await context.room(2);
  await success(host, 'room:react', { reactionId: 'smile' });
  await rejected(host, 'room:react', { reactionId: 'applause' });
  const resumed = await context.connect();
  resumed.identity = await success(resumed, 'room:resume', host.identity);
  await rejected(resumed, 'room:react', { reactionId: 'wow' });
  await rejected(host, 'room:react', { reactionId: 'cool' });
  const oldSocketCount = host.reactions.length;
  await new Promise(resolve => setTimeout(resolve, 1250));
  const received = once(guest.socket, 'room:reaction', { signal: AbortSignal.timeout(WAIT_MS) });
  await success(resumed, 'room:react', { reactionId: 'rose', targetId: guest.identity.playerId });
  const [event] = await received;
  assert.equal(event.reactionId, 'rose');
  assert.equal(event.targetId, guest.identity.playerId);
  assert.equal(event.fromId, resumed.identity.playerId);
  await success(host, 'lobby:list');
  assert.equal(host.reactions.length, oldSocketCount, 'a replaced session is excluded from the room');
  assert.equal(resumed.reactions.length, 1);
});
