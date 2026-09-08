(() => {
  "use strict";

  window.createTableLayout = function ({ root }) {
    const doc = root.ownerDocument;
    const byId = id => doc.getElementById(id);
    const focusSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
    const panels = [
      { name: "room", panel: byId("room-drawer"), trigger: byId("room-toggle"), close: byId("close-room"), backdrop: byId("room-backdrop"), modal: true },
      { name: "result", panel: byId("result-drawer"), trigger: byId("result-toggle"), close: byId("close-result"), backdrop: byId("result-backdrop"), modal: true },
      { name: "raise", panel: byId("raise-editor"), trigger: byId("raise-toggle"), close: byId("close-raise"), backdrop: byId("raise-backdrop"), modal: false },
    ].filter(item => item.panel && item.trigger);
    let state = null;
    let active = null;
    let previousFocus = null;

    function visible(node) {
      return Boolean(node?.isConnected && !node.closest("[hidden], [inert]") && node.getClientRects().length);
    }

    function focusable(panel) {
      return [...panel.querySelectorAll(focusSelector)].filter(visible);
    }

    function focusPanel(item) {
      const target = visible(item.close) && !item.close.disabled ? item.close : focusable(item.panel)[0] || item.panel;
      target.focus({ preventScroll: true });
    }

    function canRaise() {
      const self = state?.players.find(player => player.id === state.selfId);
      return Boolean(state?.phase === "playing" && self && state.turnSeat === self.seat
        && state.legal?.actions.some(action => action === "bet" || action === "raise"));
    }

    function close(restoreFocus = true) {
      if (!active) return;
      const item = active;
      const target = previousFocus;
      const hadFocus = item.panel.contains(doc.activeElement);
      active = null;
      previousFocus = null;
      item.panel.hidden = true;
      if (item.backdrop) item.backdrop.hidden = true;
      item.trigger.setAttribute("aria-expanded", "false");
      doc.body.classList.remove(`${item.name}-drawer-open`, "table-overlay-open");
      if (restoreFocus) {
        const destination = visible(target) && !target.disabled ? target : visible(item.trigger) && !item.trigger.disabled ? item.trigger : null;
        if (destination) destination.focus({ preventScroll: true });
        else if (hadFocus) doc.activeElement?.blur();
      }
    }

    function open(item) {
      if (item.trigger.disabled || !state || root.hidden) return;
      if (item.name === "raise" && !canRaise()) return;
      if (item.name === "result" && (state.phase !== "finished" || !state.result?.length)) return;
      if (active === item) { close(); return; }
      close(false);
      previousFocus = visible(doc.activeElement) ? doc.activeElement : item.trigger;
      active = item;
      item.panel.hidden = false;
      if (item.backdrop) item.backdrop.hidden = false;
      item.trigger.setAttribute("aria-expanded", "true");
      doc.body.classList.add(`${item.name}-drawer-open`);
      if (item.modal) doc.body.classList.add("table-overlay-open");
      focusPanel(item);
    }

    for (const item of panels) {
      item.panel.hidden = true;
      if (item.backdrop) item.backdrop.hidden = true;
      item.panel.setAttribute("role", "dialog");
      item.panel.setAttribute("tabindex", "-1");
      if (item.modal) item.panel.setAttribute("aria-modal", "true");
      item.trigger.setAttribute("aria-controls", item.panel.id);
      item.trigger.setAttribute("aria-expanded", "false");
      item.trigger.addEventListener("click", () => open(item));
      item.close?.addEventListener("click", () => { if (active === item) close(); });
      item.backdrop?.addEventListener("click", () => { if (active === item) close(); });
    }

    doc.addEventListener("pointerdown", event => {
      if (!active || active.modal || active.panel.contains(event.target) || active.trigger.contains(event.target)) return;
      close();
    });

    doc.addEventListener("keydown", event => {
      if (!active) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !active.modal) return;
      const targets = focusable(active.panel);
      const index = targets.indexOf(doc.activeElement);
      if (!targets.length) {
        event.preventDefault();
        active.panel.focus({ preventScroll: true });
      } else if (index < 0 || (event.shiftKey ? index === 0 : index === targets.length - 1)) {
        event.preventDefault();
        targets[event.shiftKey ? targets.length - 1 : 0].focus({ preventScroll: true });
      }
    });

    doc.addEventListener("focusin", event => {
      if (active?.modal && !active.panel.contains(event.target)) focusPanel(active);
    });

    window.addEventListener("resize", () => {
      if (!active) return;
      if (!visible(active.panel)) { close(); return; }
      if (active.panel.contains(doc.activeElement) && !visible(doc.activeElement)) focusPanel(active);
    });

    function update(next) {
      const previous = state;
      state = next;
      if (!next || (previous && (previous.code !== next.code || previous.selfId !== next.selfId))) { close(); return; }
      if (active?.name === "raise" && (!canRaise() || previous?.phase !== next.phase
        || previous?.handNumber !== next.handNumber || previous?.turnId !== next.turnId)) close();
      if (active?.name === "result" && (next.phase !== "finished" || !next.result?.length
        || previous?.handNumber !== next.handNumber)) close();
    }

    function reset() {
      close();
      state = null;
    }

    return { update, reset, close };
  };
})();
