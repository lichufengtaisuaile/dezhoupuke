"use strict";

// 管理后台：左侧导航多页布局。令牌存 sessionStorage，调 GET /api/admin/users 成功即视为有效。
(() => {
  const TOKEN_KEY = "dezhou-admin-token";
  const $ = (id) => document.getElementById(id);

  const elements = {
    gate: $("gate"),
    gateForm: $("gateForm"),
    tokenInput: $("tokenInput"),
    gateError: $("gateError"),
    app: $("app"),
    nav: $("nav"),
    logoutButton: $("logoutButton"),
    // 总览
    statGrid: $("statGrid"),
    onlineChart: $("onlineChart"),
    onlineChartEmpty: $("onlineChartEmpty"),
    regChart: $("regChart"),
    // 玩家
    searchInput: $("searchInput"),
    sortSelect: $("sortSelect"),
    orderSelect: $("orderSelect"),
    usersCount: $("usersCount"),
    usersBody: $("usersBody"),
    usersEmpty: $("usersEmpty"),
    usersPager: $("usersPager"),
    // 交易行
    marketBody: $("marketBody"),
    marketEmpty: $("marketEmpty"),
    marketCount: $("marketCount"),
    marketPager: $("marketPager"),
    marketSearch: $("marketSearch"),
    marketStatus: $("marketStatus"),
    marketRefresh: $("marketRefresh"),
    marketReasonDialog: $("marketReasonDialog"),
    marketReasonForm: $("marketReasonForm"),
    marketReasonTitle: $("marketReasonTitle"),
    marketReasonNote: $("marketReasonNote"),
    marketReasonValue: $("marketReasonValue"),
    marketReasonError: $("marketReasonError"),
    marketReasonCancel: $("marketReasonCancel"),
    marketReasonSubmit: $("marketReasonSubmit"),
    // 宝箱
    winRateForm: $("winRateForm"),
    winRateInput: $("winRateInput"),
    winRateError: $("winRateError"),
    winRateHint: $("winRateHint"),
    prizeGrid: $("prizeGrid"),
    treasureSaveHint: $("treasureSaveHint"),
    // 系统
    npcHint: $("npcHint"),
    npcForm: $("npcForm"),
    npcSmallBlind: $("npcSmallBlind"),
    npcBigBlind: $("npcBigBlind"),
    npcBuyIn: $("npcBuyIn"),
    npcMaxSeats: $("npcMaxSeats"),
    npcKeepVacant: $("npcKeepVacant"),
    npcBody: $("npcBody"),
    npcEmpty: $("npcEmpty"),
    broadcastForm: $("broadcastForm"),
    broadcastAmount: $("broadcastAmount"),
    broadcastReason: $("broadcastReason"),
    broadcastRecipients: $("broadcastRecipients"),
    broadcastSubmit: $("broadcastSubmit"),
    broadcastError: $("broadcastError"),
    auditList: $("auditList"),
    auditEmpty: $("auditEmpty"),
    auditCount: $("auditCount"),
    auditPager: $("auditPager"),
    // 对话框
    adjustDialog: $("adjustDialog"),
    adjustForm: $("adjustForm"),
    adjustTarget: $("adjustTarget"),
    adjustAmount: $("adjustAmount"),
    adjustReason: $("adjustReason"),
    adjustError: $("adjustError"),
    adjustCancel: $("adjustCancel"),
    passwordDialog: $("passwordDialog"),
    passwordForm: $("passwordForm"),
    passwordTarget: $("passwordTarget"),
    passwordValue: $("passwordValue"),
    passwordConfirm: $("passwordConfirm"),
    passwordError: $("passwordError"),
    passwordCancel: $("passwordCancel"),
    toast: $("toast"),
  };

  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let searchTimer = null;
  let usersCurrentPage = 1;
  let auditCurrentPage = 1;
  let marketCurrentPage = 1;
  let marketAction = null;
  let adjustUserId = null;
  let passwordUserId = null;
  let broadcastRequestId = null;
  let toastTimer = null;
  let treasureConfig = null; // 奖池启用状态缓存（点击头像时本地翻转后提交）

  function compactNumber(value) {
    const num = Number(value || 0);
    if (Math.abs(num) >= 1000000) {
      const m = num / 1000000;
      return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
    }
    if (Math.abs(num) >= 1000) {
      const k = num / 1000;
      return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
    }
    return num.toLocaleString("zh-CN");
  }
  function fmtMoney(value) { return compactNumber(value); }
  function fmtTime(value) {
    const date = new Date(Number(value) || 0);
    if (Number.isNaN(date.getTime())) return "—";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }
  function toast(message, isError = false) {
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
  }

  async function adminApi(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    let data = null;
    try { data = await response.json(); } catch { /* 非 JSON */ }
    if (!response.ok) {
      const error = new Error(data?.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  // ---------- 令牌门 ----------
  function showGate(message) {
    elements.gate.hidden = false;
    elements.app.hidden = true;
    if (message) {
      elements.gateError.textContent = message;
      elements.gateError.hidden = false;
    } else {
      elements.gateError.hidden = true;
    }
  }
  function showApp() {
    elements.gate.hidden = true;
    elements.app.hidden = false;
  }

  // ---------- 页面切换 ----------
  const PAGE_LOADERS = {
    dashboard: loadDashboard,
    players: () => loadUsers(usersCurrentPage),
    market: () => loadMarket(marketCurrentPage),
    treasure: loadTreasureConfig,
    system: () => Promise.all([loadNpcTables(), loadBroadcastRecipients(), loadAudit(1)]),
  };
  function switchPage(page) {
    document.querySelectorAll(".admin-nav-item").forEach((item) =>
      item.classList.toggle("is-active", item.dataset.page === page));
    document.querySelectorAll("[data-page-panel]").forEach((panel) =>
      panel.classList.toggle("is-active", panel.dataset.pagePanel === page));
    PAGE_LOADERS[page]?.().catch((error) => toast(error.message, true));
  }
  elements.nav.addEventListener("click", (event) => {
    const item = event.target.closest("[data-page]");
    if (item) switchPage(item.dataset.page);
  });

  elements.gateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    token = elements.tokenInput.value.trim();
    if (!token) return;
    try {
      await adminApi("/api/admin/users?page=1");
      sessionStorage.setItem(TOKEN_KEY, token);
      showApp();
      startNpcPolling();
      switchPage("dashboard");
    } catch (error) {
      sessionStorage.removeItem(TOKEN_KEY);
      token = "";
      showGate(error.status === 503 ? "管理后台未配置（DEZHOU_ADMIN_TOKEN）" : `验证失败：${error.message}`);
    }
  });
  elements.logoutButton.addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    token = "";
    elements.tokenInput.value = "";
    showGate();
  });

  // ---------- 总览 ----------
  function renderLineChart(svg, points, { labels = [] } = {}) {
    // points: [{x: label, y: number}]，纯 SVG 折线 + 底部文字
    const width = 600, height = 200, padX = 34, padY = 18;
    svg.innerHTML = "";
    if (!points.length) return;
    const values = points.map((p) => p.y);
    const max = Math.max(...values, 1);
    const innerW = width - padX * 2, innerH = height - padY * 2;
    const xAt = (i) => padX + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const yAt = (v) => padY + innerH - (v / max) * innerH;
    let grid = "";
    for (let g = 0; g <= 4; g += 1) {
      const y = padY + (g / 4) * innerH;
      const val = Math.round(max * (1 - g / 4));
      grid += `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
      grid += `<text x="${padX - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="rgba(255,255,255,0.45)">${compactNumber(val)}</text>`;
    }
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(" ");
    const area = `${path} L${xAt(points.length - 1).toFixed(1)},${padY + innerH} L${padX},${padY + innerH} Z`;
    let dots = "";
    points.forEach((p, i) => {
      dots += `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="2.4" fill="#5ee0a0"><title>${esc(p.x)}：${p.y}</title></circle>`;
    });
    let axis = "";
    const step = Math.max(1, Math.ceil(points.length / 6));
    points.forEach((p, i) => {
      if (i % step !== 0 && i !== points.length - 1) return;
      axis += `<text x="${xAt(i).toFixed(1)}" y="${height - 4}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.45)">${esc(String(p.x).slice(5))}</text>`;
    });
    svg.innerHTML = `${grid}<path d="${area}" fill="rgba(94,224,160,0.12)"/><path d="${path}" fill="none" stroke="#5ee0a0" stroke-width="2"/>${dots}${axis}`;
  }

  async function loadDashboard() {
    const data = await adminApi("/api/admin/dashboard");
    const stats = [
      { label: "普通玩家", value: data.players },
      { label: "账号总数（含 NPC）", value: data.accounts },
      { label: "全服筹码总量", value: fmtMoney(data.totalChips) },
      { label: "进行中房间", value: data.activeRooms },
      { label: "今日开箱", value: data.opensToday },
      { label: "今日成交", value: `${data.marketDealsToday} 笔 / ${fmtMoney(data.marketVolumeToday)}` },
    ];
    elements.statGrid.innerHTML = stats.map((item) => `
      <div class="admin-stat-card"><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join("");

    const online = (data.online || []).map((row) => ({ x: fmtTime(row.time).slice(11), y: row.online }));
    elements.onlineChartEmpty.hidden = online.length > 0;
    renderLineChart(elements.onlineChart, online);

    const regs = (data.registrations || []).map((row) => ({ x: row.day, y: row.players }));
    renderLineChart(elements.regChart, regs);
  }

  // ---------- 全服发放 ----------
  async function loadBroadcastRecipients() {
    try {
      const data = await adminApi("/api/admin/broadcast-reward/recipients");
      elements.broadcastRecipients.textContent = `预计 ${fmtMoney(data.recipientCount)} 位普通账号领取`;
      return data.recipientCount;
    } catch (error) {
      elements.broadcastRecipients.textContent = "领取人数读取失败";
      throw error;
    }
  }
  elements.broadcastForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number(elements.broadcastAmount.value);
    const reason = elements.broadcastReason.value.trim();
    elements.broadcastError.hidden = true;
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason) {
      elements.broadcastError.textContent = "请填写正整数金额和发放原因";
      elements.broadcastError.hidden = false;
      return;
    }
    try {
      const recipientCount = await loadBroadcastRecipients();
      if (!recipientCount) throw new Error("当前没有可发放的普通账号");
      const total = amount * recipientCount;
      if (!window.confirm(`确认向 ${fmtMoney(recipientCount)} 位普通账号各发放 ${fmtMoney(amount)} 筹码？\n总计 ${fmtMoney(total)} 筹码。\n\n封禁账号和系统 NPC 不参与。`)) return;
      broadcastRequestId ||= requestId();
      elements.broadcastSubmit.disabled = true;
      const result = await adminApi("/api/admin/broadcast-reward", {
        method: "POST",
        body: JSON.stringify({ amount, reason, requestId: broadcastRequestId }),
      });
      elements.broadcastForm.reset();
      broadcastRequestId = null;
      toast(`${result.replayed ? "已确认原批次：" : "已发放："}${fmtMoney(result.recipientCount)} 人，各 ${fmtMoney(result.amount)}，总计 ${fmtMoney(result.totalAmount)}`);
      await Promise.all([loadAudit(1), loadBroadcastRecipients()]);
    } catch (error) {
      elements.broadcastError.textContent = error.message;
      elements.broadcastError.hidden = false;
    } finally {
      elements.broadcastSubmit.disabled = false;
    }
  });

  // ---------- 氛围桌 ----------
  let npcTimer = null;
  async function loadNpcTables() {
    try {
      const data = await adminApi("/api/admin/npc-tables");
      const tables = data.tables || [];
      elements.npcHint.textContent = `上限 ${data.tableLimit} 张（NPC_TABLES），启用且排在前面的配置才会激活`;
      elements.npcEmpty.hidden = tables.length > 0;
      elements.npcBody.innerHTML = tables.map((table) => {
        const live = table.live
          ? `${table.live.humans} 真人 · ${table.live.npcs} NPC${table.live.phase === "lobby" ? "" : " · 对局中"}`
          : "未开桌";
        const status = table.active
          ? '<span class="admin-badge">生效中</span>'
          : table.enabled ? '<span class="admin-badge is-banned">排队中</span>' : '<span class="admin-badge is-banned">已停用</span>';
        return `
        <tr data-table-id="${esc(table.id)}">
          <td>${esc(table.code)}</td>
          <td>${table.smallBlind} / ${table.bigBlind}</td>
          <td>${fmtMoney(table.buyIn)}</td>
          <td>${table.maxSeats} 人 · 留 ${table.keepVacant} 空</td>
          <td>${live}</td>
          <td>${status}</td>
          <td>
            <div class="admin-actions">
              <button type="button" class="button secondary" data-action="toggle">${table.enabled ? "停用" : "启用"}</button>
              <button type="button" class="button secondary" data-action="delete">删除</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    } catch (error) {
      toast(error.message, true);
    }
  }
  function startNpcPolling() {
    stopNpcPolling();
    npcTimer = setInterval(() => {
      // 只在系统设置页轮询氛围桌，避免不必要的请求
      if (document.querySelector('[data-page-panel="system"]').classList.contains("is-active")) loadNpcTables();
    }, 10000);
  }
  function stopNpcPolling() {
    if (npcTimer) { clearInterval(npcTimer); npcTimer = null; }
  }
  elements.npcForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      smallBlind: Number(elements.npcSmallBlind.value),
      bigBlind: Number(elements.npcBigBlind.value),
      buyIn: Number(elements.npcBuyIn.value),
      maxSeats: Number(elements.npcMaxSeats.value),
      keepVacant: Number(elements.npcKeepVacant.value),
    };
    try {
      const result = await adminApi("/api/admin/npc-tables", { method: "POST", body: JSON.stringify(payload) });
      toast(`已添加氛围桌 ${result.table.code}`);
      await loadNpcTables();
    } catch (error) {
      toast(error.message, true);
    }
  });
  elements.npcBody.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const row = button.closest("[data-table-id]");
    const tableId = row?.dataset.tableId;
    if (!tableId) return;
    try {
      if (button.dataset.action === "toggle") {
        const enabled = button.textContent.trim() === "启用";
        const result = await adminApi(`/api/admin/npc-tables/${tableId}/enabled`, {
          method: "POST",
          body: JSON.stringify({ enabled }),
        });
        toast(`已${result.enabled ? "启用" : "停用"} ${result.code}`);
      } else if (button.dataset.action === "delete") {
        if (!window.confirm("确认删除这张氛围桌？桌上 NPC 会在本手结束后撤出。")) return;
        const result = await adminApi(`/api/admin/npc-tables/${tableId}`, { method: "DELETE" });
        toast(`已删除 ${result.code}`);
      }
      await loadNpcTables();
    } catch (error) {
      toast(error.message, true);
    }
  });

  // ---------- 玩家列表 ----------
  function renderPager(container, { page, pageSize, total, onPage }) {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (pageCount <= 1) { container.hidden = true; container.innerHTML = ""; return; }
    container.hidden = false;
    const buttons = [];
    for (let i = 1; i <= pageCount; i += 1) {
      if (pageCount > 9 && i > 2 && i < pageCount - 1 && Math.abs(i - page) > 1) {
        if (buttons[buttons.length - 1] !== "…") buttons.push("…");
        continue;
      }
      buttons.push(i);
    }
    container.innerHTML = buttons.map((item) => item === "…"
      ? `<span class="admin-pager-gap">…</span>`
      : `<button type="button" class="admin-pager-btn${item === page ? " is-current" : ""}" data-page-no="${item}">${item}</button>`).join("");
    container.onclick = (event) => {
      const btn = event.target.closest("[data-page-no]");
      if (btn) onPage(Number(btn.dataset.pageNo));
    };
  }

  async function loadUsers(page = 1) {
    try {
      const params = new URLSearchParams({ page, sort: elements.sortSelect.value, order: elements.orderSelect.value });
      const keyword = elements.searchInput.value.trim();
      if (keyword) params.set("q", keyword);
      const data = await adminApi(`/api/admin/users?${params}`);
      usersCurrentPage = data.page;
      elements.usersCount.textContent = `共 ${data.total} 人`;
      elements.usersEmpty.hidden = data.total > 0;
      elements.usersBody.innerHTML = data.users.map((user) => `
        <tr data-user-id="${esc(user.id)}">
          <td><span class="admin-name">${esc(user.name)}</span></td>
          <td>${user.isBanned ? '<span class="admin-badge is-banned">封禁</span>' : user.npc ? '<span class="admin-badge">NPC</span>' : '<span class="admin-badge is-ok">正常</span>'}</td>
          <td>${fmtMoney(user.balance)}</td>
          <td>${fmtMoney(user.tableStack)}</td>
          <td>${fmtMoney(user.totalAssets)}</td>
          <td>${fmtMoney(user.handsPlayed)}</td>
          <td>${fmtMoney(user.slotSpins)}</td>
          <td class="${user.netProfit >= 0 ? "admin-profit" : "admin-loss"}">${user.netProfit >= 0 ? "+" : "−"}${fmtMoney(Math.abs(user.netProfit))}</td>
          <td>${fmtTime(user.createdAt)}</td>
          <td>
            <div class="admin-actions">
              <button type="button" class="button secondary" data-action="adjust">调资金</button>
              <button type="button" class="button secondary" data-action="password">改密码</button>
              <button type="button" class="button ${user.isBanned ? "secondary" : "primary"}" data-action="ban">${user.isBanned ? "解封" : "封禁"}</button>
            </div>
          </td>
        </tr>`).join("");
      renderPager(elements.usersPager, { page: data.page, pageSize: data.pageSize, total: data.total, onPage: loadUsers });
    } catch (error) {
      toast(error.message, true);
      if (error.status === 401 || error.status === 503) showGate(error.message);
    }
  }

  elements.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadUsers(1), 300);
  });
  elements.sortSelect.addEventListener("change", () => loadUsers(1));
  elements.orderSelect.addEventListener("change", () => loadUsers(1));

  // ---------- 玩家行操作 ----------
  elements.usersBody.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const row = button.closest("[data-user-id]");
    const userId = row?.dataset.userId;
    if (!userId) return;
    if (button.dataset.action === "adjust") openAdjust(userId, row);
    else if (button.dataset.action === "password") openPassword(userId, row);
    else await toggleBan(userId, row, button);
  });

  function openAdjust(userId, row) {
    adjustUserId = userId;
    elements.adjustTarget.textContent = row.querySelector(".admin-name")?.textContent ?? "";
    elements.adjustAmount.value = "";
    elements.adjustReason.value = "";
    elements.adjustError.hidden = true;
    elements.adjustDialog.showModal();
  }
  elements.adjustCancel.addEventListener("click", () => elements.adjustDialog.close());
  elements.adjustForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!adjustUserId) return;
    const amount = Number(elements.adjustAmount.value);
    const reason = elements.adjustReason.value.trim();
    try {
      const result = await adminApi(`/api/admin/users/${adjustUserId}/adjust`, {
        method: "POST",
        body: JSON.stringify({ amount, reason }),
      });
      elements.adjustDialog.close();
      toast(`已调整，${result.name} 新余额 ${fmtMoney(result.balance)}`);
      await Promise.all([loadUsers(usersCurrentPage), loadAudit(1)]);
    } catch (error) {
      elements.adjustError.textContent = error.message;
      elements.adjustError.hidden = false;
    }
  });

  function openPassword(userId, row) {
    passwordUserId = userId;
    elements.passwordTarget.textContent = row.querySelector(".admin-name")?.textContent ?? "";
    elements.passwordValue.value = "";
    elements.passwordConfirm.value = "";
    elements.passwordError.hidden = true;
    elements.passwordDialog.showModal();
    elements.passwordValue.focus();
  }
  elements.passwordCancel.addEventListener("click", () => elements.passwordDialog.close());
  elements.passwordDialog.addEventListener("close", () => {
    elements.passwordValue.value = "";
    elements.passwordConfirm.value = "";
    passwordUserId = null;
  });
  elements.passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!passwordUserId) return;
    const password = elements.passwordValue.value;
    elements.passwordError.hidden = true;
    if (password !== elements.passwordConfirm.value) {
      elements.passwordError.textContent = "两次输入的密码不一致";
      elements.passwordError.hidden = false;
      return;
    }
    try {
      const result = await adminApi(`/api/admin/users/${passwordUserId}/password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      elements.passwordDialog.close();
      toast(`已更新 ${result.name} 的密码`);
      await Promise.all([loadUsers(usersCurrentPage), loadAudit(1)]);
    } catch (error) {
      elements.passwordError.textContent = error.message;
      elements.passwordError.hidden = false;
    }
  });

  async function toggleBan(userId, row, button) {
    const banned = button.textContent.trim() === "封禁";
    if (banned && !window.confirm("确认封禁该用户？\n将立即踢出所有牌桌、退回桌上筹码并断开连接。")) return;
    try {
      const result = await adminApi(`/api/admin/users/${userId}/ban`, {
        method: "POST",
        body: JSON.stringify({ banned }),
      });
      toast(banned ? `已封禁 ${result.name}` : `已解封 ${result.name}`);
      await Promise.all([loadUsers(usersCurrentPage), loadAudit(1)]);
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ---------- 审计日志 ----------
  const ACTION_NAMES = {
    ADJUST_BALANCE: "调资金", BROADCAST_GRANT: "全服发放", BAN: "封禁", UNBAN: "解封",
    RESET_PASSWORD: "重置密码", MARKET_FORCE_DELIST: "强制下架", MARKET_REVERT_TRADE: "撤回交易",
    TREASURE_CONFIG: "宝箱配置",
  };
  function auditText(entry) {
    const detail = entry.detail || {};
    if (entry.action === "ADJUST_BALANCE") {
      return `金额 ${detail.amount > 0 ? "+" : "−"}${fmtMoney(Math.abs(detail.amount))} · ${esc(detail.reason || "—")}`;
    }
    if (entry.action === "BROADCAST_GRANT") {
      return `每人 +${fmtMoney(detail.amount)} · ${fmtMoney(detail.recipientCount)} 人 · 合计 +${fmtMoney(detail.totalAmount)} · ${esc(detail.reason || "—")}`;
    }
    if (entry.action === "RESET_PASSWORD") {
      return `旧登录态已注销 ${fmtMoney(detail.revokedSessions || 0)} 个`;
    }
    if (entry.action === "TREASURE_CONFIG") {
      const parts = [];
      if (detail.winBasisPoints !== undefined) parts.push(`爆率改为 ${detail.winBasisPoints / 100}%`);
      if (detail.disabledPrizes) parts.push(`停用 ${detail.disabledPrizes.length} 个头像`);
      return parts.join("；") || "—";
    }
    return esc(detail.reason || (detail.banned ? "封禁" : "解封"));
  }
  async function loadAudit(page = 1) {
    try {
      const data = await adminApi(`/api/admin/audit?page=${page}`);
      auditCurrentPage = data.page;
      elements.auditCount.textContent = `共 ${data.total} 条`;
      elements.auditEmpty.hidden = data.total > 0;
      elements.auditList.innerHTML = data.entries.map((entry) => `
        <li>
          <time>${fmtTime(entry.time)}</time>
          <span class="admin-audit-action${entry.action === "BAN" ? " is-ban" : ""}">${ACTION_NAMES[entry.action] || esc(entry.action)}</span>
          <span class="admin-name">${entry.action === "BROADCAST_GRANT" ? "全服普通账号" : esc(entry.targetName || "（已删除）")}</span>
          <span class="admin-audit-detail">${auditText(entry)}</span>
        </li>`).join("");
      renderPager(elements.auditPager, { page: data.page, pageSize: data.pageSize, total: data.total, onPage: loadAudit });
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ---------- 交易行监管 ----------
  const MARKET_STATUS_NAMES = { ACTIVE: "在售", SOLD: "已成交", CANCELLED: "已下架", EXPIRED: "已过期", REVERTED: "已撤回" };

  async function loadMarket(page = 1) {
    try {
      const params = new URLSearchParams({ page });
      if (elements.marketStatus.value) params.set("status", elements.marketStatus.value);
      const keyword = elements.marketSearch.value.trim();
      if (keyword) params.set("q", keyword);
      const data = await adminApi(`/api/admin/market?${params}`);
      marketCurrentPage = data.page;
      elements.marketCount.textContent = `共 ${data.total} 条`;
      elements.marketEmpty.hidden = data.total > 0;
      elements.marketBody.innerHTML = data.listings.map((listing) => {
        const actions = [];
        if (listing.status === "ACTIVE") {
          actions.push(`<button type="button" class="admin-mini-button is-danger" data-market-delist="${esc(listing.id)}">强制下架</button>`);
        }
        if (listing.status === "SOLD") {
          actions.push(`<button type="button" class="admin-mini-button is-danger" data-market-revert="${esc(listing.id)}">撤回交易</button>`);
        }
        const avatarCell = listing.avatar
          ? `<div class="admin-avatar-cell"><img src="${esc(listing.avatar.src)}" alt="${esc(listing.avatar.name)}" loading="lazy" /><div><strong>${esc(listing.avatar.name)}</strong><span>${esc(listing.avatar.series || "")}</span></div></div>`
          : esc(listing.avatarId);
        return `
        <tr>
          <td>${avatarCell}</td>
          <td>${fmtMoney(listing.price)}</td>
          <td>${esc(listing.sellerName)}</td>
          <td>${esc(listing.buyerName || "—")}</td>
          <td>${MARKET_STATUS_NAMES[listing.status] || esc(listing.status)}</td>
          <td>${fmtTime(listing.createdAt)}</td>
          <td class="admin-market-actions">${actions.join("") || "—"}</td>
        </tr>`;
      }).join("");
      renderPager(elements.marketPager, { page: data.page, pageSize: data.pageSize, total: data.total, onPage: loadMarket });
    } catch (error) {
      toast(error.message, true);
    }
  }

  function openMarketReasonDialog(action, listingId) {
    marketAction = { action, listingId };
    elements.marketReasonTitle.textContent = action === "delist" ? "强制下架商品" : "撤回已成交交易";
    elements.marketReasonNote.textContent = action === "delist"
      ? "头像将退回卖家，已收取的上架费不退回。请填写下架原因（计入审计）。"
      : "买家将原路收到全额退款，头像被系统回收，卖家已到账收入会被扣回（余额不足时扣到 0）。请填写撤回原因（计入审计）。";
    elements.marketReasonValue.value = "";
    elements.marketReasonError.hidden = true;
    elements.marketReasonSubmit.textContent = action === "delist" ? "确认强制下架" : "确认撤回交易";
    elements.marketReasonDialog.showModal();
    elements.marketReasonValue.focus();
  }

  elements.marketBody.addEventListener("click", (event) => {
    const delist = event.target.closest("[data-market-delist]");
    const revert = event.target.closest("[data-market-revert]");
    if (delist) openMarketReasonDialog("delist", delist.dataset.marketDelist);
    if (revert) openMarketReasonDialog("revert", revert.dataset.marketRevert);
  });
  elements.marketSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadMarket(1), 300);
  });
  elements.marketStatus.addEventListener("change", () => loadMarket(1));
  elements.marketRefresh.addEventListener("click", () => loadMarket(marketCurrentPage));
  elements.marketReasonCancel.addEventListener("click", () => {
    marketAction = null;
    elements.marketReasonDialog.close();
  });
  elements.marketReasonForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!marketAction) return;
    const reason = elements.marketReasonValue.value.trim();
    if (!reason) {
      elements.marketReasonError.textContent = "请填写原因";
      elements.marketReasonError.hidden = false;
      return;
    }
    elements.marketReasonSubmit.disabled = true;
    try {
      await adminApi(`/api/admin/market/${encodeURIComponent(marketAction.listingId)}/${marketAction.action === "delist" ? "delist" : "revert"}`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      toast(marketAction.action === "delist" ? "已强制下架" : "已撤回交易");
      marketAction = null;
      elements.marketReasonDialog.close();
      await Promise.all([loadMarket(marketCurrentPage), loadAudit(1)]);
    } catch (error) {
      elements.marketReasonError.textContent = error.message;
      elements.marketReasonError.hidden = false;
    } finally {
      elements.marketReasonSubmit.disabled = false;
    }
  });

  // ---------- 宝箱与奖品 ----------
  async function loadTreasureConfig() {
    try {
      treasureConfig = await adminApi("/api/admin/treasure-config");
      elements.winRateInput.value = String(treasureConfig.winRate * 100);
      renderTreasureHint();
      renderPrizeGrid();
    } catch (error) {
      toast(error.message, true);
    }
  }
  function renderTreasureHint() {
    const enabled = treasureConfig.prizes.filter((p) => p.enabled).length;
    const single = treasureConfig.winRate / enabled * 100;
    elements.winRateHint.textContent =
      `当前爆率 ${treasureConfig.winRate * 100}%（万分之 ${treasureConfig.winBasisPoints}）· 奖池 ${enabled}/${treasureConfig.totalCount} · 单个头像概率 ${single.toFixed(3)}%`;
  }
  function renderPrizeGrid() {
    elements.prizeGrid.innerHTML = treasureConfig.prizes.map((prize) => `
      <button type="button" class="admin-prize-card${prize.enabled ? "" : " is-disabled"}" data-prize-id="${esc(prize.id)}" title="${prize.enabled ? "点击停用" : "点击启用"}">
        <img src="${esc(prize.src)}" alt="${esc(prize.name)}" loading="lazy" />
        <strong>${esc(prize.name)}</strong>
        <span>${esc(prize.series)}</span>
        <em>${prize.enabled ? "已启用" : "已停用"}</em>
      </button>`).join("");
  }

  elements.winRateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.winRateError.hidden = true;
    const percent = Number(elements.winRateInput.value);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      elements.winRateError.textContent = "爆率需要在 0–100 之间";
      elements.winRateError.hidden = false;
      return;
    }
    try {
      treasureConfig = await adminApi("/api/admin/treasure-config", {
        method: "POST",
        body: JSON.stringify({ winBasisPoints: Math.round(percent * 100) }),
      });
      toast(`爆率已更新为 ${treasureConfig.winRate * 100}%`);
      renderTreasureHint();
      renderPrizeGrid();
      await loadAudit(1);
    } catch (error) {
      elements.winRateError.textContent = error.message;
      elements.winRateError.hidden = false;
    }
  });

  elements.prizeGrid.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-prize-id]");
    if (!card || !treasureConfig) return;
    const id = card.dataset.prizeId;
    const prize = treasureConfig.prizes.find((p) => p.id === id);
    const enabledCount = treasureConfig.prizes.filter((p) => p.enabled).length;
    if (prize.enabled && enabledCount <= 1) {
      toast("奖池至少保留 1 个头像", true);
      return;
    }
    // 本地先翻转并重新提交全量停用列表，失败则回滚
    prize.enabled = !prize.enabled;
    renderPrizeGrid();
    renderTreasureHint();
    elements.treasureSaveHint.textContent = "保存中…";
    try {
      treasureConfig = await adminApi("/api/admin/treasure-config", {
        method: "POST",
        body: JSON.stringify({ disabledPrizes: treasureConfig.prizes.filter((p) => !p.enabled).map((p) => p.id) }),
      });
      elements.treasureSaveHint.textContent = "";
      toast(`${prize.enabled ? "已启用" : "已停用"}「${prize.name}」`);
      renderTreasureHint();
      renderPrizeGrid();
      await loadAudit(1);
    } catch (error) {
      prize.enabled = !prize.enabled;
      renderPrizeGrid();
      renderTreasureHint();
      elements.treasureSaveHint.textContent = "";
      toast(error.message, true);
    }
  });

  // ---------- 启动 ----------
  (async () => {
    if (!token) { showGate(); return; }
    try {
      await adminApi("/api/admin/users?page=1");
      showApp();
      startNpcPolling();
      switchPage("dashboard");
    } catch (error) {
      sessionStorage.removeItem(TOKEN_KEY);
      token = "";
      showGate(error.status === 503 ? "管理后台未配置（DEZHOU_ADMIN_TOKEN）" : "令牌已失效，请重新输入");
    }
  })();
})();

