"use strict";
(() => {
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const byId = (id) => document.getElementById(id);
  const dialog = byId("workspace-dialog");
  const note = (text) => {
    byId("workspace-note").textContent = text;
  };
  const request = async (route, body) => {
    const r = await window.hive.request(route, body);
    if (r.status >= 400) throw new Error(r.value.error);
    return r.value;
  };
  const run = (fn) => async (event) => {
    event?.preventDefault();
    try {
      await fn(event);
    } catch (error) {
      note(error.message);
    }
  };
  let records = [];
  let assets = [];
  let tasks = [];
  let all = [];
  let selected = null;
  let modified = false;
  let loadVersion = 0;
  const definitions = {
    task: [
      ["objective", "Objective", "text"],
      ["status", "Status", ["open", "active", "blocked", "paused", "done"]],
      ["decisions", "Decisions", "lines"],
      ["failures", "Failed attempts", "lines"],
      ["questions", "Open questions", "lines"],
      ["nextSteps", "Next actions", "lines"],
    ],
    preference: [
      ["statement", "What you like or want to avoid", "text"],
      ["polarity", "Preference", ["like", "dislike", "constraint"]],
      ["context", "When this applies", "text"],
      ["exceptions", "Exceptions", "lines"],
    ],
    collection: [],
    artifact: [["description", "Version description and feedback", "text"]],
    episode: [
      ["summary", "Work note", "text"],
      ["outcome", "Outcome", "text"],
    ],
    entity: [
      ["entityType", "Kind of concept", "text"],
      ["description", "Description", "text"],
    ],
    relation: [["relationship", "Relationship", "text"]],
  };
  function field(form, label, node) {
    const wrapper = el("label", label);
    wrapper.append(node);
    form.append(wrapper);
    return node;
  }
  function select(options, value) {
    const node = el("select");
    for (const [key, label] of options) {
      const option = el("option", label);
      option.value = key;
      node.append(option);
    }
    node.value = value ?? options[0]?.[0] ?? "";
    return node;
  }
  async function thumbnail(id, node) {
    try {
      node.src = await window.hive.assetData(id);
    } catch {
      node.alt = "Reference unavailable";
    }
  }
  async function load() {
    const version = ++loadVersion;
    const kind = byId("workspace-kind").value;
    const query = byId("workspace-search").value;
    const result = await request("/v1/brain", { kind, query, includeHistory: true });
    if (
      version !== loadVersion ||
      kind !== byId("workspace-kind").value ||
      query !== byId("workspace-search").value
    )
      return;
    records = result.records;
    const list = byId("workspace-list");
    list.replaceChildren();
    for (const record of records) {
      const li = el("li");
      const button = el("button", `${record.title} · ${record.project ?? "General"}`);
      button.onclick = run(() => edit(record));
      li.append(button);
      list.append(li);
    }
    note(
      `${result.total} records · saved sequence ${result.sequence}${result.total > 200 ? " · refine your search to see more" : ""}`,
    );
  }
  async function edit(record = null) {
    selected = record;
    modified = false;
    const kind = byId("workspace-kind").value;
    const form = byId("workspace-editor");
    form.replaceChildren();
    if (kind === "client") {
      if (record)
        form.append(
          el("h3", record.title),
          el("p", `Last received sequence: ${record.data.consumedSequence}`),
          el("p", `Updated: ${record.updatedAt}`),
          el("p", `Task: ${record.data.taskId ?? "None"}`),
        );
      return;
    }
    const title = field(form, "Title", el("input"));
    title.value = record?.title ?? "";
    title.required = true;
    title.maxLength = 200;
    const scope = field(
      form,
      "Scope",
      select(
        [
          ["project", "Project"],
          ["general", "General preference or reference"],
        ],
        record?.scope ?? "project",
      ),
    );
    const project = field(form, "Project", el("input"));
    project.value = record?.project ?? "";
    project.maxLength = 160;
    const media =
      kind === "asset" && !record
        ? field(
            form,
            "Reference type",
            select(
              [
                ["image", "Image"],
                ["file", "Model, document or source file"],
              ],
              "image",
            ),
          )
        : null;
    const controls = {};
    for (const [key, label, type] of definitions[kind] ?? []) {
      const node = Array.isArray(type)
        ? select(
            type.map((v) => [v, v]),
            record?.data[key],
          )
        : el("textarea");
      if (!Array.isArray(type))
        node.value =
          type === "lines" ? (record?.data[key] ?? []).join("\n") : (record?.data[key] ?? "");
      controls[key] = { node, type };
      field(form, label, node);
    }
    let taskSelect;
    if (["preference", "artifact", "episode"].includes(kind))
      taskSelect = field(
        form,
        "Related task",
        select(
          [
            ["", "No specific task"],
            ...tasks.map((t) => [t.id, `${t.title} (${t.project ?? "General"})`]),
          ],
          record?.data.taskId,
        ),
      );
    const relationships = {};
    if (kind === "relation")
      for (const key of ["from", "to"])
        relationships[key] = field(
          form,
          key === "from" ? "From" : "To",
          select(
            all.filter((r) => r.kind !== "client").map((r) => [r.id, r.title]),
            record?.data[key],
          ),
        );
    const imageControls = [];
    if (!["asset", "relation"].includes(kind)) {
      form.append(el("h3", "Visual references"));
      const picker = el("div");
      picker.className = "reference-picker";
      for (const asset of assets) {
        if (kind === "collection" && asset.data.media === "file") continue;
        const tile = el("div");
        const label = el("label");
        const checked = el("input");
        checked.type = "checkbox";
        checked.checked = record?.data.assetIds?.includes(asset.id) ?? false;
        const img = asset.data.media === "file" ? el("p", asset.data.filename) : el("img");
        if (asset.data.media !== "file") {
          img.alt = asset.title;
          void thumbnail(asset.id, img);
        }
        label.append(checked, document.createTextNode(asset.title), img);
        tile.append(label);
        const entry = { id: asset.id, checked };
        if (kind === "collection") {
          const annotation = record?.data.annotations?.find((a) => a.assetId === asset.id);
          entry.note = el("textarea");
          entry.note.placeholder = "Which details matter?";
          entry.note.value = annotation?.note ?? "";
          tile.append(entry.note);
          const region = el("div");
          region.className = "reference-region";
          entry.region = {};
          for (const key of ["x", "y", "width", "height"]) {
            const input = el("input");
            input.type = "number";
            input.min = "0";
            input.max = "1";
            input.step = "0.01";
            input.placeholder = key;
            input.setAttribute("aria-label", key);
            input.value = annotation?.region?.[key] ?? "";
            entry.region[key] = input;
            region.append(input);
          }
          tile.append(
            el("small", "Optional region: left, top, width, height as fractions of the image."),
            region,
          );
        }
        imageControls.push(entry);
        picker.append(tile);
      }
      form.append(picker);
    }
    let preferred;
    if (kind === "artifact" && record) {
      preferred = field(
        form,
        "Preferred version",
        select(
          [
            ["", "Use latest"],
            ...record.history.map((h) => [
              h.revision,
              `${h.at}: ${String(h.data.description).slice(0, 70)}`,
            ]),
            [record.revision, `Current: ${record.data.description}`],
          ],
          record.data.preferredRevision ?? "",
        ),
      );
      const history = el("details");
      history.append(el("summary", "Version history"));
      for (const version of record.history) {
        history.append(el("p", `${version.at} — ${version.data.description}`));
        for (const id of version.data.assetIds ?? []) {
          const img = el("img");
          img.alt = "Earlier reference";
          void thumbnail(id, img);
          history.append(img);
        }
      }
      form.append(history);
    }
    if (kind === "asset" && record) {
      const download = el("button", "Save a copy");
      download.type = "button";
      download.onclick = run(async () => {
        if (await window.hive.saveReference(record.id)) note("Reference saved.");
      });
      form.append(download);
      if (record.data.media === "file")
        form.append(
          el(
            "p",
            `${record.data.filename} · ${record.data.bytes} bytes · retained without execution`,
          ),
        );
      else {
        const image = el("img");
        image.alt = record.title;
        await thumbnail(record.id, image);
        form.append(
          image,
          el("p", `${record.data.width} × ${record.data.height} · ${record.data.mime}`),
        );
        const similar = el("button", "Find similar images");
        similar.type = "button";
        similar.onclick = run(async () => {
          const result = await request("/v1/visual-search", { assetId: record.id });
          const matches = el("div");
          matches.className = "reference-picker";
          for (const hit of result.matches) {
            const button = el("button", hit.record.title);
            button.type = "button";
            const preview = el("img");
            preview.alt = hit.record.title;
            void thumbnail(hit.record.id, preview);
            button.append(preview);
            button.onclick = run(() => edit(hit.record));
            matches.append(button);
          }
          form.append(matches);
          note(
            `${result.matches.length} matches · ${result.method}. Your stated preferences remain separate.`,
          );
        });
        form.append(similar);
      }
    }
    const buttons = el("div");
    buttons.className = "row";
    if (kind !== "asset" || !record) {
      const save = el("button", kind === "asset" ? "Choose and retain image" : "Save");
      save.type = "submit";
      buttons.append(save);
    }
    if (record) {
      const remove = el("button", "Forget");
      remove.type = "button";
      remove.className = "danger";
      remove.onclick = run(async () => {
        await request("/v1/brain/forget", { id: record.id, revision: record.revision });
        await edit();
        await load();
      });
      buttons.append(remove);
      form.append(
        el(
          "p",
          `Source: ${record.source.type} · ${record.source.provider} · ${record.source.threadId}`,
        ),
      );
    }
    if (kind === "task" && record) {
      const owner = record.data.lease;
      form.append(
        el(
          "p",
          owner && owner.expiresAt > Date.now()
            ? `Claimed by ${owner.owner} until ${new Date(owner.expiresAt).toLocaleTimeString()}`
            : "No active claim",
        ),
      );
      const claim = el("button", owner?.owner === "desktop" ? "Release my claim" : "Claim task");
      claim.type = "button";
      claim.onclick = run(async () => {
        const current = await request("/v1/tasks/claim", {
          id: record.id,
          revision: record.revision,
          owner: "desktop",
          release: owner?.owner === "desktop",
        });
        await load();
        await edit(current);
      });
      buttons.append(claim);
      form.append(el("p", `Task reference for connected AIs: ${record.id}`));
    }
    form.append(buttons);
    let saving = false;
    let draftEventId = crypto.randomUUID();
    form.oninput = () => {
      modified = true;
      if (!saving) draftEventId = crypto.randomUUID();
    };
    form.onsubmit = run(async () => {
      if (saving) return;
      saving = true;
      try {
        if (scope.value === "project" && !project.value.trim())
          throw new Error("Enter a project name.");
        const common = {
          scope: scope.value,
          project: scope.value === "project" ? project.value.trim() : undefined,
          title: title.value.trim(),
          source: { threadId: "desktop", provider: "Hive Mind", type: "user" },
          eventId: draftEventId,
        };
        if (kind === "asset") {
          const result = await (media?.value === "file"
            ? window.hive.importFile(common)
            : window.hive.importImage(common));
          if (!result) return;
          if (result.status >= 400) throw new Error(result.value.error);
          await load();
          await edit(result.value);
          return;
        }
        const data = Object.fromEntries(
          Object.entries(controls).map(([key, { node, type }]) => [
            key,
            type === "lines"
              ? node.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : node.value,
          ]),
        );
        if (!["relation"].includes(kind))
          data.assetIds = imageControls.filter((a) => a.checked.checked).map((a) => a.id);
        if (taskSelect?.value) data.taskId = taskSelect.value;
        if (kind === "task" && record?.data.lease) data.lease = record.data.lease;
        if (kind === "collection")
          data.annotations = imageControls
            .filter((a) => a.checked.checked && a.note.value.trim())
            .map((a) => ({
              assetId: a.id,
              note: a.note.value.trim(),
              ...(Object.values(a.region).every((n) => n.value !== "")
                ? {
                    region: Object.fromEntries(
                      Object.entries(a.region).map(([k, n]) => [k, Number(n.value)]),
                    ),
                  }
                : {}),
            }));
        if (kind === "artifact" && preferred?.value) data.preferredRevision = preferred.value;
        if (kind === "episode") data.eventId = record?.data.eventId ?? crypto.randomUUID();
        if (kind === "relation")
          Object.assign(
            data,
            Object.fromEntries(Object.entries(relationships).map(([k, node]) => [k, node.value])),
          );
        const saved = await request("/v1/brain/save", {
          ...common,
          kind,
          data,
          ...(record ? { id: record.id, revision: record.revision } : {}),
        });
        await load();
        await edit(saved);
        note("Saved.");
        document.dispatchEvent(
          new CustomEvent("hive:record-saved", { detail: { id: saved.id, kind: saved.kind } }),
        );
      } finally {
        saving = false;
      }
    });
    document.dispatchEvent(
      new CustomEvent("hive:record-opened", { detail: { id: record?.id ?? null, kind } }),
    );
  }
  byId("workspace").onclick = run(async () => {
    dialog.showModal();
    await catalogs();
    await load();
    await edit();
    document.dispatchEvent(new Event("hive:workspace-ready"));
  });
  document.addEventListener(
    "hive:open-record",
    run(async (event) => {
      byId("workspace-kind").value = event.detail.kind;
      if (!dialog.open) dialog.showModal();
      await catalogs();
      await load();
      const result = await request("/v1/brain", { id: event.detail.id, includeHistory: true });
      await edit(result.records[0] ?? null);
    }),
  );
  byId("workspace-close").onclick = () => dialog.close();
  byId("workspace-kind").onchange = run(async () => {
    await load();
    await edit();
    document.dispatchEvent(new Event("hive:workspace-ready"));
  });
  byId("workspace-search").oninput = run(load);
  byId("workspace-new").onclick = run(() => edit());
  for (const action of ["export", "import"])
    byId(`workspace-${action}`).onclick = run(async () => {
      const message = await window.hive.archive(action);
      if (message) {
        await load();
        note(message);
      }
    });
  async function catalogs() {
    const snapshots = await Promise.all(
      ["asset", "task"].map((kind) => request("/v1/brain", { kind })),
    );
    assets = snapshots[0].records;
    tasks = snapshots[1].records;
    all = (await request("/v1/brain", {})).records;
  }
  window.hive.onChanged(() => {
    if (dialog.open)
      void catalogs()
        .then(load)
        .then(() => {
          if (selected && all.find((r) => r.id === selected.id)?.revision !== selected.revision)
            note(
              "This record changed. Reopen it before editing its latest version; your current draft is preserved.",
            );
          else if (modified) note("New records arrived; your current draft is preserved.");
        })
        .catch((e) => note(e.message));
  });
})();
