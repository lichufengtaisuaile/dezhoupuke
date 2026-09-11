import test from "node:test";
import assert from "node:assert/strict";
import {
  MAHJONG_TILES, MAHJONG_RULES, createMahjongWall, createMahjongRound,
  evaluateHand, applyMahjongAction, legalMahjongActions, automaticMahjongAction, snapshotMahjong
} from "../src/mahjong-engine.js";

const tiles = text => text.split(" ");
const waiting = tiles("m1 m2 m3 p1 p2 p3 s1 s2 s3 s7 s8 s9 p9");
const finishedHand = [...waiting, "p9"];
const rubbish = tiles("m1 m2 m4 m5 m7 m8 p1 p3 p5 p7 s2 s5 s8");
const makeRound = (stack = 1000) => createMahjongRound({
  roundId: "test-round", base: 10,
  players: Array.from({ length: 4 }, (_, seat) => ({ id: `p${seat}`, accountId: `account${seat}`, name: `玩家${seat}`, seat, stack }))
});
function position(hands = [], options = {}) {
  const state = makeRound(options.stack ?? 1000);
  for (let seat = 0; seat < 4; seat++) {
    state.players[seat].hand = [...(hands[seat] ?? rubbish)];
    state.players[seat].melds = [];
  }
  state.players[0].hand = [...(hands[0] ?? [...rubbish, "p9"])];
  state.wall = options.wall ? [...options.wall] : tiles("m9 p8 s9 m8 p7 s7 m7 p6 s6 m6 p5 s5");
  state.drawnTile = state.players[0].hand.at(-1);
  return state;
}
function replyAll(state, choose = () => "pass") {
  const candidates = [...state.responses.candidates];
  for (const candidate of candidates) {
    if (!state.responses?.replies.some(reply => reply.seat === candidate.seat)) state = applyMahjongAction(state, candidate.seat, { action: choose(candidate) });
  }
  return state;
}
function chips(state) { return state.players.reduce((sum, player) => sum + player.stack, 0); }

test("112 张牌使用四份完整牌组，开局庄家 14 张，其余 13 张", () => {
  const wall = createMahjongWall();
  assert.equal(wall.length, 112);
  for (const tile of MAHJONG_TILES) assert.equal(wall.filter(value => value === tile).length, 4);
  const state = createMahjongRound({ players: makeRound().players, wall, dealerSeat: 2 });
  assert.equal(state.wall.length, 59);
  assert.deepEqual(state.players.map(player => player.hand.length), [13, 13, 14, 13]);
  assert.equal(state.turnSeat, 2);
  assert.equal(state.drawnTile, wall[52]);
  assert.throws(() => createMahjongRound({ players: makeRound().players, wall: Array(112).fill("z0") }), /牌墙/);
  assert.equal(MAHJONG_RULES.maxMultiplier, 16);
});

test("红中补顺子、对子和刻子，包括 8、9 前面的缺牌", () => {
  assert.equal(evaluateHand(tiles("m8 m9 z0 p1 p2 p3 s1 s2 s3 s7 s8 s9 p9 p9")).multiplier, 1);
  assert.equal(evaluateHand([...waiting, "z0"]).multiplier, 1);
  assert.equal(evaluateHand(tiles("m1 m1 z0 p2 p2 p2 s3 s3 s3 s5 s5 s5 p9 p9")).multiplier, 2);
});

test("七对、清一色叠加、对对胡和无效胡牌验证", () => {
  assert.equal(evaluateHand(tiles("m1 m1 m2 m2 p1 p1 p2 p2 s1 s1 s2 s2 z0 z0")).multiplier, 4);
  assert.equal(evaluateHand(tiles("m1 m1 m2 m2 m3 m3 m4 m4 m5 m5 m6 m6 z0 z0")).multiplier, 16);
  assert.equal(evaluateHand(tiles("m1 m1 m1 m2 m2 m2 m3 m3 m3 m4 m4 m4 m9 m9")).multiplier, 8);
  assert.equal(evaluateHand(tiles("m1 m2 m3 m4 m5 m6 m7 m8 m9 m2 m3 m4 m8 m8")).multiplier, 4);
  assert.equal(evaluateHand([...rubbish, "p9"]), null);
  assert.equal(evaluateHand(Array(14).fill("z0")), null);
  assert.equal(evaluateHand([...waiting, "bad"]), null);
  assert.equal(evaluateHand(waiting), null);
  assert.equal(evaluateHand(tiles("m1 m2 m3 p1 p2 p3 s1 s2 s3 p9 p9"), [{ kind: "peng", tiles: ["z0", "z0", "z0"] }]), null);
});

