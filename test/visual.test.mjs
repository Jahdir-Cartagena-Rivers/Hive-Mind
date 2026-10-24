import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeLayout,
  pruneLayout,
  visibleNodes,
  makeIslands,
  projectPoint,
  pickOrb,
} from "../app/ui/visual-model.mjs";

test("visual layout is store-specific and never changes canonical memory or its scope", () => {
  const nodes = [
    { id: "a", title: "Lamp", project: "Modeling", kind: "asset", preview: "Wide base" },
    { id: "b", title: "Decision", project: "Career", kind: "memory" },
  ];
  const before = JSON.stringify(nodes);
  const raw = JSON.stringify({
    version: 1,
    storeId: "one",
    boards: [{ id: "inspiration", title: "Inspiration", hue: 42 }],
    placements: { a: "inspiration", b: "unknown" },
    pinned: ["a", "a"],
  });
  const layout = decodeLayout(raw, "one");
  assert.deepEqual(layout.pinned, ["a"]);
  assert.deepEqual(layout.placements, { a: "inspiration" });
  assert.equal(decodeLayout(raw, "another").boards.length, 0);
  assert.deepEqual(
    visibleNodes(nodes, layout, {
      query: "wide",
      board: "inspiration",
      project: "Modeling",
      kind: "asset",
    }).map((n) => n.id),
    ["a"],
  );
  assert.equal(
    visibleNodes(nodes, layout, { query: "", board: "inspiration", project: "Career" }).length,
    0,
  );
  assert.equal(makeIslands(nodes, layout)[0].nodes.length, 1);
  assert.equal(JSON.stringify(nodes), before);
});
test("malformed/future visual state is recoverable and forgotten items lose presentation links", () => {
  for (const raw of [
    "{broken",
    JSON.stringify({ version: 7, storeId: "one", boards: [] }),
    "x".repeat(600001),
  ])
    assert.equal(decodeLayout(raw, "one").boards.length, 0);
  const layout = decodeLayout(
    JSON.stringify({
      version: 1,
      storeId: "one",
      boards: [{ id: "board", title: "Board", hue: 42 }],
      placements: { gone: "board", kept: "board" },
      pinned: ["gone", "kept"],
    }),
    "one",
  );
  assert.deepEqual(pruneLayout(layout, [{ id: "kept" }]).pinned, ["kept"]);
  assert.deepEqual(pruneLayout(layout, [{ id: "kept" }]).placements, { kept: "board" });
});
test("perspective orbit changes depth and picking selects the nearest overlapping orb", () => {
  const camera = { yaw: 0, pitch: 0, distance: 900, panX: 0, panY: 0 };
  const point = { x: 150, y: 30, z: 100 };
  const front = projectPoint(point, camera, 1000, 700);
  const rotated = projectPoint(point, { ...camera, yaw: Math.PI / 2 }, 1000, 700);
  assert.notEqual(front.x, rotated.x);
  assert.notEqual(front.depth, rotated.depth);
  assert.equal(projectPoint({ x: 0, y: 0, z: -900 }, camera, 1000, 700), null);
  const near = { x: 50, y: 50, radius: 15, depth: 300, id: "near" };
  assert.equal(pickOrb([{ ...near, depth: 700, id: "far" }, near], 50, 50).id, "near");
  assert.equal(pickOrb([near], 200, 200), null);
});
