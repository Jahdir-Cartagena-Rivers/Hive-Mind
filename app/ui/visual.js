import {
  PALETTE,
  hash,
  decodeLayout,
  pruneLayout,
  visibleNodes,
  makeIslands,
  projectPoint,
  pickOrb,
} from "./visual-model.mjs";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const request = async (route, body) => {
  const result = await window.hive.request(route, body);
  if (result.status >= 400) throw new Error(result.value.error);
  return result.value;
};
const filters = { query: "", kind: "", project: "", board: "", sort: "recent" };
const camera = { yaw: -0.22, pitch: 0.42, distance: 850, panX: 0, panY: 0 };
let layout = decodeLayout(null, ""),
  nodes = [],
  storeId = "",
  mode = "mind",
  groupMode = "project";
let version = 0,
  shown = 60,
  selected = null,
  projected = [],
  scheduled = false,
  active = true;
let previewVersion = 0,
  observer;
const scene = $("mind-canvas"),
  ctx = scene.getContext("2d", { alpha: false });
const storageKey = () => `hive-visual-layout:${storeId}`;
function save() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(layout));
  } catch {
    $("visual-status").textContent =
      "Your layout could not be saved on this device. Memories are safe.";
  }
}
function publish() {
  document.dispatchEvent(
    new CustomEvent("hive:visual-ready", { detail: { view: mode, count: nodes.length } }),
  );
}
function open(node) {
  if (node.resource)
    document.dispatchEvent(
      new CustomEvent("hive:open-record", { detail: { id: node.id, kind: node.kind } }),
    );
  else document.dispatchEvent(new CustomEvent("hive:open-memory", { detail: { id: node.id } }));
}
function choose(node) {
  selected = node?.id ?? null;
  const ticket = ++previewVersion;
  const panel = $("orb-inspector");
  panel.replaceChildren();
  panel.hidden = !node;
  if (node) {
    const badge = el("p", `${node.kind} / ${node.project ?? "General"}`, "eyebrow");
    const title = el("h2", node.title);
    const dismiss = el("button", "×", "orb-dismiss");
    dismiss.setAttribute("aria-label", "Close memory preview");
    dismiss.onclick = () => choose(null);
    panel.append(
      dismiss,
      badge,
      title,
      el("p", node.preview ?? "Open this memory to see its contents."),
    );
    if (node.kind === "asset" && node.media !== "file") {
      const image = el("img");
      image.alt = node.title;
      window.hive
        .assetPreview(node.id)
        .then((src) => {
          if (ticket === previewVersion && src) {
            image.src = src;
            panel.prepend(image);
          }
        })
        .catch(() => {});
    }
    const button = el("button", "Open memory", "primary");
    button.onclick = () => open(node);
    panel.append(button);
  }
  redraw();
}
function boardButton(title, id, count, tint) {
  const button = el("button", undefined, "board-item");
  button.classList.toggle("active", filters.board === id);
  const dot = el("span", undefined, "board-dot");
  dot.style.background = `hsl(${tint ?? 42} 85% 66%)`;
  button.append(dot, el("span", title), el("small", String(count)));
  button.onclick = () => {
    filters.board = id;
    shown = 60;
    render();
  };
  if (id && id !== "pinned") {
    button.ondragover = (event) => {
      event.preventDefault();
      button.classList.add("drop-over");
    };
    button.ondragleave = () => button.classList.remove("drop-over");
    button.ondrop = (event) => {
      event.preventDefault();
      button.classList.remove("drop-over");
      const memoryId = event.dataTransfer.getData("application/x-hive-memory");
      if (nodes.some((node) => node.id === memoryId)) {
        layout.placements[memoryId] = id;
        save();
        render();
      }
    };
  }
  return button;
}
function renderBoards() {
  const list = $("board-list");
  list.replaceChildren(
    boardButton("All memories", "", nodes.length),
    boardButton("Pinned", "pinned", layout.pinned.length, 172),
  );
  for (const board of layout.boards)
    list.append(
      boardButton(
        board.title,
        board.id,
        Object.values(layout.placements).filter((id) => id === board.id).length,
        board.hue,
      ),
    );
  const current = layout.boards.find((board) => board.id === filters.board);
  $("board-edit").hidden = !current;
  if (current) {
    $("board-title").value = current.title;
    $("board-color").value = String(current.hue);
  }
}
function options(select, values, placeholder, current) {
  select.replaceChildren(
    new Option(placeholder, ""),
    ...values.map((value) => new Option(value, value)),
  );
  select.value = current;
}
function renderCards(visible) {
  observer?.disconnect();
  const grid = $("memory-cards");
  grid.replaceChildren();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          const image = entry.target;
          const ticket = version;
          window.hive
            .assetPreview(image.dataset.id)
            .then((src) => {
              if (ticket === version && image.isConnected) {
                if (src) image.src = src;
                else image.replaceWith(el("span", "Open original reference", "file-placeholder"));
              }
            })
            .catch(() => {
              image.replaceWith(el("span", "File reference", "file-placeholder"));
            });
        }
    },
    { root: $("organizer-scroll"), rootMargin: "100px" },
  );
  for (const node of visible.slice(0, shown)) {
    const card = el("article", undefined, "memory-card");
    card.draggable = true;
    card.ondragstart = (event) => event.dataTransfer.setData("application/x-hive-memory", node.id);
    const visual = el("button", undefined, "card-visual");
    visual.setAttribute("aria-label", `Open ${node.title}`);
    visual.onclick = () => open(node);
    const tint = PALETTE[Math.floor(hash(node.project ?? node.kind) * PALETTE.length)];
    visual.style.setProperty("--orb-color", `hsl(${tint} 90% 65%)`);
    if (node.kind === "asset" && node.media !== "file") {
      const image = el("img");
      image.alt = node.title;
      image.dataset.id = node.id;
      visual.append(image);
      observer.observe(image);
    } else if (node.kind === "asset")
      visual.append(el("span", "Retained file", "file-placeholder"));
    else visual.append(el("span", undefined, "card-orb"));
    const body = el("div", undefined, "card-body");
    const heading = el("button", node.title, "card-title");
    heading.onclick = () => open(node);
    body.append(
      el("p", `${node.kind} · ${node.project ?? "General"}`, "eyebrow"),
      heading,
      el("p", node.preview ?? "", "card-preview"),
    );
    const controls = el("div", undefined, "card-controls");
    const pin = el("button", layout.pinned.includes(node.id) ? "★" : "☆");
    pin.setAttribute(
      "aria-label",
      `${layout.pinned.includes(node.id) ? "Unpin" : "Pin"} ${node.title}`,
    );
    pin.setAttribute("aria-pressed", String(layout.pinned.includes(node.id)));
    pin.onclick = () => {
      layout.pinned = layout.pinned.includes(node.id)
        ? layout.pinned.filter((id) => id !== node.id)
        : [...layout.pinned, node.id].slice(-1000);
      save();
      render();
    };
    const destination = el("select");
    destination.setAttribute("aria-label", `Visual board for ${node.title}`);
    destination.append(
      new Option("No visual board", ""),
      ...layout.boards.map((board) => new Option(board.title, board.id)),
    );
    destination.value = layout.placements[node.id] ?? "";
    destination.onchange = () => {
      if (destination.value) layout.placements[node.id] = destination.value;
      else delete layout.placements[node.id];
      save();
      render();
    };
    controls.append(pin, destination);
    body.append(controls);
    card.append(visual, body);
    grid.append(card);
  }
  $("cards-more").hidden = visible.length <= shown;
}
function render() {
  if (!active) return;
  const visible = visibleNodes(nodes, layout, filters);
  renderBoards();
  $("visual-total").textContent = `${visible.length.toLocaleString()} memories`;
  $("visual-empty").hidden = visible.length > 0;
  $("visual-empty").textContent = nodes.length
    ? "No memories match this view. Try another board or clear your filters."
    : "Your memory space is ready. Add a memory or retain a visual reference to place the first orb.";
  $("visual-status").textContent =
    mode === "mind" && visible.length > 800
      ? `Showing 800 of ${visible.length} orbs. Search or filter to explore more.`
      : "";
  if (mode === "organizer") renderCards(visible);
  else {
    observer?.disconnect();
    redraw();
  }
  publish();
}
async function load() {
  const ticket = ++version;
  try {
    const graph = await request("/v1/graph", {});
    if (ticket !== version) return;
    const identity = graph.streamId;
    if (typeof identity !== "string") throw new Error("Memory store identity is unavailable.");
    if (identity !== storeId) {
      storeId = identity;
      let raw;
      try {
        raw = localStorage.getItem(storageKey());
      } catch {
        /* private storage may be disabled */
      }
      layout = decodeLayout(raw, storeId);
    }
    nodes = graph.nodes;
    layout = pruneLayout(layout, nodes);
    save();
    if (selected && !nodes.some((node) => node.id === selected)) choose(null);
    options(
      $("visual-project"),
      [...new Set(nodes.map((node) => node.project ?? "General memories"))].sort(),
      "All projects",
      filters.project,
    );
    options(
      $("visual-kind"),
      [...new Set(nodes.map((node) => node.kind))].sort(),
      "All kinds",
      filters.kind,
    );
    render();
  } catch (error) {
    $("visual-status").textContent = error.message;
  }
}
function setView(value) {
  mode = value;
  active = value !== "graph";
  document.body.dataset.view = value;
  for (const button of document.querySelectorAll("[data-view-tab]")) {
    const on = button.dataset.viewTab === value;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
  $("visual-shell").hidden = !active;
  $("graph-shell").hidden = active;
  $("mind-space").hidden = value !== "mind";
  $("organizer-scroll").hidden = value !== "organizer";
  $("mind-controls").hidden = value !== "mind";
  if (value !== "organizer") observer?.disconnect();
  if (active) render();
  else {
    document.dispatchEvent(new Event("hive:graph-visible"));
    window.dispatchEvent(new Event("resize"));
  }
}

// A small perspective renderer: real XYZ positions, depth sorting, camera orbit,
// zoom and depth-aware picking. It sleeps between interactions; no background loop.
function redraw() {
  if (!active || mode !== "mind" || scheduled || document.hidden) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    draw();
  });
}
function draw() {
  const rect = scene.getBoundingClientRect(),
    w = rect.width,
    h = rect.height;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  scene.width = Math.round(w * dpr);
  scene.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sky = ctx.createRadialGradient(w * 0.48, h * 0.4, 20, w / 2, h / 2, w * 0.8);
  sky.addColorStop(0, "#22203e");
  sky.addColorStop(0.5, "#101629");
  sky.addColorStop(1, "#080c17");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 110; i++) {
    ctx.fillStyle = `rgba(194,202,239,${0.12 + hash(String(i)) * 0.34})`;
    ctx.beginPath();
    ctx.arc(hash(`sx${i}`) * w, hash(`sy${i}`) * h * 0.76, hash(`sr${i}`) + 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  const project = (point) => projectPoint(point, camera, w, h);
  const line = (a, b, color, width = 1) => {
    const p = project(a),
      q = project(b);
    if (!p || !q) return;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  for (let i = -9; i <= 9; i++) {
    line({ x: i * 90, y: -60, z: -850 }, { x: i * 90, y: -60, z: 850 }, "#89a4df0c");
    line({ x: -850, y: -60, z: i * 90 }, { x: 850, y: -60, z: i * 90 }, "#89a4df0c");
  }
  const visible = visibleNodes(nodes, layout, filters).slice(0, 800);
  const islands = makeIslands(visible, layout, groupMode);
  const orbs = [],
    labels = [],
    shelves = [];
  for (const island of islands) {
    const columns = Math.min(9, Math.max(3, Math.ceil(Math.sqrt(island.nodes.length))));
    const rows = Math.ceil(island.nodes.length / columns);
    const width = Math.max(150, columns * 40);
    for (let row = 0; row < Math.min(rows, 14); row++)
      shelves.push({ x: island.x, y: row * 42 - 28, z: island.z + 10, width, hue: island.hue });
    for (let i = 0; i < island.nodes.length; i++) {
      const layer = Math.floor(i / (columns * 14));
      const point = {
        x: island.x + ((i % columns) - (columns - 1) / 2) * 40,
        y: Math.floor((i % (columns * 14)) / columns) * 42 - 7,
        z: island.z - layer * 44,
      };
      const p = project(point);
      if (p && p.x > -60 && p.x < w + 60 && p.y > -60 && p.y < h + 60)
        orbs.push({
          ...p,
          radius: Math.max(2, 15 * p.scale),
          hue: island.hue,
          node: island.nodes[i],
        });
    }
    const p = project({ x: island.x, y: -63, z: island.z });
    if (p) labels.push({ ...p, title: island.title, count: island.nodes.length, hue: island.hue });
  }
  // Rails and islands are depth sorted with the orbs so foreground objects
  // correctly cover objects behind them while orbiting.
  const objects = [
    ...orbs.map((orb) => ({ ...orb, type: "orb" })),
    ...shelves.flatMap((shelf) => {
      const p = project(shelf);
      return p ? [{ ...shelf, ...p, type: "shelf" }] : [];
    }),
  ].sort((a, b) => b.depth - a.depth);
  for (const object of objects) {
    const { x, y, scale } = object;
    if (object.type === "shelf") {
      const rail = object.width * scale;
      ctx.fillStyle = "#111b2ce8";
      ctx.strokeStyle = `hsla(${object.hue} 70% 65% / .3)`;
      ctx.lineWidth = Math.max(0.8, scale);
      ctx.beginPath();
      ctx.ellipse(x, y, rail / 2, 8 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }
    const r = object.radius,
      selectedOrb = object.node.id === selected;
    const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * (selectedOrb ? 3.3 : 2.5));
    glow.addColorStop(0, `hsla(${object.hue} 100% 65% / .4)`);
    glow.addColorStop(1, `hsla(${object.hue} 100% 65% / 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 3.3, y - r * 3.3, r * 6.6, r * 6.6);
    const glass = ctx.createRadialGradient(
      x - r * 0.35,
      y - r * 0.42,
      r * 0.05,
      x + r * 0.12,
      y + r * 0.12,
      r,
    );
    glass.addColorStop(0, "#fffde7");
    glass.addColorStop(0.18, `hsl(${object.hue} 100% 86%)`);
    glass.addColorStop(0.65, `hsl(${object.hue} 90% 59%)`);
    glass.addColorStop(1, `hsl(${object.hue} 65% 26%)`);
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = selectedOrb ? "#fff" : `hsla(${object.hue} 100% 90% / .65)`;
    ctx.lineWidth = selectedOrb ? 2 : 1;
    ctx.stroke();
    if (layout.pinned.includes(object.node.id)) {
      ctx.fillStyle = "#fff9d6";
      ctx.beginPath();
      ctx.arc(x + r * 0.65, y - r * 0.65, Math.max(2, r * 0.23), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const label of labels) {
    if (label.scale < 0.12) continue;
    ctx.font = "600 12px Segoe UI";
    ctx.fillStyle = "#e9e5ff";
    ctx.fillText(
      label.title.length > 32 ? label.title.slice(0, 31) + "…" : label.title,
      label.x,
      label.y,
    );
    ctx.font = "10px Segoe UI";
    ctx.fillStyle = "#9d9bb8";
    ctx.fillText(`${label.count} memories`, label.x, label.y + 19);
  }
  projected = orbs;
  window.__hiveVisual = {
    mode,
    orbs: orbs.length,
    islands: islands.length,
    rendered3d: true,
    finite: orbs.every((p) => Number.isFinite(p.x + p.y + p.depth)),
    camera: { ...camera },
    boards: layout.boards.length,
    pins: layout.pinned.length,
    sample: orbs[0] ? { x: orbs[0].x, y: orbs[0].y } : null,
  };
  document.dispatchEvent(new Event("hive:scene-painted"));
}
const localPoint = (event) => {
  const r = scene.getBoundingClientRect();
  return { x: event.clientX - r.left, y: event.clientY - r.top };
};
let drag;
scene.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  scene.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, moved: false, pan: event.shiftKey };
  scene.focus();
});
scene.addEventListener("pointermove", (event) => {
  if (drag) {
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.moved) {
      if (drag.pan) {
        camera.panX += dx;
        camera.panY += dy;
      } else {
        camera.yaw += dx * 0.006;
        camera.pitch = Math.max(-0.6, Math.min(1, camera.pitch + dy * 0.005));
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      redraw();
    }
    return;
  }
  const p = localPoint(event),
    orb = pickOrb(projected, p.x, p.y);
  scene.style.cursor = orb ? "pointer" : "grab";
  const tip = $("mind-tooltip");
  tip.hidden = !orb;
  if (orb) {
    tip.textContent = orb.node.title;
    tip.style.left = `${Math.min(p.x + 14, scene.clientWidth - 250)}px`;
    tip.style.top = `${Math.max(10, p.y - 35)}px`;
  }
});
scene.addEventListener("pointerup", (event) => {
  if (drag && !drag.moved) {
    const p = localPoint(event);
    choose(pickOrb(projected, p.x, p.y)?.node);
  }
  drag = null;
  $("mind-tooltip").hidden = true;
});
scene.addEventListener("pointercancel", () => {
  drag = null;
});
scene.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    camera.distance = Math.max(
      210,
      Math.min(6000, camera.distance * Math.exp(event.deltaY * 0.001)),
    );
    redraw();
  },
  { passive: false },
);
scene.addEventListener("keydown", (event) => {
  const keys = {
    ArrowLeft: () => (camera.yaw -= 0.12),
    ArrowRight: () => (camera.yaw += 0.12),
    ArrowUp: () => (camera.pitch = Math.max(-0.6, camera.pitch - 0.08)),
    ArrowDown: () => (camera.pitch = Math.min(1, camera.pitch + 0.08)),
    "+": () => (camera.distance = Math.max(210, camera.distance * 0.85)),
    "=": () => (camera.distance = Math.max(210, camera.distance * 0.85)),
    "-": () => (camera.distance = Math.min(6000, camera.distance * 1.15)),
    Home: reset,
  };
  if (keys[event.key]) {
    event.preventDefault();
    keys[event.key]();
    redraw();
  }
});
function reset() {
  camera.yaw = -0.22;
  camera.pitch = 0.42;
  const islands = makeIslands(visibleNodes(nodes, layout, filters), layout, groupMode);
  const heights = islands.map((island) => {
    const columns = Math.min(9, Math.max(3, Math.ceil(Math.sqrt(island.nodes.length))));
    return Math.min(14, Math.ceil(island.nodes.length / columns)) * 70;
  });
  camera.distance = Math.max(750, islands.length * 160, ...heights);
  camera.panX = 0;
  camera.panY = 0;
  redraw();
}
for (const button of document.querySelectorAll("[data-view-tab]"))
  button.onclick = () => setView(button.dataset.viewTab);
$("visual-search").oninput = (event) => {
  filters.query = event.target.value;
  shown = 60;
  render();
};
for (const key of ["project", "kind", "sort"])
  $("visual-" + key).onchange = (event) => {
    filters[key] = event.target.value;
    shown = 60;
    render();
  };
$("cards-more").onclick = () => {
  shown += 60;
  render();
};
$("mind-reset").onclick = reset;
$("mind-group").onchange = (event) => {
  groupMode = event.target.value;
  reset();
  render();
};
$("mind-zoom-in").onclick = () => {
  camera.distance = Math.max(210, camera.distance * 0.8);
  redraw();
};
$("mind-zoom-out").onclick = () => {
  camera.distance = Math.min(6000, camera.distance * 1.25);
  redraw();
};
for (const hue of PALETTE)
  $("board-color").append(new Option(`Color ${PALETTE.indexOf(hue) + 1}`, String(hue)));
$("board-create").onsubmit = (event) => {
  event.preventDefault();
  const title = $("new-board-title").value.trim();
  if (!title || layout.boards.length >= 48) return;
  const id = crypto.randomUUID();
  layout.boards.push({
    id,
    title: title.slice(0, 60),
    hue: PALETTE[layout.boards.length % PALETTE.length],
  });
  filters.board = id;
  $("new-board-title").value = "";
  save();
  render();
};
$("board-edit").onsubmit = (event) => {
  event.preventDefault();
  const board = layout.boards.find((board) => board.id === filters.board);
  if (!board) return;
  board.title = $("board-title").value.trim().slice(0, 60) || board.title;
  board.hue = Number($("board-color").value);
  save();
  render();
};
$("board-remove").onclick = () => {
  const id = filters.board;
  layout.boards = layout.boards.filter((board) => board.id !== id);
  layout.placements = Object.fromEntries(
    Object.entries(layout.placements).filter(([, board]) => board !== id),
  );
  filters.board = "";
  save();
  render();
};
new ResizeObserver(redraw).observe(scene);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) redraw();
});
let reloading = false,
  pending = false;
window.hive.onChanged(async () => {
  pending = true;
  if (reloading) return;
  reloading = true;
  try {
    while (pending) {
      pending = false;
      await load();
    }
  } finally {
    reloading = false;
  }
});
setInterval(() => {
  if (active && !document.hidden) void load();
}, 30000);
setView("mind");
void load();
