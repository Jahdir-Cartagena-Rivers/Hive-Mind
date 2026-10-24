// Presentation state only. Nothing here writes to the memory service.
export const PALETTE = [42, 172, 260, 334, 205, 18, 105];
export const hash = (value) => {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0) / 4294967296;
};
export const emptyLayout = (storeId) => ({
  version: 1,
  storeId,
  boards: [],
  placements: {},
  pinned: [],
});
export function decodeLayout(raw, storeId) {
  const clean = emptyLayout(storeId);
  if (!raw || raw.length > 600_000) return clean;
  try {
    const input = JSON.parse(raw);
    if (input.version !== 1 || input.storeId !== storeId || !Array.isArray(input.boards))
      return clean;
    const ids = new Set();
    for (const board of input.boards.slice(0, 48)) {
      if (typeof board?.id !== "string" || !/^[\w-]{1,80}$/u.test(board.id) || ids.has(board.id))
        continue;
      if (typeof board.title !== "string" || !board.title.trim()) continue;
      ids.add(board.id);
      clean.boards.push({
        id: board.id,
        title: board.title.trim().slice(0, 60),
        hue: PALETTE.includes(board.hue) ? board.hue : 42,
      });
    }
    clean.placements = Object.fromEntries(
      Object.entries(input.placements ?? {})
        .filter(([id, board]) => id.length <= 200 && ids.has(board))
        .slice(0, 20_000),
    );
    clean.pinned = [
      ...new Set(
        (Array.isArray(input.pinned) ? input.pinned : []).filter(
          (id) => typeof id === "string" && id.length <= 200,
        ),
      ),
    ].slice(0, 1000);
  } catch {
    /* A broken local layout never makes memories inaccessible. */
  }
  return clean;
}
export function pruneLayout(layout, nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...layout,
    placements: Object.fromEntries(Object.entries(layout.placements).filter(([id]) => ids.has(id))),
    pinned: layout.pinned.filter((id) => ids.has(id)),
  };
}
export function visibleNodes(nodes, layout, filters) {
  const query = filters.query.trim().toLowerCase();
  const pinned = new Set(layout.pinned);
  return nodes
    .filter(
      (node) =>
        (!filters.project || (node.project ?? "General memories") === filters.project) &&
        (!filters.kind || node.kind === filters.kind) &&
        (!filters.board ||
          (filters.board === "pinned"
            ? pinned.has(node.id)
            : layout.placements[node.id] === filters.board)) &&
        (!query ||
          `${node.title} ${node.preview ?? ""} ${node.project ?? ""}`
            .toLowerCase()
            .includes(query)),
    )
    .sort(
      filters.sort === "title"
        ? (a, b) => a.title.localeCompare(b.title)
        : (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
}
export function makeIslands(nodes, layout, mode = "project") {
  const boards = new Map(layout.boards.map((board) => [board.id, board]));
  const groups = new Map();
  for (const node of nodes) {
    const board = boards.get(layout.placements[node.id]);
    const title =
      board?.title ?? (mode === "kind" ? node.kind : (node.project ?? "General memories"));
    const key = board ? `board:${board.id}` : `${mode}:${title}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        title,
        hue: board?.hue ?? PALETTE[Math.floor(hash(key) * PALETTE.length)],
        nodes: [],
      });
    groups.get(key).nodes.push(node);
  }
  return [...groups.values()]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((group, index, all) => {
      const angle = (index / Math.max(1, all.length)) * Math.PI * 2;
      const radius = all.length === 1 ? 0 : Math.max(260, all.length * 70);
      return { ...group, x: Math.sin(angle) * radius, z: Math.cos(angle) * radius, y: 0 };
    });
}
export function projectPoint(point, camera, width, height) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const z = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - z * Math.sin(camera.pitch);
  const depth = camera.distance + point.y * Math.sin(camera.pitch) + z * Math.cos(camera.pitch);
  if (depth < 35) return null;
  const scale = (Math.min(width, height) * 1.35) / depth;
  return {
    x: width / 2 + camera.panX + x * scale,
    y: height * 0.57 + camera.panY - y * scale,
    scale,
    depth,
  };
}
export function pickOrb(orbs, x, y) {
  return (
    [...orbs]
      .sort((a, b) => a.depth - b.depth)
      .find((orb) => Math.hypot(orb.x - x, orb.y - y) <= Math.max(9, orb.radius)) ?? null
  );
}
