import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import { createTable } from './engine.js';
import { describeHand } from './hand-description.js';
import './public/social-catalog.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺'];
const ACTION_NAMES = { fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', 'all-in': '全押' };
const ROUND_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
const BOT_NAMES = ['小林', '阿岳', '小满', '阿森', '小夏'];
const REACTIONS = new Map(globalThis.HOLDEM_REACTIONS.map(reaction => [reaction.id, reaction]));
const REACTION_COOLDOWN_MS = 1200;

class GameError extends Error {}
function requireThat(condition, message) { if (!condition) throw new GameError(message); }
function validName(value) {
  requireThat(typeof value === 'string', '请输入昵称');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  requireThat(name.length >= 1 && [...name].length <= 12, '昵称需要 1–12 个字');
  return name;
}
function integer(value, min, max, label) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, `${label}需要是 ${min}–${max} 之间的整数`);
  return value;
}
export function networkUrls(port) {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/vethernet|virtualbox|vmware|docker|loopback/i.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
    .map(entry => `http://${entry.address}:${port}`);
}

export async function createPokerServer({ port = 0, host = '127.0.0.1', turnTimeoutMs = 30000, botDelayMs = 1100, disconnectGraceMs = 90000, nextHandDelayMs = 5000 } = {}) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 8192, serveClient: true });
  const rooms = new Map();
  let actualPort = port;
  let closing = false;
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.get('/api/network', (_req, res) => res.json({ port: actualPort, urls: networkUrls(actualPort) }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/vendor/lucide.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/lucide/dist/umd/lucide.js')));
  app.use(express.static(path.join(ROOT, 'public'), { etag: true, maxAge: 0 }));

  function log(room, text) {
    room.log.push({ id: ++room.logSequence, text });
    if (room.log.length > 60) room.log.shift();
  }
  function clearTurn(room) {
    clearTimeout(room.timer);
    room.timer = null;
    room.turnDeadline = null;
  }
  function clearNextHand(room) {
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
    room.nextHandAt = null;
  }
  function activePlayers(room) {
    return room.players.filter(p => !p.departing && p.connected && (p.stack > 0 || p.isBot));
  }
  function canAutoStart(room) {
    return !closing && rooms.get(room.code) === room && room.autoNext
      && room.phase === 'finished' && activePlayers(room).length >= 2;
  }
  function scheduleNextHand(room) {
    if (!canAutoStart(room)) { clearNextHand(room); return; }
    if (room.nextHandTimer) return;
    room.nextHandAt = Date.now() + nextHandDelayMs;
    room.nextHandTimer = setTimeout(() => {
      clearNextHand(room);
      if (!canAutoStart(room)) return;
      try { startHand(room); broadcast(room); }
      catch (error) { recoverHand(room, error); }
    }, nextHandDelayMs);
    room.nextHandTimer.unref();
  }
  function playerAt(room, seat) { return room.players.find(p => p.seat === seat); }
  function isPlaying(room) { return room.phase === 'playing'; }
  function getLegal(room) {
    if (!isPlaying(room) || !room.table.isBettingRoundInProgress()) return null;
    const { actions, chipRange, callAmount: engineCallAmount } = room.table.legalActions();
    const seat = room.table.playerToAct();
    const seated = room.table.seats();
    const self = seated[seat];
    const maxBet = Math.max(room.round === 'preflop' ? room.bigBlind : 0, ...seated.map(p => p?.betSize ?? 0));
    const callAmount = engineCallAmount ?? Math.min(self.stack, Math.max(0, maxBet - self.betSize));
    const canRaise = actions.includes('raise') || actions.includes('bet');
    return {
      actions,
      minRaise: canRaise ? chipRange?.min ?? null : null,
      maxRaise: canRaise ? chipRange?.max ?? null : null,
      callAmount,
      canAllIn: self.stack > 0 && (canRaise || (actions.includes('call') && callAmount === self.stack)),
    };
  }
  function snapshot(room, viewer) {
    const acting = isPlaying(room) && room.table.isBettingRoundInProgress();
    const turnSeat = acting ? room.table.playerToAct() : null;
    const showableWinner = foldWinner(room, viewer);
    return {
      code: room.code, phase: room.phase, handNumber: room.handNumber,
      autoNext: room.autoNext, nextHandAt: room.nextHandAt,
      smallBlind: room.smallBlind, bigBlind: room.bigBlind, buyIn: room.buyIn,
      maxPlayers: 6, hostId: room.hostId, selfId: viewer.id,
      players: room.players.map(p => ({
        id: p.id, name: p.name, seat: p.seat, stack: p.stack, bet: p.bet,
        connected: p.connected, isBot: p.isBot, folded: p.folded, inHand: p.inHand,
        hasCards: p.inHand && Boolean(room.holeCards[p.seat]),
        cards: p.inHand && (p.id === viewer.id || room.revealed.has(p.seat)) ? room.holeCards[p.seat] ?? null : null,
        lastAction: p.lastAction, winner: room.result.some(r => r.id === p.id),
      })),
      board: room.board, round: room.round, pot: room.pot,
      pots: room.pots.map(p => ({ size: p.size })),
      dealerSeat: room.dealerSeat, turnSeat, turnDeadline: room.turnDeadline,
      turnId: room.turnId, legal: viewer.seat === turnSeat ? getLegal(room) : null,
      selfHand: viewer.inHand ? describeHand(room.holeCards[viewer.seat], room.board) : null,
      canShowCards: Boolean(showableWinner && !showableWinner.revealed),
      result: room.result.map(winner => {
        const visible = winner.id === viewer.id || winner.revealed;
        return { ...winner, cards: visible ? winner.cards : null, hand: visible ? winner.hand : null };
      }),
      log: room.log,
    };
  }
  function foldWinner(room, player) {
    if (room.phase !== 'finished' || !player.inHand || player.folded || room.result.length !== 1) return null;
    const winner = room.result[0];
    return winner.id === player.id && winner.reason === 'folds' ? winner : null;
  }
  function lobbyRooms() {
    return [...rooms.values()]
      .filter(room => room.players.some(player => !player.isBot && !player.departing))
      .map(room => ({
        code: room.code,
        hostName: room.players.find(player => player.id === room.hostId)?.name ?? '',
        playerCount: room.players.length,
        onlineCount: room.players.filter(player => player.connected && !player.departing).length,
        maxPlayers: 6, phase: room.phase,
        smallBlind: room.smallBlind, bigBlind: room.bigBlind, buyIn: room.buyIn,
      }));
  }
  function broadcastLobby() {
    if (closing) return;
    const list = lobbyRooms();
    const signature = JSON.stringify(list);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.membership || socket.data.lobbySignature === signature) continue;
      socket.data.lobbySignature = signature;
      socket.emit('lobby:state', { rooms: list });
    }
  }
  function broadcast(room) {
    scheduleNextHand(room);
    for (const p of room.players) {
      if (p.socketId && p.connected) io.sockets.sockets.get(p.socketId)?.emit('room:state', snapshot(room, p));
    }
    broadcastLobby();
  }
  function syncTable(room) {
    const seats = room.table.seats();
    for (const p of room.players) {
      if (p.inHand) { p.stack = seats[p.seat]?.stack ?? 0; p.bet = seats[p.seat]?.betSize ?? 0; }
    }
    if (room.table.isHandInProgress()) {
      room.board = room.table.communityCards();
      room.round = room.table.roundOfBetting();
      room.pots = room.table.pots();
      room.pot = room.pots.reduce((sum, p) => sum + p.size, 0) + room.players.reduce((sum, p) => sum + p.bet, 0);
    }
  }
  function transferHost(room) {
    const current = room.players.find(p => p.id === room.hostId);
    if (current?.connected && !current.departing) return;
    const next = room.players.find(p => !p.isBot && p.connected && !p.departing);
    if (next) {
      room.hostId = next.id;
      log(room, `${next.name} 成为房主`);
    }
  }
  function removePlayer(room, player) {
    clearTimeout(player.disconnectTimer);
    room.players = room.players.filter(p => p !== player);
    transferHost(room);
    if (!room.players.some(p => !p.isBot && !p.departing)) {
      clearTurn(room);
      clearNextHand(room);
      for (const p of room.players) clearTimeout(p.disconnectTimer);
      rooms.delete(room.code);
      broadcastLobby();
    }
  }
  function finishHand(room) {
    room.board = room.table.communityCards();
    room.pots = room.table.pots();
    room.pot = room.pots.reduce((sum, p) => sum + p.size, 0);
    const eligible = new Set(room.pots.flatMap(p => p.eligiblePlayers));
    if (eligible.size > 1) for (const seat of eligible) room.revealed.add(seat);
    const before = room.players.map(p => ({ id: p.id, stack: p.stack, name: p.name, seat: p.seat }));
    room.table.showdown();
    syncTable(room);
    const winnings = room.table.winners().flat();
    room.result = before.flatMap(p => {
      const player = room.players.find(item => item.id === p.id);
      const amount = player.stack - p.stack;
      if (amount <= 0) return [];
      const winningHand = winnings.find(winner => winner[0] === p.seat);
      return [{
        id: p.id, name: p.name, amount,
        handName: eligible.size === 1 ? '其余玩家弃牌' : HAND_NAMES[winningHand?.[1]?.ranking] ?? '赢得底池',
        reason: eligible.size === 1 ? 'folds' : 'showdown',
        cards: room.holeCards[p.seat], hand: describeHand(room.holeCards[p.seat], room.board),
        revealed: eligible.size > 1,
      }];
    });
    room.phase = 'finished';
    clearTurn(room);
    for (const winner of room.result) log(room, `${winner.name} 获得 ${winner.amount} 筹码 · ${winner.handName}`);
    for (const p of [...room.players]) if (p.departing) removePlayer(room, p);
  }
  function settleRounds(room) {
    while (room.table.isHandInProgress() && !room.table.isBettingRoundInProgress()) {
      if (room.table.areBettingRoundsCompleted()) { finishHand(room); return; }
      const previous = room.round;
      room.table.endBettingRound();
      syncTable(room);
      if (room.round !== previous) {
        for (const p of room.players) if (!p.folded) p.lastAction = '';
        log(room, ROUND_NAMES[room.round] ?? room.round);
      }
    }
  }
  function botAction(room) {
    const legal = getLegal(room);
    const seat = room.table.playerToAct();
    const player = playerAt(room, seat);
    const cards = room.holeCards[seat] ?? [];
    const ranks = cards.map(c => '23456789TJQKA'.indexOf(c.rank) + 2);
    const strong = ranks[0] === ranks[1] || ranks.reduce((a, b) => a + b, 0) >= 24;
    const choice = randomInt(100);
    if (legal.minRaise !== null && strong && choice < 24) {
      return { action: legal.actions.includes('raise') ? 'raise' : 'bet', amount: Math.min(legal.maxRaise, Math.max(legal.minRaise, room.bigBlind * 3)) };
    }
    if (legal.actions.includes('check')) return { action: 'check' };
    if (legal.actions.includes('call') && (strong || legal.callAmount <= room.bigBlind * 3 || (legal.callAmount < player.stack / 4 && choice < 65))) return { action: 'call' };
    return { action: 'fold' };
  }
  function scheduleTurn(room) {
    clearTurn(room);
    if (!isPlaying(room)) return;
    const player = playerAt(room, room.table.playerToAct());
    const delay = player.isBot ? botDelayMs : player.departing ? Math.min(200, turnTimeoutMs) : turnTimeoutMs;
    room.turnDeadline = Date.now() + delay;
    const turnId = ++room.turnId;
    room.timer = setTimeout(() => {
      if (!rooms.has(room.code) || room.turnId !== turnId || !isPlaying(room)) return;
      try {
        const action = player.isBot ? botAction(room) : { action: getLegal(room).actions.includes('check') && !player.departing ? 'check' : 'fold' };
        takeAction(room, player, action, true);
      } catch (error) { recoverHand(room, error); }
    }, delay);
    room.timer.unref();
  }
  function recoverHand(room, error) {
    console.error('Hand error:', room.code, error);
    clearTurn(room);
    clearNextHand(room);
    for (const p of room.players) {
      if (room.startStacks.has(p.id)) p.stack = room.startStacks.get(p.id);
      p.bet = 0; p.inHand = false; p.folded = false; p.lastAction = '';
    }
    room.phase = 'lobby'; room.table = null; room.board = []; room.holeCards = [];
    room.round = null; room.pot = 0; room.pots = []; room.result = []; room.revealed.clear();
    log(room, '本手已取消，筹码已退回。房主可以重新发牌。');
    broadcast(room);
  }
  function takeAction(room, player, input, automatic = false) {
    requireThat(isPlaying(room), '当前没有进行中的牌局');
    requireThat(room.table.playerToAct() === player.seat, '还没有轮到你行动');
    if (!automatic) requireThat(input.handNumber === room.handNumber && input.turnId === room.turnId, '牌局已更新，请重新选择操作');
    const legal = getLegal(room);
    let action = input.action;
    let amount = input.amount;
    if (action === 'all-in') {
      requireThat(legal.canAllIn, '当前不能全押');
      if (legal.actions.includes('raise') || legal.actions.includes('bet')) {
        action = legal.actions.includes('raise') ? 'raise' : 'bet';
        amount = legal.maxRaise;
      } else action = 'call';
    }
    requireThat(legal.actions.includes(action), '当前不能执行这个操作');
    if (action === 'bet' || action === 'raise') integer(amount, legal.minRaise, legal.maxRaise, '下注额');
    const before = player.stack;
    room.table.actionTaken(action, amount);
    syncTable(room);
    player.folded ||= action === 'fold';
    const paid = before - player.stack;
    player.lastAction = player.stack === 0 && action !== 'fold' ? '全押' : ACTION_NAMES[action];
    log(room, `${player.name} ${player.lastAction}${paid > 0 ? ` ${paid}` : ''}${automatic && !player.isBot ? '（自动）' : ''}`);
    settleRounds(room);
    scheduleTurn(room);
    broadcast(room);
  }
  function startHand(room) {
    requireThat(!isPlaying(room), '本手尚未结束');
    const active = activePlayers(room);
    requireThat(active.length >= 2, '至少需要两位在线且有筹码的玩家');
    clearNextHand(room);
    for (const p of active) if (p.isBot && p.stack === 0) { p.stack = room.buyIn; log(room, `${p.name} 补充 ${room.buyIn} 筹码`); }
    room.table = createTable({ smallBlind: room.smallBlind, bigBlind: room.bigBlind }, 6);
    room.startStacks = new Map(active.map(p => [p.id, p.stack]));
    room.result = []; room.revealed.clear(); room.board = []; room.pots = []; room.pot = 0;
    for (const p of room.players) {
      p.inHand = active.includes(p); p.folded = false; p.bet = 0; p.lastAction = '';
      if (p.inHand) room.table.sitDown(p.seat, p.stack);
    }
    const activeSeats = active.map(p => p.seat).sort((a, b) => a - b);
    const dealer = activeSeats.find(seat => seat > (room.dealerSeat ?? -1)) ?? activeSeats[0];
    room.table.startHand(dealer);
    room.phase = 'playing'; room.handNumber++; room.dealerSeat = room.table.button();
    room.holeCards = room.table.holeCards();
    syncTable(room);
    log(room, `第 ${room.handNumber} 手开始 · 盲注 ${room.smallBlind}/${room.bigBlind}`);
    settleRounds(room);
    scheduleTurn(room);
  }
  function newPlayer(room, name, bot = false) {
    requireThat(room.players.length < 6, '房间已满，最多 6 人');
    requireThat(!room.players.some(p => p.name === name), '这个昵称已被使用');
    const seat = Array.from({ length: 6 }, (_, n) => n).find(n => !room.players.some(p => p.seat === n));
    const player = {
      id: randomUUID(), token: randomBytes(32).toString('hex'), name, seat,
      stack: room.buyIn, bet: 0, connected: bot, isBot: bot, socketId: null,
      folded: false, inHand: false, lastAction: '', departing: false, disconnectTimer: null,
      lastReactionAt: null,
    };
    room.players.push(player);
    log(room, `${name} 入座${isPlaying(room) ? '，等待下一手' : ''}`);
    return player;
  }
  function associate(socket, room, player) {
    clearTimeout(player.disconnectTimer);
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        old.data.membership = null;
        old.emit('session:replaced', { reason: '座位已在另一个页面恢复' });
      }
    }
    player.socketId = socket.id; player.connected = true;
    socket.data.membership = { code: room.code, id: player.id };
    socket.data.lobbySignature = null;
    transferHost(room);
    return { code: room.code, token: player.token, playerId: player.id };
  }
  function member(socket) {
    const membership = socket.data.membership;
    const room = rooms.get(membership?.code);
    const player = room?.players.find(p => p.id === membership.id && p.socketId === socket.id && !p.departing);
    requireThat(room && player, '请先加入房间');
    return { room, player };
  }
  function hostOnly(room, player) { requireThat(room.hostId === player.id, '只有房主可以操作'); }
  function leave(socket, room, player) {
    socket.data.membership = null;
    player.socketId = null; player.connected = false; player.departing = true;
    clearTimeout(player.disconnectTimer);
    log(room, `${player.name} 离开房间`);
    transferHost(room);
    if (!isPlaying(room) || !player.inHand) removePlayer(room, player);
    else if (!room.players.some(p => !p.isBot && !p.departing)) removePlayer(room, player);
    else if (room.table.playerToAct() === player.seat) {
      takeAction(room, player, { action: 'fold' }, true);
    }
    if (rooms.has(room.code)) broadcast(room);
  }

  io.on('connection', socket => {
    let requests = [];
    function on(event, handler) {
      socket.on(event, (input, ack) => {
        if (typeof ack !== 'function') return;
        try {
          const now = Date.now();
          requests = requests.filter(time => now - time < 5000);
          requireThat(requests.length < 70, '操作太快了，请稍后再试');
          requests.push(now);
          requireThat(input !== null && typeof input === 'object' && !Array.isArray(input), '请求格式不正确');
          const result = handler(input) ?? {};
          ack({ ok: true, ...result });
        } catch (error) {
          if (!(error instanceof GameError)) console.error('Request error:', event, error);
          ack({ ok: false, error: error instanceof GameError ? error.message : '操作没有完成，请刷新牌局后重试' });
        }
      });
    }
    on('lobby:list', () => ({ rooms: lobbyRooms() }));
    on('room:react', input => {
      const { room, player } = member(socket);
      const reaction = typeof input.reactionId === 'string' ? REACTIONS.get(input.reactionId) : null;
      requireThat(reaction, '这个表情暂时不可用');
      const targetId = input.targetId === undefined ? null : input.targetId;
      requireThat(targetId === null || typeof targetId === 'string', '请选择有效的互动对象');
      const target = targetId === null ? null : room.players.find(item => item.id === targetId && item.connected && !item.departing);
      requireThat(targetId === null || target, '这位玩家已离开或暂时离线');
      requireThat(reaction.kind !== 'gift' || (target && target.id !== player.id), '请选择另一位玩家送花');
      const now = Date.now();
      requireThat(player.lastReactionAt === null || now - player.lastReactionAt >= REACTION_COOLDOWN_MS, '互动太快了，稍等一下');
      player.lastReactionAt = now;
      const event = {
        id: randomUUID(), code: room.code, fromId: player.id,
        targetId, reactionId: reaction.id, createdAt: now,
      };
      for (const recipient of room.players) {
        if (recipient.connected && !recipient.departing && recipient.socketId) {
          io.sockets.sockets.get(recipient.socketId)?.emit('room:reaction', event);
        }
      }
    });
    on('room:create', input => {
      requireThat(!socket.data.membership, '请先离开当前房间');
      requireThat(rooms.size < 100, '房间较多，请稍后再试');
      const name = validName(input.name);
      const smallBlind = integer(input.smallBlind ?? 10, 1, 500, '小盲注');
      const bigBlind = integer(input.bigBlind ?? smallBlind * 2, smallBlind * 2, smallBlind * 2, '大盲注');
      const buyIn = integer(input.buyIn ?? 2000, bigBlind * 20, 100000, '初始筹码');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code;
      do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
      const room = {
        code, smallBlind, bigBlind, buyIn, phase: 'lobby', players: [], hostId: null,
        handNumber: 0, turnId: 0, turnDeadline: null, timer: null, table: null,
        autoNext: true, nextHandAt: null, nextHandTimer: null,
        board: [], holeCards: [], pot: 0, pots: [], round: null, dealerSeat: null,
        result: [], revealed: new Set(), log: [], logSequence: 0, startStacks: new Map(),
      };
      const player = newPlayer(room, name);
      room.hostId = player.id;
      rooms.set(code, room);
      const response = associate(socket, room, player);
      broadcast(room);
      return response;
    });
    on('room:join', input => {
      requireThat(!socket.data.membership, '请先离开当前房间');
      const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      requireThat(room, '没有找到房间，请检查房间号');
      const player = newPlayer(room, validName(input.name));
      const response = associate(socket, room, player);
      broadcast(room);
      return response;
    });
    on('room:resume', input => {
      requireThat(!socket.data.membership, '当前页面已经在房间中');
      const room = rooms.get(input.code);
      const player = room?.players.find(p => p.token === input.token && !p.isBot && !p.departing);
      requireThat(player, '座位已失效，请重新加入房间');
      const response = associate(socket, room, player);
      log(room, `${player.name} 已连接`);
      broadcast(room);
      return response;
    });
    on('room:bot', () => {
      const { room, player } = member(socket); hostOnly(room, player);
      requireThat(!isPlaying(room), '本手结束后可以添加陪练');
      const name = BOT_NAMES.find(n => !room.players.some(p => p.name === `${n}·陪练`));
      requireThat(name, '陪练已全部入座');
      newPlayer(room, `${name}·陪练`, true);
      broadcast(room);
    });
    on('room:remove-bot', input => {
      const { room, player } = member(socket); hostOnly(room, player);
      requireThat(!isPlaying(room), '本手结束后可以移除陪练');
      const bot = room.players.find(p => p.id === input.id && p.isBot);
      requireThat(bot, '没有找到这位陪练');
      removePlayer(room, bot);
      broadcast(room);
    });
    on('room:start', () => {
      const { room, player } = member(socket); hostOnly(room, player);
      startHand(room);
      broadcast(room);
    });
    on('room:auto-next', input => {
      const { room, player } = member(socket); hostOnly(room, player);
      requireThat(typeof input.enabled === 'boolean', '自动下一手设置需要是开或关');
      room.autoNext = input.enabled;
      broadcast(room);
    });
    on('game:action', input => { const { room, player } = member(socket); takeAction(room, player, input); });
    on('game:show-cards', input => {
      const { room, player } = member(socket);
      requireThat(input.handNumber === room.handNumber, '牌局已更新，不能展示上一手的牌');
      const winner = foldWinner(room, player);
      requireThat(winner, '本手结束后，未摊牌的赢家可以展示自己的手牌');
      if (winner.revealed) return;
      winner.revealed = true;
      room.revealed.add(player.seat);
      log(room, `${player.name} 展示手牌 · ${winner.hand.detail}`);
      clearNextHand(room);
      broadcast(room);
    });
    on('room:rebuy', () => {
      const { room, player } = member(socket);
      requireThat(!isPlaying(room), '本手结束后可以补充筹码');
      requireThat(player.stack === 0, '筹码用完后可以重新补充');
      player.stack = room.buyIn;
      log(room, `${player.name} 补充 ${room.buyIn} 筹码`);
      broadcast(room);
    });
    on('room:leave', () => { const { room, player } = member(socket); leave(socket, room, player); });
    socket.on('disconnect', () => {
      if (!socket.data.membership) return;
      let context;
      try { context = member(socket); } catch { return; }
      const { room, player } = context;
      player.connected = false; player.socketId = null;
      log(room, `${player.name} 暂时离线`);
      transferHost(room);
      broadcast(room);
      player.disconnectTimer = setTimeout(() => {
        if (player.connected || !rooms.has(room.code)) return;
        leave({ data: {} }, room, player);
      }, disconnectGraceMs);
      player.disconnectTimer.unref();
    });
    broadcastLobby();
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  actualPort = httpServer.address().port;
  return {
    app, httpServer, io, rooms, port: actualPort,
    async close() {
      closing = true;
      for (const room of rooms.values()) {
        clearTurn(room);
        clearNextHand(room);
        for (const p of room.players) clearTimeout(p.disconnectTimer);
      }
      io.removeAllListeners('connection');
      await new Promise(resolve => io.close(resolve));
      for (const room of rooms.values()) for (const p of room.players) clearTimeout(p.disconnectTimer);
      rooms.clear();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedPort = Number(process.env.PORT ?? 3210);
  integer(requestedPort, 1, 65535, '端口');
  let server;
  for (let offset = 0; offset < 20; offset++) {
    try { server = await createPokerServer({ port: requestedPort + offset, host: '0.0.0.0' }); break; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  if (!server) throw new Error('No available port');
  console.log(`LAN Holdem is running: http://localhost:${server.port}`);
  for (const url of networkUrls(server.port)) console.log(`LAN address: ${url}`);
  console.log('Keep this process running while playing. Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
}
