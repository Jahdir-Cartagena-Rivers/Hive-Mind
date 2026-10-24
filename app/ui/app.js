"use strict";
// Graph, search and editing for Hive Mind. Every call goes through window.hive (main process).
const $ = (id) => document.getElementById(id);
const api = async (route, body) => {
  const { status, value } = await window.hive.request(route, body);
  if (status >= 400) throw Object.assign(new Error(value?.error ?? `HTTP ${status}`), { status });
  return value;
};
const hash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};
const hue = (project) => Math.round(hash(project || "General memories") * 360);

const state = {
  nodes: [], // hubs then memories; each {id,title,x,y,vx,vy,r,hub,project,...}
  byId: new Map(),
  links: [], // {a,b,type}
  selected: null,
  filter: null,
  matches: new Set(),
  view: { x: 0, y: 0, k: 1 },
  config: { version: 1 },
  records: -1,
  indexing: false,
};
const canvas = $("graph");
const ctx = canvas.getContext("2d");
let dirty = false;
// Repaint only on demand; nothing animates continuously.
const redraw = () => {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    draw();
  });
};

// ---------- layout: grid-accelerated force simulation in short chunks; stops when cooled ----------
let layoutToken = 0;
function layout(steps) {
  const token = ++layoutToken;
  const { nodes, links } = state;
  const cell = 110;
  let step = 0;
  const run = () => {
    if (token !== layoutToken) return;
    for (let n = 0; n < 8 && step < steps; n++, step++) {
      const alpha = Math.max(0.02, 1 - step / steps);
      const grid = new Map();
      for (const node of nodes) {
        const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push(node);
      }
      for (const a of nodes) {
        const gx = Math.floor(a.x / cell);
        const gy = Math.floor(a.y / cell);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (const b of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
              if (a === b) continue;
              let ox = a.x - b.x;
              let oy = a.y - b.y;
              let d2 = ox * ox + oy * oy;
              if (d2 < 100) {
                if (d2 < 1) {
                  ox = Math.random() - 0.5;
                  oy = Math.random() - 0.5;
                }
                d2 = 100;
              }
              // Falls to zero at the grid's reach so cell borders leave no seams.
              const reach = Math.max(0, 1 - Math.sqrt(d2) / (cell * 2));
              const f =
                ((a.hub && b.hub ? 6000 : a.hub || b.hub ? 1800 : 520) * alpha * reach) / d2;
              a.vx += ox * f;
              a.vy += oy * f;
            }
      }
      for (const l of links) {
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.hypot(dx, dy) || 1;
        const rest = l.type === "hub" ? 70 : 120;
        const f = ((d - rest) / d) * (l.type === "hub" ? 0.04 : 0.004) * alpha;
        l.a.vx += dx * f;
        l.a.vy += dy * f;
        l.b.vx -= dx * f;
        l.b.vy -= dy * f;
      }
      for (const node of nodes) {
        node.vx -= node.x * 0.0008 * alpha;
        node.vy -= node.y * 0.0008 * alpha;
        node.vx *= 0.82;
        node.vy *= 0.82;
        // A runaway pair must never fling a node out of the view.
        const speed = Math.hypot(node.vx, node.vy);
        if (speed > 12) {
          node.vx *= 12 / speed;
          node.vy *= 12 / speed;
        }
        node.x += node.vx;
        node.y += node.vy;
      }
    }
    if (step >= steps && !state.touched) fitToNodes();
    redraw();
    if (step < steps) setTimeout(run, 0);
  };
  run();
}

