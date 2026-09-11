(() => {
  "use strict";

  const AUTH_KEY = "tongzhuo-auth";
  const SUBSIDY_THRESHOLD = 2000;
  const LEDGER_TYPES = {
    REGISTER_GRANT: "注册赠送",
    SUBSIDY: "每日补助",
    BRING_IN: "带入牌桌",
    CASH_OUT: "离桌退回",
    HAND_WIN: "手牌输赢",
    PRACTICE: "练习筹码",
    SLOT_BET: "老虎机下注",
    SLOT_WIN: "老虎机派奖",
    MAHJONG_SETTLE: "麻将桌内输赢",
    ADMIN_ADJUST: "管理员调整",
  };
  const TRANSFER_TYPES = new Set(["BRING_IN", "CASH_OUT"]);
  const suitSymbols = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
  const SLOT_SYMBOL_LABELS = {
    seven: "幸运 7", diamond: "钻石", bell: "金铃", bar: "BAR",
    cherry: "樱桃", lemon: "柠檬", clover: "四叶草",
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
  const money = (value) => Number(value || 0).toLocaleString("zh-CN");
  const signedMoney = (value) => `${Number(value) > 0 ? "+" : "−"}${money(Math.abs(Number(value) || 0))}`;
  const icons = () => window.lucide?.createIcons();
  const fmtTime = (value) => {
    const date = new Date(Number(value) || 0);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  function get() {
    try {
      const data = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
      return data && typeof data.token === "string" && data.token ? data : null;
    } catch {
      return null;
    }
  }
  function write(data) {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(data)); } catch { /* Storage may be disabled. */ }
  }
  function clear(notify = true) {
    const had = Boolean(get());
    try { localStorage.removeItem(AUTH_KEY); } catch { /* Storage may be disabled. */ }
    overviewData = null;
    boardEntries = null;
    if (had && notify) window.dispatchEvent(new CustomEvent("tongzhuo:logout"));
  }

  async function api(path, options = {}) {
    const account = get();
    const headers = { ...(options.headers || {}) };
    if (account) headers.Authorization = `Bearer ${account.token}`;
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch {
      throw { status: 0, error: "网络连接失败，请稍后重试" };
    }
    let data = null;
    try { data = await response.json(); } catch { /* 非 JSON 响应 */ }
    if (response.status === 401) {
      clear();
      throw { status: 401, error: "登录已过期，请重新登录" };
    }
    if (!response.ok) throw { status: response.status, error: data?.error || "请求失败，请稍后重试" };
    return data;
  }

  async function refreshBalance() {
    const account = get();
    if (!account) return null;
    try {
      const data = await api("/api/me/overview");
      const next = { ...account, ...pickStats(data) };
      write(next);
      return next;
    } catch {
      return account;
    }
  }
  function pickStats(data) {
    return {
      balance: data.balance ?? 0,
      tableStack: data.tableStack ?? 0,
      totalAssets: data.totalAssets ?? data.balance ?? 0,
      rank: data.rank ?? null,
      totalPlayers: data.totalPlayers ?? null,
      netProfit: data.netProfit ?? 0,
      handsPlayed: data.handsPlayed ?? 0,
      winRate: data.winRate ?? 0,
      slotSpins: data.slotSpins ?? 0,
      slotNet: data.slotNet ?? 0,
      mahjongRounds: data.mahjongRounds ?? 0,
      mahjongNet: data.mahjongNet ?? 0,
      mahjongHuCount: data.mahjongHuCount ?? 0,
    };
  }

  function avatarIndex(name) {
    const hash = [...String(name || "player")].reduce((value, ch) => (value * 31 + ch.codePointAt(0)) >>> 0, 0);
    return hash % 6;
  }
  function avatarMarkup(name) {
    return `<span class="account-avatar"><img src="/avatars/player-${avatarIndex(name) + 1}.svg" width="64" height="64" alt="" draggable="false" /></span>`;
  }
  function cardMarkup(card) {
    if (!card) return "";
    const suit = suitSymbols[card.suit] || "♠";
    const rank = card.rank === "T" ? "10" : card.rank;
    const red = card.suit === "hearts" || card.suit === "diamonds";
    return `<div class="playing-card ${red ? "red" : ""}" aria-label="${esc(rank)} ${suit}"><span class="card-corner"><span class="card-rank">${esc(rank)}</span><span class="card-suit">${suit}</span></span><span class="card-symbol">${suit}</span></div>`;
  }
  const miniCards = (cards) => `<span class="hand-mini-cards">${(cards || []).map(cardMarkup).join("")}</span>`;

  // ---------- 登录 / 注册 ----------

  let authDialog = null;
  let authResolve = null;
  let authTab = "login";

  function buildAuthDom() {
    if (authDialog) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <dialog class="home-dialog account-dialog" data-auth-dialog aria-labelledby="account-auth-title">
        <div class="home-dialog-heading"><h2 id="account-auth-title" data-auth-heading>登录</h2><button type="button" class="icon-button" data-auth-close aria-label="关闭" title="关闭"><i data-lucide="x"></i></button></div>
        <div class="account-tabs" role="group" aria-label="登录或注册">
          <button type="button" data-auth-tab="login" aria-pressed="true">登录</button>
          <button type="button" data-auth-tab="register" aria-pressed="false">注册</button>
        </div>
        <form data-auth-form class="home-dialog-form" autocomplete="off">
          <label for="account-auth-name">昵称</label>
          <div class="input-wrap"><i data-lucide="user-round"></i><input id="account-auth-name" name="name" maxlength="12" autocomplete="nickname" required /></div>
          <label for="account-auth-password">密码</label>
          <div class="input-wrap"><i data-lucide="key-round"></i><input id="account-auth-password" name="password" type="password" minlength="6" maxlength="64" autocomplete="current-password" required /></div>
          <p class="home-dialog-error" data-auth-error role="alert" hidden></p>
          <button type="submit" class="button primary full" data-auth-submit><i data-lucide="log-in"></i><span>登录</span></button>
          <p class="account-hint" data-auth-hint></p>
        </form>
      </dialog>`;
    document.body.append(wrap.firstElementChild);
    authDialog = document.querySelector("[data-auth-dialog]");
    const form = authDialog.querySelector("[data-auth-form]");
    authDialog.querySelector("[data-auth-close]").addEventListener("click", () => settleAuth(false));
    authDialog.addEventListener("click", (event) => {
      if (event.target !== authDialog) return;
      const rect = authDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settleAuth(false);
    });
    authDialog.addEventListener("close", () => {
      const resolve = authResolve;
      authResolve = null;
      if (resolve) resolve(false);
    });
    authDialog.querySelectorAll("[data-auth-tab]").forEach((button) =>
      button.addEventListener("click", () => setAuthTab(button.dataset.authTab)),
    );
    form.addEventListener("submit", submitAuth);
  }

  function setAuthTab(tab) {
    authTab = tab === "register" ? "register" : "login";
    const register = authTab === "register";
    authDialog.querySelectorAll("[data-auth-tab]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.authTab === authTab)));
    authDialog.querySelector("[data-auth-heading]").textContent = register ? "注册账号" : "登录";
    authDialog.querySelector("[data-auth-submit]").innerHTML =
      `<i data-lucide="${register ? "user-round-plus" : "log-in"}"></i><span>${register ? "注册并进入大厅" : "登录"}</span>`;
    authDialog.querySelector("[data-auth-hint]").textContent = register
      ? "注册即赠送 10,000 筹码；昵称 1–12 个字，密码 6–64 位"
      : "还没有账号？点上方「注册」，注册即赠送 10,000 筹码";
    authDialog.querySelector("[data-auth-error]").hidden = true;
    icons();
  }

  function settleAuth(ok) {
    const resolve = authResolve;
    authResolve = null;
    if (authDialog?.open) authDialog.close();
    if (resolve) resolve(Boolean(ok));
  }

  function openAuthModal({ tab = "login" } = {}) {
    buildAuthDom();
    return new Promise((resolve) => {
      authResolve = resolve;
      setAuthTab(tab);
      authDialog.querySelector("[data-auth-form]").reset();
      if (!authDialog.open) authDialog.showModal();
      const nameInput = authDialog.querySelector('[name="name"]');
      (nameInput.value.trim() ? authDialog.querySelector('[name="password"]') : nameInput).focus();
    });
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = event.target;
    const error = authDialog.querySelector("[data-auth-error]");
    const submit = authDialog.querySelector("[data-auth-submit]");
    const name = form.elements.name.value.trim();
    const password = form.elements.password.value;
    if (!name) {
      error.textContent = "请输入昵称";
      error.hidden = false;
      return;
    }
    if ([...password].length < 6) {
      error.textContent = "密码需要 6–64 个字符";
      error.hidden = false;
      return;
    }
    error.hidden = true;
    submit.disabled = true;
    try {
      const response = await fetch(`/api/${authTab}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "操作未完成，请稍后重试");
      write({ token: data.token, name: data.name, balance: data.balance ?? 0, tableStack: 0, totalAssets: data.balance ?? 0 });
      settleAuth(true);
    } catch (err) {
      error.textContent = err?.message || "操作未完成，请稍后重试";
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  // ---------- 个人中心 ----------

  let drawer = null;
  let backdrop = null;
  let profileTab = "overview";
  let overviewData = null;
  let boardEntries = null;
  const handsState = { items: [], page: 0, hasMore: false, loading: false };
  const ledgerState = { items: [], page: 0, hasMore: false, loading: false };
  const slotsState = { items: [], page: 0, hasMore: false, loading: false };
  const mahjongState = { items: [], page: 0, hasMore: false, loading: false };

  function buildProfileDom() {
    if (drawer) return;
    backdrop = document.createElement("div");
    backdrop.className = "drawer-backdrop";
    backdrop.hidden = true;
    backdrop.dataset.profileBackdrop = "";
    drawer = document.createElement("aside");
    drawer.className = "profile-drawer";
    drawer.hidden = true;
    drawer.setAttribute("aria-label", "个人中心");
    drawer.innerHTML = `
      <div class="drawer-heading">
        <h2>个人中心</h2>
        <button type="button" class="icon-button" data-profile-close aria-label="关闭个人中心" title="关闭个人中心"><i data-lucide="x"></i></button>
      </div>
      <div class="profile-account" data-profile-head></div>
      <div class="profile-tabs" role="group" aria-label="个人中心页签">
        <button type="button" data-profile-tab="overview" aria-pressed="true">总览</button>
        <button type="button" data-profile-tab="hands" aria-pressed="false">德州</button>
        <button type="button" data-profile-tab="slots" aria-pressed="false">老虎机</button>
        <button type="button" data-profile-tab="mahjong" aria-pressed="false">麻将</button>
        <button type="button" data-profile-tab="ledger" aria-pressed="false">筹码明细</button>
      </div>
      <div class="profile-body">
        <section data-profile-panel="overview" class="profile-panel"></section>
        <section data-profile-panel="hands" class="profile-panel" hidden></section>
        <section data-profile-panel="slots" class="profile-panel" hidden></section>
        <section data-profile-panel="mahjong" class="profile-panel" hidden></section>
        <section data-profile-panel="ledger" class="profile-panel" hidden></section>
      </div>`;
    document.body.append(backdrop, drawer);
    drawer.querySelector("[data-profile-close]").addEventListener("click", closeProfile);
    backdrop.addEventListener("click", closeProfile);
    drawer.querySelectorAll("[data-profile-tab]").forEach((button) =>
      button.addEventListener("click", () => switchTab(button.dataset.profileTab)));
    drawer.addEventListener("click", (event) => {
      if (event.target.closest("[data-profile-subsidy]"))
        window.dispatchEvent(new CustomEvent("tongzhuo:claim-subsidy"));
      if (event.target.closest("[data-profile-logout]")) {
        closeProfile();
        window.dispatchEvent(new CustomEvent("tongzhuo:logout-request"));
      }
      const more = event.target.closest("[data-profile-more]");
      if (more && !more.disabled) {
        if (more.dataset.profileMore === "hands") loadHands(false);
        else if (more.dataset.profileMore === "slots") loadSlots(false);
        else if (more.dataset.profileMore === "mahjong") loadMahjong(false);
        else loadLedger(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && drawer && !drawer.hidden) closeProfile();
    });
  }

  function openProfile() {
    if (!get()) {
      openAuthModal().then((ok) => { if (ok) openProfile(); });
      return;
    }
    buildProfileDom();
    drawer.hidden = false;
    backdrop.hidden = false;
    switchTab("overview", true);
  }
  function closeProfile() {
    if (!drawer) return;
    drawer.hidden = true;
    backdrop.hidden = true;
  }
  function isProfileOpen() { return Boolean(drawer && !drawer.hidden); }

  function switchTab(tab, force = false) {
    profileTab = tab;
    drawer.querySelectorAll("[data-profile-tab]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.profileTab === tab)));
    drawer.querySelectorAll("[data-profile-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.profilePanel !== tab;
    });
    if (tab === "overview") loadOverview(force);
    else if (tab === "hands") loadHands(true);
    else if (tab === "slots") loadSlots(true);
    else if (tab === "mahjong") loadMahjong(true);
    else loadLedger(true);
  }

  function renderHead() {
    const account = get();
    if (!account || !drawer) return;
    drawer.querySelector("[data-profile-head]").innerHTML = `
      ${avatarMarkup(account.name)}
      <div class="profile-account-info">
        <strong>${esc(account.name)}</strong>
        <span>可用 ${money(account.balance)} · 桌上 ${money(account.tableStack)}</span>
      </div>
      <button type="button" class="icon-button bordered profile-logout" data-profile-logout title="退出登录" aria-label="退出登录"><i data-lucide="log-out"></i></button>`;
    icons();
  }

  async function loadOverview(force = false) {
    const panel = drawer.querySelector('[data-profile-panel="overview"]');
    if (!force && overviewData && panel.innerHTML) return;
    panel.innerHTML = `<p class="profile-empty">正在加载…</p>`;
    renderHead();
    try {
      const [overview, board] = await Promise.all([
        api("/api/me/overview"),
        boardEntries ? Promise.resolve(null) : api("/api/leaderboard"),
      ]);
      overviewData = overview;
      write({ ...get(), ...pickStats(overview) });
      if (board) boardEntries = Array.isArray(board) ? board : (board.entries || []);
      renderHead();
      renderOverview(panel);
    } catch (error) {
      panel.innerHTML = `<p class="profile-empty">${esc(error?.error || "加载失败，请稍后重试")}</p>`;
    }
  }

  function renderOverview(panel) {
    const account = get();
    const data = overviewData || {};
    const rank = data.rank ? `#${data.rank}${data.totalPlayers ? ` / ${data.totalPlayers}` : ""}` : "—";
    const net = Number(data.netProfit || 0);
    const winRate = `${Math.round((data.winRate || 0) * 1000) / 10}%`;
    const rows = (boardEntries || []).slice(0, 10);
    const selfIndex = boardEntries.findIndex((entry) => entry.name === account?.name);
    const selfBeyond = Boolean(account) && selfIndex >= 10;
    // 自己排在十名开外时，在第十名下面单独显示自己的名次；榜上找不到时用总览数据兜底
    const selfRow = selfBeyond ? {
      rank: selfIndex >= 0 ? selfIndex + 1 : (data.rank || null),
      name: selfIndex >= 0 ? boardEntries[selfIndex].name : account.name,
      total: selfIndex >= 0 ? boardEntries[selfIndex].total : data.totalAssets,
    } : null;
    panel.innerHTML = `
      <div class="profile-stats">
        <div><span>总资产</span><strong>${money(data.totalAssets)}</strong></div>
        <div><span>财富排名</span><strong>${rank}</strong></div>
        <div><span>累计净盈亏</span><strong class="${net > 0 ? "pos" : net < 0 ? "neg" : ""}">${net === 0 ? "0" : signedMoney(net)}</strong></div>
        <div><span>德州手数</span><strong>${money(data.handsPlayed)}</strong></div>
        <div><span>德州盈利手数占比</span><strong>${winRate}</strong></div>
        <div><span>老虎机次数</span><strong>${money(data.slotSpins ?? 0)}</strong></div>
        <div><span>老虎机净盈亏</span><strong class="${Number(data.slotNet || 0) > 0 ? "pos" : Number(data.slotNet || 0) < 0 ? "neg" : ""}">${Number(data.slotNet || 0) === 0 ? "0" : signedMoney(Number(data.slotNet || 0))}</strong></div>
        <div><span>麻将局数 / 胡牌次数</span><strong>${money(data.mahjongRounds)} / ${money(data.mahjongHuCount)}</strong></div>
        <div><span>麻将净盈亏</span><strong class="${Number(data.mahjongNet || 0) > 0 ? "pos" : Number(data.mahjongNet || 0) < 0 ? "neg" : ""}">${Number(data.mahjongNet || 0) === 0 ? "0" : signedMoney(data.mahjongNet)}</strong></div>
      </div>
      ${Number(data.totalAssets) < SUBSIDY_THRESHOLD
        ? `<button type="button" class="button secondary full profile-subsidy" data-profile-subsidy><i data-lucide="gift"></i>领取每日补助 2,000 筹码</button>`
        : ""}
      <h3 class="profile-subhead">财富排行榜</h3>
      ${rows.length ? `<ol class="profile-board">${rows.map((entry, index) => `
        <li class="${index < 3 ? `rank-${index + 1}` : ""} ${entry.name === account?.name ? "is-self" : ""}">
          <span class="profile-board-rank">${index + 1}</span>
          <span class="profile-board-name">${esc(entry.name)}${entry.name === account?.name ? "<b>（你）</b>" : ""}</span>
          <strong>${money(entry.total)}</strong>
        </li>`).join("")}
        ${selfRow ? `
        <li class="profile-board-gap" aria-hidden="true"><span>…</span></li>
        <li class="is-self">
          <span class="profile-board-rank">${selfRow.rank ?? "—"}</span>
          <span class="profile-board-name">${esc(selfRow.name)}<b>（你）</b></span>
          <strong>${money(selfRow.total)}</strong>
        </li>` : ""}
      </ol>`
        : '<p class="profile-empty">暂无排行数据</p>'}`;
    icons();
  }

  async function loadHands(reset) {
    const panel = drawer.querySelector('[data-profile-panel="hands"]');
    if (handsState.loading) return;
    if (reset) {
      handsState.items = [];
      handsState.page = 0;
      handsState.hasMore = false;
    }
    handsState.loading = true;
    if (!handsState.items.length) panel.innerHTML = `<p class="profile-empty">正在加载…</p>`;
    try {
      const data = await api(`/api/me/hands?page=${handsState.page + 1}`);
      const pageItems = data.hands || data.items || [];
      handsState.page = data.page || handsState.page + 1;
      handsState.hasMore = typeof data.hasMore === "boolean"
        ? data.hasMore
        : handsState.page * (data.pageSize || 20) < (data.total ?? 0);
      handsState.items = handsState.items.concat(pageItems);
      renderHands(panel);
    } catch (error) {
      panel.innerHTML = `<p class="profile-empty">${esc(error?.error || "加载失败，请稍后重试")}</p>`;
    } finally {
      handsState.loading = false;
    }
  }

  function renderHands(panel) {
    const items = handsState.items;
    panel.innerHTML = items.length ? `
      <ul class="profile-list">${items.map((hand) => {
        const net = Number(hand.net || 0);
        const winners = Array.isArray(hand.winners) ? hand.winners : [];
        const winnerNames = winners.map((w) => (typeof w === "string" ? w : w?.name)).filter(Boolean);
        const winnerHands = winners.map((w) => (typeof w === "string" ? null : w?.handName)).filter(Boolean);
        return `<li class="profile-hand">
          <div class="profile-hand-top">
            <time>${esc(fmtTime(hand.playedAt ?? hand.time))}</time>
            <span class="profile-hand-room">#${esc(hand.roomCode)} · 第 ${money(hand.handNumber)} 手 · 盲注 ${money(hand.smallBlind)}/${money(hand.bigBlind)}</span>
            <strong class="profile-net ${net > 0 ? "pos" : net < 0 ? "neg" : ""}">${net === 0 ? "0" : signedMoney(net)}</strong>
          </div>
          <div class="profile-hand-cards">
            <div><span class="profile-hand-label">底牌</span>${hand.holeCards?.length ? miniCards(hand.holeCards) : '<span class="profile-hand-none">未亮牌</span>'}</div>
            <div><span class="profile-hand-label">公共牌</span>${miniCards(hand.communityCards || hand.board || [])}</div>
          </div>
          <p class="profile-hand-meta">赢家：${winnerNames.length ? esc(winnerNames.join("、")) : "—"}${winnerHands.length ? ` · ${esc(winnerHands.join(" / "))}` : ""}</p>
        </li>`;
      }).join("")}</ul>
      ${handsState.hasMore ? `<button type="button" class="button secondary full profile-more" data-profile-more="hands"><i data-lucide="chevrons-down"></i>加载更多</button>` : ""}`
      : '<p class="profile-empty">还没有牌局记录，上桌打几手吧</p>';
    icons();
  }

  async function loadSlots(reset) {
    const panel = drawer.querySelector('[data-profile-panel="slots"]');
    if (slotsState.loading) return;
    if (reset) {
      slotsState.items = [];
      slotsState.page = 0;
      slotsState.hasMore = false;
    }
    slotsState.loading = true;
    if (!slotsState.items.length) panel.innerHTML = `<p class="profile-empty">正在加载…</p>`;
    try {
      const data = await api(`/api/me/spins?page=${slotsState.page + 1}`);
      const pageItems = data.spins || [];
      slotsState.page = data.page || slotsState.page + 1;
      slotsState.hasMore = typeof data.hasMore === "boolean"
        ? data.hasMore
        : slotsState.page * (data.pageSize || 20) < (data.total ?? 0);
      slotsState.items = slotsState.items.concat(pageItems);
      renderSlots(panel);
    } catch (error) {
      panel.innerHTML = `<p class="profile-empty">${esc(error?.error || "加载失败，请稍后重试")}</p>`;
    } finally {
      slotsState.loading = false;
    }
  }

  // 老虎机战绩：时间、下注、三个结果符号（复用 slot 页素材）、派奖与净盈亏。
  function renderSlots(panel) {
    const items = slotsState.items;
    panel.innerHTML = items.length ? `
      <ul class="profile-list">${items.map((spin) => {
        const net = Number(spin.net || 0);
        const symbols = Array.isArray(spin.reels) ? spin.reels : [];
        return `<li class="profile-slot">
          <div class="profile-hand-top">
            <time>${esc(fmtTime(spin.time))}</time>
            <span class="profile-hand-room">下注 ${money(spin.bet)}${spin.payout > 0 ? ` · 派奖 ${money(spin.payout)}` : " · 未中奖"}</span>
            <strong class="profile-net ${net > 0 ? "pos" : net < 0 ? "neg" : ""}">${net === 0 ? "0" : signedMoney(net)}</strong>
          </div>
          <div class="profile-slot-symbols">${symbols.map((id) =>
            `<img src="/slot/assets/${esc(id)}.svg" alt="${esc(SLOT_SYMBOL_LABELS[id] || id)}" title="${esc(SLOT_SYMBOL_LABELS[id] || id)}" draggable="false" />`).join("")}</div>
        </li>`;
      }).join("")}</ul>
      ${slotsState.hasMore ? `<button type="button" class="button secondary full profile-more" data-profile-more="slots"><i data-lucide="chevrons-down"></i>加载更多</button>` : ""}`
      : '<p class="profile-empty">还没有老虎机记录，去拉一次杆吧</p>';
    icons();
  }

  async function loadMahjong(reset) {
    const panel = drawer.querySelector('[data-profile-panel="mahjong"]');
    if (mahjongState.loading) return;
    if (reset) {
      mahjongState.items = [];
      mahjongState.page = 0;
      mahjongState.hasMore = false;
    }
    mahjongState.loading = true;
    const token = get()?.token;
    if (!mahjongState.items.length) panel.innerHTML = '<p class="profile-empty">正在加载麻将战绩…</p>';
    try {
      const data = await api(`/api/me/mahjong?page=${mahjongState.page + 1}`);
      if (get()?.token !== token) return;
      mahjongState.page = data.page || mahjongState.page + 1;
      mahjongState.hasMore = mahjongState.page * (data.pageSize || 20) < (data.total ?? 0);
      mahjongState.items = mahjongState.items.concat(data.rounds || []);
      renderMahjong(panel);
    } catch (error) {
      panel.innerHTML = `<p class="profile-empty">${esc(error?.error || "加载失败，请稍后重试")}</p>`;
    } finally {
      mahjongState.loading = false;
    }
  }

  function mahjongTileLabel(tile) {
    if (tile === "z0") return "红中";
    const match = /^([mps])([1-9])$/.exec(String(tile));
    return match ? `${match[2]}${({ m: "万", p: "筒", s: "条" })[match[1]]}` : "牌";
  }

  function mahjongTiles(tiles) {
    return `<span class="profile-mahjong-tiles" aria-label="公开胡牌">${tiles.map((tile) => {
      const face = /^(?:[mps][1-9]|z0)$/.test(tile) ? tile : "back";
      return `<span class="profile-mahjong-tile" role="img" aria-label="${esc(mahjongTileLabel(tile))}" title="${esc(mahjongTileLabel(tile))}"><svg viewBox="0 0 60 80" aria-hidden="true" focusable="false"><use href="/mahjong/tile-faces.svg#${face}" /></svg></span>`;
    }).join("")}</span>`;
  }

  function renderMahjong(panel) {
    const items = mahjongState.items;
    const signed = (value) => Number(value) === 0 ? "0" : signedMoney(value);
    const netClass = (value) => Number(value) > 0 ? "pos" : Number(value) < 0 ? "neg" : "";
    panel.innerHTML = items.length ? `
      <p class="profile-hand-meta">每局结束后收录战绩；练习桌不计入。胡牌、杠牌的即时输赢可在筹码明细查看。</p>
      <ul class="profile-list">${items.map((round) => {
        const participants = Array.isArray(round.players) ? round.players : [];
        const events = Array.isArray(round.events) ? round.events : [];
        const playerName = (seat) => participants.find((entry) => entry.seat === seat)?.name || `${Number(seat) + 1} 号位`;
        return `<li class="profile-mahjong-round">
          <div class="profile-hand-top">
            <time>${esc(fmtTime(round.time))}</time>
            <span class="profile-hand-room">#${esc(round.roomCode)} · 第 ${money(round.roundNumber)} 局</span>
            <strong class="profile-net ${netClass(round.net)}">${signed(round.net)}</strong>
          </div>
          <p class="profile-hand-meta">底分 ${money(round.base)} · 胡牌 ${money(round.wins)} 次 · ${round.reason === "bankrupt" ? "有玩家筹码不足，本局结束" : "本局已结束"}<br>桌上筹码 ${money(round.startingStack)} → ${money(round.endingStack)}</p>
          <details class="profile-mahjong-details">
            <summary>查看 ${money(events.length)} 笔胡牌 / 杠牌结算</summary>
            <ul class="profile-mahjong-scores">${participants.map((entry) => `<li><span>${esc(entry.name)}${entry.seat === round.mySeat ? "（你）" : ""} · 胡 ${money(entry.wins)} 次</span><strong class="${netClass(entry.net)}">${signed(entry.net)}</strong></li>`).join("")}</ul>
            ${events.length ? `<ol class="profile-mahjong-events">${events.map((event, index) => {
              const ownDelta = (event.changes || []).find((entry) => entry.seat === round.mySeat)?.delta ?? 0;
              const winners = Array.isArray(event.winners) ? event.winners : [];
              const gangName = ({ concealedGang: "暗杠", exposedGang: "直杠", addedGang: "补杠", addGang: "补杠", discardGang: "直杠" })[event.gangKind] || "杠牌";
              const actorSeat = event.seat ?? (event.changes || []).find((entry) => entry.delta > 0)?.seat ?? event.sourceSeat;
              const title = event.kind === "hu" ? `${event.selfDraw ? "自摸" : "点炮胡"}${winners.length > 1 ? " · 一炮多响" : ""}` : `${playerName(actorSeat)} · ${gangName}`;
              return `<li><div class="profile-mahjong-event-top"><span>${index + 1}. ${esc(title)}</span><strong class="${netClass(ownDelta)}">你 ${signed(ownDelta)}</strong></div>
                ${event.kind === "hu" && !event.selfDraw ? `<p>点炮：${esc(playerName(event.sourceSeat))}</p>` : ""}
                ${winners.map((winner) => `<p>${esc(winner.name || playerName(winner.seat))} · ${esc((winner.patterns || winner.hand?.patterns || []).join(" · ") || winner.hand?.name || "胡牌")} · ${money(winner.multiplier ?? winner.hand?.multiplier ?? 1)} 倍</p>${mahjongTiles(winner.hand?.tiles || winner.tiles || [])}`).join("")}
                ${event.kind === "gang" && event.tile ? `<p>${esc(mahjongTileLabel(event.tile))}</p>` : ""}
                <p>${(event.changes || []).filter((entry) => entry.delta !== 0).map((entry) => `${esc(playerName(entry.seat))} ${signed(entry.delta)}`).join(" · ")}</p>
              </li>`;
            }).join("")}</ol>` : '<p class="profile-hand-meta">本局没有胡牌或杠牌结算</p>'}
          </details>
        </li>`;
      }).join("")}</ul>
      ${mahjongState.hasMore ? '<button type="button" class="button secondary full profile-more" data-profile-more="mahjong"><i data-lucide="chevrons-down"></i>加载更多</button>' : ""}`
      : '<p class="profile-empty">还没有麻将战绩，完成一局正式血流红中后会记录在这里</p>';
    icons();
  }

  async function loadLedger(reset) {
    const panel = drawer.querySelector('[data-profile-panel="ledger"]');
    if (ledgerState.loading) return;
    if (reset) {
      ledgerState.items = [];
      ledgerState.page = 0;
      ledgerState.hasMore = false;
    }
    ledgerState.loading = true;
    if (!ledgerState.items.length) panel.innerHTML = `<p class="profile-empty">正在加载…</p>`;
    try {
      const data = await api(`/api/me/ledger?page=${ledgerState.page + 1}`);
      const pageItems = data.entries || data.items || [];
      ledgerState.page = data.page || ledgerState.page + 1;
      ledgerState.hasMore = typeof data.hasMore === "boolean"
        ? data.hasMore
        : ledgerState.page * (data.pageSize || 20) < (data.total ?? 0);
      ledgerState.items = ledgerState.items.concat(pageItems);
      renderLedger(panel);
    } catch (error) {
      panel.innerHTML = `<p class="profile-empty">${esc(error?.error || "加载失败，请稍后重试")}</p>`;
    } finally {
      ledgerState.loading = false;
    }
  }

  function renderLedger(panel) {
    const items = ledgerState.items;
    panel.innerHTML = items.length ? `
      <ul class="profile-list">${items.map((entry) => {
        const amount = Number(entry.amount || 0);
        const transfer = TRANSFER_TYPES.has(entry.type);
        const tableMemo = entry.type === "MAHJONG_SETTLE" || entry.type === "HAND_WIN";
        return `<li class="profile-ledger">
          <div class="profile-ledger-main">
            <span class="profile-ledger-type${transfer ? " is-transfer" : ""}">${esc(LEDGER_TYPES[entry.type] || entry.type)}</span>
            <time>${esc(fmtTime(entry.createdAt ?? entry.time))}</time>
            ${tableMemo ? '<span class="profile-ledger-note">输赢发生在桌上，未重复增减钱包</span>' : ""}
          </div>
          <div class="profile-ledger-side">
            <strong class="${amount > 0 ? "pos" : amount < 0 ? "neg" : ""}">${amount === 0 ? "0" : signedMoney(amount)}</strong>
            <span class="profile-ledger-after">${tableMemo ? "当时可用" : "余额"} ${money(entry.balanceAfter)}</span>
          </div>
        </li>`;
      }).join("")}</ul>
      ${ledgerState.hasMore ? `<button type="button" class="button secondary full profile-more" data-profile-more="ledger"><i data-lucide="chevrons-down"></i>加载更多</button>` : ""}`
      : '<p class="profile-empty">暂无筹码明细</p>';
    icons();
  }

  window.addEventListener("tongzhuo:balance", () => {
    boardEntries = null;
    if (!isProfileOpen()) return;
    if (profileTab === "overview") loadOverview(true);
    if (profileTab === "slots") loadSlots(true);
    if (profileTab === "mahjong") loadMahjong(true);
    if (profileTab === "ledger") loadLedger(true);
    renderHead();
  });

  // 顶栏身份簇：并入全局顶栏右侧（登录/注册、头像昵称余额、个人中心、补助）。
  window.createTopbar = function ({ mount, onRequireAuth }) {
    let account = null;

    const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
    const render = () => {
      if (!account) {
        mount.innerHTML = `
          <button class="button secondary topbar-auth" type="button" data-topbar="login" aria-label="登录">${icon("log-in")}<span>登录</span></button>
          <button class="button primary topbar-auth" type="button" data-topbar="register" aria-label="注册">${icon("user-round-plus")}<span>注册</span></button>`;
      } else {
        const balance = Number(account.balance || 0);
        const tableStack = Number(account.tableStack || 0);
        const totalAssets = Number(account.totalAssets ?? balance + tableStack);
        const subsidyVisible = totalAssets < SUBSIDY_THRESHOLD;
        const rank = account.rank ? `<span class="topbar-rank">#${money(account.rank)}</span>` : "";
        mount.innerHTML = `
          <button class="topbar-account" type="button" data-topbar="profile" title="个人中心" aria-label="个人中心">
            ${avatarMarkup(account.name)}
            <span class="topbar-account-text">
              <strong>${esc(account.name)}${rank}</strong>
              <span class="topbar-balance">${icon("coins")}可用 ${money(balance)}</span>
            </span>
          </button>
          ${subsidyVisible ? `<button class="icon-button bordered topbar-subsidy" type="button" data-topbar="subsidy" title="领取每日补助" aria-label="领取每日补助">${icon("gift")}<span class="topbar-dot"></span></button>` : ""}`;
      }
      icons();
    };

    mount.addEventListener("click", (event) => {
      const button = event.target.closest("[data-topbar]");
      if (!button) return;
      if (button.dataset.topbar === "login" || button.dataset.topbar === "register") {
        if (onRequireAuth) onRequireAuth();
      } else if (button.dataset.topbar === "subsidy") {
        window.dispatchEvent(new CustomEvent("tongzhuo:claim-subsidy"));
      } else if (button.dataset.topbar === "profile") {
        openProfile();
      }
    });

    render();
    return {
      setAccount(next) {
        account = next && next.token ? next : null;
        render();
      },
    };
  };

  window.tongzhuoAuth = {
    get, clear, api, refreshBalance,
    openAuthModal, openProfile,
    avatarMarkup, avatarIndex,
    money, esc, LEDGER_TYPES,
  };
})();