test("初始自摸继续出牌，同一摸牌不能重复胡，失败操作不修改原局", () => {
  const original = position([finishedHand]);
  const before = structuredClone(original);
  assert.ok(legalMahjongActions(original, 0).actions.includes("hu"));
  const next = applyMahjongAction(original, 0, { action: "hu" });
  assert.deepEqual(original, before);
  assert.equal(next.events.length, 1);
  assert.equal(next.phase, "playing");
  assert.equal(next.turnSeat, 0);
  assert.equal(next.players[0].hand.length, 14);
  assert.deepEqual(next.players.map(player => player.stack), [1030, 990, 990, 990]);
  assert.equal(next.players[0].huCount, 1);
  assert.ok(!legalMahjongActions(next, 0).actions.includes("hu"));
  assert.throws(() => applyMahjongAction(next, 0, { action: "hu" }), /当前不能/);
  assert.equal(chips(next), 4000);
  assert.equal(applyMahjongAction(next, 0, { action: "discard", tile: "p9" }).players[0].hand.length, 13);
});

test("红中不能碰杠，但其他玩家可以胡打出的红中", () => {
  let state = position([[...rubbish, "z0"], waiting, ["z0", "z0", "z0", ...rubbish.slice(0, 10)]]);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "z0" });
  assert.ok(legalMahjongActions(state, 1).actions.includes("hu"));
  assert.ok(!legalMahjongActions(state, 2).actions.includes("peng"));
  assert.ok(!legalMahjongActions(state, 2).actions.includes("gang"));
  const own = position([["z0", "z0", "z0", "z0", ...rubbish.slice(0, 10)]]);
  assert.ok(!legalMahjongActions(own, 0).gangTiles.includes("z0"));
  assert.throws(() => applyMahjongAction(own, 0, { action: "gang", tile: "z0" }));
});

test("收齐所有响应后才结算一炮多响，胡优先于碰，点炮胡不改变手牌", () => {
  let state = position([undefined, waiting, waiting, ["p9", "p9", ...rubbish.slice(0, 11)]]);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  assert.equal(state.responses.candidates.length, 3);
  state = applyMahjongAction(state, 3, { action: "peng" });
  state = applyMahjongAction(state, 2, { action: "hu" });
  assert.equal(state.events.length, 0);
  assert.equal(state.stage, "responses");
  assert.deepEqual(legalMahjongActions(state, 2).actions, []);
  assert.throws(() => applyMahjongAction(state, 2, { action: "hu" }), /当前不能/);
  state = applyMahjongAction(state, 1, { action: "hu" });
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0].winners.map(winner => winner.seat), [1, 2]);
  assert.deepEqual(state.players.map(player => player.stack), [980, 1010, 1010, 1000]);
  assert.equal(state.players[2].hand.length, 13);
  assert.equal(state.players[1].hand.length, 14); // 下家已正常摸下一张，而不是拿走胡牌。
  assert.equal(state.players[3].melds.length, 0);
  assert.equal(state.turnSeat, 1);
  assert.equal(state.phase, "playing");
  assert.equal(state.events[0].winners[0].hand.concealedTiles.length, 14);
  assert.equal(chips(state), 4000);
});

test("未胡的玩家全部过后轮到下家摸牌，碰牌后必须打牌", () => {
  let state = position([undefined, ["p9", "p9", ...rubbish.slice(0, 11)]]);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  state = replyAll(state, candidate => candidate.seat === 1 ? "peng" : "pass");
  assert.equal(state.turnSeat, 1);
  assert.equal(state.players[1].melds[0].kind, "peng");
  assert.equal(state.players[1].hand.length, 11);
  assert.equal(state.players[0].discards.length, 0);
  assert.ok(!legalMahjongActions(state, 1).actions.includes("hu"));
  assert.equal(state.drawnTile, null);
});