function build(data) {
  const old = state.byId;
  const nodes = [];
  const byId = new Map();
  const place = (item, hubNode, isHub) => {
    const previous = old.get(item.id);
    const angle = hash(item.id) * Math.PI * 2;
    const radius = isHub ? 300 + hash(`${item.id}r`) * 500 : 40 + hash(`${item.id}d`) * 80;
    const base = hubNode ?? { x: 0, y: 0 };
    const node = {
      ...item,
      hub: isHub,
      x: previous?.x ?? base.x + Math.cos(angle) * radius,
      y: previous?.y ?? base.y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      r: isHub ? 8 : 3,
      hue: isHub ? hue(item.title) : hue(item.project),
    };
    nodes.push(node);
    byId.set(item.id, node);
    return node;
  };
  for (const hub of data.hubs)
    place({ id: hub.id, title: hub.title, project: hub.title }, null, true);
  const hubOf = new Map(
    data.edges.filter((e) => e.type === "hub").map((e) => [e.source, byId.get(e.target)]),
  );
  for (const memory of data.nodes) place(memory, hubOf.get(memory.id), false);
  state.nodes = nodes;
  state.byId = byId;
  state.links = data.edges.flatMap((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    return a && b ? [{ a, b, type: e.type }] : [];
  });
  for (const memory of data.nodes) {
    const hub = hubOf.get(memory.id);
    if (hub) hub.members = (hub.members ?? 0) + 1;
  }
  state.records = data.memoryRecords ?? data.nodes.length;
  const fresh = old.size === 0;
  layout(fresh ? 320 : 70);
  if (fresh) fit();
  renderFilters(data);
}

// Frames the densest 96% of nodes so a few stray outliers don't shrink everything.
function fitToNodes() {
  const xs = state.nodes.map((n) => n.x).sort((a, b) => a - b);
  const ys = state.nodes.map((n) => n.y).sort((a, b) => a - b);
  const at = (list, q) => list[Math.floor((list.length - 1) * q)] ?? 0;
  const [x0, x1, y0, y1] = [at(xs, 0.02), at(xs, 0.98), at(ys, 0.02), at(ys, 0.98)];
  const { width, height } = canvas.getBoundingClientRect();
  const k = Math.min(width / Math.max(x1 - x0, 1), height / Math.max(y1 - y0, 1)) * 0.9;
  state.view = { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
}

function fit() {
  const { width, height } = canvas.getBoundingClientRect();
  state.view = { x: width / 2, y: height / 2, k: Math.min(width, height) / 1500 };
}

// ---------- drawing ----------
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const { x, y, k } = state.view;
  ctx.translate(x, y);
  ctx.scale(k, k);
  const focus = state.selected ? state.byId.get(state.selected) : null;
  const neighbors = new Set();
  if (focus)
    for (const l of state.links) {
      if (l.a === focus) neighbors.add(l.b);
      else if (l.b === focus) neighbors.add(l.a);
    }
  const active = (node) =>
    (!state.filter || node.project === state.filter || node.title === state.filter) &&
    (state.matches.size === 0 || state.matches.has(node.id) || node.hub);

  ctx.lineWidth = 1 / k;
  for (const type of ["hub", "related"]) {
    ctx.beginPath();
    for (const l of state.links) {
      if (l.type !== type || !active(l.a) || !active(l.b)) continue;
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
    }
    ctx.strokeStyle = type === "hub" ? "rgba(140,150,170,0.07)" : "rgba(245,184,61,0.13)";
    ctx.stroke();
  }
  if (focus) {
    ctx.beginPath();
    for (const l of state.links)
      if (l.a === focus || l.b === focus) {
        ctx.moveTo(l.a.x, l.a.y);
        ctx.lineTo(l.b.x, l.b.y);
      }
    ctx.strokeStyle = "rgba(245,184,61,0.9)";
    ctx.lineWidth = 1.6 / k;
    ctx.stroke();
  }
  for (const node of state.nodes) {
    ctx.globalAlpha = active(node) ? 1 : 0.12;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r + (node === focus ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${node.hue} ${node.hub ? 70 : 55}% ${node.hub ? 58 : 62}%)`;
    ctx.fill();
    if (node === focus) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / k;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#dde3ee";
  ctx.textBaseline = "middle";
  const label = (node, size) => {
    ctx.font = `${size / k}px "Segoe UI", sans-serif`;
    const text = node.title.length > 32 ? `${node.title.slice(0, 31)}…` : node.title;
    ctx.fillText(text, node.x + node.r + 3 / k, node.y);
  };
  for (const node of state.nodes)
    if (node.hub && active(node) && (node.members >= 8 || k > 1.2)) label(node, 12);
  if (focus) {
    label(focus, 12);
    neighbors.forEach((node) => label(node, 11));
  }
  let shown = 0;
  for (const id of state.matches) {
    const node = state.byId.get(id);
    if (node && shown++ < 40) label(node, 11);
  }
}

// ---------- interaction ----------
const toWorld = (event) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.view.x) / state.view.k,
    y: (event.clientY - rect.top - state.view.y) / state.view.k,
  };
};
function pick(event) {
  const p = toWorld(event);
  let best = null;
  let bestD = Infinity;
  for (const node of state.nodes) {
    const d = Math.hypot(node.x - p.x, node.y - p.y);
    if (d < Math.max(node.r + 3, 9 / state.view.k) && d < bestD) {
      best = node;
      bestD = d;
    }
  }
  return best;
}
let drag = null;
canvas.addEventListener("mousedown", (e) => {
  state.touched = true;
  drag = { x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener("mouseup", (e) => {
  if (drag && !drag.moved && e.target === canvas) {
    const node = pick(e);
    if (node && !node.hub) select(node.id);
    else if (node) setFilter(state.filter === node.title ? null : node.title);
  }
  drag = null;
});
window.addEventListener("mousemove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) {
      state.view.x += dx;
      state.view.y += dy;
      drag.x = e.clientX;
      drag.y = e.clientY;
      $("tip").hidden = true;
      redraw();
    }
    return;
  }
  const tip = $("tip");
  if (e.target !== canvas) {
    tip.hidden = true;
    return;
  }
  const node = pick(e);
  tip.hidden = !node;
  canvas.style.cursor = node ? "pointer" : "default";
  if (node) {
    tip.textContent = node.hub
      ? `${node.title} (project)`
      : `${node.title}${node.preview ? ` — ${node.preview.slice(0, 120)}` : ""}`;
    const rect = canvas.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(e.clientX - rect.left + 14, rect.width - 330))}px`;
    tip.style.top = `${e.clientY - rect.top + 14}px`;
  }
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    state.touched = true;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const k = Math.min(8, Math.max(0.05, state.view.k * Math.exp(-e.deltaY * 0.0015)));
    state.view.x = mx - ((mx - state.view.x) / state.view.k) * k;
    state.view.y = my - ((my - state.view.y) / state.view.k) * k;
    state.view.k = k;
    redraw();
  },
  { passive: false },
);
new ResizeObserver(redraw).observe(canvas);
document.addEventListener("hive:graph-visible", () => {
  if (state.view.k <= 0) fitToNodes();
  redraw();
});

