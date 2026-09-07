(() => {
  "use strict";

  window.createDealingEffects = function (stage, deck) {
    const layer = document.createElement("div");
    layer.className = "dealing-layer";
    layer.setAttribute("aria-hidden", "true");
    stage.append(layer);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const flights = new Map();
    let handKey = "";

    function finish(key) {
      const flight = flights.get(key);
      if (!flight) return;
      clearTimeout(flight.timer);
      flight.target.style.visibility = "";
      flight.node.remove();
      flights.delete(key);
      deck.classList.toggle("dealing", flights.size > 0);
    }

    function cancel() {
      for (const key of flights.keys()) finish(key);
    }

    function schedule(key, target, delay, fromDeck = true) {
      if (!target || flights.has(key)) return;
      const stageRect = stage.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const sourceRect = deck.getBoundingClientRect();
      const width = target.offsetWidth;
      const height = target.offsetHeight;
      const left = targetRect.left + targetRect.width / 2 - stageRect.left - width / 2;
      const top = targetRect.top + targetRect.height / 2 - stageRect.top - height / 2;
      const dx = sourceRect.left + sourceRect.width / 2 - targetRect.left - targetRect.width / 2;
      const dy = sourceRect.top + sourceRect.height / 2 - targetRect.top - targetRect.height / 2;
      const rotation = getComputedStyle(target).transform;
      const endRotation = rotation === "none" ? "rotate(0deg)" : rotation;
      const faceUp = !target.classList.contains("back");
      const flightTime = fromDeck ? 380 : 0;
      const flipTime = faceUp ? 260 : 0;
      const node = document.createElement("div");
      node.className = "card-flight";
      node.dataset.cardFlight = key;
      Object.assign(node.style, {
        left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      });
      const turn = document.createElement("div");
      turn.className = "flight-turn";
      const back = document.createElement("div");
      back.className = "playing-card back flight-back";
      turn.append(back);
      if (faceUp) {
        const face = target.cloneNode(true);
        face.removeAttribute("data-card-key");
        face.removeAttribute("aria-label");
        face.classList.add("flight-face");
        face.style.visibility = "";
        // Flight cards retain the destination's responsive card typography.
        for (const selector of [".card-corner", ".card-rank", ".card-suit", ".card-symbol"]) {
          const source = target.querySelector(selector);
          const copy = face.querySelector(selector);
          if (!source || !copy) continue;
          const style = getComputedStyle(source);
          for (const property of ["fontSize", "left", "right", "top", "bottom", "lineHeight", "marginTop"])
            copy.style[property] = style[property];
        }
        turn.append(face);
      }
      node.append(turn);
      layer.append(node);
      target.style.visibility = "hidden";
      const flight = { node, target, faceUp, timer: null, endsAt: performance.now() + delay + flightTime + flipTime + 20 };
      flights.set(key, flight);
      deck.classList.add("dealing");
      node.animate(fromDeck ? [
        { transform: `translate(${dx}px, ${dy}px) rotate(-12deg) scale(${Math.min(1, sourceRect.width / width)})`, opacity: 0 },
        { transform: `translate(${dx}px, ${dy}px) rotate(-12deg) scale(${Math.min(1, sourceRect.width / width)})`, opacity: 1, offset: 0.05 },
        { transform: `translate(${dx * 0.36}px, ${dy * 0.36 - 12}px) rotate(-4deg) scale(1)`, opacity: 1, offset: 0.64 },
        { transform: `translate(0, 0) ${endRotation}`, opacity: 1 },
      ] : [
        { transform: endRotation, opacity: 1 },
        { transform: endRotation, opacity: 1 },
      ], { duration: flightTime || 1, delay, fill: "both", easing: "cubic-bezier(.2,.65,.3,1)" });
      if (faceUp) turn.animate([
        { transform: "rotateY(0deg)" },
        { transform: "rotateY(180deg)" },
      ], { duration: flipTime, delay: delay + flightTime, fill: "both", easing: "ease-in-out" });
      flight.timer = setTimeout(() => finish(key), delay + flightTime + flipTime + 20);
    }

    function update(previous, next, animate = true) {
      const nextKey = next ? `${next.code}:${next.handNumber}` : "";
      if (nextKey !== handKey) { cancel(); handKey = nextKey; }
      if (!next || !animate || reducedMotion.matches || document.hidden) { cancel(); return; }
      const targets = new Map([...stage.querySelectorAll("[data-card-key]")].map(card => [card.dataset.cardKey, card]));
      // Socket updates rebuild the card nodes; keep active flights and hide
      // their replacement destinations until the original animation finishes.
      for (const [key, flight] of flights) {
        const target = targets.get(key);
        if (!target) { finish(key); continue; }
        if (flight.faceUp === target.classList.contains("back")) { finish(key); continue; }
        flight.target.style.visibility = "";
        flight.target = target;
        target.style.visibility = "hidden";
      }
      if (!previous || previous.code !== next.code) return;
      const newHand = previous.handNumber !== next.handNumber;
      let boardDelay = 0;
      if (newHand) {
        const players = next.players.filter(player => player.hasCards && player.inHand).sort((a, b) =>
          ((a.seat - next.dealerSeat - 1 + 6) % 6) - ((b.seat - next.dealerSeat - 1 + 6) % 6));
        for (let cardIndex = 0; cardIndex < 2; cardIndex++) {
          players.forEach((player, index) => {
            const key = `hole:${player.id}:${cardIndex}`;
            schedule(key, targets.get(key), (cardIndex * players.length + index) * 100);
          });
        }
        boardDelay = players.length * 200 + 480;
      }
      const previousBoardCount = newHand ? 0 : previous.board.length;
      for (let index = previousBoardCount; index < next.board.length; index++) {
        const key = `board:${index}`;
        const runoutPause = index >= 3 ? (index - Math.max(2, previousBoardCount - 1)) * 220 : 0;
        schedule(key, targets.get(key), boardDelay + (index - previousBoardCount) * 140 + runoutPause);
      }
      if (!newHand) {
        next.players.forEach(player => {
          const oldPlayer = previous.players.find(old => old.id === player.id);
          if (!player.cards?.length || !oldPlayer?.hasCards || oldPlayer.cards?.length) return;
          player.cards.forEach((_, index) => {
            const key = `hole:${player.id}:${index}`;
            schedule(key, targets.get(key), index * 100, false);
          });
        });
      }
    }

    window.addEventListener("resize", cancel);
    reducedMotion.addEventListener("change", cancel);
    document.addEventListener("visibilitychange", cancel);
    function remaining() {
      return Math.max(0, ...[...flights.values()].map(flight => flight.endsAt - performance.now()));
    }
    return { update, cancel, remaining };
  };
})();