test("暗杠收取每家两倍底分并补牌，直杠只向出牌者收取两倍底分", () => {
  let state = position([["p9", "p9", "p9", "p9", ...rubbish.slice(0, 10)]]);
  const wallLength = state.wall.length;
  state = applyMahjongAction(state, 0, { action: "gang", tile: "p9" });
  assert.deepEqual(state.players.map(player => player.stack), [1060, 980, 980, 980]);
  assert.equal(state.players[0].hand.length, 11);
  assert.equal(state.players[0].melds[0].kind, "concealedGang");
  assert.equal(state.wall.length, wallLength - 1);
  assert.equal(state.lastDrawKind, "supplement");
  state = position([undefined, ["p9", "p9", "p9", ...rubbish.slice(0, 10)]]);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  state = replyAll(state, candidate => candidate.seat === 1 ? "gang" : "pass");
  assert.deepEqual(state.players.map(player => player.stack), [980, 1020, 1000, 1000]);
  assert.equal(state.players[1].melds[0].kind, "gang");
  assert.equal(state.players[1].hand.length, 11);
  assert.equal(state.turnSeat, 1);
  assert.equal(chips(state), 4000);
});

test("补杠收取每家一倍底分，抢杠胡时保留原碰且不收杠分", () => {
  const setup = () => {
    const state = position([["p9", ...rubbish.slice(0, 10)]]);
    state.players[0].melds = [{ kind: "peng", type: "peng", tiles: ["p9", "p9", "p9"], fromSeat: 3 }];
    return state;
  };
  let state = applyMahjongAction(setup(), 0, { action: "gang", tile: "p9" });
  assert.equal(state.stage, "discard");
  assert.deepEqual(state.players.map(player => player.stack), [1030, 990, 990, 990]);
  assert.equal(state.players[0].melds[0].kind, "addedGang");
  state = setup();
  // 抢第四张 p9 组成顺子，不把自己的对子设为第五张 p9。
  state.players[1].hand = tiles("m1 m2 m3 p7 p8 s1 s2 s3 s7 s8 s9 m5 m5");
  state = applyMahjongAction(state, 0, { action: "gang", tile: "p9" });
  assert.equal(state.responses.kind, "robKong");
  assert.equal(state.events.length, 0);
  state = replyAll(state, candidate => candidate.seat === 1 ? "hu" : "pass");
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, "hu");
  assert.equal(state.events[0].robbedKong, true);
  assert.equal(state.players[0].melds[0].kind, "peng");
  assert.ok(!state.players[0].hand.includes("p9"));
  assert.equal(state.players[0].discards.at(-1), "p9");
  assert.deepEqual(state.players.map(player => player.stack), [990, 1010, 1000, 1000]);
});

test("暗杠身份在快照和公开流水中保密，胡牌公开组合后才显示", () => {
  let state = position([["p9", "p9", "p9", "p9", ...rubbish.slice(0, 10)]]);
  state = applyMahjongAction(state, 0, { action: "gang", tile: "p9" });
  const own = snapshotMahjong(state, 0);
  const other = snapshotMahjong(state, 1);
  assert.deepEqual(own.players[0].melds[0].tiles, ["p9", "p9", "p9", "p9"]);
  assert.deepEqual(other.players[0].melds[0].tiles, [null, null, null, null]);
  assert.equal(other.events[0].tile, null);
  assert.equal(other.events[0].concealed, true);
  state.players[0].hand = tiles("m1 m2 m3 p1 p2 p3 s1 s2 s3 m5 m5");
  state.drawnTile = "m5";
  state = applyMahjongAction(state, 0, { action: "hu" });
  assert.deepEqual(snapshotMahjong(state, 1).players[0].melds[0].tiles, ["p9", "p9", "p9", "p9"]);
  assert.equal(state.events[1].winners[0].hand.tiles.length, 15);
});