// ---------- selection and editing ----------
function center(node) {
  const { width, height } = canvas.getBoundingClientRect();
  state.view.k = Math.max(state.view.k, 1.2);
  state.view.x = width / 2 - node.x * state.view.k;
  state.view.y = height / 2 - node.y * state.view.k;
}
async function select(id, recenter = false) {
  if (document.body.dataset.view !== "graph")
    document.querySelector('[data-view-tab="graph"]').click();
  state.selected = id;
  const node = state.byId.get(id);
  if (node?.resource) {
    document.dispatchEvent(
      new CustomEvent("hive:open-record", { detail: { id, kind: node.kind } }),
    );
    return;
  }
  if (recenter && node) center(node);
  redraw();
  try {
    const detail = await api("/v1/memory", { id });
    if (state.selected !== id) return;
    $("right").hidden = false;
    $("badge").textContent = detail.memory.project ?? "General";
    $("title").textContent = detail.memory.subject;
    $("fact").value = detail.memory.fact;
    $("fact").dataset.revision = detail.memory.revision;
    $("saved").textContent = "";
    $("source").textContent =
      `Source ${detail.memory.sourceThreadId} · updated ${detail.memory.updatedAt.slice(0, 10)}`;
    const items = detail.related.map((item) => {
      const li = document.createElement("li");
      li.textContent = item.title;
      li.onclick = () => select(item.id, true);
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No close matches yet.";
      items.push(li);
    }
    $("related").replaceChildren(...items);
    $("forget").textContent = "Forget";
  } catch (error) {
    $("saved").textContent = String(error.message);
  }
}
const closeDetail = () => {
  state.selected = null;
  $("right").hidden = true;
  redraw();
};
document.addEventListener("hive:open-memory", (event) => select(event.detail.id, true));
$("close").onclick = closeDetail;
$("save").onclick = async () => {
  try {
    await api("/v1/edit", {
      id: state.selected,
      revision: $("fact").dataset.revision,
      fact: $("fact").value,
    });
    $("saved").textContent = "Saved";
    setTimeout(() => state.selected && select(state.selected), 400);
  } catch (error) {
    $("saved").textContent =
      error.status === 409 ? "Changed elsewhere — reloaded." : String(error.message);
    if (error.status === 409) select(state.selected);
  }
};
$("forget").onclick = async () => {
  if ($("forget").textContent === "Forget") {
    $("forget").textContent = "Click again to forget";
    return;
  }
  await api("/v1/forget", { id: state.selected });
  closeDetail();
  await refresh(true);
};

// ---------- search and filters ----------
function setFilter(name) {
  state.filter = name;
  for (const button of $("filters").children)
    button.classList.toggle("on", button.dataset.name === name);
  redraw();
}
function renderFilters(data) {
  const counts = new Map();
  for (const m of data.nodes) {
    const name = m.project ?? "General memories";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14);
  $("filters").replaceChildren(
    ...top.map(([name, count]) => {
      const button = document.createElement("button");
      button.textContent = `${name} ${count}`;
      button.dataset.name = name;
      button.classList.toggle("on", state.filter === name);
      button.onclick = () => setFilter(state.filter === name ? null : name);
      return button;
    }),
  );
}
let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = $("search").value.trim();
    if (!query) {
      state.matches = new Set();
      $("results").replaceChildren();
      redraw();
      return;
    }
    try {
      const [facts, resources] = await Promise.all([
        api("/v1/search", { query }),
        api("/v1/brain", { query }),
      ]);
      if ($("search").value.trim() !== query) return;
      const memories = [
        ...facts.memories,
        ...resources.records
          .filter((r) => r.kind !== "client")
          .map((r) => ({
            id: r.id,
            subject: r.title,
            fact: JSON.stringify(r.data),
            resourceKind: r.kind,
          })),
      ];
      state.matches = new Set(memories.map((m) => m.id));
      $("results").replaceChildren(
        ...memories.map((m) => {
          const li = document.createElement("li");
          li.textContent = m.subject;
          const small = document.createElement("small");
          small.textContent = m.fact.slice(0, 90);
          li.append(small);
          li.onclick = () =>
            m.resourceKind
              ? document.dispatchEvent(
                  new CustomEvent("hive:open-record", {
                    detail: { id: m.id, kind: m.resourceKind },
                  }),
                )
              : select(m.id, true);
          return li;
        }),
      );
      redraw();
    } catch (error) {
      $("results").textContent = String(error.message);
    }
  }, 250);
});

