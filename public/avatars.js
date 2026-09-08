(() => {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  window.playerAvatarMarkup = function (player, own = false) {
    const seed = String(player.id || player.name || "player");
    const hash = [...seed].reduce((value, character) => (Math.imul(value, 31) + character.codePointAt(0)) >>> 0, 0);
    const index = Number.isInteger(player.seat) && player.seat >= 0 ? player.seat % 6 : hash % 6;
    if (own) return `<span class="seat-avatar is-self" title="${esc(player.name)}"><img src="/avatars/player-${index + 1}.svg" width="64" height="64" alt="" draggable="false" /></span>`;
    const title = `送花给 ${player.name}`;
    return `<button type="button" class="seat-avatar" data-interact-player="${esc(player.id)}" title="${esc(title)}" aria-label="${esc(title)}" aria-haspopup="dialog" aria-expanded="false"><img src="/avatars/player-${index + 1}.svg" width="64" height="64" alt="" draggable="false" /></button>`;
  };
})();
