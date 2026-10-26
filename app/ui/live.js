"use strict";
// Live strip of what other chats are doing. Presence is ephemeral service state, so a short poll
// while the window is visible is enough; nothing here touches stored memories.
(() => {
  const strip = document.getElementById("live-chats");
  const item = (e) => {
    const row = document.createElement("span");
    row.className = `live-chat ${e.status}${e.overlap ? " overlap" : ""}`;
    const name = document.createElement("strong");
    name.textContent = e.title || e.chatId;
    const detail = document.createElement("span");
    detail.textContent = `${e.provider}${e.project ? ` · ${e.project}` : ""} · ${e.status}${e.step ? ` — ${e.step}` : ""} · ${e.ageSeconds}s ago${e.overlap ? " · same task as another chat" : ""}`;
    row.append(name, detail);
    return row;
  };
  async function poll() {
    if (document.hidden) return;
    try {
      const { status, value } = await window.hive.request("/v1/presence/list", {});
      if (status >= 400) return;
      strip.replaceChildren(...value.presence.map(item));
      strip.hidden = value.presence.length === 0;
    } catch {
      // The service restarting is not worth interrupting the user for.
    }
  }
  void poll();
  setInterval(poll, 2000);
})();