// ---------- status, sync, compose ----------
async function refresh(force = false) {
  const status = await api("/v1/status");
  state.config = status.config ?? { version: 1 };
  const chip = (text, warn) => {
    const span = document.createElement("span");
    span.textContent = text;
    if (warn) span.className = "warn";
    return span;
  };
  const chips = [
    chip(`${status.records} memories`),
    chip(`${status.skills} skills`),
    ...(status.continuity?.records
      ? [chip(`${status.continuity.records} task/reference records`)]
      : []),
    ...(status.pendingIndex ? [chip(`${status.pendingIndex} indexing`, true)] : []),
    chip(
      status.phase === "idle" ? "up to date" : status.phase,
      status.phase === "syncing" || status.phase === "degraded",
    ),
  ];
  if (status.issues?.length) {
    const issues = chip(`${status.issues.length} issue(s)`, true);
    issues.title = status.issues.join("\n");
    chips.push(issues);
  }
  $("stats").replaceChildren(...chips);
  // Rebuild when the record count changes or an index pass just finished (new related links).
  if (force || status.records !== state.records || (status.pendingIndex === 0 && state.indexing))
    build(await api("/v1/graph", {}));
  state.indexing = status.pendingIndex > 0;
  return status;
}
$("sync").onclick = async () => {
  $("sync").disabled = true;
  try {
    await api("/v1/sync", {});
    await refresh(true);
  } finally {
    $("sync").disabled = false;
  }
};
$("new").onclick = () => $("compose").showModal();
$("compose").addEventListener("close", async () => {
  if ($("compose").returnValue !== "save") return;
  const scope = $("c-scope").value;
  await api("/v1/remember", {
    scope,
    project: scope === "project" ? $("c-project").value || undefined : undefined,
    subject: $("c-subject").value,
    fact: $("c-fact").value,
  });
  $("c-subject").value = "";
  $("c-fact").value = "";
  await refresh(true);
});

