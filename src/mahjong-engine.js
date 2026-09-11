import { randomInt, randomUUID } from "node:crypto";
import { GameError } from "./errors.js";

export const MAHJONG_TILES = Object.freeze([
  ...["m", "p", "s"].flatMap(suit => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`)), "z0"
]);
export const MAHJONG_RULES = Object.freeze({
  id: "bloodflow-red-v1", name: "血流红中", playerCount: 4, tileCount: 112,
  redTile: "z0", maxMultiplier: 16, exchange: false, dingque: false,
  description: "万、筒、条各 36 张，加 4 张红中。红中仅在胡牌时作赖子，可以打出，不能碰杠。不吃牌、不换三张、不定缺。",
  hu: "胡牌后继续参与，支持一炮多响。自摸胡后仍须出牌，同一次摸牌只能自摸胡一次。",
  scoring: "平胡 1 倍、对对胡 2 倍、七对 4 倍；清一色再乘 4，最多 16 倍。红中本身不加番。自摸其余三家付分，点炮者向每位胡牌者付分。",
  gang: "暗杠每家付 2 倍底分，补杠每家付 1 倍底分，直杠由出牌者付 2 倍底分。补杠可抢杠胡；有补牌才允许杠。",
  ending: "牌墙摸完结束，不查叫、不查花猪、不退杠分。赔付以现有桌上筹码为限，多人胡牌按应得比例分配，余数按出牌者下家起顺时针分配；有人筹码归零则本局提前结束。"
});

const clone = value => structuredClone(value);
const tileIndex = tile => MAHJONG_TILES.indexOf(tile);
const fail = message => { throw new GameError(message); };
const clockwise = (from, to) => (to - from + 4) % 4;
const playerAt = (state, seat) => state.players.find(player => player.seat === seat);
const countTile = (hand, tile) => hand.filter(value => value === tile).length;
const sortHand = hand => hand.sort((a, b) => tileIndex(a) - tileIndex(b));

export function createMahjongWall() {
  const wall = MAHJONG_TILES.flatMap(tile => Array(4).fill(tile));
  for (let i = wall.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall;
}

function meldsPossible(counts, wild, groups, pungsOnly, memo) {
  if (groups === 0) return wild === 0 && counts.every(count => count === 0);
  const first = counts.findIndex(count => count > 0);
  if (first === -1) return wild === groups * 3;
  const key = `${counts.join("")}:${wild}:${groups}`;
  if (memo.has(key)) return memo.get(key);
  for (let used = Math.min(3, counts[first]); used >= 1; used--) {
    const needed = 3 - used;
    if (wild < needed) continue;
    counts[first] -= used;
    const result = meldsPossible(counts, wild - needed, groups - 1, pungsOnly, memo);
    counts[first] += used;
    if (result) { memo.set(key, true); return true; }
  }
  if (!pungsOnly) {
    const rank = first % 9;
    const suitStart = first - rank;
    for (let start = Math.max(0, rank - 2); start <= Math.min(6, rank); start++) {
      const indices = [suitStart + start, suitStart + start + 1, suitStart + start + 2];
      const takeSequence = (offset, remainingWild) => {
        if (offset === 3) return meldsPossible(counts, remainingWild, groups - 1, pungsOnly, memo);
        const index = indices[offset];
        if (counts[index] > 0) {
          counts[index]--;
          const result = takeSequence(offset + 1, remainingWild);
          counts[index]++;
          if (result) return true;
        }
        // The first remaining natural tile must be consumed by this group.
        return index !== first && remainingWild > 0 && takeSequence(offset + 1, remainingWild - 1);
      };
      if (takeSequence(0, wild)) { memo.set(key, true); return true; }
    }
  }
  memo.set(key, false);
  return false;
}

function standardHu(counts, wild, groups, pungsOnly) {
  const memo = new Map();
  if (wild >= 2 && meldsPossible(counts, wild - 2, groups, pungsOnly, memo)) return true;
  for (let i = 0; i < counts.length; i++) {
    for (let used = Math.min(2, counts[i]); used >= 1; used--) {
      if (wild < 2 - used) continue;
      counts[i] -= used;
      const result = meldsPossible(counts, wild - (2 - used), groups, pungsOnly, memo);
      counts[i] += used;
      if (result) return true;
    }
  }
  return false;
}

export function evaluateHand(tiles, melds = [], winningTile = undefined) {
  if (!Array.isArray(tiles) || !Array.isArray(melds) || melds.length > 4) return null;
  const hand = [...tiles, ...(winningTile === undefined ? [] : [winningTile])];
  if (hand.length !== 14 - melds.length * 3) return null;
  const visible = [...hand];
  for (const meld of melds) {
    if (!Array.isArray(meld.tiles) || ![3, 4].includes(meld.tiles.length) || meld.tiles.includes("z0") || !meld.tiles.every(tile => tile === meld.tiles[0])) return null;
    visible.push(...meld.tiles);
  }
  const totalCounts = Array(28).fill(0);
  for (const tile of visible) {
    const index = tileIndex(tile);
    if (index === -1 || ++totalCounts[index] > 4) return null;
  }
  const counts = Array(27).fill(0);
  let wild = 0;
  for (const tile of hand) tile === "z0" ? wild++ : counts[tileIndex(tile)]++;
  const sevenPairs = melds.length === 0 && counts.filter(count => count % 2).length <= wild;
  const allPungs = standardHu([...counts], wild, 4 - melds.length, true);
  if (!sevenPairs && !allPungs && !standardHu([...counts], wild, 4 - melds.length, false)) return null;
  const suits = new Set(visible.filter(tile => tile !== "z0").map(tile => tile[0]));
  const pure = suits.size === 1;
  const patterns = [sevenPairs ? "七对" : allPungs ? "对对胡" : "平胡"];
  let multiplier = sevenPairs ? 4 : allPungs ? 2 : 1;
  if (pure) { patterns.unshift("清一色"); multiplier *= 4; }
  return { name: patterns.join("·"), multiplier: Math.min(16, multiplier), patterns };
}

export function createMahjongRound({ players, base = 10, wall, dealerSeat = 0, roundId = randomUUID() }) {
  if (!Array.isArray(players) || players.length !== 4 || new Set(players.map(player => player.seat)).size !== 4 || players.some(player => !Number.isInteger(player.seat) || player.seat < 0 || player.seat > 3)) fail("麻将需要四位不同座位的玩家");
  if (!Number.isSafeInteger(base) || base < 1 || base > 1000000) fail("底分不合法");
  if (!Number.isInteger(dealerSeat) || dealerSeat < 0 || dealerSeat > 3) fail("庄家座位不合法");
  if (players.some(player => !Number.isSafeInteger(player.stack) || player.stack < 1 || player.stack > 1000000000000)) fail("带入筹码不合法");
  const deck = wall === undefined ? createMahjongWall() : [...wall];
  const counts = Array(28).fill(0);
  if (deck.length < 53 || deck.length > 112 || deck.some(tile => tileIndex(tile) === -1 || ++counts[tileIndex(tile)] > 4)) fail("牌墙不合法");
  const state = {
    id: String(roundId), phase: "playing", stage: "discard", base, dealerSeat,
    turnSeat: dealerSeat, turnId: 1, wall: deck, lastDiscard: null, responses: null,
    drawnTile: null, drawnSeat: dealerSeat, lastDrawKind: "initial", selfDrawClaimed: false,
    events: [], endReason: null, result: null,
    players: players.map(player => ({
      id: player.id, accountId: player.accountId, name: player.name, seat: player.seat,
      avatar: player.avatar, stack: player.stack, startStack: player.stack,
      net: 0, huCount: 0, hand: [], melds: [], discards: []
    })).sort((a, b) => a.seat - b.seat)
  };
  for (let i = 0; i < 13; i++) {
    for (let step = 0; step < 4; step++) playerAt(state, (dealerSeat + step) % 4).hand.push(state.wall.shift());
  }
  state.drawnTile = state.wall.shift();
  playerAt(state, dealerSeat).hand.push(state.drawnTile);
  for (const player of state.players) sortHand(player.hand);
  return state;
}

function finish(state, reason) {
  state.phase = "finished";
  state.stage = "finished";
  state.responses = null;
  state.endReason = reason;
  state.result = {
    reason, eventsCount: state.events.length,
    players: state.players.map(({ id, seat, name, startStack, stack, net, huCount }) => ({ id, seat, name, startStack, stack, net, huCount }))
  };
}

function draw(state, seat, kind = "normal") {
  if (!state.wall.length) { finish(state, "wallEmpty"); return; }
  const tile = state.wall.shift();
  playerAt(state, seat).hand.push(tile);
  sortHand(playerAt(state, seat).hand);
  state.stage = "discard";
  state.turnSeat = seat;
  state.responses = null;
  state.drawnTile = tile;
  state.drawnSeat = seat;
  state.lastDrawKind = kind;
  state.selfDrawClaimed = false;
}

function removeTiles(player, tile, amount) {
  if (countTile(player.hand, tile) < amount) fail("手牌中没有足够的这张牌");
  for (let i = 0; i < amount; i++) player.hand.splice(player.hand.indexOf(tile), 1);
}

function settle(state, metadata, payments) {
  const changes = state.players.map(player => ({ seat: player.seat, delta: 0 }));
  const transfers = [];
  for (const payer of state.players) {
    const dues = payments.filter(payment => payment.from === payer.seat).sort((a, b) => clockwise(payer.seat, a.to) - clockwise(payer.seat, b.to));
    const total = dues.reduce((sum, payment) => sum + payment.amount, 0);
    if (!total) continue;
    const available = Math.min(payer.stack, total);
    const allocations = dues.map(payment => ({ ...payment, paid: Math.floor(available * payment.amount / total) }));
    let remainder = available - allocations.reduce((sum, payment) => sum + payment.paid, 0);
    for (const payment of allocations) {
      if (remainder > 0) { payment.paid++; remainder--; }
      changes.find(change => change.seat === payment.from).delta -= payment.paid;
      changes.find(change => change.seat === payment.to).delta += payment.paid;
      transfers.push(payment);
    }
  }
  for (const change of changes) {
    const player = playerAt(state, change.seat);
    player.stack += change.delta;
    player.net = player.stack - player.startStack;
  }
  const event = { id: `${state.id}:${state.events.length + 1}`, at: Date.now(), ...metadata, changes, transfers };
  state.events.push(event);
  if (state.players.some(player => player.stack === 0)) finish(state, "bankrupt");
}

function publicWinningHand(player, winningTile) {
  const tiles = [...player.hand, ...(winningTile === undefined ? [] : [winningTile])];
  const evaluated = evaluateHand(tiles, player.melds);
  return {
    seat: player.seat, ...evaluated,
    hand: { ...evaluated, tiles: [...tiles, ...player.melds.flatMap(meld => meld.tiles)], concealedTiles: tiles, melds: clone(player.melds) },
    tiles: [...tiles, ...player.melds.flatMap(meld => meld.tiles)]
  };
}

function hu(state, seats, sourceSeat, selfDraw, tile, robbedKong = false) {
  const winners = seats.map(seat => publicWinningHand(playerAt(state, seat), selfDraw ? undefined : tile));
  for (const seat of seats) playerAt(state, seat).huCount++;
  const payments = winners.flatMap(winner => (selfDraw ? state.players.filter(player => player.seat !== winner.seat).map(player => player.seat) : [sourceSeat])
    .map(from => ({ from, to: winner.seat, amount: state.base * winner.multiplier })));
  settle(state, { kind: "hu", sourceSeat, selfDraw, robbedKong, tile, winners }, payments);
}

function gangOptions(state, player) {
  if (!state.wall.length) return [];
  return [...new Set(player.hand)].filter(tile => tile !== "z0" && (countTile(player.hand, tile) === 4 || player.melds.some(meld => meld.kind === "peng" && meld.tiles[0] === tile)));
}

export function legalMahjongActions(state, seat) {
  const legal = { actions: [], discardTiles: [], gangTiles: [] };
  if (state.phase !== "playing") return legal;
  const player = playerAt(state, seat);
  if (!player) return legal;
  if (state.stage === "responses") {
    if (state.responses.replies.some(reply => reply.seat === seat)) return legal;
    const candidate = state.responses.candidates.find(candidate => candidate.seat === seat);
    if (candidate) {
      legal.actions = [...candidate.actions, "pass"];
      if (candidate.actions.includes("gang")) legal.gangTiles = [state.responses.tile];
    }
    return legal;
  }
  if (state.stage !== "discard" || state.turnSeat !== seat) return legal;
  legal.actions.push("discard");
  legal.discardTiles = [...new Set(player.hand)];
  legal.gangTiles = gangOptions(state, player);
  if (legal.gangTiles.length) legal.actions.push("gang");
  if (state.drawnSeat === seat && state.drawnTile !== null && !state.selfDrawClaimed && evaluateHand(player.hand, player.melds)) legal.actions.push("hu");
  return legal;
}

function responseCandidates(state, sourceSeat, tile, robKong = false) {
  return state.players.filter(player => player.seat !== sourceSeat).map(player => {
    const actions = [];
    if (evaluateHand(player.hand, player.melds, tile)) actions.push("hu");
    if (!robKong && tile !== "z0") {
      const count = countTile(player.hand, tile);
      if (count >= 2) actions.push("peng");
      if (count >= 3 && state.wall.length) actions.push("gang");
    }
    return { seat: player.seat, actions };
  }).filter(candidate => candidate.actions.length).sort((a, b) => clockwise(sourceSeat, a.seat) - clockwise(sourceSeat, b.seat));
}

function recordGang(state, seat, tile, kind, sourceSeat) {
  const payers = kind === "gang" ? [sourceSeat] : state.players.filter(player => player.seat !== seat).map(player => player.seat);
  settle(state, { kind: "gang", sourceSeat, seat, tile: kind === "concealedGang" ? null : tile, concealed: kind === "concealedGang", gangKind: kind, winners: [] }, payers.map(from => ({ from, to: seat, amount: state.base * (kind === "addedGang" ? 1 : 2) })));
  if (state.phase === "playing") draw(state, seat, "supplement");
}

function completeAddedGang(state, pending) {
  const player = playerAt(state, pending.seat);
  removeTiles(player, pending.tile, 1);
  const meld = player.melds[pending.meldIndex];
  meld.kind = meld.type = "addedGang";
  meld.tiles.push(pending.tile);
  recordGang(state, pending.seat, pending.tile, "addedGang", pending.seat);
}

function resolveResponses(state) {
  const pending = state.responses;
  if (pending.replies.length !== pending.candidates.length) return;
  const winners = pending.replies.filter(reply => reply.action === "hu").map(reply => reply.seat).sort((a, b) => clockwise(pending.sourceSeat, a) - clockwise(pending.sourceSeat, b));
  if (winners.length) {
    if (pending.kind === "robKong") {
      const source = playerAt(state, pending.sourceSeat);
      removeTiles(source, pending.tile, 1);
      source.discards.push(pending.tile);
    }
    state.lastDiscard = { ...state.lastDiscard, seat: pending.sourceSeat, tile: pending.tile, kind: pending.kind, huSeats: winners, claimed: true };
    hu(state, winners, pending.sourceSeat, false, pending.tile, pending.kind === "robKong");
    if (state.phase === "playing") draw(state, (pending.sourceSeat + 1) % 4);
    return;
  }
  if (pending.kind === "robKong") { completeAddedGang(state, pending.kong); return; }
  const claim = pending.replies.filter(reply => reply.action === "peng" || reply.action === "gang")
    .sort((a, b) => clockwise(pending.sourceSeat, a.seat) - clockwise(pending.sourceSeat, b.seat))[0];
  if (!claim) { draw(state, (pending.sourceSeat + 1) % 4); return; }
  const player = playerAt(state, claim.seat);
  const source = playerAt(state, pending.sourceSeat);
  source.discards.pop();
  removeTiles(player, pending.tile, claim.action === "gang" ? 3 : 2);
  player.melds.push({ kind: claim.action, type: claim.action, tiles: Array(claim.action === "gang" ? 4 : 3).fill(pending.tile), fromSeat: pending.sourceSeat });
  state.lastDiscard.claimed = true;
  state.lastDiscard.claimSeat = claim.seat;
  state.responses = null;
  state.turnSeat = claim.seat;
  state.stage = "discard";
  state.drawnTile = null;
  state.drawnSeat = null;
  state.lastDrawKind = null;
  if (claim.action === "gang") recordGang(state, claim.seat, pending.tile, "gang", pending.sourceSeat);
}

export function applyMahjongAction(original, seat, move) {
  if (!move || typeof move.action !== "string") fail("请选择有效操作");
  const legal = legalMahjongActions(original, seat);
  if (!legal.actions.includes(move.action)) fail("当前不能进行这个操作");
  if (move.action === "discard" && !legal.discardTiles.includes(move.tile)) fail("请选择自己的手牌");
  const state = clone(original);
  const player = playerAt(state, seat);
  state.turnId++;
  if (state.stage === "responses") {
    if (move.tile !== undefined && move.tile !== state.responses.tile) fail("响应的牌已改变");
    state.responses.replies.push({ seat, action: move.action });
    resolveResponses(state);
    return state;
  }
  if (move.action === "hu") {
    state.selfDrawClaimed = true;
    hu(state, [seat], seat, true, state.drawnTile);
    return state;
  }
  if (move.action === "discard") {
    removeTiles(player, move.tile, 1);
    player.discards.push(move.tile);
    state.lastDiscard = { seat, tile: move.tile, id: state.turnId, kind: "discard", claimed: false, huSeats: [] };
    state.drawnTile = null;
    state.drawnSeat = null;
    state.lastDrawKind = null;
    const candidates = responseCandidates(state, seat, move.tile);
    if (!candidates.length) draw(state, (seat + 1) % 4);
    else {
      state.stage = "responses";
      state.responses = { kind: "discard", sourceSeat: seat, tile: move.tile, candidates, replies: [] };
    }
    return state;
  }
  const tile = move.tile ?? (legal.gangTiles.length === 1 ? legal.gangTiles[0] : null);
  if (!legal.gangTiles.includes(tile)) fail("请选择可以杠的牌");
  const meldIndex = player.melds.findIndex(meld => meld.kind === "peng" && meld.tiles[0] === tile);
  if (meldIndex !== -1) {
    const kong = { seat, tile, meldIndex };
    const candidates = responseCandidates(state, seat, tile, true);
    if (!candidates.length) completeAddedGang(state, kong);
    else {
      state.stage = "responses";
      state.responses = { kind: "robKong", sourceSeat: seat, tile, candidates, replies: [], kong };
    }
  } else {
    removeTiles(player, tile, 4);
    player.melds.push({ kind: "concealedGang", type: "concealedGang", tiles: Array(4).fill(tile), fromSeat: seat });
    recordGang(state, seat, tile, "concealedGang", seat);
  }
  return state;
}

// A small structural hand assessment for unattended play. Groups consume their
// tiles, so one useful middle tile cannot earn points for several overlapping
// sequences. This sees only the acting player's held tiles and exposed melds.
function automaticDiscard(player, drawnTile) {
  const counts = Array(27).fill(0);
  let wild = 0;
  for (const tile of player.hand) tile === "z0" ? wild++ : counts[tileIndex(tile)]++;
  const memo = new Map();
  function structure() {
    const first = counts.findIndex(count => count > 0);
    if (first === -1) return 0;
    const key = counts.join("");
    if (memo.has(key)) return memo.get(key);
    counts[first]--;
    let best = structure(); // An isolated tile may wait for a later draw.
    if (counts[first] >= 2) {
      counts[first] -= 2;
      best = Math.max(best, 12 + structure());
      counts[first] += 2;
    }
    if (counts[first] >= 1) {
      counts[first]--;
      best = Math.max(best, 5 + structure());
      counts[first]++;
    }
    const rank = first % 9;
    if (rank <= 6 && counts[first + 1] && counts[first + 2]) {
      counts[first + 1]--; counts[first + 2]--;
      best = Math.max(best, 12 + structure());
      counts[first + 1]++; counts[first + 2]++;
    }
    for (const gap of [1, 2]) {
      if (rank + gap > 8 || !counts[first + gap]) continue;
      counts[first + gap]--;
      best = Math.max(best, 3 + structure());
      counts[first + gap]++;
    }
    counts[first]++;
    memo.set(key, best);
    return best;
  }
  let bestTile = null;
  let bestScore = -Infinity;
  for (const tile of [...new Set(player.hand)]) {
    const index = tileIndex(tile);
    if (tile !== "z0") counts[index]--;
    const pairs = counts.reduce((sum, count) => sum + Math.floor(count / 2), 0);
    const score = Math.max(structure(), player.melds.length === 0 ? pairs * 8 : 0)
      + (wild - Number(tile === "z0")) * 14;
    if (tile !== "z0") counts[index]++;
    // Equal structures can safely discard the draw; otherwise use stable tile
    // order instead of randomness, opponent hands, or knowledge of the wall.
    if (score > bestScore || (score === bestScore && (tile === drawnTile || (bestTile !== drawnTile && index > tileIndex(bestTile))))) {
      bestScore = score;
      bestTile = tile;
    }
  }
  return bestTile;
}

export function automaticMahjongAction(state, seat) {
  const legal = legalMahjongActions(state, seat);
  if (legal.actions.includes("hu")) return { action: "hu" };
  if (legal.actions.includes("pass")) return { action: "pass" };
  if (legal.actions.includes("discard")) {
    return { action: "discard", tile: automaticDiscard(playerAt(state, seat), state.drawnTile) };
  }
  return null;
}

export function snapshotMahjong(state, viewerSeat = -1) {
  const legal = legalMahjongActions(state, viewerSeat);
  return {
    id: state.id, roundId: state.id, phase: state.phase, stage: state.stage,
    turnSeat: state.turnSeat, turnId: state.turnId, dealerSeat: state.dealerSeat,
    base: state.base, wallCount: state.wall.length, remainingTiles: state.wall.length,
    lastDiscard: clone(state.lastDiscard), endReason: state.endReason, result: clone(state.result),
    drawnTile: state.drawnSeat === viewerSeat ? state.drawnTile : null,
    lastDrawKind: state.lastDrawKind,
    players: state.players.map(player => ({
      id: player.id, name: player.name, avatar: player.avatar, seat: player.seat,
      stack: player.stack, startStack: player.startStack, net: player.net, huCount: player.huCount,
      hand: player.seat === viewerSeat ? [...player.hand] : [], handCount: player.hand.length,
      melds: player.melds.map(meld => {
        const published = state.events.some(event => event.kind === "hu" && event.winners.some(winner => winner.seat === player.seat && winner.hand.melds.some(shown => shown.kind === "concealedGang" && shown.tiles[0] === meld.tiles[0])));
        if (meld.kind !== "concealedGang" || player.seat === viewerSeat || published) return clone(meld);
        return { kind: meld.kind, type: meld.type, tiles: [null, null, null, null], fromSeat: meld.fromSeat, concealed: true };
      }), discards: [...player.discards]
    })),
    responses: state.responses ? {
      kind: state.responses.kind, sourceSeat: state.responses.sourceSeat, tile: state.responses.tile,
      waitingSeats: state.responses.candidates.filter(candidate => !state.responses.replies.some(reply => reply.seat === candidate.seat)).map(candidate => candidate.seat),
      repliedSeats: state.responses.replies.map(reply => reply.seat),
      ownPending: state.responses.candidates.some(candidate => candidate.seat === viewerSeat) && !state.responses.replies.some(reply => reply.seat === viewerSeat)
    } : null,
    events: clone(state.events), legal, legalActions: clone(legal), rules: clone(MAHJONG_RULES)
  };
}
