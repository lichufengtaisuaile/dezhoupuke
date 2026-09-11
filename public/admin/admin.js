"use strict";

// 管理后台：令牌存 sessionStorage，调 GET /api/admin/users 成功即视为有效。
(() => {
  const TOKEN_KEY = "dezhou-admin-token";
  const $ = (id) => document.getElementById(id);

  const elements = {
    gate: $("gate"),
    gateForm: $("gateForm"),
    tokenInput: $("tokenInput"),
    gateError: $("gateError"),
    panel: $("panel"),
    logoutButton: $("logoutButton"),
    npcHint: $("npcHint"),
    npcForm: $("npcForm"),
    npcSmallBlind: $("npcSmallBlind"),
    npcBigBlind: $("npcBigBlind"),
    npcBuyIn: $("npcBuyIn"),
    npcMaxSeats: $("npcMaxSeats"),
    npcKeepVacant: $("npcKeepVacant"),
    npcBody: $("npcBody"),
    npcEmpty: $("npcEmpty"),
    searchInput: $("searchInput"),
    usersCount: $("usersCount"),
    usersBody: $("usersBody"),
    usersEmpty: $("usersEmpty"),
    auditList: $("auditList"),
    auditEmpty: $("auditEmpty"),
    auditMore: $("auditMore"),
    adjustDialog: $("adjustDialog"),
    adjustForm: $("adjustForm"),
    adjustTarget: $("adjustTarget"),
    adjustAmount: $("adjustAmount"),
    adjustReason: $("adjustReason"),
    adjustError: $("adjustError"),
    adjustCancel: $("adjustCancel"),
    toast: $("toast"),
  };

  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let searchTimer = null;
  let auditPage = 0;
  let auditHasMore = false;
  let adjustUserId = null;
  let toastTimer = null;

  function fmtMoney(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }
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

  // ---------- 令牌门 ----------
  function showGate(message) {
    elements.gate.hidden = false;
    elements.panel.hidden = true;
    elements.logoutButton.hidden = true;
    if (message) {
      elements.gateError.textContent = message;
      elements.gateError.hidden = false;
    } else {
      elements.gateError.hidden = true;
    }
  }
  function showPanel() {
    elements.gate.hidden = true;
    elements.panel.hidden = false;
    elements.logoutButton.hidden = false;
  }

  elements.gateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    token = elements.tokenInput.value.trim();
    if (!token) return;
    try {
      await adminApi("/api/admin/users?page=1");
      sessionStorage.setItem(TOKEN_KEY, token);
      showPanel();
      startNpcPolling();
      await Promise.all([loadUsers(), loadAudit(true), loadNpcTables()]);
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
    npcTimer = setInterval(loadNpcTables, 10000);
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

  // ---------- 用户列表 ----------
  async function loadUsers() {
    const q = elements.searchInput.value.trim();
    try {
      const data = await adminApi(`/api/admin/users?page=1&q=${encodeURIComponent(q)}`);
      elements.usersCount.textContent = `共 ${data.total} 位用户`;
      elements.usersEmpty.hidden = data.users.length > 0;
      elements.usersBody.innerHTML = data.users.map((user) => `
        <tr data-user-id="${esc(user.id)}">
          <td><span class="admin-name">${esc(user.name)}</span>${user.isNpc ? '<span class="admin-badge is-npc" title="系统常驻 NPC（有真实经济身份，对外不可见）">NPC</span>' : ""}</td>
          <td><span class="admin-badge${user.isBanned ? " is-banned" : ""}">${user.isBanned ? "已封禁" : "正常"}</span></td>
          <td>${fmtMoney(user.balance)}</td>
          <td>${fmtMoney(user.tableStack)}</td>
          <td>${fmtMoney(user.totalAssets)}</td>
          <td>${fmtMoney(user.handsPlayed)}</td>
          <td>${fmtMoney(user.slotSpins)}</td>
          <td class="${user.netProfit > 0 ? "pos" : user.netProfit < 0 ? "neg" : ""}">${user.netProfit > 0 ? "+" : user.netProfit < 0 ? "−" : ""}${fmtMoney(Math.abs(user.netProfit))}</td>
          <td>${fmtTime(user.createdAt)}</td>
          <td>
            <div class="admin-actions">
              <button type="button" class="button secondary" data-action="adjust">调资金</button>
              <button type="button" class="button ${user.isBanned ? "secondary" : "primary"}" data-action="ban">${user.isBanned ? "解封" : "封禁"}</button>
            </div>
          </td>
        </tr>`).join("");
    } catch (error) {
      toast(error.message, true);
      if (error.status === 401 || error.status === 503) showGate(error.message);
    }
  }

  elements.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 300);
  });

  // ---------- 行操作 ----------
  elements.usersBody.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const row = button.closest("[data-user-id]");
    const userId = row?.dataset.userId;
    if (!userId) return;
    if (button.dataset.action === "adjust") openAdjust(userId, row);
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
      await Promise.all([loadUsers(), loadAudit(true)]);
    } catch (error) {
      elements.adjustError.textContent = error.message;
      elements.adjustError.hidden = false;
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
      await Promise.all([loadUsers(), loadAudit(true)]);
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ---------- 审计日志 ----------
  const ACTION_NAMES = { ADJUST_BALANCE: "调资金", BAN: "封禁", UNBAN: "解封" };
  function auditText(entry) {
    const detail = entry.detail || {};
    if (entry.action === "ADJUST_BALANCE") {
      return `金额 ${detail.amount > 0 ? "+" : "−"}${fmtMoney(Math.abs(detail.amount))} · ${esc(detail.reason || "—")}`;
    }
    return esc(detail.reason || (detail.banned ? "封禁" : "解封"));
  }
  async function loadAudit(reset = false) {
    if (reset) {
      auditPage = 0;
      auditHasMore = false;
      elements.auditList.innerHTML = "";
    }
    try {
      const data = await adminApi(`/api/admin/audit?page=${auditPage + 1}`);
      auditPage = data.page;
      auditHasMore = auditPage * data.pageSize < data.total;
      elements.auditMore.hidden = !auditHasMore;
      elements.auditEmpty.hidden = data.total > 0 || elements.auditList.children.length > 0;
      const rows = data.entries.map((entry) => `
        <li>
          <time>${fmtTime(entry.time)}</time>
          <span class="admin-audit-action${entry.action === "BAN" ? " is-ban" : ""}">${ACTION_NAMES[entry.action] || esc(entry.action)}</span>
          <span class="admin-name">${esc(entry.targetName || "（已删除）")}</span>
          <span class="admin-audit-detail">${auditText(entry)}</span>
        </li>`).join("");
      elements.auditList.insertAdjacentHTML("beforeend", rows);
    } catch (error) {
      toast(error.message, true);
    }
  }
  elements.auditMore.addEventListener("click", () => loadAudit(false));

  // ---------- 启动 ----------
  (async () => {
    if (!token) { showGate(); return; }
    try {
      await adminApi("/api/admin/users?page=1");
      showPanel();
      startNpcPolling();
      await Promise.all([loadUsers(), loadAudit(true), loadNpcTables()]);
    } catch (error) {
      sessionStorage.removeItem(TOKEN_KEY);
      token = "";
      showGate(error.status === 503 ? "管理后台未配置（DEZHOU_ADMIN_TOKEN）" : "令牌已失效，请重新输入");
    }
  })();
})();