// ---------- settings ----------
async function saveConfig(next) {
  const result = await api("/v1/configure", { ...next, version: 1 });
  state.config = result.config ?? next;
  await renderSettings();
}
async function renderSettings() {
  const c = state.config;
  $("vault").textContent = c.vault ?? "Not set";
  $("automatic").checked = c.automatic !== false;
  $("skills").replaceChildren(
    ...(c.skills ?? []).map((skill, index) => {
      const li = document.createElement("li");
      li.className = "row";
      const code = document.createElement("code");
      code.textContent = skill.path;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet";
      remove.textContent = "Remove";
      remove.onclick = () => saveConfig({ ...c, skills: c.skills.filter((_, i) => i !== index) });
      li.append(code, remove);
      return li;
    }),
  );
  const info = await window.hive.connection();
  $("conn-file").textContent = info.file;
  $("mcp").textContent = info.mcp;
  $("login").checked = info.login;
}
$("settings").onclick = async () => {
  await refresh();
  await renderSettings();
  $("config").showModal();
};
$("pick-vault").onclick = async () => {
  const dir = await window.hive.pickFolder();
  if (dir) await saveConfig({ ...state.config, vault: dir });
};
$("open-vault").onclick = () => window.hive.openVault();
$("add-skills").onclick = async () => {
  const dir = await window.hive.pickFolder();
  if (dir)
    await saveConfig({ ...state.config, skills: [...(state.config.skills ?? []), { path: dir }] });
};
$("automatic").onchange = () => saveConfig({ ...state.config, automatic: $("automatic").checked });
$("login").onchange = () => window.hive.loginItem($("login").checked);
$("copy-token").onclick = async () => {
  await window.hive.copyToken();
  $("config-note").textContent = "Token copied; it clears from the clipboard in 30 seconds.";
};
$("import").onclick = async () => {
  $("config-note").textContent = "Importing…";
  try {
    const r = await api("/v1/import", { url: $("h-url").value, bank: $("h-bank").value });
    $("config-note").textContent =
      `Imported ${r.created + r.updated} records from ${r.documents} documents.`;
    await refresh(true);
  } catch (error) {
    $("config-note").textContent = String(error.message);
  }
};

// Counts non-transparent pixels so a blank canvas is detectable by the smoke test.
function painted() {
  if (!canvas.width || !canvas.height) return 0;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count++;
  return count;
}

// ---------- start ----------
(async () => {
  try {
    await refresh(true);
    // The layout settles over a few chunks; report once the first frames have drawn.
    setTimeout(() => {
      window.__hiveReady = {
        memories: state.records,
        hubs: state.nodes.filter((n) => n.hub).length,
        related: state.links.filter((l) => l.type === "related").length,
        painted: painted(),
        nan: state.nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y)).length,
      };
    }, 800);
  } catch (error) {
    window.__hiveReady = { error: String(error.message) };
  }
  let changePending = false;
  let refreshing = false;
  async function committedChange() {
    changePending = true;
    if (document.hidden || refreshing) return;
    refreshing = true;
    try {
      while (changePending) {
        changePending = false;
        await refresh(true);
      }
    } catch (error) {
      console.warn("Memory refresh failed", error.message);
    } finally {
      refreshing = false;
    }
  }
  window.hive.onChanged(committedChange);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && changePending) void committedChange();
  });
  // Periodic reconciliation remains a recovery path; committed changes arrive immediately.
  setInterval(() => {
    if (!document.hidden) refresh().catch(() => {});
  }, 30000);
})();
