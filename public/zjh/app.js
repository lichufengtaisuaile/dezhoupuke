(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const auth = window.tongzhuoAuth;
  const esc = auth.esc;
  const money = auth.money;
  const ROOM_KEY = "tongzhuo-zjh-room";
  const suits = { clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" };
  const redSuits = new Set(["diamonds", "hearts"]);
  let socket = null;
  let socketToken = null;
  let state = null;
  let rooms = [];
  let savedRoom = readRoom();
  let pending = false;
  let toastTimer;
  let balanceTimer;
  let actionPanel = null;
  let lastFinishedRound = null;
  const topbar = window.createTopbar({ mount: $("zjh-identity"), onRequireAuth: login });

  function icons() { window.lucide?.createIcons(); }
  function toast(message) {
    clearTimeout(toastTimer);
    $("zjh-toast").textContent = message;
    $("zjh-toast").hidden = false;
    toastTimer = setTimeout(() => { $("zjh-toast").hidden = true; }, 4200);
  }
  function showDialog(id) {
    const dialog = $(id);
    const error = dialog.querySelector("[data-form-error]");
    if (error) error.hidden = true;
    if (!dialog.open) dialog.showModal();
  }
  function readRoom() {
    try {
      const saved = JSON.parse(localStorage.getItem(ROOM_KEY) || "null");
      return saved && saved.account === auth.get()?.name ? String(saved.code || "") : "";
    } catch { return ""; }
  }
  function rememberRoom(code) {
    savedRoom = code || "";
    try {
      if (savedRoom) localStorage.setItem(ROOM_KEY, JSON.stringify({ code: savedRoom, account: auth.get()?.name }));
      else localStorage.removeItem(ROOM_KEY);
    } catch { /* Connection state remains authoritative. */ }
    renderResume();
  }
  function self() { return state?.players?.find(player => player.id === state.selfId); }
  function roundPlayer(seat) { return state?.round?.players?.find(player => Number(player.seat) === Number(seat)); }
  function mergedPlayers() {
    return (state?.players || []).map(player => ({ ...roundPlayer(player.seat), ...player }));
  }
  function signed(value) {
    const number = Number(value || 0);
    return `${number > 0 ? "+" : number < 0 ? "−" : ""}${money(Math.abs(number))}`;
  }
  function requestId() {
    return window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  function cardMarkup(card, small = false) {
    if (!card) return `<span class="${small ? "zjh-card-back" : "zjh-own-card back"}" aria-label="暗牌"></span>`;
    const red = redSuits.has(card.suit) ? " red" : "";
    const rank = card.rank === "T" ? "10" : card.rank;
    return small
      ? `<span class="zjh-mini-card${red}" aria-label="${esc(rank)}${suits[card.suit]}">${esc(rank)}${suits[card.suit]}</span>`
      : `<span class="zjh-own-card${red}" aria-label="${esc(rank)}${suits[card.suit]}"><b>${esc(rank)}</b><i>${suits[card.suit]}</i></span>`;
  }

  async function refreshBalance() {
    const account = await auth.refreshBalance();
    topbar.setAccount(auth.get() ? account : null);
    window.dispatchEvent(new CustomEvent("tongzhuo:balance"));
  }
  function scheduleBalance() {
    clearTimeout(balanceTimer);
    balanceTimer = setTimeout(() => void refreshBalance(), 200);
  }
  async function login() {
    if (!auth.get()) {
      const ok = await auth.openAuthModal();
      if (!ok) return false;
    }
    topbar.setAccount(auth.get());
    void refreshBalance();
    return true;
  }
  function emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error("连接已断开，正在重新连接"));
      socket.timeout(10000).emit(event, payload, (error, result) => {
        if (error) return reject(new Error("响应超时，请等待牌桌同步"));
        if (!result?.ok) return reject(new Error(result?.error || "操作没有完成"));
        resolve(result);
      });
    });
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
      socket = window.io("/zjh", { auth: { token: account.token }, autoConnect: false });
      socket.on("lobby:state", data => { rooms = data?.rooms || []; renderRooms(); });
      socket.on("room:state", receiveState);
      socket.on("account:avatar", auth.applyAvatar);
      socket.on("room:left", leaveLocal);
      socket.on("session:replaced", data => { leaveLocal(); toast(data?.reason || "座位已在其他页面打开"); });
      socket.on("disconnect", () => { pending = false; renderTable(); });
      socket.on("connect", () => {
        if (savedRoom && !state) emit("room:resume", { code: savedRoom }).catch(() => rememberRoom(""));
        socket.emit("room:list", {});
      });
    }
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接超时，请检查网络")), 10000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("connect_error", error => { clearTimeout(timer); reject(new Error(error?.message || "连接失败")); });
      socket.connect();
    });
  }

  async function loadRooms() {
    try {
      const response = await fetch("/api/zjh/rooms");
      const data = await response.json();
      if (!data.ok) throw new Error(data.error);
      rooms = data.rooms || [];
      renderRooms();
    } catch {
      $("zjh-room-list").innerHTML = '<p class="zjh-empty">房间加载失败，请稍后刷新。</p>';
    }
  }
  function renderRooms() {
    $("zjh-room-list").innerHTML = rooms.length ? rooms.map(room => {
      const players = room.players || [];
      const avatars = players.slice(0, 8).map(player => `<span title="${esc(player.name)}"><img src="${auth.avatarSource(player.name, player.avatar)}" alt="${esc(player.name)}" /></span>`).join("");
      const full = room.playerCount >= 8;
      return `<article class="zjh-room-card">
        <div class="zjh-room-card-head"><h3>#${esc(room.code)}</h3><span class="zjh-room-count">${money(room.playerCount)} / 8 人</span></div>
        <p>最小下注 ${money(room.minBet)} · ${room.twoThreeFiveBeatsTrips ? "235 吃豹子" : "普通牌型规则"}${room.phase === "playing" ? " · 对局中可旁入等待" : ""}</p>
        <div class="zjh-room-avatars">${avatars}</div>
        <button class="button secondary" type="button" data-join="${esc(room.code)}" ${full && room.code !== savedRoom ? "disabled" : ""}>${room.code === savedRoom ? "返回牌桌" : full ? "已坐满" : "加入牌桌"}</button>
      </article>`;
    }).join("") : '<p class="zjh-empty">还没有炸金花牌桌。<br />创建一桌，把房号发给朋友。</p>';
    icons();
  }
  function renderResume() {
    $("zjh-resume").hidden = !savedRoom || Boolean(state);
    $("zjh-resume-code").textContent = savedRoom ? `房号 ${savedRoom} · 托管筹码仍在桌上` : "";
  }

  function receiveState(next) {
    const finished = next?.round?.phase === "finished" ? next.round.id : null;
    if (finished && finished !== lastFinishedRound) {
      lastFinishedRound = finished;
      scheduleBalance();
    }
    state = next;
    actionPanel = null;
    rememberRoom(next.code);
    $("zjh-lobby").hidden = true;
    $("zjh-game").hidden = false;
    document.body.classList.add("in-zjh-room");
    renderTable();
  }
  function leaveLocal() {
    state = null;
    actionPanel = null;
    rememberRoom("");
    $("zjh-game").hidden = true;
    $("zjh-lobby").hidden = false;
    document.body.classList.remove("in-zjh-room");
    scheduleBalance();
    void loadRooms();
  }
  function visualPositions() {
    const players = mergedPlayers();
    const ownSeat = Number(self()?.seat ?? players[0]?.seat ?? 0);
    const ordered = [...players].sort((left, right) =>
      ((Number(left.seat) - ownSeat + 8) % 8) - ((Number(right.seat) - ownSeat + 8) % 8));
    const layouts = {
      1: [0],
      2: [0, 4],
      3: [0, 3, 5],
      4: [0, 2, 4, 6],
      5: [0, 2, 3, 5, 6],
      6: [0, 1, 2, 4, 6, 7],
      7: [0, 1, 2, 3, 4, 5, 7],
      8: [0, 1, 2, 3, 4, 5, 6, 7],
    };
    return new Map(ordered.map((player, index) => [player.seat, layouts[ordered.length][index]]));
  }
  function renderSeats() {
    const positions = visualPositions();
    $("zjh-seats").innerHTML = mergedPlayers().map(player => {
      const inRound = Boolean(roundPlayer(player.seat));
      const cards = player.cards && (player.seen || state.round?.phase === "finished") ? player.cards.map(card => cardMarkup(card, true)).join("")
        : inRound ? Array.from({ length: 3 }, () => cardMarkup(null, true)).join("") : "";
      const status = player.departing ? "本局后离桌" : player.trustee ? "托管中" : player.folded ? (player.comparedOut ? "比牌落败" : "已弃牌")
        : player.seen ? "已看牌" : inRound ? (player.lastAction || "暗牌") : player.ready ? "等待下一局" : "未准备";
      return `<article class="zjh-seat pos-${positions.get(player.seat)}${state.round?.turnSeat === player.seat ? " is-turn" : ""}${player.folded ? " is-folded" : ""}">
        <div class="zjh-mini-cards">${cards}</div>
        <div class="zjh-seat-main">
          <span class="zjh-seat-avatar"><img src="${auth.avatarSource(player.name, player.avatar)}" alt="" /><i class="${player.connected ? "" : "offline"}"></i></span>
          <span class="zjh-seat-info"><strong>${esc(player.name)}</strong><span>${money(player.stack)}</span></span>
        </div>
        <span class="zjh-seat-state">${esc(status)}</span>
      </article>`;
    }).join("");
  }
  function renderOwnCards() {
    const me = roundPlayer(self()?.seat);
    if (!me) {
      $("zjh-own-cards").innerHTML = "";
      return;
    }
    const visible = me.seen || state.round.phase === "finished";
    $("zjh-own-cards").innerHTML = Array.from({ length: 3 }, (_, index) => cardMarkup(visible ? me.cards?.[index] : null)).join("");
  }
  function renderActions() {
    const legal = state?.round?.legal || { actions: [] };
    const me = self();
    if (!state || state.phase !== "playing" || !me?.inRound) {
      $("zjh-actions").innerHTML = "";
      $("zjh-action-panel").hidden = true;
      return;
    }
    if (me.trustee) {
      $("zjh-actions").innerHTML = '<button class="button primary" type="button" data-trustee="false">接管操作</button>';
      $("zjh-action-panel").hidden = true;
      return;
    }
    const can = !pending && socket?.connected && state.round.turnSeat === me.seat;
    const button = (action, label, cls = "secondary") => `<button class="button ${cls}" type="button" data-action="${action}" ${!can || !legal.actions.includes(action) ? "disabled" : ""}>${label}</button>`;
    $("zjh-actions").innerHTML = [
      button("peek", "看牌"),
      button("call", legal.callAmount ? `跟注 ${money(legal.callAmount)}` : "跟注", "primary"),
      button("raise", "加注"),
      button("compare", "比牌"),
      button("fold", "弃牌", "danger"),
    ].join("");
    renderActionPanel(can);
  }
  function renderActionPanel(can) {
    const panel = $("zjh-action-panel");
    const legal = state.round.legal;
    if (!actionPanel || !can) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    panel.hidden = false;
    if (actionPanel === "raise") {
      panel.innerHTML = `<div class="zjh-action-panel-row"><input id="zjh-raise-value" type="number" min="${legal.raiseMin}" max="${legal.raiseMax}" step="${state.minBet}" value="${legal.raiseMin}" inputmode="numeric" aria-label="加注后的暗注额度" /><button class="button primary" type="button" data-confirm-raise>确认加注</button><button class="icon-button" type="button" data-close-panel aria-label="取消"><i data-lucide="x"></i></button></div>`;
    } else {
      const targets = legal.compareSeats.map(seat => mergedPlayers().find(player => player.seat === seat)).filter(Boolean);
      panel.innerHTML = `<div class="zjh-targets">${targets.map(player => `<button type="button" data-compare-seat="${player.seat}"><img src="${auth.avatarSource(player.name, player.avatar)}" alt="" />与 ${esc(player.name)} 比牌</button>`).join("")}</div>`;
    }
    icons();
  }
  function renderWaiting() {
    const box = $("zjh-waiting");
    const me = self();
    const playing = state.phase === "playing";
    const waiting = !me?.inRound;
    box.hidden = playing && !waiting;
    if (box.hidden) return;
    $("zjh-ready").hidden = playing;
    if (playing) {
      $("zjh-waiting-text").textContent = "本局正在进行，你将在下一局准备后加入";
      return;
    }
    $("zjh-ready").hidden = false;
    $("zjh-ready").disabled = pending || !socket?.connected;
    $("zjh-ready").textContent = me?.ready ? "取消准备" : "准备";
    const readyCount = state.players.filter(player => player.ready && player.connected && player.stack >= state.minBet).length;
    $("zjh-waiting-text").textContent = state.phase === "finished"
      ? (me?.ready ? `已准备 · ${readyCount} 人就绪，下一局即将开始` : "上一局结束，准备后加入下一局")
      : `${readyCount} 人已准备，至少两人开局`;
  }
  function renderTable() {
    if (!state) return;
    $("zjh-room-code").textContent = `#${state.code}`;
    $("zjh-room-rule").textContent = `最小下注 ${money(state.minBet)} · ${state.twoThreeFiveBeatsTrips ? "235 吃豹子" : "235 不吃豹子"}`;
    $("zjh-round-label").textContent = state.round ? `第 ${money(state.round.number)} 局 · 第 ${money(state.round.bettingRound)} 轮` : "等待开局";
    $("zjh-pot").textContent = `底池 ${money(state.round?.pot || state.round?.finalPot || 0)}`;
    $("zjh-current-bet").textContent = state.round ? `当前暗注 ${money(state.round.currentBet)}` : `最小下注 ${money(state.minBet)}`;
    const result = $("zjh-result");
    if (state.round?.phase === "finished" && state.round.result) {
      result.hidden = false;
      result.innerHTML = `<strong>${esc(state.round.result.winnerName)} 赢得 ${money(state.round.result.amount)}</strong><span>${esc(state.round.result.reason)}${state.round.result.hand ? ` · ${esc(state.round.result.hand.name)}` : ""}</span>`;
    } else {
      result.hidden = true;
    }
    const me = self();
    const myRound = roundPlayer(me?.seat);
    $("zjh-self-summary").innerHTML = `<strong>${esc(me?.name || "")}</strong><span>桌上 ${money(me?.stack)}</span>${myRound?.seen && state.round?.selfHand ? `<span>· ${esc(state.round.selfHand.name)}</span>` : ""}`;
    $("zjh-turn-text").textContent = state.phase === "playing"
      ? state.round.turnSeat === me?.seat ? (me.trustee ? "托管代打" : "轮到你") : `等待 ${esc(mergedPlayers().find(player => player.seat === state.round.turnSeat)?.name || "其他玩家")}`
      : "等待下一局";
    renderSeats();
    renderOwnCards();
    renderActions();
    renderWaiting();
    renderCountdown();
    icons();
  }
  function renderCountdown() {
    const countdown = $("zjh-countdown");
    if (state?.phase === "finished" && state.nextRoundAt) {
      const seconds = Math.max(0, Math.ceil((state.nextRoundAt - Date.now()) / 1000));
      countdown.textContent = `${seconds}s`;
      return;
    }
    if (!state?.round?.deadline || state.phase !== "playing") {
      countdown.textContent = "";
      return;
    }
    const seconds = Math.max(0, Math.ceil((state.round.deadline - Date.now()) / 1000));
    countdown.textContent = state.round.turnSeat === self()?.seat ? `${seconds}s` : "";
  }
  async function act(action, extra = {}) {
    if (pending) return;
    pending = true;
    actionPanel = null;
    renderActions();
    try {
      await emit("game:action", {
        action,
        ...extra,
        roundId: state.round.id,
        turnId: state.round.turnId,
        requestId: requestId(),
      });
    } catch (error) {
      toast(error.message);
    } finally {
      pending = false;
      renderTable();
    }
  }
  async function joinRoom(code, resume = false) {
    if (!(await login())) return;
    await connectSocket();
    const result = await emit(resume ? "room:resume" : "room:join", { code });
    rememberRoom(result.code || code);
    $("zjh-join-dialog").close();
    scheduleBalance();
  }

  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  document.querySelectorAll("[data-open-rules]").forEach(button => button.addEventListener("click", () => showDialog("zjh-rules-dialog")));
  $("zjh-create-open").addEventListener("click", async () => { if (await login()) showDialog("zjh-create-dialog"); });
  $("zjh-join-open").addEventListener("click", () => showDialog("zjh-join-dialog"));
  $("zjh-refresh").addEventListener("click", loadRooms);
  $("zjh-resume-button").addEventListener("click", () => joinRoom(savedRoom, true).catch(error => toast(error.message)));
  $("zjh-room-list").addEventListener("click", event => {
    const button = event.target.closest("[data-join]");
    if (!button) return;
    if (button.dataset.join === savedRoom) joinRoom(savedRoom, true).catch(error => toast(error.message));
    else {
      $("zjh-join-code").value = button.dataset.join;
      const room = rooms.find(item => item.code === button.dataset.join);
      $("zjh-join-preview").textContent = `最小下注 ${money(room?.minBet)}，将带入钱包中的全部可用筹码。`;
      showDialog("zjh-join-dialog");
    }
  });
  $("zjh-create-form").addEventListener("submit", async event => {
    event.preventDefault();
    const error = event.currentTarget.querySelector("[data-form-error]");
    const submit = event.currentTarget.querySelector('[type="submit"]');
    error.hidden = true; submit.disabled = true;
    try {
      if (!(await login())) return;
      await connectSocket();
      const result = await emit("room:create", {
        minBet: Number($("zjh-min-bet").value),
        twoThreeFiveBeatsTrips: $("zjh-rule-235").checked,
      });
      rememberRoom(result.code);
      $("zjh-create-dialog").close();
      scheduleBalance();
    } catch (caught) {
      error.textContent = caught.message;
      error.hidden = false;
    } finally { submit.disabled = false; }
  });
  $("zjh-join-form").addEventListener("submit", async event => {
    event.preventDefault();
    const error = event.currentTarget.querySelector("[data-form-error]");
    const submit = event.currentTarget.querySelector('[type="submit"]');
    error.hidden = true; submit.disabled = true;
    try { await joinRoom($("zjh-join-code").value.trim().toUpperCase(), false); }
    catch (caught) { error.textContent = caught.message; error.hidden = false; }
    finally { submit.disabled = false; }
  });
  $("zjh-ready").addEventListener("click", async () => {
    if (pending) return;
    pending = true; renderWaiting();
    try { await emit("room:ready", { ready: !self()?.ready }); }
    catch (error) { toast(error.message); }
    finally { pending = false; renderTable(); }
  });
  $("zjh-actions").addEventListener("click", event => {
    const trustee = event.target.closest("[data-trustee]");
    if (trustee) {
      emit("room:trustee", { enabled: false }).catch(error => toast(error.message));
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    if (button.dataset.action === "raise" || button.dataset.action === "compare") {
      actionPanel = actionPanel === button.dataset.action ? null : button.dataset.action;
      renderActions();
    } else {
      void act(button.dataset.action);
    }
  });
  $("zjh-action-panel").addEventListener("click", event => {
    if (event.target.closest("[data-close-panel]")) { actionPanel = null; renderActions(); return; }
    if (event.target.closest("[data-confirm-raise]")) {
      void act("raise", { bet: Number($("zjh-raise-value").value) });
      return;
    }
    const target = event.target.closest("[data-compare-seat]");
    if (target) void act("compare", { targetSeat: Number(target.dataset.compareSeat) });
  });
  $("zjh-invite").addEventListener("click", async () => {
    const url = `${location.origin}/zjh/?room=${encodeURIComponent(state.code)}`;
    try { await navigator.clipboard.writeText(url); toast("邀请链接已复制"); }
    catch { toast(`房号 ${state.code}`); }
  });
  $("zjh-leave-open").addEventListener("click", () => {
    $("zjh-leave-note").textContent = state.phase === "playing"
      ? "离桌后本局进入托管，轮到你时自动弃牌；本局结束后退回剩余筹码。"
      : `离桌后，剩余 ${money(self()?.stack)} 筹码退回钱包。`;
    $("zjh-leave-confirm").textContent = state.phase === "playing" ? "本局结束后离桌" : "确认离桌";
    showDialog("zjh-leave-dialog");
  });
  $("zjh-leave-confirm").addEventListener("click", async () => {
    const button = $("zjh-leave-confirm");
    button.disabled = true;
    try {
      const result = await emit("room:leave");
      $("zjh-leave-dialog").close();
      if (result.pending) toast("已进入托管，本局结束后自动离桌");
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  window.addEventListener("tongzhuo:logout", () => {
    socket?.disconnect(); socket = null; socketToken = null; leaveLocal(); topbar.setAccount(null);
  });
  window.addEventListener("tongzhuo:claim-subsidy", async () => {
    try { await auth.api("/api/me/subsidy", { method: "POST", body: "{}" }); await refreshBalance(); toast("每日补助已到账"); }
    catch (error) { toast(error?.error || "暂时无法领取补助"); }
  });
  setInterval(renderCountdown, 250);
  setInterval(() => { if (!state && !document.hidden) void loadRooms(); }, 15000);
  topbar.setAccount(auth.get());
  renderResume();
  icons();
  void loadRooms();
  if (auth.get()) void refreshBalance();
  const requestedRoom = new URL(location.href).searchParams.get("room");
  if (savedRoom && auth.get() && (!requestedRoom || requestedRoom === savedRoom)) connectSocket().catch(error => toast(error.message));
  else if (requestedRoom) {
    $("zjh-join-code").value = requestedRoom;
    showDialog("zjh-join-dialog");
  }
})();
