(() => {
  "use strict";
  function findReactionPlacement({ anchor, width, height, bounds, obstacles }) {
    const margin = 4;
    const gap = 6;
    if (width > bounds.width - margin * 2 || height > bounds.height - margin * 2) return null;
    const centerX = (anchor.left + anchor.right) / 2;
    const centerY = (anchor.top + anchor.bottom) / 2;
    const xs = [centerX - width / 2, anchor.left - width - gap, anchor.right + gap, margin, bounds.width - width - margin];
    const ys = [centerY - height / 2, anchor.top - height - gap, anchor.bottom + gap, margin, bounds.height - height - margin];
    // Obstacle edges supply nearby empty positions even when seats are tightly packed.
    for (const box of obstacles) {
      xs.push(box.left - width - gap, box.right + gap);
      ys.push(box.top - height - gap, box.bottom + gap);
    }
    const candidatesX = [...new Set(xs.map(x => Math.max(margin, Math.min(bounds.width - width - margin, x))))];
    const candidatesY = [...new Set(ys.map(y => Math.max(margin, Math.min(bounds.height - height - margin, y))))];
    const maxDistance = Math.max(120, Math.min(180, bounds.width * .4));
    let best = null;
    let bestScore = Infinity;
    for (const x of candidatesX) for (const y of candidatesY) {
      const dx = x + width / 2 - centerX;
      const dy = y + height / 2 - centerY;
      const score = dx * dx + dy * dy;
      if (score >= bestScore || score > maxDistance * maxDistance) continue;
      if (obstacles.some(box => x < box.right + margin && x + width > box.left - margin && y < box.bottom + margin && y + height > box.top - margin)) continue;
      best = { x, y };
      bestScore = score;
    }
    return best;
  }
  window.findReactionPlacement = findReactionPlacement;
  window.createSocial = function ({ root, stage, send, notify, onReaction }) {
    const catalog = window.HOLDEM_REACTIONS;
    const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const icon = name => `<i data-lucide="${name}"></i>`;
    root.innerHTML = `<div class="social-toolbar">
      <span class="social-heading">桌边互动</span>
      <div class="social-commands">
        <button class="social-tool" data-open-social="emoji" title="表情" aria-label="表情" aria-expanded="false">${icon("smile")}</button>
        <span class="social-divider"></span>
        <button class="social-phrase" data-send-reaction="luck">${icon("clover")}<span>祝你好运</span></button>
        <button class="social-phrase" data-send-reaction="inspect">${icon("scan-eye")}<span>我要验牌</span></button>
        <button class="social-tool" data-open-social="all" title="更多互动" aria-label="更多互动" aria-expanded="false">${icon("ellipsis")}</button>
      </div>
    </div>
    <div class="social-picker" hidden role="dialog" aria-label="桌边互动选项">
      <div class="social-picker-heading"><strong>桌边互动</strong><button class="icon-button" data-close-social title="关闭互动" aria-label="关闭互动">${icon("x")}</button></div>
      <div class="social-options"></div>
    </div>
    <div class="social-feed" role="status" aria-live="polite"></div>`;
    const picker = root.querySelector(".social-picker");
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
    let mode = "all";
    let sending = false;
    let cooldownUntil = 0;
    let cooldownTimer;
    let lastTrigger = null;
    let avatarTrigger = null;
    let session = 0;

    function later(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    }
    function refreshIcons() { window.lucide?.createIcons(); }
    function findAvatar(id, roster = false) {
      const container = roster ? document.getElementById("roster") : stage;
      return [...(container?.querySelectorAll(".seat-avatar[data-interact-player]") || [])].find(node => node.dataset.interactPlayer === id);
    }
    function triggerAvatar() {
      return avatarTrigger && (findAvatar(avatarTrigger.id, avatarTrigger.roster) || findAvatar(avatarTrigger.id));
    }
    function positionPicker() {
      if (picker.hidden || !avatarTrigger) return;
      const anchor = triggerAvatar();
      if (!anchor) { closePicker(); return; }
      anchor.setAttribute("aria-expanded", "true");
      const box = anchor.getBoundingClientRect();
      const width = picker.offsetWidth;
      const height = picker.offsetHeight;
      const margin = 8;
      const below = box.bottom + margin;
      const above = box.top - height - margin;
      const top = below + height <= innerHeight - margin ? below : above >= margin ? above : margin;
      picker.style.left = `${Math.max(margin, Math.min(innerWidth - width - margin, box.left + box.width / 2 - width / 2))}px`;
      picker.style.top = `${Math.max(margin, Math.min(innerHeight - height - margin, top))}px`;
    }
    function closePicker(restoreFocus = false) {
      const anchor = triggerAvatar();
      picker.hidden = true;
      picker.classList.remove("avatar-picker");
      picker.style.removeProperty("left");
      picker.style.removeProperty("top");
      anchor?.setAttribute("aria-expanded", "false");
      root.querySelectorAll("[data-open-social]").forEach(button => button.setAttribute("aria-expanded", "false"));
      const focusTarget = anchor || (lastTrigger?.isConnected ? lastTrigger : null);
      if (restoreFocus) focusTarget?.focus({ preventScroll: true });
      avatarTrigger = null;
    }
    function controls() {
      const locked = !state || !connected || sending || Date.now() < cooldownUntil;
      root.querySelectorAll("[data-send-reaction],[data-open-social]").forEach(button => { button.disabled = locked; });
      const rose = options.querySelector('[data-send-reaction="rose"]');
      if (rose) rose.disabled ||= !giftRecipient();
    }
    function giftRecipient() {
      return state?.players.find(player => player.id === avatarTrigger?.id && player.id !== state.selfId && player.connected);
    }
    function renderOptions() {
      const choices = mode === "gift" ? catalog.filter(item => item.kind === "gift")
        : mode === "emoji" ? catalog.filter(item => item.kind === "emoji") : catalog.filter(item => item.kind !== "gift");
      options.className = `social-options ${mode === "emoji" ? "emoji-options" : mode === "gift" ? "gift-options" : ""}`;
      options.innerHTML = choices.map(item => `<button class="social-option ${item.kind === "emoji" ? "emoji-option" : ""}" data-send-reaction="${esc(item.id)}" title="${esc(item.label)}" aria-label="${esc(item.label)}">${item.symbol ? `<span class="reaction-symbol" aria-hidden="true">${esc(item.symbol)}</span>` : icon(item.icon || "message-circle")}${item.kind !== "emoji" ? `<span>${esc(item.label)}</span>` : ""}</button>`).join("");
      picker.querySelector("strong").textContent = mode === "gift" ? `送花给 ${giftRecipient()?.name || "玩家"}` : mode === "emoji" ? "表情" : "更多互动";
      picker.setAttribute("aria-label", mode === "gift" ? "送花" : mode === "emoji" ? "表情" : "更多互动");
      refreshIcons();
      controls();
    }
    function openPicker(nextMode) {
      mode = nextMode;
      picker.hidden = false;
      picker.classList.toggle("avatar-picker", Boolean(avatarTrigger));
      root.querySelectorAll("[data-open-social]").forEach(button => button.setAttribute("aria-expanded", String(button.dataset.openSocial === mode)));
      renderOptions();
      positionPicker();
      options.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    }
    root.addEventListener("click", async event => {
      const opener = event.target.closest("[data-open-social]");
      if (opener) {
        lastTrigger = opener;
        const closing = !picker.hidden && !avatarTrigger && mode === opener.dataset.openSocial;
        closePicker();
        if (!closing) openPicker(opener.dataset.openSocial);
        return;
      }
      if (event.target.closest("[data-close-social]")) { closePicker(true); return; }
      const button = event.target.closest("[data-send-reaction]");
      if (!button || !state || !connected || sending || Date.now() < cooldownUntil) return;
      const reactionId = button.dataset.sendReaction;
      const item = catalog.find(item => item.id === reactionId);
      if (!item) return;
      const targetId = item.kind === "gift" && mode === "gift" && picker.contains(button) ? giftRecipient()?.id || null : null;
      if (item.kind === "gift" && !targetId) return;
      sending = true;
      controls();
      const sendingSession = session;
      try {
        const result = await send({ reactionId, targetId });
        if (sendingSession !== session) return;
        if (result) { cooldownUntil = Date.now() + 1250; closePicker(true); }
      } catch {
        if (sendingSession === session) notify("互动发送失败，请稍后重试", true);
      } finally {
        if (sendingSession === session) {
          sending = false;
          controls();
          clearTimeout(cooldownTimer);
          cooldownTimer = setTimeout(controls, Math.max(0, cooldownUntil - Date.now()) + 10);
        }
      }
    });
    document.addEventListener("pointerdown", event => {
      if (!root.contains(event.target) && !event.target.closest("[data-interact-player]")) closePicker();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !picker.hidden) closePicker(true);
    });

    function findSeat(id) { return [...stage.querySelectorAll("[data-player-id]")].find(node => node.dataset.playerId === id); }
    function point(id, avatar = false) {
      const seat = findSeat(id);
      const node = (avatar && seat?.querySelector(".seat-avatar")) || seat?.querySelector(".seat-body");
      if (!node) return null;
      const table = stage.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2 - table.left, y: box.top + box.height / 2 - table.top, top: box.top - table.top, bottom: box.bottom - table.top };
    }
    function placeBubble(id, bubble) {
      const seat = findSeat(id);
      const avatar = seat?.querySelector(".seat-avatar");
      if (!avatar) { bubble.style.visibility = "hidden"; return; }
      // Always measure the normal bubble, including after a compact avatar fallback.
      for (const property of ["width", "height", "min-height", "font-size", "line-height", "background", "border-radius"]) bubble.style.removeProperty(property);
      const table = stage.getBoundingClientRect();
      function localBox(node) {
        const box = node.getBoundingClientRect();
        return { left: box.left - table.left, right: box.right - table.left, top: box.top - table.top, bottom: box.bottom - table.top };
      }
      const protectedNodes = stage.querySelectorAll(".seat-body, .seat-avatar, .seat-cards, [data-card-key], .seat-bet, .seat-status, .table-center, .card-deck, [data-social-obstacle]");
      const obstacles = [...protectedNodes].filter(node => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const reservedCard = node.hasAttribute("data-card-key");
        return style.display !== "none" && (reservedCard || (style.visibility !== "hidden" && style.opacity !== "0")) && box.width > 0 && box.height > 0;
      }).map(localBox);
      for (const node of bubbles.values()) {
        if (node === bubble || node.style.visibility === "hidden") continue;
        const left = parseFloat(node.style.left), top = parseFloat(node.style.top);
        obstacles.push({ left, top, right: left + node.offsetWidth, bottom: top + node.offsetHeight });
      }
      const placement = findReactionPlacement({
        anchor: localBox(avatar), width: bubble.offsetWidth, height: bubble.offsetHeight,
        bounds: { width: stage.clientWidth, height: stage.clientHeight }, obstacles,
      });
      if (!placement && bubble.classList.contains("reaction-emoji")) {
        const box = localBox(avatar);
        const size = Math.min(44, box.right - box.left, box.bottom - box.top);
        Object.assign(bubble.style, { visibility: "visible", width: `${size}px`, height: `${size}px`,
          minHeight: `${size}px`, fontSize: `${size - 4}px`, lineHeight: `${size}px`,
          left: `${box.left + (box.right - box.left - size) / 2}px`, top: `${box.top + (box.bottom - box.top - size) / 2}px`,
          background: "#192c2b", borderRadius: "50%" });
        return;
      }
      bubble.style.visibility = placement ? "visible" : "hidden";
      if (placement) Object.assign(bubble.style, { left: `${placement.x}px`, top: `${placement.y}px` });
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
      const source = point(fromId, true);
      const target = point(targetId, true);
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
    function cancel() {
      session += 1;
      sending = false;
      cooldownUntil = 0;
      clearTimeout(cooldownTimer);
      state = null;
      connected = false;
      cancelEffects();
      closePicker();
      lastTrigger = null;
      seen.clear();
    }
    function update(next, online) {
      if (state?.code !== next?.code) cancel();
      state = next;
      connected = online;
      for (const [id, node] of bubbles) {
        if (!state?.players.some(player => player.id === id)) { node.remove(); bubbles.delete(id); }
        else placeBubble(id, node);
      }
      if (avatarTrigger && !state?.players.some(player => player.id === avatarTrigger.id && player.connected)) closePicker();
      positionPicker();
      controls();
    }
    function receive(event) {
      if (!state || !connected || !event || typeof event.id !== "string" || event.code !== state.code || seen.has(event.id) || document.hidden) return;
      const item = catalog.find(item => item.id === event.reactionId);
      const from = state.players.find(player => player.id === event.fromId);
      const target = state.players.find(player => player.id === event.targetId);
      if (!item || !from || (event.targetId && !target) || (item.kind === "gift" && !target)) return;
      seen.add(event.id);
      if (seen.size > 100) seen.delete(seen.values().next().value);
      onReaction?.(item, event);
      const message = item.kind === "gift" ? `${from.name} 送给 ${target.name} 一朵花`
        : `${from.name}${target ? ` 对 ${target.name}` : ""}：${item.symbol || item.label}`;
      feed.textContent = message;
      later(() => { if (feed.textContent === message) feed.textContent = ""; }, 6000);
      if (item.kind === "gift") flowers(from.id, target.id, item.symbol);
      else bubble(from.id, item.symbol || item.label, item.kind === "emoji");
    }
    window.addEventListener("resize", () => { cancelEffects(); positionPicker(); });
    window.addEventListener("scroll", positionPicker, true);
    document.addEventListener("visibilitychange", cancelEffects);
    reduced.addEventListener("change", cancelEffects);
    refreshIcons();
    return { update, receive, cancel, openTarget(id) {
      if (!state || !connected || id === state.selfId || !state.players.some(player => player.id === id && player.connected)) return;
      const active = document.activeElement?.closest(".seat-avatar[data-interact-player]");
      closePicker();
      avatarTrigger = { id, roster: active?.dataset.interactPlayer === id && Boolean(active.closest("#roster")) };
      lastTrigger = triggerAvatar();
      openPicker("gift");
    } };
  };
})();
