(() => {
  "use strict";
  window.createSocial = function ({ root, stage, send, notify }) {
    const catalog = window.HOLDEM_REACTIONS;
    const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const icon = name => `<i data-lucide="${name}"></i>`;
    root.innerHTML = `<div class="social-toolbar">
      <span class="social-heading">桌边互动</span>
      <div class="social-commands">
        <button class="social-tool" data-open-social="emoji" title="表情" aria-label="表情" aria-expanded="false">${icon("smile")}</button>
        <button class="social-tool gift-tool" data-open-social="gift" title="送花" aria-label="送花" aria-expanded="false">${icon("flower-2")}</button>
        <span class="social-divider"></span>
        <button class="social-phrase" data-send-reaction="luck">${icon("clover")}<span>祝你好运</span></button>
        <button class="social-phrase" data-send-reaction="inspect">${icon("scan-eye")}<span>我要验牌</span></button>
        <button class="social-tool" data-open-social="all" title="更多互动" aria-label="更多互动" aria-expanded="false">${icon("ellipsis")}</button>
      </div>
    </div>
    <div class="social-picker" hidden role="dialog" aria-label="桌边互动选项">
      <div class="social-picker-heading"><strong>桌边互动</strong><button class="icon-button" data-close-social title="关闭互动" aria-label="关闭互动">${icon("x")}</button></div>
      <label class="social-target-row"><span>发送给</span><select aria-label="互动对象"><option value="">全桌</option></select></label>
      <div class="social-options"></div>
    </div>
    <div class="social-feed" role="status" aria-live="polite"></div>`;
    const picker = root.querySelector(".social-picker");
    const targetSelect = root.querySelector("select");
    const options = root.querySelector(".social-options");
    const feed = root.querySelector(".social-feed");
    const layer = document.createElement("div");
    layer.className = "social-layer";
    layer.setAttribute("aria-hidden", "true");
    stage.append(layer);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const timers = new Set();
    const bubbles = new Map();
    const seen = new Set();
    let state = null;
    let connected = false;
    let rosterKey = "";
    let mode = "all";
    let sending = false;
    let cooldownUntil = 0;
    let cooldownTimer;
    let lastTrigger = null;

    function later(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    }
    function refreshIcons() { window.lucide?.createIcons(); }
    function closePicker() {
      picker.hidden = true;
      root.querySelectorAll("[data-open-social]").forEach(button => button.setAttribute("aria-expanded", "false"));
    }
    function controls() {
      const locked = !state || !connected || sending || Date.now() < cooldownUntil;
      root.querySelectorAll("[data-send-reaction],[data-open-social]").forEach(button => { button.disabled = locked; });
      targetSelect.disabled = locked;
      const rose = options.querySelector('[data-send-reaction="rose"]');
      if (rose) rose.disabled ||= !targetSelect.value;
    }
    function renderOptions() {
      const choices = mode === "gift" ? catalog.filter(item => item.kind === "gift")
        : mode === "emoji" ? catalog.filter(item => item.kind === "emoji") : catalog;
      options.className = `social-options ${mode === "emoji" ? "emoji-options" : ""}`;
      options.innerHTML = choices.map(item => `<button class="social-option ${item.kind === "emoji" ? "emoji-option" : ""}" data-send-reaction="${esc(item.id)}" title="${esc(item.label)}" aria-label="${esc(item.label)}">${item.symbol ? `<span class="reaction-symbol" aria-hidden="true">${esc(item.symbol)}</span>` : icon(item.icon || "message-circle")}${item.kind !== "emoji" ? `<span>${esc(item.label)}</span>` : ""}</button>`).join("");
      picker.querySelector("strong").textContent = mode === "gift" ? "送一朵花" : mode === "emoji" ? "表情" : "桌边互动";
      refreshIcons();
      controls();
    }
    function openPicker(nextMode, targetId = "") {
      mode = nextMode;
      targetSelect.value = targetId;
      if (mode === "gift" && !targetSelect.value) {
        const recipient = state?.players.find(player => player.id !== state.selfId && player.connected);
        targetSelect.value = recipient?.id || "";
      }
      picker.hidden = false;
      root.querySelectorAll("[data-open-social]").forEach(button => button.setAttribute("aria-expanded", String(button.dataset.openSocial === mode)));
      renderOptions();
      targetSelect.focus();
    }
    root.addEventListener("click", async event => {
      const opener = event.target.closest("[data-open-social]");
      if (opener) {
        lastTrigger = opener;
        if (!picker.hidden && mode === opener.dataset.openSocial) closePicker();
        else openPicker(opener.dataset.openSocial);
        return;
      }
      if (event.target.closest("[data-close-social]")) { closePicker(); lastTrigger?.focus(); return; }
      const button = event.target.closest("[data-send-reaction]");
      if (!button || !state || sending || Date.now() < cooldownUntil) return;
      const reactionId = button.dataset.sendReaction;
      const targetId = picker.contains(button) ? targetSelect.value || null : null;
      if (reactionId === "rose" && !targetId) { notify("请选择一位玩家", true); return; }
      sending = true;
      controls();
      const result = await send({ reactionId, targetId });
      sending = false;
      if (result) { cooldownUntil = Date.now() + 1250; closePicker(); }
      controls();
      clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(controls, 1260);
    });
    targetSelect.addEventListener("change", controls);
    document.addEventListener("pointerdown", event => {
      if (!root.contains(event.target) && !event.target.closest("[data-interact-player]")) closePicker();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !picker.hidden) { closePicker(); lastTrigger?.focus(); }
    });

    function findSeat(id) { return [...stage.querySelectorAll("[data-player-id]")].find(node => node.dataset.playerId === id); }
    function point(id) {
      const node = findSeat(id)?.querySelector(".seat-body");
      if (!node) return null;
      const table = stage.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2 - table.left, y: box.top + box.height / 2 - table.top, top: box.top - table.top, bottom: box.bottom - table.top };
    }
    function placeBubble(id, bubble) {
      const seat = findSeat(id);
      const pos = point(id);
      if (!pos || !seat) return;
      const centerSeat = seat.classList.contains("position-0") || seat.classList.contains("position-3");
      const upper = ["position-2", "position-3", "position-4"].some(name => seat.classList.contains(name));
      const width = Math.min(132, stage.clientWidth * .34);
      const x = centerSeat ? pos.x + (stage.clientWidth < 600 ? 92 : 140) : pos.x;
      const y = centerSeat ? pos.y - 22 : upper ? pos.top - 66 : pos.bottom + 22;
      Object.assign(bubble.style, {
        width: `${width}px`, left: `${Math.max(4, Math.min(stage.clientWidth - width - 4, x - width / 2))}px`,
        top: `${Math.max(3, Math.min(stage.clientHeight - 46, y))}px`,
      });
    }
    function bubble(id, text, emoji = false) {
      if (!state?.players.some(player => player.id === id && player.connected) || !point(id)) return;
      bubbles.get(id)?.remove();
      const node = document.createElement("div");
      node.className = `reaction-bubble ${emoji ? "reaction-emoji" : ""}`;
      node.textContent = text;
      layer.append(node);
      bubbles.set(id, node);
      placeBubble(id, node);
      later(() => { node.remove(); if (bubbles.get(id) === node) bubbles.delete(id); }, 3400);
    }
    function flowers(fromId, targetId, symbol) {
      const source = point(fromId);
      const target = point(targetId);
      if (!source || !target) return;
      if (reduced.matches) { bubble(targetId, symbol, true); return; }
      const node = document.createElement("div");
      node.className = "gift-flight";
      node.textContent = symbol;
      Object.assign(node.style, { left: `${source.x - 22}px`, top: `${source.y - 22}px` });
      layer.append(node);
      const dx = target.x - source.x, dy = target.y - source.y;
      node.animate([
        { transform: "translate(0,0) rotate(-24deg) scale(.5)", opacity: 0 },
        { transform: `translate(${dx * .48}px,${dy * .48 - 65}px) rotate(14deg) scale(1.25)`, opacity: 1, offset: .5 },
        { transform: `translate(${dx}px,${dy}px) rotate(-10deg) scale(1)`, opacity: 1 },
      ], { duration: 900, easing: "cubic-bezier(.2,.65,.3,1)", fill: "both" });
      later(() => { node.remove(); bubble(targetId, symbol, true); }, 920);
    }
    function cancelEffects() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      layer.replaceChildren();
      bubbles.clear();
      feed.textContent = "";
      controls();
    }
    function cancel() { cancelEffects(); closePicker(); seen.clear(); }
    function update(next, online) {
      if (state?.code !== next?.code) { cancel(); rosterKey = ""; }
      state = next;
      connected = online;
      const players = state?.players.filter(player => player.connected && player.id !== state.selfId) || [];
      const key = JSON.stringify(players.map(player => [player.id, player.name]));
      if (key !== rosterKey) {
        rosterKey = key;
        const selected = targetSelect.value;
        targetSelect.innerHTML = `<option value="">全桌</option>${players.map(player => `<option value="${esc(player.id)}">${esc(player.name)}</option>`).join("")}`;
        targetSelect.value = players.some(player => player.id === selected) ? selected : "";
      }
      for (const [id, node] of bubbles) {
        if (!state?.players.some(player => player.id === id)) { node.remove(); bubbles.delete(id); }
        else placeBubble(id, node);
      }
      controls();
    }
    function receive(event) {
      if (!state || !connected || event.code !== state.code || seen.has(event.id) || document.hidden) return;
      const item = catalog.find(item => item.id === event.reactionId);
      const from = state.players.find(player => player.id === event.fromId);
      const target = state.players.find(player => player.id === event.targetId);
      if (!item || !from || (event.targetId && !target)) return;
      seen.add(event.id);
      if (seen.size > 100) seen.delete(seen.values().next().value);
      const message = item.kind === "gift" ? `${from.name} 送给 ${target.name} 一朵花`
        : `${from.name}${target ? ` 对 ${target.name}` : ""}：${item.symbol || item.label}`;
      feed.textContent = message;
      later(() => { if (feed.textContent === message) feed.textContent = ""; }, 6000);
      if (item.kind === "gift") flowers(from.id, target.id, item.symbol);
      else bubble(from.id, item.symbol || item.label, item.kind === "emoji");
    }
    window.addEventListener("resize", cancelEffects);
    document.addEventListener("visibilitychange", cancelEffects);
    reduced.addEventListener("change", cancelEffects);
    refreshIcons();
    return { update, receive, cancel, openTarget(id) {
      if (!state || !connected || !state.players.some(player => player.id === id && player.connected)) return;
      lastTrigger = findSeat(id)?.querySelector(".seat-interact");
      openPicker("all", id === state.selfId ? "" : id);
    } };
  };
})();