test("最后一张牌仍能胡，牌墙为空不能杠，出牌响应后结束", () => {
  let state = position([finishedHand], { wall: [] });
  assert.ok(legalMahjongActions(state, 0).actions.includes("hu"));
  state = applyMahjongAction(state, 0, { action: "hu" });
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  if (state.responses) state = replyAll(state);
  assert.equal(state.phase, "finished");
  assert.equal(state.endReason, "wallEmpty");
  const kong = position([["p9", "p9", "p9", "p9", ...rubbish.slice(0, 10)]], { wall: [] });
  assert.deepEqual(legalMahjongActions(kong, 0).gangTiles, []);
  assert.deepEqual(legalMahjongActions(state, 0).actions, []);
});

test("赔付按筹码封顶，多胡比例分配，顺时针分配整数余数并提前结束", () => {
  let state = position([undefined, waiting, waiting]);
  state.players[0].stack = state.players[0].startStack = 7;
  const originalTotal = chips(state);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  state = replyAll(state, candidate => candidate.seat === 1 || candidate.seat === 2 ? "hu" : "pass");
  assert.deepEqual(state.players.map(player => player.stack), [0, 1004, 1003, 1000]);
  assert.equal(state.phase, "finished");
  assert.equal(state.endReason, "bankrupt");
  assert.equal(chips(state), originalTotal);
  assert.ok(state.players.every(player => player.stack >= 0));
  assert.equal(state.result.eventsCount, 1);
});

test("不同番数的多人胡牌按应付比例封顶，不借用本次收款扩大赔付", () => {
  let state = position([undefined, waiting, tiles("m1 m1 m1 p2 p2 p2 s3 s3 s3 s5 s5 s5 p9")]);
  state.players[0].stack = state.players[0].startStack = 7;
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  state = replyAll(state, candidate => candidate.actions.includes("hu") ? "hu" : "pass");
  assert.deepEqual(state.players.map(player => player.stack), [0, 1003, 1004, 1000]);
  assert.deepEqual(state.events[0].transfers.map(transfer => transfer.amount), [10, 20]);
  assert.equal(chips(state), 3007);
});

test("生成的合法顺子刻子组合在替换至多四张红中后始终可以胡", () => {
  let seed = 90317;
  const next = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  let checked = 0;
  for (let attempt = 0; attempt < 2000 && checked < 160; attempt++) {
    const hand = [];
    for (let group = 0; group < 4; group++) {
      const suit = ["m", "p", "s"][next(3)];
      if (next(2)) { const tile = `${suit}${next(9) + 1}`; hand.push(tile, tile, tile); }
      else { const first = next(7) + 1; hand.push(`${suit}${first}`, `${suit}${first + 1}`, `${suit}${first + 2}`); }
    }
    const pair = MAHJONG_TILES[next(27)];
    hand.push(pair, pair);
    if (hand.some(tile => hand.filter(value => value === tile).length > 4)) continue;
    const wilds = next(5);
    for (let i = 0; i < wilds; i++) {
      let index = next(14);
      while (hand[index] === "z0") index = (index + 1) % 14;
      hand[index] = "z0";
    }
    assert.ok(evaluateHand(hand), hand.join(" "));
    checked++;
  }
  assert.equal(checked, 160);
});

test("快照隐藏其他手牌、牌墙、账号和响应选项；公开胡牌组合不随以后手牌改变", () => {
  let state = position([undefined, waiting, waiting]);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  const view = snapshotMahjong(state, 1);
  assert.equal(view.players[1].hand.length, 13);
  assert.deepEqual(view.players[0].hand, []);
  assert.equal(view.players[0].accountId, undefined);
  assert.equal(view.wall, undefined);
  assert.equal(view.drawnTile, null);
  assert.equal(view.responses.candidates, undefined);
  assert.equal(view.responses.replies, undefined);
  assert.equal(view.responses.ownPending, true);
  state = applyMahjongAction(state, 1, { action: "hu" });
  const responded = snapshotMahjong(state, 1);
  assert.equal(responded.responses.ownPending, false);
  assert.deepEqual(responded.legal.actions, []);
  state = applyMahjongAction(state, 2, { action: "hu" });
  const published = structuredClone(state.events[0].winners[0].hand);
  state.players[1].hand[0] = "z0";
  assert.deepEqual(state.events[0].winners[0].hand, published);
  const spectator = snapshotMahjong(state);
  assert.ok(spectator.players.every(player => player.hand.length === 0));
  assert.ok(spectator.events[0].winners[0].hand.tiles.length > 0);
});

