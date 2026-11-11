// app.js — router + screens: Projects, 1 Data & prompt, 2 Harnesses & method (+ validate & initialize).
"use strict";
(function () {
  const { GET, POST, PATCH, DEL, h, mount, clear, toast, modal, confirmModal, debounce, waitJob, fmt, progressBar, stateBadge, field, select, numInput, textInput, withToken } = window.WPO;
  const app = document.getElementById("app");
  const S = { meta: null, connections: [], view: null, scan: null, folderMap: null, classOrder: null, manifestPreview: null };
  window.WPO.S = S;

  // ─── router ───
  function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const m = hash.match(/^\/p\/([a-z0-9-]+)\/(data|config|dashboard)$/);
    if (window.WPO.dashboard) window.WPO.dashboard.stop();
    if (!m) return screenProjects();
    const [, id, step] = m;
    setStepper(id, step);
    if (step === "data") return screenData(id);
    if (step === "config") return screenConfig(id);
    return window.WPO.dashboard.show(id);
  }
  window.addEventListener("hashchange", route);
  window.WPO.go = (path) => { if (location.hash === `#${path}`) route(); else location.hash = path; };

  function setStepper(id, step) {
    const st = document.getElementById("stepper");
    st.hidden = !id;
    for (const s of ["data", "config", "dashboard"]) {
      const a = document.getElementById(`step-${s}`);
      a.href = `#/p/${id}/${s}`;
      a.classList.toggle("active", s === step);
    }
  }

  async function loadBasics() {
    if (!S.meta) S.meta = await GET("/api/meta");
    S.connections = await GET("/api/connections");
  }
  async function loadView(id) { S.view = await GET(`/api/projects/${id}`); return S.view; }

  // ─── Projects ───
  async function screenProjects() {
    document.getElementById("stepper").hidden = true;
    mount(document.getElementById("topbar-right"));
    const list = await GET("/api/projects");
    const name = h("input", { type: "text", placeholder: "e.g. Falls + bed exit (Bedrock Nova)", "aria-label": "Project name" });
    const create = async () => {
      const v = await POST("/api/projects", { name: name.value });
      window.WPO.go(`/p/${v.project.id}/data`);
    };
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
    mount(app,
      h("div.panel",
        h("h1", "Optimize a prompt"),
        h("p.muted", "Drop in a labelled dataset and a base prompt, connect the model you run in production (the candidate) and the model that writes new prompts (the generator), and run the Whole-Prompt Optimizer."),
        h("div.row", { style: { marginTop: "10px" } }, h("div", { style: { flex: "1", minWidth: "240px" } }, name), h("button.primary", { on: { click: create } }, "New optimization"))),
      h("div.panel",
        h("h2", "Projects"),
        list.length === 0 ? h("p.empty", "No projects yet.") : h("div.table-wrap", h("table",
          h("tr", h("th", "Name"), h("th", "State"), h("th", "Step"), h("th", "Best train"), h("th", "Test"), h("th", "Updated"), h("th", "")),
          list.map((p) => h("tr",
            h("td", h("a", { href: `#/p/${p.id}/${["running", "paused", "stopped", "completed", "needs_attention", "crashed", "initializing"].includes(p.state) ? "dashboard" : p.state === "draft" ? "data" : "config"}` }, p.name || p.id)),
            h("td", stateBadge(p.state)), h("td", p.step ?? "—"), h("td", fmt.pct(p.bestAccuracy)), h("td", fmt.pct(p.testAccuracy)), h("td.small.muted", fmt.time(p.updatedAt)),
            h("td", h("button.small.danger", { on: { click: async () => { if (await confirmModal("Move project to trash?", `"${p.name}" is moved to projects/.trash (its files are kept, nothing is deleted).`, "Move to trash", true)) { await DEL(`/api/projects/${p.id}`); route(); } } } }, "Trash"))))))));
  }

  // ─── Connections modal ───
  function connectionModal(allowedTypes, onSaved) {
    const types = Object.entries(S.meta.connectionTypes).filter(([k]) => !allowedTypes || allowedTypes.includes(k));
    let type = types[0][0];
    const values = {};
    const body = h("div");
    let nameInput;
    const render = () => {
      const t = S.meta.connectionTypes[type];
      nameInput = h("input", { type: "text", value: t.label, "aria-label": "Connection name" });
      mount(body,
        field("Type", select(types.map(([k, v]) => ({ value: k, label: v.label })), type, (v) => { type = v; render(); })),
        h("div.callout", h("strong", "How to authenticate"), h("ul", t.how.map((x) => h("li", x)))),
        field("Name", nameInput),
        ...t.fields.map((f) => {
          const inp = f.multiline
            ? h("textarea", { rows: 4, placeholder: f.secret ? "stored server-side, never shown again" : "", on: { input: (e) => { values[f.key] = e.target.value; } } })
            : h("input", { type: f.secret ? "password" : "text", value: f.default || "", autocomplete: "off", on: { input: (e) => { values[f.key] = e.target.value; } } });
          if (f.default) values[f.key] = f.default;
          return field(f.label + (f.required ? " *" : ""), inp);
        }),
        h("p.hint", "Secrets are stored in .secrets/ in the app folder (mode 600) on this machine only and are never sent back to the browser."));
    };
    render();
    const save = h("button.primary", { on: { click: async () => {
      const c = await POST("/api/connections", { type, name: nameInput.value, fields: values });
      m.close();
      S.connections = await GET("/api/connections");
      toast(`Saved connection "${c.name}"`);
      if (onSaved) onSaved(c);
    } } }, "Save connection");
    const m = modal("Add connection", body, [save]);
  }

  function connectionSelect(value, allowedTypes, onChange, onAdded) {
    const opts = S.connections.filter((c) => !allowedTypes || allowedTypes.includes(c.type))
      .map((c) => ({ value: c.id, label: `${c.name} · ${S.meta.connectionTypes[c.type].label}${c.source === "environment" ? " (env)" : ""}` }));
    const sel = select([{ value: "", label: opts.length ? "Choose a connection…" : "No connections yet" }, ...opts], value || "", onChange);
    const add = h("button.small", { on: { click: () => connectionModal(allowedTypes, async (c) => { await onChange(c.id); if (onAdded) onAdded(c); }) } }, "+ Add");
    return h("div.row", h("div", { style: { flex: "1", minWidth: "220px" } }, sel), add);
  }

  // ─── Screen 1: Data & base prompt ───
  async function screenData(id) {
    await loadBasics();
    const view = await loadView(id);
    const p = view.project;
    mount(document.getElementById("topbar-right"), h("span.muted.small", p.name), stateBadge(view.state));
    const locked = view.hasBaseline;
    const sourcePanel = h("div.panel");
    const mapPanel = h("div");
    const fieldsPanel = h("div.panel");
    const promptPanel = h("div.panel");
    mount(app,
      h("h1", "1 · Data & base prompt"),
      h("p.muted", "Point at your labelled data (local files, a folder, or an S3 / GCS / Azure bucket), tag folders or map manifest columns, then add the prompt you want to optimize."),
      locked ? h("div.callout.warn", "This run already has a baseline, so the dataset and base prompt are locked. Fork the project from the dashboard to change them.") : null,
      sourcePanel, mapPanel, fieldsPanel, promptPanel,
      h("div.row", h("div.spacer"), h("button.primary", { on: { click: () => window.WPO.go(`/p/${id}/config`) } }, "Next: harnesses →")));
    renderSource(sourcePanel, mapPanel, id, locked);
    renderFields(fieldsPanel, id, locked);
    renderPrompt(promptPanel, id, locked);
    if (S.scanFor === id && S.scan) renderMapping(mapPanel, id);
  }

  function renderSource(panel, mapPanel, id, locked) {
    const p = S.view.project;
    const health = S.view.health;
    const tabs = ["Drop files", "Local folder", "Amazon S3", "Google Cloud Storage", "Azure Blob", "Manifest URL"];
    if (S.meta.legacyRunners.length) tabs.push("Legacy WPO runner");
    let tab = S.sourceTab || (p.dataset ? null : "Drop files");
    const content = h("div");
    const status = h("div");
    const doScan = async (uri, connectionId) => {
      mount(status, h("p.muted", "Listing files…"), progressBar(0, 1));
      try {
        const job = await POST(`/api/projects/${id}/dataset/scan`, { uri, connectionId });
        const r = await waitJob(job, (pr) => { if (pr) mount(status, h("p.muted", `${pr.label || "Working"}… ${pr.done ? fmt.int(pr.done) + " files" : ""}`)); });
        S.scan = r; S.scanFor = id; S.scanUri = uri;
        S.folderMap = JSON.parse(JSON.stringify(r.suggestions || []));
        S.classOrder = S.legacyClassOrder || null;
        S.layout = r.manifests.length && r.media < 10 ? "manifest" : "folders";
        mount(status, h("div.callout.ok", `Found ${fmt.int(r.files)} files (${fmt.int(r.media)} usable inputs, ${fmt.bytes(r.totalSize)}) in ${r.described}.${r.legacyLayout ? " This looks like the legacy WPO layout — folders are pre-tagged." : ""}`));
        renderMapping(mapPanel, id);
        mapPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { mount(status, h("div.callout.bad", e.message)); }
    };
    const renderTab = () => {
      clear(content);
      if (!tab) return;
      if (tab === "Drop files") content.appendChild(dropZone(id, () => doScan("@upload", null)));
      if (tab === "Local folder") {
        const inp = h("input", { type: "text", placeholder: "/Users/you/data/my-dataset", value: S.lastLocal || "" });
        content.appendChild(h("div",
          field("Folder on this machine", inp, "Files are APFS-cloned into the project (instant, no extra disk on the same volume); nothing links back to the original."),
          h("div.row", { style: { marginTop: "8px" } }, h("button.primary", { on: { click: () => { S.lastLocal = inp.value; doScan(inp.value.trim(), null); } } }, "Scan folder"))));
      }
      const cloud = { "Amazon S3": ["aws", "s3://my-bucket/path/"], "Google Cloud Storage": ["gcs", "gs://my-bucket/path/"], "Azure Blob": ["azure_blob", "https://ACCOUNT.blob.core.windows.net/CONTAINER/path/"] }[tab];
      if (cloud) {
        let conn = S.lastConn && S.connections.find((c) => c.id === S.lastConn && c.type === cloud[0]) ? S.lastConn : (S.connections.find((c) => c.type === cloud[0]) || {}).id;
        const uri = h("input", { type: "text", placeholder: cloud[1] });
        content.appendChild(h("div.grid2",
          field("Connection", connectionSelect(conn, [cloud[0]], (v) => { conn = v; S.lastConn = v; }, () => renderTab())),
          field("Bucket / container path", uri, "Every folder under this path is listed; you tag folders with classes next.")));
        content.appendChild(h("div.row", { style: { marginTop: "8px" } }, h("button.primary", { on: { click: () => { if (!conn) return toast("Choose or add a connection", true); doScan(uri.value.trim(), conn); } } }, "List folders")));
      }
      if (tab === "Manifest URL") {
        const uri = h("input", { type: "text", placeholder: "https://…/labels.csv  (rows may point at s3:// gs:// https:// files)" });
        content.appendChild(h("div", field("Manifest URL", uri), h("div.row", { style: { marginTop: "8px" } }, h("button.primary", { on: { click: () => doScan(uri.value.trim(), null) } }, "Fetch manifest"))));
      }
      if (tab === "Legacy WPO runner") {
        const runner = select(S.meta.legacyRunners.map((r) => ({ value: r, label: r.split("/").slice(-1)[0] })), S.meta.legacyRunners[0], () => {});
        content.appendChild(h("div",
          h("p.muted", "Reproduce an original wpo_video_optimizer run exactly: imports the runner's fields, indices and descriptions, builds its original base prompt, applies the original harness settings (Vertex, gemini-2.5-flash-lite at temperature 0, 840×480 PNG grids, TIMING injection) and tags the grids folders."),
          field("Runner", runner),
          h("div.row", { style: { marginTop: "8px" } }, h("button.primary", { on: { click: async () => {
            const r = await POST(`/api/projects/${id}/import-legacy-runner`, { path: runner.value });
            S.legacyClassOrder = r.classOrder;
            S.legacyMeta = true;
            toast("Runner imported: fields, base prompt and harness settings set");
            await loadView(id);
            if (!r.gridsPath) { route(); return; }
            await doScan(r.gridsPath, null);
            const keep = new Set(r.classOrder);
            S.folderMap = (S.scan.suggestions || []).filter((e) => !e.tags || e.tags.every((t) => keep.has(t.class)));
            S.classOrder = r.classOrder;
            route();
          } } }, "Import runner"))));
      }
    };
    const tabBar = h("div.tabs", tabs.map((t) => h("button", { class: t === tab ? "active" : "", on: { click: () => { tab = t; S.sourceTab = t; [...tabBar.children].forEach((b) => b.classList.toggle("active", b.textContent === t)); renderTab(); } } }, t)));
    mount(panel,
      h("div.panel-head", h("h2", "Dataset source"), p.dataset ? h("span.badge.ok", `${fmt.int(p.dataset.items)} items committed`) : null),
      p.dataset ? h("div.kv.small",
        h("span.muted", "Source"), h("span.mono", (p.dataset.source && p.dataset.source.uri) || "—"),
        h("span.muted", "Layout"), h("span", p.dataset.layout),
        h("span.muted", "Fields"), h("span", (p.fields || []).map((f) => f.label || f.key).join(", ")),
        health ? [h("span.muted", "Health"), healthLine(health)] : null) : null,
      locked ? null : h("div", { style: { marginTop: p.dataset ? "12px" : 0 } }, p.dataset ? h("p.hint", "Scan a source again to change the dataset.") : null, tabBar, content, status));
    renderTab();
    if (health && !locked) panel.appendChild(healthPanel(id, health));
  }

  function healthLine(hl) {
    return h("span", `${fmt.int(hl.items)} items · ${fmt.int(hl.uniqueContents)} unique inputs · `,
      h("span.badge", { class: hl.crossSplitLeaks ? "warn" : "ok" }, `${hl.crossSplitLeaks} train/test leaks`), " ",
      h("span.badge", { class: hl.labelConflicts ? "warn" : "ok" }, `${hl.labelConflicts} label conflicts`), " ",
      hl.missing ? h("span.badge.bad", `${hl.missing} missing files`) : null);
  }

  function healthPanel(id, hl) {
    const pol = Object.assign({ leaks: "keep", conflicts: "keep" }, (S.view.project.dataset && S.view.project.dataset.policies) || {});
    return h("details", { style: { marginTop: "10px" } }, h("summary", "Dataset health report"),
      h("p.small.muted", "Duplicates are found by content hash. A leak = the same input in train and test (inflates test accuracy). A conflict = the same input labelled both ways for one field (a guaranteed error whatever the prompt)."),
      h("div.grid2",
        field("Train/test leaks", select([{ value: "keep", label: "Keep as is (original behaviour)" }, { value: "drop_test", label: "Drop the test copies" }], pol.leaks, (v) => { pol.leaks = v; })),
        field("Label conflicts", select([{ value: "keep", label: "Keep as is (original behaviour)" }, { value: "drop", label: "Drop conflicting items" }], pol.conflicts, (v) => { pol.conflicts = v; }))),
      h("div.row", { style: { marginTop: "8px" } }, h("button", { on: { click: async () => { const r = await POST(`/api/projects/${id}/dataset/policies`, pol); toast(`${r.before - r.after} items removed`); route(); } } }, "Apply policies")),
      hl.examples && hl.examples.conflicts.length ? h("details", h("summary.small", "Conflict examples"), h("pre.code-box", hl.examples.conflicts.slice(0, 10).map((c) => `${c.field}: ${c.items.map((i) => `${i.id}=${i.label}`).join("  |  ")}`).join("\n"))) : null);
  }

  function dropZone(id, onDone) {
    const status = h("div.small.muted");
    const zone = h("div.dropzone", h("p", "Drop a folder, files, a .zip, or a CSV/JSONL manifest here"), h("p.small", "or"),
      h("div.row", { style: { justifyContent: "center" } },
        h("label", h("input", { type: "file", multiple: true, webkitdirectory: true, style: { display: "none" }, on: { change: (e) => upload([...e.target.files].map((f) => [f.webkitRelativePath || f.name, f])) } }), h("span.badge.accent", { style: { cursor: "pointer", padding: "5px 12px" } }, "Choose folder")),
        h("label", h("input", { type: "file", multiple: true, style: { display: "none" }, on: { change: (e) => upload([...e.target.files].map((f) => [f.name, f])) } }), h("span.badge", { style: { cursor: "pointer", padding: "5px 12px" } }, "Choose files"))),
      status);
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault(); zone.classList.remove("over");
      const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
      const files = [];
      const walk = (entry, prefix) => new Promise((resolve) => {
        if (entry.isFile) entry.file((f) => { files.push([prefix + f.name, f]); resolve(); }, resolve);
        else {
          const reader = entry.createReader();
          const all = [];
          const read = () => reader.readEntries(async (batch) => { if (!batch.length) { for (const b of all) await walk(b, `${prefix}${entry.name}/`); resolve(); } else { all.push(...batch); read(); } }, resolve);
          read();
        }
      });
      for (const en of entries) await walk(en, "");
      upload(files);
    });
    async function upload(files) {
      files = files.filter(([p]) => !/(^|\/)\./.test(p));
      if (!files.length) return;
      const total = files.reduce((a, [, f]) => a + f.size, 0);
      if (total > 4 * 1024 * 1024 * 1024) return toast("That is more than 4 GB — use the Local folder tab instead (no copy through the browser).", true);
      let done = 0, bytes = 0, i = 0;
      const worker = async () => {
        while (i < files.length) {
          const [rel, f] = files[i++];
          await window.WPO.api("POST", `/api/projects/${id}/dataset/upload?path=${encodeURIComponent(rel)}`, f);
          done++; bytes += f.size;
          mount(status, h("span", `Uploaded ${done}/${files.length} files (${fmt.bytes(bytes)})`), progressBar(bytes, total));
        }
      };
      await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
      onDone();
    }
    return zone;
  }

  // ─── folder categorizer / manifest mapping ───
  function renderMapping(panel, id) {
    if (!S.scan) return clear(panel);
    const r = S.scan;
    const layoutTabs = h("div.tabs",
      h("button", { class: S.layout === "folders" ? "active" : "", on: { click: () => { S.layout = "folders"; renderMapping(panel, id); } } }, "Tag folders"),
      r.manifests.length ? h("button", { class: S.layout === "manifest" ? "active" : "", on: { click: () => { S.layout = "manifest"; renderMapping(panel, id); } } }, `Use a manifest (${r.manifests.length})`) : null);
    const body = h("div");
    mount(panel, h("div.panel", h("div.panel-head", h("h2", S.layout === "manifest" ? "Map manifest columns" : "Tag folders with classes"), h("span.muted.small", S.scan.described)), layoutTabs, body));
    if (S.layout === "manifest") return renderManifest(body, id);
    renderCategorizer(body, id);
  }

  function renderCategorizer(body, id) {
    const tree = S.scan.tree;
    const mapIdx = () => new Map(S.folderMap.map((e) => [e.path, e]));
    const preview = h("div");
    const filter = h("input", { type: "text", placeholder: "Filter folders…", "aria-label": "Filter folders" });
    const tableBox = h("div.table-wrap", { style: { maxHeight: "520px", overflow: "auto" } });
    const classesList = () => [...new Set(S.folderMap.flatMap((e) => (e.tags || []).map((t) => t.class)))];
    const datalist = h("datalist#class-options");
    const refresh = debounce(async () => {
      try {
        const pv = await POST(`/api/projects/${id}/dataset/preview-folders`, { folderMap: S.folderMap, classOrder: S.classOrder, trainRatio: S.trainRatio || 0.8 }, { quiet: true });
        S.lastPreview = pv;
        mount(preview,
          h("div.stats", h("div.stat", h("div.k", "Items"), h("div.v", fmt.int(pv.items))), h("div.stat", h("div.k", "Unique files"), h("div.v", fmt.int(pv.uniqueFiles))), h("div.stat", h("div.k", "To copy/download"), h("div.v", fmt.bytes(pv.downloadBytes))), h("div.stat", h("div.k", "Untagged files"), h("div.v", fmt.int(pv.counts.ignored)))),
          pv.fields.length ? h("table", { style: { marginTop: "10px" } },
            h("tr", h("th", "#"), h("th", "Class (field)"), h("th", "Train +"), h("th", "Train −"), h("th", "Test +"), h("th", "Test −"), h("th", "")),
            pv.fields.map((f, i) => {
              const c = pv.perField[f.key];
              return h("tr", h("td", i), h("td", f.label), h("td", c.train.positive), h("td", c.train.negative), h("td", c.test.positive), h("td", c.test.negative),
                h("td", h("div.row",
                  h("button.small", { disabled: i === 0, on: { click: () => { const order = pv.fields.map((x) => x.key); [order[i - 1], order[i]] = [order[i], order[i - 1]]; S.classOrder = order; refresh(); } } }, "↑"),
                  h("button.small", { on: { click: () => renameClass(f.label) } }, "Rename"))));
            })) : h("p.muted", "Tag at least one folder with a class and polarity."));
      } catch (e) { mount(preview, h("div.callout.bad", e.message)); }
    }, 250);
    const renameClass = (old) => {
      const inp = h("input", { type: "text", value: old });
      const m = modal("Rename class", field("New name", inp), [h("button.primary", { on: { click: () => { for (const e of S.folderMap) for (const t of e.tags || []) if (t.class === old) t.class = inp.value.trim(); if (S.classOrder) S.classOrder = null; m.close(); renderTable(); refresh(); } } }, "Rename")]);
    };
    const effective = (path) => {
      const idx = mapIdx();
      let p = path;
      for (;;) {
        const e = idx.get(p);
        if (e && (e.ignore || (e.tags && e.tags.length))) return { from: p, tags: e.ignore ? [] : e.tags, ignore: !!e.ignore };
        if (p === "") return null;
        p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      }
    };
    const entryFor = (path) => {
      let e = S.folderMap.find((x) => x.path === path);
      if (!e) { e = { path }; S.folderMap.push(e); }
      return e;
    };
    const renderTable = () => {
      const q = filter.value.trim().toLowerCase();
      mount(datalist, classesList().map((c) => h("option", { value: c })));
      const rows = tree.filter((n) => n.recursiveFiles > 0 && (!q || n.path.toLowerCase().includes(q))).slice(0, 800);
      mount(tableBox, h("table.tree",
        h("tr", h("th", "Folder"), h("th", "Files"), h("th", "Types"), h("th", "Tags (class + polarity)"), h("th", "Split"), h("th", "Ignore"), h("th", "")),
        rows.map((n) => {
          const e = S.folderMap.find((x) => x.path === n.path) || {};
          const eff = effective(n.path);
          const inherited = eff && eff.from !== n.path;
          const cls = h("input", { type: "text", list: "class-options", placeholder: "class", style: { width: "120px" } });
          const pol = select(["positive", "negative"], "positive", () => {});
          pol.style.width = "105px";
          const addTag = () => { if (!cls.value.trim()) return; const en = entryFor(n.path); en.ignore = false; en.tags = (en.tags || []).concat([{ class: cls.value.trim(), polarity: pol.value }]); renderTable(); refresh(); };
          cls.addEventListener("keydown", (ev) => { if (ev.key === "Enter") addTag(); });
          return h("tr", { class: e.tags && e.tags.length ? "tagged" : "" },
            h("td.name", { style: { paddingLeft: `${8 + n.depth * 14}px` } }, n.path === "" ? "/ (root)" : n.name),
            h("td.small", fmt.int(n.recursiveFiles), n.files !== n.recursiveFiles ? h("span.muted", ` (${n.files} here)`) : null),
            h("td.small.muted", Object.entries(n.types).map(([k, v]) => `${k} ${v}`).join(", ")),
            h("td",
              (e.tags || []).map((t, ti) => h("span.tag-chip", { class: t.polarity === "positive" ? "pos" : "neg" }, `${t.class} · ${t.polarity === "positive" ? "+" : "−"}`,
                h("button", { "aria-label": "Remove tag", on: { click: () => { e.tags.splice(ti, 1); renderTable(); refresh(); } } }, "×"))),
              inherited && eff.tags.length ? h("span.small.muted", `inherits ${eff.tags.map((t) => `${t.class} ${t.polarity === "positive" ? "+" : "−"}`).join(", ")}`) : null,
              e.ignore ? h("span.badge", "ignored") : null,
              h("div.row", { style: { gap: "4px", marginTop: "2px" } }, cls, pol, h("button.small", { on: { click: addTag } }, "+ tag"))),
            h("td", select([{ value: "auto", label: "auto" }, { value: "train", label: "train" }, { value: "test", label: "test" }], e.split || "auto", (v) => { const en = entryFor(n.path); en.split = v === "auto" ? undefined : v; refresh(); })),
            h("td", h("input", { type: "checkbox", checked: !!e.ignore, "aria-label": "Ignore folder", on: { change: (ev) => { const en = entryFor(n.path); en.ignore = ev.target.checked; if (en.ignore) en.tags = []; renderTable(); refresh(); } } })),
            h("td", n.files ? h("button.small", { on: { click: () => previewFolder(n) } }, "Preview") : null));
        })));
    };
    const previewFolder = (n) => {
      const box = h("div.thumbs", h("span.muted", "Loading…"));
      modal(`Preview · ${n.path || "/"}`, box);
      // tag only this folder temporarily to get its first files (direct children first)
      POST(`/api/projects/${id}/dataset/preview-folders`, { folderMap: [{ path: n.path, tags: [{ class: "__preview__", polarity: "positive" }] }], classOrder: ["__preview__"] }, { quiet: true }).then((pv) => {
        const prefix = n.path ? n.path + "/" : "";
        const direct = pv.sample.filter((s) => !s.source.key.slice(prefix.length).includes("/"));
        const sample = (direct.length ? direct : pv.sample).slice(0, 8);
        mount(box, sample.length ? sample.map((s) => h("figure", { style: { margin: 0 } }, h("img", { src: withToken(`/api/projects/${id}/dataset/source-thumb?key=${encodeURIComponent(s.source.key)}`), alt: s.source.key, loading: "lazy" }), h("figcaption.small.muted", s.source.key.split("/").pop()))) : h("span.muted", "No previewable files in this folder."));
      }).catch((e) => mount(box, h("span.muted", e.message)));
    };
    filter.addEventListener("input", debounce(renderTable, 200));
    const ratio = numInput(S.trainRatio || 0.8, (v) => { S.trainRatio = v; refresh(); }, { step: 0.05, min: 0, max: 1, style: { width: "90px" } });
    const mode = select([{ value: "clone", label: "Clone / download into the project (independent copy)" }, { value: "copy", label: "Full copy" }, { value: "reference", label: "Reference local files in place (no copy)" }], S.mode || "clone", (v) => { S.mode = v; });
    const commit = h("button.primary", { on: { click: async () => {
      commit.disabled = true;
      const st = h("div");
      body.appendChild(st);
      try {
        const job = await POST(`/api/projects/${id}/dataset/commit`, { layout: "folders", folderMap: S.folderMap, classOrder: S.classOrder || (S.lastPreview ? S.lastPreview.fields.map((f) => f.key) : null), trainRatio: S.trainRatio || 0.8, mode: S.mode || "clone", legacyMeta: !!S.legacyMeta });
        const r = await waitJob(job, (pr) => { if (pr) mount(st, h("p.muted", `${pr.phase === "health" ? "Checking dataset health" : "Copying files"}: ${fmt.int(pr.done)}/${fmt.int(pr.total)}`), progressBar(pr.done, pr.total)); });
        toast(`Dataset committed: ${fmt.int(r.items)} items, ${r.fields.length} fields`);
        S.scan = null;
        route();
      } catch (e) { mount(st, h("div.callout.bad", e.message)); commit.disabled = false; }
    } } }, "Commit dataset");
    mount(body,
      h("p.muted.small", "Tag each folder with a class you name (e.g. falls, bed exit) and whether its files are positive or negative examples. Tags apply to subfolders unless a subfolder has its own; a folder can carry several tags (e.g. reuse bed-exit positives as falls negatives). Train/test comes from training/test folders when present, otherwise a stable hash split."),
      h("div.row", filter,
        h("button.small", { on: { click: () => { S.folderMap = JSON.parse(JSON.stringify(S.scan.suggestions || [])); renderTable(); refresh(); } } }, `Apply name suggestions (${(S.scan.suggestions || []).length})`),
        h("button.small", { on: { click: () => { S.folderMap = []; renderTable(); refresh(); } } }, "Clear all tags")),
      datalist, tableBox,
      h("h3", "Result"), preview,
      h("div.grid2", { style: { marginTop: "10px" } }, field("Train fraction for folders without a train/test split", ratio), S.scan.kind === "local" ? field("Copy mode", mode) : h("div")),
      h("div.row", { style: { marginTop: "12px" } }, h("div.spacer"), commit));
    renderTable();
    refresh();
  }

  async function renderManifest(body, id) {
    const keySel = select(S.scan.manifests, S.manifestKey || S.scan.manifests[0], (v) => { S.manifestKey = v; S.manifestPreview = null; load(); });
    const box = h("div");
    mount(body, field("Manifest file", keySel), box);
    async function load(roles) {
      S.manifestKey = keySel.value;
      try {
        S.manifestPreview = await POST(`/api/projects/${id}/dataset/preview-manifest`, { key: S.manifestKey, roles });
        draw();
      } catch (e) { mount(box, h("div.callout.bad", e.message)); }
    }
    function draw() {
      const pv = S.manifestPreview;
      const roles = pv.roles;
      mount(box,
        h("p.small.muted", `${fmt.int(pv.rows)} rows · ${pv.items} labelled items · fields: ${pv.fields.map((f) => `${f.label} (${f.type})`).join(", ") || "none"}`),
        h("div.table-wrap", h("table",
          h("tr", h("th", "Column"), h("th", "Role"), h("th", "Label type"), h("th", "Examples")),
          pv.columns.map((c) => h("tr",
            h("td.mono", c),
            h("td", select(["id", "file", "text", "split", "label", "var", "ignore"], roles[c].role, (v) => { roles[c].role = v; load(roles); })),
            h("td", roles[c].role === "label" ? select(["binary", "categorical", "text", "number"], roles[c].type || "categorical", (v) => { roles[c].type = v; load(roles); }) : null),
            h("td.small.muted", (roles[c].examples || []).join(" · ")))))),
        h("div.row", { style: { marginTop: "10px" } }, h("div.spacer"), h("button.primary", { on: { click: async () => {
          const st = h("div");
          box.appendChild(st);
          try {
            const job = await POST(`/api/projects/${id}/dataset/commit`, { layout: "manifest", key: S.manifestKey, roles, trainRatio: S.trainRatio || 0.8, mode: S.mode || "clone" });
            const r = await waitJob(job, (pr) => { if (pr) mount(st, h("p.muted", `${pr.phase}: ${fmt.int(pr.done)}/${fmt.int(pr.total)}`), progressBar(pr.done, pr.total)); });
            toast(`Dataset committed: ${fmt.int(r.items)} items, ${r.fields.length} fields`);
            S.scan = null;
            route();
          } catch (e) { mount(st, h("div.callout.bad", e.message)); }
        } } }, "Commit dataset")));
    }
    load();
  }

  // ─── fields ───
  function renderFields(panel, id, locked) {
    const p = S.view.project;
    if (!p.fields || !p.fields.length) return mount(panel, h("h2", "Fields"), h("p.muted", "Fields appear here after you commit a dataset."));
    const fields = JSON.parse(JSON.stringify(p.fields));
    const save = debounce(async () => { S.view = await PATCH(`/api/projects/${id}`, { fields }); toast("Fields saved"); }, 500);
    mount(panel, h("div.panel-head", h("h2", "Fields"), h("span.muted.small", "Descriptions are for you and for the starter prompt; scoring uses the labels.")),
      h("div.table-wrap", h("table",
        h("tr", h("th", "Index"), h("th", "Key"), h("th", "Label"), h("th", "Type"), h("th", "Description")),
        fields.map((f) => h("tr",
          h("td", locked ? f.index : numInput(f.index, (v) => { f.index = v; save(); }, { style: { width: "70px" } })),
          h("td.mono", f.key),
          h("td", locked ? f.label : textInput(f.label, (v) => { f.label = v; save(); })),
          h("td", h("span.badge", f.type), f.classes ? h("div.small.muted", f.classes.slice(0, 8).join(", ")) : null),
          h("td", locked ? f.description : textInput(f.description, (v) => { f.description = v; save(); }, { placeholder: "e.g. Resident is lying on the floor" })))))));
  }

  // ─── base prompt ───
  async function renderPrompt(panel, id, locked) {
    const p = S.view.project;
    const ta = h("textarea", { rows: 16, placeholder: "Paste the system prompt you use in production, or drop a .txt / .md file here.", disabled: locked });
    ta.value = p.prompt.base || "";
    const status = h("span.small.muted");
    const save = debounce(async () => { await PATCH(`/api/projects/${id}`, { prompt: Object.assign({}, S.view.project.prompt, { base: ta.value }) }); S.view.project.prompt.base = ta.value; mount(status, "Saved"); checkVars(); }, 600);
    ta.addEventListener("input", () => { mount(status, "Saving…"); save(); });
    ta.addEventListener("dragover", (e) => e.preventDefault());
    ta.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) { ta.value = await f.text(); ta.dispatchEvent(new Event("input")); }
    });
    const varsBox = h("div.small");
    let sampleVars = [];
    try {
      const items = await GET(`/api/projects/${id}/items?split=train`, { quiet: true });
      if (items.length) sampleVars = Object.keys((await GET(`/api/projects/${id}/items/${encodeURIComponent(items[0].id)}`, { quiet: true })).vars || {});
      // videos sent as frame grids get timing variables when they are preprocessed
      if (items.some((i) => i.kind === "video") && !(p.target.media && p.target.media.video && p.target.media.video.mode === "native")) {
        for (const v of ["duration", "interval", "timing_line"]) if (!sampleVars.includes(v)) sampleVars.push(v);
      }
    } catch {}
    function checkVars() {
      const used = [...new Set([...ta.value.matchAll(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g)].map((m) => m[1]))];
      const unknown = used.filter((u) => !sampleVars.includes(u));
      mount(varsBox,
        sampleVars.length ? h("span", "Per-item variables you can use: ", sampleVars.map((v) => h("code", { style: { marginRight: "6px" } }, `{{${v}}}`))) : h("span.muted", "No per-item variables in this dataset."),
        unknown.length ? h("div.callout.warn", `Unknown placeholders (left as-is): ${unknown.map((u) => `{{${u}}}`).join(", ")}`) : null,
        (p.prompt.rules || []).length ? h("div.muted", `Substitution rules: ${p.prompt.rules.map((r) => `"${r.find.slice(0, 50)}…" → ${r.replace}`).join("; ")}`) : null);
    }
    const starter = () => {
      const f = S.view.project.fields || [];
      const allBinary = f.length && f.every((x) => x.type === "binary");
      let t = "You are a model that analyzes the input and reports the conditions below.\n\n";
      if (allBinary) {
        t += `ARRAY "b" RULES\nThe array "b" must contain only the indices [0-${f.length - 1}] where the condition is present.\n\nINDEX and VALUE DEFINITIONS FOR ARRAY "b"\n`;
        for (const x of f) t += `${x.index} = ${x.description || x.label || x.key}\n`;
        t += "\nWhen uncertain, do not include the index.\n";
      } else {
        t += "Return a JSON object with these fields:\n";
        for (const x of f) t += `- ${x.key} (${x.type}${x.classes ? `: ${x.classes.join(" | ")}` : ""}): ${x.description || x.label}\n`;
      }
      ta.value = t;
      ta.dispatchEvent(new Event("input"));
    };
    mount(panel,
      h("div.panel-head", h("h2", "Base prompt"), h("div.row", status, locked ? null : h("button.small", { on: { click: starter } }, "Insert starter template"))),
      ta, varsBox);
    checkVars();
  }

  // ─── Screen 2: Harnesses & method ───
  async function screenConfig(id) {
    await loadBasics();
    const view = await loadView(id);
    const p = view.project;
    mount(document.getElementById("topbar-right"), h("span.muted.small", p.name), stateBadge(view.state));
    const locked = view.hasBaseline;
    const saveState = h("span.small.muted");
    const patch = debounce(async (part) => {
      mount(saveState, "Saving…");
      try { S.view = await PATCH(`/api/projects/${id}`, part); mount(saveState, "Saved"); renderValidate(); } catch (e) { mount(saveState, h("span", { style: { color: "var(--bad)" } }, e.message)); }
    }, 400);
    const validatePanel = h("div.panel");
    function renderValidate() { drawValidate(validatePanel, id); }
    mount(app,
      h("div.row", h("h1", "2 · Harnesses & method"), h("div.spacer"), saveState),
      h("p.muted", "The candidate harness runs the prompt being optimized (your production model and settings). The generator harness writes new candidate prompts. Both accept any provider: paste a key, use your cloud login, or point at your own endpoint."),
      locked ? h("div.callout.warn", "The run has a baseline: candidate harness, dataset, output schema and base prompt are locked (fork to change them). Generator settings and the meta-prompt can still change.") : null,
      h("div.grid2", harnessCard(id, "target", locked, patch), harnessCard(id, "generator", false, patch)),
      outputCard(id, locked, patch),
      methodCard(id, patch),
      validatePanel);
    renderValidate();
  }

  const HARNESS_TYPES = ["gemini", "vertex", "aws", "bedrock_key", "azure_openai", "openai", "anthropic", "openai_compatible", "custom_http", "mock"];

  function harnessCard(id, role, locked, patch) {
    const p = S.view.project;
    const cfg = JSON.parse(JSON.stringify(p[role]));
    const save = () => patch({ [role]: cfg });
    const modelInput = h("input", { type: "text", list: `models-${role}`, value: cfg.model || "", placeholder: "model id", disabled: locked, on: { change: (e) => { cfg.model = e.target.value.trim(); save(); updateCaps(); } } });
    const dl = h(`datalist#models-${role}`);
    const capsBox = h("div.small.muted");
    const loadModels = async () => {
      if (!cfg.connectionId) return toast("Choose a connection first", true);
      mount(capsBox, "Loading models…");
      try {
        const models = await GET(`/api/connections/${encodeURIComponent(cfg.connectionId)}/models`);
        mount(dl, models.map((m) => h("option", { value: m.id }, m.displayName && m.displayName !== m.id ? m.displayName : "")));
        mount(capsBox, `${models.length} models available${models[0] && models[0].note ? ` (${models[0].note})` : ""} — start typing in the model box.`);
      } catch (e) { mount(capsBox, h("span", { style: { color: "var(--bad)" } }, e.message)); }
    };
    const updateCaps = () => {
      const conn = S.connections.find((c) => c.id === cfg.connectionId);
      const isClaude = conn && conn.type === "anthropic";
      if (isClaude && /claude-(opus-4-[78]|opus-5|sonnet-5|fable|mythos)/.test(cfg.model || "")) mount(capsBox, "This Claude model does not accept a temperature — the provider default is used.");
    };
    const conn = S.connections.find((c) => c.id === cfg.connectionId);
    const adv = h("details", h("summary.small", "Advanced"),
      h("div.grid2", { style: { marginTop: "8px" } },
        field("Max output tokens", numInput(cfg.maxOutputTokens, (v) => { cfg.maxOutputTokens = v; save(); }, { disabled: locked, placeholder: "provider default" })),
        field("Concurrency", numInput(cfg.concurrency, (v) => { cfg.concurrency = v; save(); }, { disabled: locked })),
        field("Timeout per call (ms, 0 = none)", numInput(cfg.timeoutMs, (v) => { cfg.timeoutMs = v; save(); }, { disabled: locked })),
        role === "target" ? field("Prompt placement", select([{ value: "system", label: "System instruction" }, { value: "user", label: "Prepended to the user message" }], cfg.placement || "system", (v) => { cfg.placement = v; save(); }, { disabled: locked })) : field("Stream responses", select([{ value: "true", label: "Stream (recommended for long outputs)" }, { value: "false", label: "Single response" }], String(cfg.stream !== false), (v) => { cfg.stream = v === "true"; save(); }))),
      role === "target" ? mediaControls(cfg, save, locked) : null,
      field("Extra HTTP headers (JSON)", jsonArea(cfg.headers || {}, (v) => { cfg.headers = v; save(); }, locked), "e.g. Vertex Flex: {\"X-Vertex-AI-LLM-Request-Type\":\"shared\",\"X-Vertex-AI-LLM-Shared-Request-Type\":\"flex\"}"),
      field("Extra request parameters (JSON)", jsonArea(cfg.extra || {}, (v) => { cfg.extra = v; save(); }, locked), role === "generator" ? "Anthropic: {\"effort\": \"high\"} (refusal fallback is on for the generator; {\"refusalFallback\": false} turns it off) · OpenAI: {\"reasoning_effort\": \"high\"} · Gemini: {\"thinkingConfig\": {\"thinkingBudget\": 8192}}" : "Merged into the provider request as-is (e.g. Anthropic effort, OpenAI reasoning_effort, Bedrock serviceTier)."),
      h("div.row", { style: { marginTop: "8px" } }, h("button.small", { on: { click: async () => { const r = await POST(`/api/projects/${id}/render-preview`, { role }); modal(`Rendered ${role === "target" ? "candidate" : "generator"} request (${r.provider})`, h("pre.code-box", r.rendered)); } } }, "Preview the exact request")));
    return h("div.panel",
      h("div.panel-head", h("h2", role === "target" ? "Candidate harness" : "Generator harness"), h("span.small.muted", role === "target" ? "runs every candidate prompt on every item" : "writes candidate prompts (one call per step)")),
      field("Connection", connectionSelect(cfg.connectionId, HARNESS_TYPES, async (v) => { cfg.connectionId = v || null; S.view = await PATCH(`/api/projects/${id}`, { [role]: cfg }); }, () => screenConfig(id))),
      h("div.row", { style: { alignItems: "flex-end", marginTop: "8px" } },
        h("div", { style: { flex: "1" } }, field("Model", modelInput)), h("button.small", { on: { click: loadModels } }, "Load models"), dl),
      capsBox,
      h("div.grid2", { style: { marginTop: "8px" } },
        field("Temperature", numInput(cfg.temperature, (v) => { cfg.temperature = v; save(); }, { step: 0.1, disabled: locked, placeholder: "provider default" }), role === "target" ? "Original: 0" : "Original: 1.0"),
        conn ? field("Provider", h("div", { style: { paddingTop: "6px" } }, S.meta.connectionTypes[conn.type].label)) : h("div")),
      adv);
  }

  function jsonArea(value, onChange, disabled) {
    const ta = h("textarea", { rows: 3, disabled, style: { minHeight: "60px" } });
    ta.value = JSON.stringify(value, null, 1);
    ta.addEventListener("change", () => {
      try { onChange(ta.value.trim() ? JSON.parse(ta.value) : {}); ta.style.borderColor = ""; } catch { ta.style.borderColor = "var(--bad)"; toast("Not valid JSON", true); }
    });
    return ta;
  }

  function mediaControls(cfg, save, locked) {
    cfg.media = cfg.media || {};
    const im = cfg.media.image = Object.assign({ mode: "none", width: 840, height: 480, fit: "fill", format: "png" }, cfg.media.image || {});
    const vi = cfg.media.video = Object.assign({ mode: "grid", frames: 4, rows: 2, cols: 2, cellWidth: 840, cellHeight: 480 }, cfg.media.video || {});
    return h("div", { style: { marginTop: "10px" } }, h("h3", "Input preprocessing"),
      h("div.grid3",
        field("Images", select([{ value: "none", label: "Send as-is" }, { value: "resize", label: "Resize" }], im.mode, (v) => { im.mode = v; save(); }, { disabled: locked })),
        field("Size W×H", h("div.row", numInput(im.width, (v) => { im.width = v; save(); }, { disabled: locked, style: { width: "80px" } }), "×", numInput(im.height, (v) => { im.height = v; save(); }, { disabled: locked, style: { width: "80px" } }))),
        field("Fit / format", h("div.row", select(["fill", "inside", "cover", "contain"], im.fit, (v) => { im.fit = v; save(); }, { disabled: locked }), select(["png", "jpeg"], im.format, (v) => { im.format = v; save(); }, { disabled: locked })))),
      h("div.grid3", { style: { marginTop: "6px" } },
        field("Videos", select([{ value: "grid", label: "Frame grid (like the original)" }, { value: "native", label: "Send the video natively" }], vi.mode, (v) => { vi.mode = v; save(); }, { disabled: locked })),
        field("Frames / grid", h("div.row", numInput(vi.frames, (v) => { vi.frames = v; save(); }, { disabled: locked, style: { width: "60px" } }), numInput(vi.rows, (v) => { vi.rows = v; save(); }, { disabled: locked, style: { width: "60px" } }), "×", numInput(vi.cols, (v) => { vi.cols = v; save(); }, { disabled: locked, style: { width: "60px" } }))),
        field("Cell W×H", h("div.row", numInput(vi.cellWidth, (v) => { vi.cellWidth = v; save(); }, { disabled: locked, style: { width: "80px" } }), "×", numInput(vi.cellHeight, (v) => { vi.cellHeight = v; save(); }, { disabled: locked, style: { width: "80px" } })))),
      h("p.hint", "Original harness: frame grid of 4 frames (2×2, 840×480 cells), then the grid resized to 840×480 (fill) PNG. Grids expose {{duration}}, {{interval}} and {{timing_line}} to the prompt."));
  }

  function outputCard(id, locked, patch) {
    const p = S.view.project;
    if (!p.output) return h("div.panel", h("h2", "Output schema"), h("p.muted", "Commit a dataset first."));
    const out = JSON.parse(JSON.stringify(p.output));
    const allBinary = p.fields.every((f) => f.type === "binary");
    const schemaTa = h("textarea", { rows: 10, disabled: locked });
    schemaTa.value = JSON.stringify(out.jsonSchema, null, 2);
    schemaTa.addEventListener("change", () => {
      try { out.jsonSchema = JSON.parse(schemaTa.value); out.style = "custom"; out.nativeSchema = null; patch({ output: out }); draw(); } catch { toast("Schema is not valid JSON", true); }
    });
    const regen = async (style, inMain) => {
      const o = await POST(`/api/projects/${id}/output/generate`, { style, justificationInMain: inMain, justificationProperty: out.justification && out.justification.property });
      Object.assign(out, o);
      schemaTa.value = JSON.stringify(out.jsonSchema, null, 2);
      patch({ output: out });
      draw();
    };
    const mapBox = h("div");
    const top = h("div");
    const draw = () => {
      mount(top, h("div.grid3",
        field("Style", select([{ value: "index_array", label: "Index array {\"b\": [...]} (original)", disabled: !allBinary }, { value: "named", label: "Named fields {\"field\": value}" }, { value: "custom", label: "Custom JSON Schema" }], out.style, (v) => { if (v === "custom") { out.style = "custom"; patch({ output: out }); draw(); } else regen(v, out.justification.mode === "main_response"); }, { disabled: locked })),
        field("Justifications", select([{ value: "second_call", label: "Separate justification call (original default)" }, { value: "main_response", label: "Summary/reasoning inside every response" }], out.justification.mode, (v) => { if (out.style === "custom") { out.justification.mode = v; patch({ output: out }); } else regen(out.style, v === "main_response"); }, { disabled: locked }), "Original: alerts used the summary inside every response; staff/health used a separate call."),
        field("Justification property", textInput(out.justification.property, (v) => { out.justification.property = v; patch({ output: out }); }, { disabled: locked }))));
      mount(mapBox, h("table",
        h("tr", h("th", "Field"), h("th", "JSON path"), h("th", "Read as"), h("th", "Value")),
        p.fields.map((f) => {
          const m = out.mapping[f.key] = out.mapping[f.key] || { path: f.key, op: "value" };
          return h("tr", h("td", f.label || f.key),
            h("td", textInput(m.path, (v) => { m.path = v; patch({ output: out }); }, { disabled: locked, style: { width: "120px" } })),
            h("td", select([{ value: "value", label: "value at path" }, { value: "contains", label: "array contains" }], m.op, (v) => { m.op = v; patch({ output: out }); draw(); }, { disabled: locked })),
            h("td", m.op === "contains" ? numInput(m.value, (v) => { m.value = v; patch({ output: out }); }, { disabled: locked, style: { width: "80px" } }) : h("span.muted.small", f.type)));
        })));
    };
    draw();
    return h("div.panel",
      h("div.panel-head", h("h2", "Output schema"), out.nativeSchema ? h("span.badge.accent", "Gemini receives the original schema verbatim") : null),
      top, h("div.grid2", { style: { marginTop: "10px" } }, field("JSON Schema (edit to customise)", schemaTa), h("div", h("span.small.muted", "How each field is read from the output"), mapBox)));
  }

  function methodCard(id, patch) {
    const p = S.view.project;
    const m = JSON.parse(JSON.stringify(p.method));
    const save = () => patch({ method: m });
    const T = m.toggles;
    const tog = (key, label, opts, help) => field(label, select(opts.map((o) => ({ value: String(o.value), label: o.label })), String(T[key]), (v) => { const o = opts.find((x) => String(x.value) === v); T[key] = o.value; save(); }), help);
    const pr = JSON.parse(JSON.stringify(p.pricing || { target: {}, generator: {} }));
    const savePricing = () => patch({ pricing: pr });
    const tmpl = h("textarea", { rows: 18, readonly: !m.metaTemplate });
    tmpl.value = m.metaTemplate || S.meta.originalMetaTemplate;
    const tmplStatus = h("span.badge", { class: m.metaTemplate ? "warn" : "ok" }, m.metaTemplate ? "Edited" : "Original (unchanged)");
    const editBtn = h("button.small", { on: { click: () => { tmpl.readOnly = false; tmpl.focus(); } } }, "Edit");
    tmpl.addEventListener("change", () => { if (tmpl.value === S.meta.originalMetaTemplate) m.metaTemplate = null; else m.metaTemplate = tmpl.value; tmplStatus.textContent = m.metaTemplate ? "Edited" : "Original (unchanged)"; tmplStatus.className = `badge ${m.metaTemplate ? "warn" : "ok"}`; save(); });
    const reset = h("button.small", { on: { click: async () => { if (!(await confirmModal("Reset meta-prompt", "Restore the original meta-prompt template exactly?", "Reset"))) return; m.metaTemplate = null; tmpl.value = S.meta.originalMetaTemplate; tmpl.readOnly = true; tmplStatus.textContent = "Original (unchanged)"; tmplStatus.className = "badge ok"; save(); } } }, "Reset to original");
    return h("div.panel",
      h("h2", "Method"),
      h("div.grid3",
        field("Candidates per step", numInput(m.candidatesPerStep, (v) => { m.candidatesPerStep = v; save(); }), "Original: 3"),
        field("Minimum candidate length (chars)", numInput(m.minCandidateChars, (v) => { m.minCandidateChars = v; save(); }), "Original: 200"),
        field("Pass marks TPR / TNR / score (%)", h("div.row", numInput(m.targets.tpr, (v) => { m.targets.tpr = v; save(); }, { style: { width: "70px" } }), numInput(m.targets.tnr, (v) => { m.targets.tnr = v; save(); }, { style: { width: "70px" } }), numInput(m.targets.score, (v) => { m.targets.score = v; save(); }, { style: { width: "70px" } })), "Original: 80 / 80; pass marks only label the ✓/✗ — acceptance is always overall accuracy")),
      h("details", { open: true, style: { marginTop: "10px" } }, h("summary", "Meta-prompt template ", tmplStatus),
        h("p.small.muted", "This is the exact text sent to the generator each step. It stays identical to the original unless you edit it here."),
        (S.view.metaHints || []).map((x) => h("div.callout.warn.small", x)),
        tmpl,
        h("div.row", { style: { marginTop: "6px" } }, editBtn, reset,
          h("button.small", { on: { click: async () => { const r = await POST(`/api/projects/${id}/meta-preview`, { template: m.metaTemplate }); modal(`Rendered meta-prompt (${r.basedOn})`, h("pre.code-box", r.text)); } } }, "Preview rendered"),
          h("details", h("summary.small", "Slots"), h("ul.small", Object.entries(S.meta.metaSlots).map(([k, v]) => h("li", h("code", `{{${k}}}`), ` — ${v}`)))))),
      h("details", { style: { marginTop: "10px" } }, h("summary", "Method switches (defaults = original behaviour)"),
        h("div.grid3", { style: { marginTop: "8px" } },
          tog("matchBestBy", "Wrong predictions for the meta-prompt come from", [{ value: "prompt", label: "latest entry with the best prompt's text (original)" }, { value: "id", label: "the accepted entry itself" }]),
          tog("historyWindow", "Prompt history in the meta-prompt", [{ value: 0, label: "all steps (original)" }, { value: 5, label: "last 5 steps" }, { value: 10, label: "last 10 steps" }, { value: 20, label: "last 20 steps" }]),
          tog("dedupeCandidates", "Duplicate candidates", [{ value: false, label: "evaluate every copy (original)" }, { value: true, label: "evaluate once" }]),
          tog("justificationPerItem", "Justification calls", [{ value: false, label: "one per wrong item-field (original)" }, { value: true, label: "one per item" }]),
          tog("absentFieldScore", "Fields with no examples in a split", [{ value: 100, label: "score 100% (original)" }, { value: "exclude", label: "leave out of the mean" }]),
          tog("placeholderGuard", "Candidates that drop a {{placeholder}}", [{ value: "warn", label: "warn on the dashboard" }, { value: "discard", label: "discard the candidate" }, { value: "off", label: "ignore (original)" }]),
          tog("parseRetryLimit", "Output missing required keys", [{ value: 8, label: "retry 8×, then empty prediction" }, { value: 0, label: "retry forever (original)" }]),
          tog("persistentErrorPolicy", "Auth / bad-request errors", [{ value: "attention", label: "pause and ask after 8 tries" }, { value: "retry", label: "retry forever (original)" }]))),
      h("details", { style: { marginTop: "10px" } }, h("summary", "Stop conditions & cost (optional — the original runs until paused)"),
        h("div.grid3", { style: { marginTop: "8px" } },
          field("Max steps", numInput(m.stop.maxSteps, (v) => { m.stop.maxSteps = v; save(); }, { placeholder: "none" })),
          field("Stop after N steps without improvement", numInput(m.stop.maxStale, (v) => { m.stop.maxStale = v; save(); }, { placeholder: "none" })),
          field("Stop when every field passes", select([{ value: "false", label: "no" }, { value: "true", label: "yes" }], String(!!m.stop.allPass), (v) => { m.stop.allPass = v === "true"; save(); })),
          field("Test-set eval when the run stops", select([{ value: "false", label: "no" }, { value: "true", label: "yes, evaluate the best prompt on test" }], String(!!m.stop.testEvalOnStop), (v) => { m.stop.testEvalOnStop = v === "true"; save(); })),
          field("Budget ($, needs prices)", numInput(m.stop.budgetUsd, (v) => { m.stop.budgetUsd = v; save(); }, { placeholder: "none" })),
          field("Candidate $/M tokens in · out", h("div.row", numInput(pr.target && pr.target.inPerM, (v) => { pr.target = pr.target || {}; pr.target.inPerM = v; savePricing(); }, { style: { width: "80px" } }), numInput(pr.target && pr.target.outPerM, (v) => { pr.target = pr.target || {}; pr.target.outPerM = v; savePricing(); }, { style: { width: "80px" } }))),
          field("Generator $/M tokens in · out", h("div.row", numInput(pr.generator && pr.generator.inPerM, (v) => { pr.generator = pr.generator || {}; pr.generator.inPerM = v; savePricing(); }, { style: { width: "80px" } }), numInput(pr.generator && pr.generator.outPerM, (v) => { pr.generator = pr.generator || {}; pr.generator.outPerM = v; savePricing(); }, { style: { width: "80px" } }))),
          field("API call log", select([{ value: "compact", label: "compact (prompts stored once)" }, { value: "full", label: "full (like the original)" }, { value: "errors", label: "errors only" }], (p.logging && p.logging.apiLog) || "compact", (v) => patch({ logging: { apiLog: v } }))))));
  }

  async function drawValidate(panel, id) {
    const v = S.view;
    const p = v.project;
    const rep = p.preflight;
    const fresh = rep && rep.configSha === v.configSha;
    const running = v.running;
    const startBtn = h("button.primary", { disabled: running || !(v.hasBaseline || (rep && rep.ok && fresh)), on: { click: start } }, v.hasBaseline ? "Resume run" : "Start optimization");
    const runBtn = h("button", { disabled: running, on: { click: runPreflight } }, rep ? "Re-validate" : "Validate & initialize");
    const out = h("div");
    mount(panel, h("div.panel-head", h("h2", "Validate & initialize"), h("div.row", runBtn, startBtn)),
      h("p.small.muted", "Checks both connections, runs the base prompt on 3 training items to show raw → parsed → expected, and estimates calls and tokens per step. Nothing is optimized until you press Start."),
      running ? h("div.callout", "A run is active — ", h("a", { href: `#/p/${id}/dashboard` }, "open the dashboard")) : null, out);
    if (rep) drawReport(out, rep, fresh);
    async function runPreflight() {
      runBtn.disabled = true; startBtn.disabled = true;
      mount(out, h("p.muted", "Validating…"));
      try {
        const job = await POST(`/api/projects/${id}/preflight`);
        const r = await waitJob(job, (pr) => { if (pr && pr.label) mount(out, h("p.muted", pr.label + "…")); });
        S.view = await GET(`/api/projects/${id}`);
        drawValidate(panel, id);
        if (r.ok) toast("All checks passed — ready to start");
      } catch (e) { mount(out, h("div.callout.bad", e.message)); runBtn.disabled = false; }
    }
    async function start() {
      startBtn.disabled = true;
      await POST(`/api/projects/${id}/start`);
      const box = h("div.callout", "Initializing…");
      mount(out, box);
      for (;;) {
        const s = await GET(`/api/projects/${id}/summary`, { quiet: true });
        if (s.progress && s.progress.total) mount(box, h("div", `${s.progress.label || s.phase}: ${fmt.int(s.progress.done)}/${fmt.int(s.progress.total)}`), progressBar(s.progress.done, s.progress.total));
        else mount(box, `${(s.progress && s.progress.label) || "Initializing"}…`);
        if (s.state === "running" || s.state === "paused") { window.WPO.go(`/p/${id}/dashboard`); return; }
        if (s.state === "needs_attention" || s.state === "crashed" || s.state === "stopped") {
          mount(box, h("div.callout.bad", `${s.state.replace("_", " ")}: ${(s.attention && s.attention.message) || s.error || "see the dashboard log"}`), h("a", { href: `#/p/${id}/dashboard` }, "Open the dashboard"));
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  function drawReport(out, rep, fresh) {
    const icon = (c) => (c.level === "warn" ? h("span.badge.warn", "note") : c.ok ? h("span.badge.ok", "ok") : h("span.badge.bad", "fix"));
    const est = rep.estimate;
    mount(out,
      fresh ? null : h("div.callout.warn", "Settings changed since this check — validate again before starting."),
      h("ul.checks", { style: { paddingLeft: "18px" } }, rep.checks.map((c) => h("li", icon(c), " ", h("strong", c.name), " — ", c.detail))),
      rep.dryRun && rep.dryRun.length ? h("div", h("h3", "Dry run (base prompt)"), h("div.table-wrap", h("table",
        h("tr", h("th", "Item"), h("th", "Expected"), h("th", "Predicted"), h("th", "Raw output")),
        rep.dryRun.map((r) => h("tr",
          h("td.small.mono", r.itemId), h("td.small", Object.entries(r.expected || {}).map(([k, v]) => `${k}=${fmt.val(v)}`).join(", ")),
          h("td.small", r.error ? h("span", { style: { color: "var(--bad)" } }, r.error) : Object.entries(r.predicted || {}).map(([k, v]) => `${k}=${fmt.val(v)}`).join(", "), r.warning ? h("div.small", { style: { color: "var(--warn)" } }, r.warning) : null),
          h("td", r.raw ? h("details", h("summary.small", `${r.raw.length} chars · ${r.structured || ""}`), h("pre.code-box", r.raw)) : null)))))) : null,
      est ? h("div", h("h3", "Estimate"), h("div.stats",
        h("div.stat", h("div.k", "Train / test items"), h("div.v", `${fmt.int(est.trainItems)} / ${fmt.int(est.testItems)}`)),
        h("div.stat", h("div.k", "Candidate calls per step"), h("div.v", fmt.int(est.perStep.targetCalls))),
        h("div.stat", h("div.k", "Input tokens per step"), h("div.v", fmt.tokens(est.perStep.inputTokens))),
        h("div.stat", h("div.k", "Output tokens per step"), h("div.v", fmt.tokens(est.perStep.outputTokens))),
        est.perStep.usd !== undefined ? h("div.stat", h("div.k", "≈ $ per step (candidate)"), h("div.v", fmt.usd(est.perStep.usd))) : null,
        h("div.stat", h("div.k", "Meta-prompt (step 1 → growth/step)"), h("div.v.small", `${fmt.tokens(est.metaPromptTokensStep1)} → +${fmt.tokens(est.metaPromptGrowthPerStepTokens)}`))),
        h("p.hint", "Per step = candidates × train items, plus up to one justification call per wrong prediction of an accepted candidate and one generator call. The original method keeps every prior prompt in the meta-prompt, so it grows each step.")) : null);
  }

  // boot
  window.WPO.app = { route, loadView, connectionModal };
  // dashboard.js loads after this file — route once every script has run (deep links / reloads)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", route);
  else route();
})();
