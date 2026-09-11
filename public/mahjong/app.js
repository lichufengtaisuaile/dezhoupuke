(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const auth = window.tongzhuoAuth;
  const esc = auth.esc;
  const money = auth.money;
  const names = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const suitNames = { m: "万", p: "筒", s: "条" };
  const positions = ["bottom", "right", "top", "left"];
  const phaseNames = { waiting: "等待入座", playing: "正在对局", finished: "等待下一局" };
  const ROOM_KEY = "tongzhuo-mahjong-room";
  let socket = null;
  let socketToken = null;
  let state = null;
  let rooms = [];
  let selected = -1;
  let handStamp = "";
  let savedRoom = readRoom();
  let pending = false;
  let busyJoin = false;
  let toastTimer;
  let eventTimer;
  let balanceTimer;
  let joinPreview = null;
  let lastRoundId = null;
  let lastEventId = null;
  let silenced = false;
  const topbar = window.createTopbar({ mount: $("mj-identity"), onRequireAuth: login });
  const renderedMarkup = new WeakMap();
  const effects = window.createMahjongEffects?.({ root: $("mj-game"), table: document.querySelector(".mj-table"), hand: $("mj-hand"), tileMarkup });

  // Keep unchanged nodes in place so socket acknowledgements preserve focus and live animations.
  function renderMarkup(node, markup) {
    if (renderedMarkup.get(node) === markup) return;
    node.innerHTML = markup;
    renderedMarkup.set(node, markup);
  }

  function readRoom() {
    try {
      const data = JSON.parse(localStorage.getItem(ROOM_KEY) || "null");
      const current = auth.get();
      return data && current && data.account === current.name ? String(data.code || "") : "";
    } catch { return ""; }
  }
  function rememberRoom(code) {
    savedRoom = code || "";
    try {
      if (code) localStorage.setItem(ROOM_KEY, JSON.stringify({ code, account: auth.get()?.name }));
      else localStorage.removeItem(ROOM_KEY);
    } catch { /* The active connection remains usable without local storage. */ }
    renderResume();
  }
  function icons() { window.lucide?.createIcons(); }
  function toast(text) {
    clearTimeout(toastTimer);
    $("mj-toast").textContent = text;
    $("mj-toast").hidden = false;
    toastTimer = setTimeout(() => { $("mj-toast").hidden = true; }, 4500);
  }
  function showDialog(id) {
    const dialog = $(id);
    const error = dialog.querySelector("[data-form-error]");
    if (error) error.hidden = true;
    if (!dialog.open) dialog.showModal();
  }
  function signed(value) { return `${Number(value) > 0 ? "+" : Number(value) < 0 ? "−" : ""}${money(Math.abs(Number(value) || 0))}`; }
  function scoreClass(value) { return Number(value) > 0 ? "mj-gain" : Number(value) < 0 ? "mj-loss" : ""; }
  function tileName(tile) { return tile === "z0" ? "红中" : /^[mps][1-9]$/.test(tile || "") ? `${names[Number(tile[1]) - 1]}${suitNames[tile[0]]}` : "暗牌"; }
  function tileMarkup(tile, { button = false, index, extra = "", disabled = false } = {}) {
    if (!tile || !/^(?:[mps][1-9]|z0)$/.test(tile)) return '<span class="mj-tile mj-tile-back-face" role="img" aria-label="暗牌"><svg class="mj-tile-face" viewBox="0 0 60 80" aria-hidden="true" focusable="false"><use href="/mahjong/tile-faces.svg#back" /></svg></span>';
    const suit = tile[0];
    const content = `<svg class="mj-tile-face" viewBox="0 0 60 80" aria-hidden="true" focusable="false"><use href="/mahjong/tile-faces.svg#${tile}" /></svg>`;
    const attrs = button ? `type="button" ${Number.isInteger(index) ? `data-hand-index="${index}"` : `data-gang-tile="${tile}"`} ${disabled ? 'disabled aria-disabled="true"' : ""}` : 'role="img"';
    return `<${button ? "button" : "span"} class="mj-tile suit-${suit} ${extra}" data-tile="${tile}" ${attrs} aria-label="${tileName(tile)}"${button && Number.isInteger(index) ? ` aria-pressed="${selected === index}"` : ""}>${content}</${button ? "button" : "span"}>`;
  }
  function players() {
    return (state?.players || []).map((player) => {
      const gamePlayer = state.round?.players?.find((item) => Number(item.seat) === Number(player.seat));
      return { ...gamePlayer, ...player };
    });
  }
  function self() {
    const all = players();
    return all.find((player) => player.id === state?.selfId || player.accountId === state?.selfId)
      || all.find((player) => player.name === auth.get()?.name && !player.isBot);
  }
  function playerAt(seat) { return players().find((player) => Number(player.seat) === Number(seat)); }
  function playerName(seat) { return playerAt(seat)?.name || `座位 ${Number(seat) + 1}`; }
  function round() { return state?.round; }
  function legal() { return round()?.legal || round()?.legalActions || { actions: [], discardTiles: [], gangTiles: [] }; }
  function canAct() { return socket?.connected && !pending && state?.phase === "playing" && !self()?.departing && !self()?.trustee && !silenced; }
  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  async function refreshBalance() {
    const account = await auth.refreshBalance();
    topbar.setAccount(auth.get() ? account : null);
    window.dispatchEvent(new CustomEvent("tongzhuo:balance"));
  }
  function scheduleBalance() {
    clearTimeout(balanceTimer);
    balanceTimer = setTimeout(() => { void refreshBalance(); }, 250);
  }
  async function login() {
    if (!auth.get()) {
      const ok = await auth.openAuthModal();
      if (!ok) return false;
    }
    silenced = false;
    topbar.setAccount(auth.get());
    void refreshBalance();
    return true;
  }
  function connectSocket() {
    const account = auth.get();
    if (!account) return Promise.reject(new Error("请先登录"));
    if (socket && socketToken !== account.token) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    if (!socket) {
      socketToken = account.token;
      socket = window.io("/mahjong", { auth: { token: account.token }, autoConnect: false });
      socket.on("lobby:state", (data) => { rooms = data?.rooms || []; renderRooms(); });
      socket.on("room:state", receiveState);
      socket.on("room:left", (data) => {
        leaveLocal();
        if (data?.error || data?.message) toast(data.error || data.message);
      });
      socket.on("session:replaced", () => {
        silenced = true;
        leaveLocal();
        socket.disconnect();
        toast("账号已在另一个页面接管牌桌。如需在这里继续，请重新加入。");
      });
      socket.on("disconnect", () => {
        effects?.reset();
        lastRoundId = null; lastEventId = null;
        clearTimeout(eventTimer); $("mj-event-banner").hidden = true;
        pending = false; renderTable();
      });
      socket.on("connect", () => {
        pending = false;
        renderTable();
        if (savedRoom && !busyJoin && !silenced) {
          emit("room:resume", { code: savedRoom }).catch((error) => {
            if (!state) { rememberRoom(""); clearRoomUrl(); }
            toast(error.message);
          });
        }
        socket.emit("room:list", {});
      });
    }
    if (socket.connected) return Promise.resolve();
    const connecting = socket;
    return new Promise((resolve, reject) => {
      const connected = () => { cleanup(); resolve(); };
      const failed = (error) => { cleanup(); reject(new Error(error?.message || "牌桌连接失败，请稍后重试")); };
      const timer = setTimeout(() => failed(new Error("连接超时，请检查网络后重试")), 10000);
      const cleanup = () => { clearTimeout(timer); connecting.off("connect", connected); connecting.off("connect_error", failed); };
      connecting.once("connect", connected);
      connecting.once("connect_error", failed);
      connecting.connect();
    });
  }
  function emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) { reject(new Error("连接已断开，正在重新连接")); return; }
      socket.timeout(10000).emit(event, payload, (error, result) => {
        if (error) { reject(new Error("响应超时，请等待牌桌同步后重试")); return; }
        if (!result?.ok) { reject(new Error(result?.error || "操作未完成，请重试")); return; }
        resolve(result);
      });
    });
  }

  async function loadRooms() {
    try {
      const result = await auth.api("/api/mahjong/rooms");
      rooms = result.rooms || [];
      renderRooms();
    } catch (error) {
      $("mj-room-list").innerHTML = `<p class="mj-empty">${esc(error?.error || "房间加载失败")}<br />点击右上方刷新重试。</p>`;
    }
  }
  function renderRooms() {
    $("mj-room-list").innerHTML = rooms.length ? rooms.map((room) => {
      const seated = (room.players || []).filter(Boolean);
      const count = Number(room.playerCount ?? seated.length);
      const full = count >= 4;
      const seatMarks = Array.from({ length: 4 }, (_, index) => {
        if (seated[index]) return `<span title="${esc(seated[index].name)}"><img src="/avatars/player-${auth.avatarIndex(seated[index].name) + 1}.svg" alt="${esc(seated[index].name)}" /></span>`;
        return index < count ? '<span class="is-occupied" aria-label="已入座">●</span>' : '<span aria-label="空座位">＋</span>';
      }).join("");
      return `<article class="mj-room-card"><div class="mj-room-card-heading"><h3>${esc(room.code)}</h3><span class="mj-badge ${room.practice ? "is-practice" : ""}">${room.practice ? "练习桌" : "正式桌"}</span></div><p>底分 ${money(room.base)} · 带入 ${money(room.buyIn)}</p><div class="mj-room-seats" aria-label="${count} 人已入座">${seatMarks}</div><button class="button secondary" type="button" data-join-room="${esc(room.code)}" ${full && room.code !== savedRoom ? "disabled" : ""}>${room.code === savedRoom ? "回到牌桌" : full ? "房间已满" : `${phaseNames[room.phase] || "等待入座"} · 加入`}</button></article>`;
    }).join("") : '<p class="mj-empty">还没有牌桌，来开第一桌吧。<br />创建正式桌邀请朋友，也可以开练习桌熟悉玩法。</p>';
  }
  function renderResume() {
    $("mj-resume").hidden = !savedRoom || Boolean(state);
    $("mj-resume-code").textContent = savedRoom ? `房号 ${savedRoom} · 已带入的筹码保留在桌上` : "";
  }
  function openJoin(code = "") {
    joinPreview = null;
    $("mj-join-code").value = code;
    $("mj-join-preview").textContent = "先查看规则与带入金额，再确认入座。";
    $("mj-join-submit").textContent = "查看房间";
    showDialog("mj-join-dialog");
    if (code) void previewJoin();
  }
  async function previewJoin() {
    const code = $("mj-join-code").value.trim().toUpperCase();
    if (!code) throw new Error("请输入房间号");
    await loadRooms();
    const room = rooms.find((item) => item.code.toUpperCase() === code);
    if (!room) {
      joinPreview = null;
      $("mj-join-preview").textContent = "没有找到这个房间，请检查房号或让朋友重新发送邀请。";
      return false;
    }
    joinPreview = room;
    $("mj-join-code").value = room.code;
    const count = Number(room.playerCount ?? (room.players || []).length);
    $("mj-join-preview").textContent = `${room.practice ? "练习桌 · 使用练习筹码" : "正式桌 · 从钱包带入"} ${money(room.buyIn)}，底分 ${money(room.base)}。${count}/4 人，16 倍封顶、不换三张、不定缺。${count >= 4 && room.code !== savedRoom ? "当前房间已满。" : ""}`;
    $("mj-join-submit").textContent = room.code === savedRoom ? "回到牌桌" : "确认带入并加入";
    return true;
  }
  async function joinRoom(code, resume = false) {
    if (!(await login())) return false;
    busyJoin = true;
    try {
      await connectSocket();
      const result = await emit(resume ? "room:resume" : "room:join", { code });
      rememberRoom(result.code || code);
      $("mj-join-dialog").close();
      scheduleBalance();
      return true;
    } finally { busyJoin = false; }
  }
  function clearRoomUrl() {
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
  }
  function leaveLocal() {
    effects?.reset();
    clearTimeout(eventTimer);
    $("mj-event-banner").hidden = true;
    state = null;
    selected = -1;
    handStamp = "";
    lastRoundId = null;
    lastEventId = null;
    pending = false;
    rememberRoom("");
    clearRoomUrl();
    document.querySelectorAll(".mj-dialog[open]").forEach((dialog) => dialog.close());
    $("mj-lobby").hidden = false;
    $("mj-game").hidden = true;
    scheduleBalance();
    void loadRooms();
  }
  function receiveState(next) {
    if (!next?.code) return;
    const captured = effects?.capture();
    const priorRoundId = state?.round?.id || state?.round?.roundId;
    const priorEventId = state?.round?.events?.at(-1)?.id;
    state = next;
    silenced = false;
    rememberRoom(next.code);
    const url = new URL(location.href);
    url.searchParams.set("room", next.code);
    history.replaceState(null, "", url);
    $("mj-lobby").hidden = true;
    $("mj-game").hidden = false;
    const currentId = round()?.id || round()?.roundId;
    if (currentId !== priorRoundId) {
      selected = -1;
      handStamp = "";
      $("mj-event-banner").hidden = true;
      $("mj-gang-dialog").close();
    }
    renderTable();
    const latest = round()?.events?.at(-1);
    if (!document.hidden && latest && lastRoundId === currentId && lastEventId && latest.id !== lastEventId) showEvent(latest);
    else if (!document.hidden && latest && lastRoundId === currentId && !lastEventId && priorRoundId === currentId) showEvent(latest);
    lastRoundId = currentId;
    lastEventId = latest?.id || null;
    if (latest?.id !== priorEventId || currentId !== priorRoundId) scheduleBalance();
    effects?.update(next, captured);
  }

  function meldMarkup(melds) {
    return (melds || []).map((meld) => `<span class="mj-meld" aria-label="${({ peng: "碰", gang: "明杠", concealedGang: "暗杠", addedGang: "补杠" })[meld.kind || meld.type] || "副露"}">${(meld.tiles || []).map((tile) => tileMarkup(tile)).join("")}</span>`).join("");
  }
  function relativePosition(seat) { return positions[((Number(seat) - Number(self()?.seat || 0)) + 4) % 4]; }
  function renderOpponents() {
    const mine = Number(self()?.seat || 0);
    const html = [];
    for (let offset = 1; offset <= 3; offset += 1) {
      const seat = (mine + offset) % 4;
      const player = playerAt(seat);
      if (!player) {
        html.push(`<div class="mj-opponent mj-opponent-empty pos-${positions[offset]}"><div class="mj-empty-avatar">＋</div><span>等待朋友</span></div>`);
        continue;
      }
      const active = state.phase === "playing" && (round()?.stage === "responses" ? round()?.responses?.waitingSeats?.includes(seat) : Number(round()?.turnSeat) === seat);
      const net = Number(player.net ?? (player.stack - (player.startStack ?? player.stack)));
      const tags = [player.isBot ? "电脑陪练" : "", player.departing ? "结束后离桌" : player.trustee || player.connected === false ? "托管中" : "", state.phase !== "playing" ? player.ready ? "已准备" : "未准备" : ""].filter(Boolean);
      html.push(`<div class="mj-opponent pos-${positions[offset]}" data-player-seat="${seat}"><div class="mj-player-badge"><span class="mj-player-avatar ${active ? "is-active" : ""}"><img src="/avatars/player-${auth.avatarIndex(player.name) + 1}.svg" alt="" />${Number(round()?.dealerSeat) === seat ? '<span class="mj-dealer">庄</span>' : ""}</span><div><span class="mj-player-name">${esc(player.name)}</span><span class="mj-player-stack" data-chip-seat="${seat}">${money(player.stack)}</span></div></div><div class="mj-player-detail"><span class="${scoreClass(net)}">本局 ${signed(net)}</span> <span>· 胡 ${player.huCount ?? player.wins ?? 0} 次</span></div><div class="mj-player-tags">${esc(tags.join(" · "))}</div><div class="mj-hidden-hand" aria-label="${Number(player.handCount || 0)} 张暗牌">${Array.from({ length: Math.min(14, Math.max(0, Number(player.handCount || 0))) }, () => '<span class="mj-tile-back" aria-hidden="true"></span>').join("")}</div><div class="mj-melds">${meldMarkup(player.melds)}</div></div>`);
    }
    renderMarkup($("mj-opponents"), html.join(""));
  }
  function renderRivers() {
    const last = round()?.lastDiscard;
    const previousScroll = new Map([...$("mj-rivers").querySelectorAll("[data-river-seat]")].map((node) => [node.dataset.riverSeat, [node.scrollTop, node.scrollHeight]]));
    renderMarkup($("mj-rivers"), players().map((player) => `<div class="mj-river pos-${relativePosition(player.seat)}" data-river-seat="${player.seat}" aria-label="${esc(player.name)}的弃牌"><span class="mj-river-name">${esc(player.name)}的弃牌</span><div class="mj-river-tiles">${(player.discards || []).map((entry, index, pile) => {
      const tile = typeof entry === "string" ? entry : entry.tile;
      const latest = last && Number(last.seat ?? last.sourceSeat) === Number(player.seat) && index === pile.length - 1 && tile === last.tile && !last.claimed;
      return tileMarkup(tile, { extra: latest ? "is-latest" : "" });
    }).join("")}</div></div>`).join(""));
    $("mj-rivers").querySelectorAll("[data-river-seat]").forEach((node) => {
      const prior = previousScroll.get(node.dataset.riverSeat);
      node.scrollTop = prior && prior[1] === node.scrollHeight ? prior[0] : node.scrollHeight;
    });
  }
  function renderHand() {
    const player = self();
    const hand = player?.hand || [];
    const currentStamp = `${round()?.id || round()?.roundId || ""}:${round()?.turnId || ""}:${hand.join(",")}`;
    if (handStamp !== currentStamp) { handStamp = currentStamp; selected = -1; }
    const discardAllowed = canAct() && legal().actions.includes("discard");
    const scroll = $("mj-hand-scroll").scrollLeft;
    const entries = hand.map((tile, index) => ({ tile, index, drawn: false }));
    const drawnIndex = round()?.drawnTile && hand.length % 3 === 2 ? entries.findLastIndex((entry) => entry.tile === round().drawnTile) : -1;
    if (drawnIndex >= 0) {
      const drawn = entries.splice(drawnIndex, 1)[0];
      drawn.drawn = true;
      entries.push(drawn);
    }
    renderMarkup($("mj-hand"), entries.map(({ tile, index, drawn }) => {
      const valid = discardAllowed && (!legal().discardTiles?.length || legal().discardTiles.includes(tile));
      return tileMarkup(tile, { button: true, index, disabled: !valid, extra: `${selected === index ? "is-selected" : ""} ${!valid ? "is-disabled" : ""}${drawn ? " is-drawn" : ""}` });
    }).join(""));
    renderMarkup($("mj-self-melds"), meldMarkup(player?.melds));
    $("mj-hand-scroll").scrollLeft = scroll;
    const handTip = window.matchMedia("(max-width: 560px) and (orientation: portrait)").matches ? "点选一张牌，再点一次打出" : "点选一张牌，再点一次打出；可左右滑动手牌";
    $("mj-hand-help").textContent = state?.phase === "finished" ? "准备后开始下一局" : player?.departing ? "已安排本局结束后离桌，当前由托管继续" : player?.trustee ? "正在托管，点击「接管」恢复操作" : discardAllowed ? selected >= 0 ? `已选${tileName(hand[selected])}，再点一次打出` : handTip : "等待其他玩家操作";
  }
  function renderActions() {
    const player = self();
    const actions = legal().actions || [];
    const allowed = canAct();
    const controls = [];
    if (state?.phase === "playing" && !player?.departing) controls.push(`<button class="mj-action is-trustee" type="button" data-trustee="${!player?.trustee}" ${!socket?.connected || pending ? "disabled" : ""}>${player?.trustee ? "接管" : "托管"}</button>`);
    for (const [action, label] of [["hu", "胡"], ["peng", "碰"], ["gang", "杠"], ["pass", "过"]]) {
      if (actions.includes(action)) controls.push(`<button class="mj-action ${action === "hu" ? "is-hu" : action === "pass" ? "is-pass" : ""}" type="button" data-action="${action}" ${!allowed ? "disabled" : ""}>${label}</button>`);
    }
    renderMarkup($("mj-actions"), controls.join(""));
    if ($("mj-gang-dialog").open && (!actions.includes("gang") || !allowed)) $("mj-gang-dialog").close();
  }
  function renderTable() {
    if (!state) return;
    const player = self();
    const game = round();
    $("mj-room-code").textContent = state.code;
    $("mj-room-type").textContent = state.practice ? "练习桌" : "正式桌";
    $("mj-room-type").classList.toggle("is-practice", Boolean(state.practice));
    $("mj-room-base").textContent = `底分 ${money(state.base)}`;
    document.querySelector(".mj-hand-area").dataset.playerSeat = player?.seat ?? "";
    renderMarkup($("mj-self-info"), `${esc(player?.name || "我")}<strong data-chip-seat="${player?.seat ?? ""}">${money(player?.stack)}</strong><small>本局 <span class="${scoreClass(player?.net)}">${signed(player?.net)}</span> · 胡 ${player?.huCount ?? player?.wins ?? 0} 次</small>`);
    renderOpponents();
    renderRivers();
    renderHand();
    renderActions();
    const playing = state.phase === "playing";
    $("mj-wall").textContent = game ? `余牌 ${game.wallCount ?? game.remainingTiles ?? 0} 张` : "等待入座";
    $("mj-round-hint").textContent = playing ? game.stage === "responses" ? "等待碰杠胡选择" : `${playerName(game.turnSeat)}出牌` : state.phase === "finished" ? "本局已结算" : "四位玩家准备后开始";
    const last = game?.lastDiscard;
    renderMarkup($("mj-last-discard"), last && playing ? `${tileMarkup(last.tile)}<span class="mj-last-discard-label">${esc(playerName(last.seat ?? last.sourceSeat))}<br />${last.kind === "robKong" ? "申请补杠" : last.huSeats?.length ? "已被胡牌" : last.claimed ? "已被碰杠" : "打出"}</span>` : "");
    $("mj-ready-panel").hidden = playing || Boolean(player?.departing);
    $("mj-ready-hint").textContent = state.phase === "finished" ? "四位玩家准备后，开始下一局" : `${players().length}/4 人已入座 · ${players().filter((p) => p.ready).length}/4 已准备`;
    $("mj-ready").textContent = player?.ready ? "已准备 · 点击取消" : state.phase === "finished" ? "准备下一局" : "准备";
    $("mj-ready").disabled = !socket?.connected || pending;
    $("mj-round-result").hidden = state.phase !== "finished";
    if (state.phase === "finished") {
      renderMarkup($("mj-round-result"), `<h2>本局结算</h2><p>${game?.endReason === "bankrupt" ? "有玩家筹码不足，本局结束" : "牌墙摸完，下局再见好牌"}</p><div class="mj-result-players">${players().map((item) => `<div class="mj-result-row"><span>${esc(item.name)}<small>胡 ${item.huCount ?? item.wins ?? 0} 次 · 余 ${money(item.stack)}</small></span><strong class="${scoreClass(item.net)}">${signed(item.net)}</strong></div>`).join("")}</div>`);
    }
    if ($("mj-ledger-dialog").open) renderLedger();
    renderCountdown();
    icons();
  }
  function renderCountdown() {
    if (!state) return;
    const player = self();
    const game = round();
    const active = state.phase === "playing";
    $("mj-turn-label").textContent = !socket?.connected ? "连接中，恢复后继续" : state.phase === "finished" ? "本局已结束" : player?.departing ? "本局结束后离桌" : player?.trustee ? "托管中" : !active ? "等待准备" : game?.responses?.ownPending ? "请选择碰、杠、胡或过" : legal().actions?.includes("discard") ? "轮到你出牌" : "等待其他玩家";
    const deadline = Number(game?.deadline || state.deadline || 0);
    $("mj-countdown").textContent = active && deadline > Date.now() ? String(Math.ceil((deadline - Date.now()) / 1000)) : "";
  }
  function eventTitle(event) {
    if (event.kind === "hu") {
      const winners = event.winners || [];
      return winners.length > 1 ? `一炮 ${winners.length} 响` : `${playerName(winners[0]?.seat)} ${event.selfDraw ? "自摸" : "胡牌"}`;
    }
    return `${playerName(event.seat ?? event.sourceSeat)}${({ concealedGang: "暗杠", addedGang: "补杠", gang: "明杠", exposedGang: "明杠" })[event.gangKind] || "杠牌"}`;
  }
  function showEvent(event) {
    clearTimeout(eventTimer);
    const detail = (event.winners || []).map((winner) => `${event.winners.length > 1 ? `${playerName(winner.seat)} · ` : ""}${winner.hand?.name || winner.name || "胡牌"} ${winner.hand?.multiplier || winner.multiplier || 1} 倍`).join(" / ");
    $("mj-event-banner").innerHTML = `<strong>${esc(eventTitle(event))}</strong>${esc(detail || "已计入本局账单")}`;
    $("mj-event-banner").hidden = false;
    eventTimer = setTimeout(() => { $("mj-event-banner").hidden = true; }, 3000);
  }
  function renderLedger() {
    const events = round()?.events || [];
    $("mj-ledger-content").innerHTML = events.length ? [...events].reverse().map((event, index) => `<article class="mj-ledger-item"><h3>${events.length - index}. ${esc(eventTitle(event))}</h3>${(event.winners || []).map((winner) => `<p>${esc(playerName(winner.seat))} · ${esc(winner.hand?.name || winner.name || "胡牌")} · ${winner.hand?.multiplier || winner.multiplier || 1} 倍</p><div class="mj-ledger-tiles">${(winner.tiles || winner.hand?.tiles || []).map((tile) => tileMarkup(tile)).join("")}</div>`).join("")}<div class="mj-ledger-deltas">${(event.changes || []).filter((change) => change.delta).map((change) => `<span>${esc(playerName(change.seat))} <strong class="${scoreClass(change.delta)}">${signed(change.delta)}</strong></span>`).join("")}</div></article>`).join("") : '<p class="mj-dialog-note">本局还没有胡牌或杠牌记录。每次结算会在这里列出各家的筹码变化。</p>';
  }
  async function act(action, tile) {
    if (!canAct() || !legal().actions.includes(action)) return;
    const payload = { roundId: round().id || round().roundId, turnId: round().turnId, requestId: requestId(), action, ...(tile ? { tile } : {}) };
    pending = true;
    renderActions();
    renderHand();
    try { await emit("game:action", payload); }
    catch (error) { toast(error.message); }
    finally { pending = false; renderTable(); }
  }

  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.querySelectorAll("[data-open-rules]").forEach((button) => button.addEventListener("click", () => showDialog("mj-rules-dialog")));
  $("mj-create-open").addEventListener("click", async () => { if (await login()) showDialog("mj-create-dialog"); });
  $("mj-join-open").addEventListener("click", () => openJoin());
  $("mj-refresh").addEventListener("click", () => { void loadRooms(); });
  $("mj-resume-button").addEventListener("click", () => { void joinRoom(savedRoom, true).catch((error) => toast(error.message)); });
  $("mj-room-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-join-room]");
    if (!button) return;
    const code = button.dataset.joinRoom;
    if (code === savedRoom) void joinRoom(code, true).catch((error) => toast(error.message));
    else openJoin(code);
  });
  $("mj-practice").addEventListener("change", () => { $("mj-buyin-hint").textContent = $("mj-practice").checked ? "练习桌自动安排三位电脑陪练，练习筹码不影响钱包与财富榜。" : "带入筹码从钱包扣除，离桌时退回剩余筹码。"; });
  $("mj-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const errorNode = form.querySelector("[data-form-error]");
    button.disabled = true;
    errorNode.hidden = true;
    busyJoin = true;
    try {
      if (!(await login())) return;
      await connectSocket();
      const result = await emit("room:create", { base: Number($("mj-base").value), buyIn: Number($("mj-buyin").value), practice: $("mj-practice").checked });
      rememberRoom(result.code || state?.code);
      $("mj-create-dialog").close();
      scheduleBalance();
    } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
    finally { busyJoin = false; button.disabled = false; }
  });
  $("mj-join-code").addEventListener("input", () => { joinPreview = null; $("mj-join-submit").textContent = "查看房间"; $("mj-join-preview").textContent = "先查看规则与带入金额，再确认入座。"; });
  $("mj-join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorNode = event.currentTarget.querySelector("[data-form-error]");
    errorNode.hidden = true;
    $("mj-join-submit").disabled = true;
    try {
      if (!joinPreview) await previewJoin();
      else await joinRoom(joinPreview.code, joinPreview.code === savedRoom);
    } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
    finally { $("mj-join-submit").disabled = false; }
  });
  $("mj-hand").addEventListener("click", (event) => {
    const tile = event.target.closest("[data-hand-index]");
    if (!tile || tile.disabled || !canAct()) return;
    const index = Number(tile.dataset.handIndex);
    if (selected === index) { selected = -1; void act("discard", self().hand[index]); }
    else { selected = index; renderHand(); }
  });
  $("mj-actions").addEventListener("click", async (event) => {
    const trustee = event.target.closest("[data-trustee]");
    if (trustee) {
      trustee.disabled = true;
      try { await emit("room:trustee", { enabled: trustee.dataset.trustee === "true" }); }
      catch (error) { toast(error.message); }
      finally { trustee.disabled = false; renderTable(); }
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    if (button.dataset.action === "gang") {
      const options = legal().gangTiles || [];
      if (options.length === 1) void act("gang", typeof options[0] === "string" ? options[0] : options[0].tile);
      else {
        $("mj-gang-options").innerHTML = options.map((tile) => tileMarkup(typeof tile === "string" ? tile : tile.tile, { button: true })).join("");
        showDialog("mj-gang-dialog");
      }
    } else void act(button.dataset.action);
  });
  $("mj-gang-options").addEventListener("click", (event) => {
    const button = event.target.closest("[data-gang-tile]");
    if (!button) return;
    $("mj-gang-dialog").close();
    void act("gang", button.dataset.gangTile);
  });
  $("mj-ready").addEventListener("click", async () => {
    if (pending) return;
    pending = true;
    renderTable();
    try { await emit("room:ready", { ready: !self()?.ready }); }
    catch (error) { toast(error.message); }
    finally { pending = false; renderTable(); }
  });
  $("mj-ledger-open").addEventListener("click", () => { renderLedger(); showDialog("mj-ledger-dialog"); });
  $("mj-copy-room").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("邀请链接已复制，发给朋友即可加入"); }
    catch { toast(`房号 ${state?.code}，朋友打开麻将后选择「房号加入」`); }
  });
  $("mj-leave-open").addEventListener("click", () => {
    $("mj-leave-note").textContent = state?.phase === "playing" ? "本局将由托管继续，结束后自动离桌并退回剩余筹码。已经发生的输赢会保留。" : state?.practice ? "离开练习桌，练习筹码不会计入钱包。" : `离桌后，剩余 ${money(self()?.stack)} 筹码退回钱包。`;
    $("mj-leave-confirm").textContent = state?.phase === "playing" ? "本局结束后离桌" : "确认离桌";
    showDialog("mj-leave-dialog");
  });
  $("mj-leave-confirm").addEventListener("click", async () => {
    $("mj-leave-confirm").disabled = true;
    try {
      const result = await emit("room:leave");
      $("mj-leave-dialog").close();
      if (result.pending) toast("已安排本局结束后离桌，当前由托管继续");
      else if (state) leaveLocal();
    } catch (error) { toast(error.message); }
    finally { $("mj-leave-confirm").disabled = false; }
  });
  window.addEventListener("tongzhuo:logout", () => {
    socket?.disconnect();
    socket = null;
    socketToken = null;
    leaveLocal();
    topbar.setAccount(null);
  });
  window.addEventListener("tongzhuo:claim-subsidy", async () => {
    try { await auth.api("/api/me/subsidy", { method: "POST", body: "{}" }); await refreshBalance(); toast("每日补助已到账"); }
    catch (error) { toast(error?.error || "暂时无法领取补助"); }
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== "tongzhuo-auth") return;
    const current = auth.get();
    topbar.setAccount(current);
    if (socketToken && current?.token !== socketToken) { socket?.disconnect(); socket = null; socketToken = null; leaveLocal(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(eventTimer); $("mj-event-banner").hidden = true; }
    else if (state) scheduleBalance(); else void loadRooms();
  });
  window.addEventListener("pagehide", () => effects?.reset());
  window.addEventListener("resize", () => { if (state) renderHand(); });
  setInterval(renderCountdown, 250);
  setInterval(() => { if (!state && !document.hidden) void loadRooms(); }, 15000);
  topbar.setAccount(auth.get());
  renderResume();
  icons();
  void loadRooms();
  if (auth.get()) void refreshBalance();
  const requestedRoom = new URL(location.href).searchParams.get("room");
  if (savedRoom && auth.get() && (!requestedRoom || requestedRoom === savedRoom)) {
    void connectSocket().catch((error) => toast(error.message));
  } else if (requestedRoom) openJoin(requestedRoom);
})();