test("自动操作优先胡、否则过或出牌，不主动碰杠", () => {
  assert.deepEqual(automaticMahjongAction(position([finishedHand]), 0), { action: "hu" });
  let state = position([undefined, ["p9", "p9", ...rubbish.slice(0, 11)]]);
  const move = automaticMahjongAction(state, 0);
  assert.equal(move.action, "discard");
  assert.ok(state.players[0].hand.includes(move.tile));
  assert.equal(automaticMahjongAction(state, 1), null);
  state = applyMahjongAction(state, 0, { action: "discard", tile: "p9" });
  assert.deepEqual(automaticMahjongAction(state, 1), { action: "pass" });
});

test("托管保留新摸到的成搭牌，打出原有孤张并保留红中、对子和刻子", () => {
  const state = position([tiles("m1 m2 m3 p1 p2 p3 s1 s2 s3 m5 m5 p7 p8 s9")]);
  state.drawnTile = "m3";
  assert.deepEqual(automaticMahjongAction(state, 0), { action: "discard", tile: "s9" });
  const red = position([tiles("m1 m1 m1 p1 p2 p3 s1 s2 s3 m5 m5 p7 z0 s9")]);
  red.drawnTile = "z0";
  const move = automaticMahjongAction(red, 0);
  assert.equal(move.action, "discard");
  assert.ok(["p7", "s9"].includes(move.tile));
  assert.notEqual(move.tile, "z0");
});

test("托管选择只依赖自己的牌，改变其他人的手牌或牌墙不影响决定", () => {
  const state = position([tiles("m1 m2 m3 p1 p2 p3 s1 s2 s3 m5 m5 p7 p8 s9")]);
  state.drawnTile = "m3";
  const original = structuredClone(state);
  const expected = automaticMahjongAction(state, 0);
  const altered = structuredClone(state);
  for (const player of altered.players.slice(1)) {
    player.hand = [...finishedHand];
    player.discards = ["s9", "s9", "s9"];
  }
  altered.wall = ["s9", "s9", "z0", "z0"];
  assert.deepEqual(automaticMahjongAction(altered, 0), expected);
  assert.deepEqual(automaticMahjongAction(state, 0), expected);
  assert.deepEqual(state, original);
});

test("完整随机牌局始终守恒、终止，无私牌变异或负数筹码", () => {
  for (let game = 0; game < 16; game++) {
    let state = makeRound(10000);
    let steps = 0;
    while (state.phase === "playing") {
      assert.ok(++steps < 500);
      const seat = state.stage === "responses"
        ? state.responses.candidates.find(candidate => !state.responses.replies.some(reply => reply.seat === candidate.seat)).seat
        : state.turnSeat;
      const legal = legalMahjongActions(state, seat);
      let action = automaticMahjongAction(state, seat);
      if (legal.actions.includes("gang") && steps % 3 === 0) action = { action: "gang", tile: legal.gangTiles[0] };
      else if (legal.actions.includes("peng") && steps % 3 === 1) action = { action: "peng" };
      const prior = JSON.stringify(state);
      const next = applyMahjongAction(state, seat, action);
      assert.equal(JSON.stringify(state), prior);
      state = next;
      assert.equal(chips(state), 40000);
      assert.ok(state.players.every(player => Number.isSafeInteger(player.stack) && player.stack >= 0));
      const allTiles = [...state.wall, ...state.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)])];
      assert.equal(allTiles.length, 112);
      for (const tile of MAHJONG_TILES) assert.equal(allTiles.filter(value => value === tile).length, 4);
    }
    assert.ok(["wallEmpty", "bankrupt"].includes(state.endReason));
  }
});
