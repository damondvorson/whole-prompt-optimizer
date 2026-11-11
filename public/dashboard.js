// dashboard.js — run dashboard (generalised from the original wpo_dashboard.html).
// Polls a small summary every 3 s; history entries, item results, meta-prompts, API calls and logs are
// fetched on demand / incrementally (cursor or byte offset) instead of re-downloading everything.
"use strict";
(function () {
  const { GET, POST, h, mount, clear, toast, modal, confirmModal, fmt, progressBar, stateBadge, select, withToken } = window.WPO;
  const D = { id: null, timers: [], summary: null, chart: null, logOffset: null, apiCursor: null, apiRecords: [], apiType: "", results: null, resultsWhich: "best", resultsField: "", resultsWrongOnly: false, resultsKey: null, openSteps: new Set() };

  function stop() { D.timers.forEach(clearInterval); D.timers = []; if (D.chart) { D.chart.destroy(); D.chart = null; } }

  const els = {};
  async function show(id) {
    stop();
    Object.assign(D, { id, summary: null, logOffset: null, apiCursor: null, apiRecords: [], results: null, resultsKey: null });
    const view = await GET(`/api/projects/${id}`);
    D.view = view;
    const app = document.getElementById("app");
    for (const k of ["head", "attention", "progress", "stats", "chart", "metrics", "results", "history", "best", "meta", "api", "logs"]) els[k] = h("div");
    mount(document.getElementById("topbar-right"), h("span.muted.small", view.project.name));
    mount(app, els.head, els.attention, els.progress, els.stats,
      h("div.panel", h("div.panel-head", h("h2", "Accuracy trend"), h("span.small.muted", "accepted prompts (overall + per field); dots = every candidate")), h("div.chart-box", h("canvas#trend"))),
      h("div.panel", els.metrics),
      h("div.panel", els.results),
      h("div.panel", els.history),
      h("div.panel", els.best),
      h("div.panel", els.meta),
      h("div.panel", els.api),
      h("div.panel", els.logs));
    await tick();
    D.timers.push(setInterval(tick, 3000));
    D.timers.push(setInterval(pollLogs, 3000));
    D.timers.push(setInterval(pollApi, 6000));
    pollLogs();
    pollApi(true);
  }

  async function tick() {
    let s;
    try { s = await GET(`/api/projects/${D.id}/summary`, { quiet: true }); } catch { return; }
    const prev = D.summary;
    D.summary = s;
    renderHead(s);
    renderAttention(s);
    renderProgress(s);
    renderStats(s);
    if (!prev || prev.history?.length !== s.history?.length || prev.bestEntryId !== s.bestEntryId || JSON.stringify(prev.testEval) !== JSON.stringify(s.testEval)) {
      renderChart(s);
      renderMetrics(s);
      renderHistory(s);
      renderBest(s);
      renderMetaList();
    }
    const key = `${s.bestEntryId}|${s.testEval && s.testEval.timestamp}|${s.excluded}`;
    if (key !== D.resultsKey) { D.resultsKey = key; loadResults(); }
  }

  function renderHead(s) {
    const running = s.running;
    const paused = s.state === "paused";
    const canResume = !running && ["stopped", "crashed", "completed", "paused", "needs_attention", "validated", "configured"].includes(s.state);
    mount(els.head, h("div.panel-head",
      h("div", h("h1", D.view.project.name), h("div.row.small.muted", stateBadge(s.state), s.models ? `candidate ${s.models.targetProvider || ""} ${s.models.target || ""} · generator ${s.models.generatorProvider || ""} ${s.models.generator || ""}` : "")),
      h("div.row",
        running && !paused && s.state !== "needs_attention" ? h("button", { on: { click: () => POST(`/api/projects/${D.id}/pause`).then(() => toast("Pausing after the current step")) } }, "Pause") : null,
        running && (paused || s.state === "needs_attention") ? h("button.primary", { on: { click: () => POST(`/api/projects/${D.id}/resume`).then(tick) } }, "Resume") : null,
        canResume ? h("button.primary", { on: { click: async () => { try { await POST(`/api/projects/${D.id}/start`); toast("Starting…"); tick(); } catch (e) { if (e.status === 409 || e.status === 400) window.WPO.go(`/p/${D.id}/config`); } } } }, s.step ? "Resume run" : "Start") : null,
        running ? h("button", { disabled: s.testEval && s.testEval.running, on: { click: () => POST(`/api/projects/${D.id}/test-eval`).then(() => { toast("Test evaluation started"); tick(); }) } }, s.testEval && s.testEval.running ? "Testing…" : "Run test eval") : null,
        running ? h("button.danger", { on: { click: async () => { if (await confirmModal("Stop the run?", "The current step is abandoned; finished calls are kept in the journal and reused when you resume.", "Stop", true)) POST(`/api/projects/${D.id}/stop`).then(tick); } } }, "Stop") : null,
        h("a", { href: withToken(`/api/projects/${D.id}/snapshot`) }, h("button", "Snapshot")),
        h("a", { href: withToken(`/api/projects/${D.id}/export/checkpoint`) }, h("button", { title: "Original checkpoint format (version 4)" }, "Export checkpoint")),
        h("button", { on: { click: async () => { const v = await POST(`/api/projects/${D.id}/fork`, {}); toast("Forked"); window.WPO.go(`/p/${v.project.id}/data`); } } }, "Fork"))));
  }

  function renderAttention(s) {
    const items = [];
    if (s.attention) items.push(h("div.callout.bad", h("strong", `Needs attention — ${s.attention.role || ""} ${s.attention.kind}: `), s.attention.message, h("div.small", "Fix the connection or settings (", h("a", { href: `#/p/${D.id}/config` }, "Harnesses"), "), then press Resume. Finished calls are reused.")));
    if (s.state === "crashed") items.push(h("div.callout.bad", h("strong", "The engine stopped unexpectedly: "), s.error || "see the log below"));
    if (s.state === "completed") items.push(h("div.callout.ok", "Run completed (stop condition reached)."));
    if (s.warnings && s.warnings.length) items.push(h("details.callout.warn", h("summary", `${s.warnings.length} warning${s.warnings.length > 1 ? "s" : ""} — latest: ${s.warnings[s.warnings.length - 1].message.slice(0, 140)}`), h("ul.small", s.warnings.slice().reverse().map((w) => h("li", `${fmt.time(w.at)} · ${w.message}`)))));
    mount(els.attention, ...items);
  }

  function renderProgress(s) {
    if (!s.progress || !s.running) return clear(els.progress);
    const pr = s.progress;
    mount(els.progress, h("div.panel", h("div.row.small", h("strong", pr.label || s.phase), pr.total ? h("span.muted", `${fmt.int(pr.done)} / ${fmt.int(pr.total)}`) : null), pr.total ? progressBar(pr.done, pr.total) : null));
  }

  function renderStats(s) {
    const sp = s.spend || {};
    const tok = (r) => (sp[r] ? `${fmt.int(sp[r].calls)} calls · ${fmt.tokens(sp[r].inputTokens)} in / ${fmt.tokens(sp[r].outputTokens)} out` : "—");
    mount(els.stats, h("div.stats", { style: { marginBottom: "16px" } },
      stat("Steps done", s.step ? Math.max(0, s.step - 1) : "—", s.step ? (s.state === "completed" || s.state === "stopped" ? "baseline + optimisation steps" : `now on step ${s.step}`) : null),
      stat("Best train", fmt.pct(s.bestAccuracy, 2), s.baseAccuracy !== null && s.baseAccuracy !== undefined ? `base ${fmt.pct(s.baseAccuracy, 2)}` : null),
      stat("Test (best prompt)", s.testEval && s.testEval.overallAccuracy !== undefined ? fmt.pct(s.testEval.overallAccuracy, 2) : "—", s.testEval && s.testEval.step ? `after step ${Math.max(0, s.testEval.step - 1)}` : "run test eval"),
      stat("Fields passing", s.fields ? `${s.fieldsPassing}/${s.fields.length}` : "—"),
      stat("Stale steps", s.stale ?? "—", s.bestAchievedAtStep ? `best found at step ${s.bestAchievedAtStep}` : null),
      stat("Items", `${fmt.int(s.trainCount)} / ${fmt.int(s.testCount)}`, s.excluded ? `${s.excluded} excluded` : "train / test"),
      stat("Candidate model", tok("target")),
      stat("Generator", tok("generator")),
      sp.usd !== null && sp.usd !== undefined ? stat("Spend", fmt.usd(sp.usd)) : null));
  }
  function stat(k, v, sub) { return h("div.stat", h("div.k", k), h("div.v", { style: { fontSize: String(v).length > 14 ? "13px" : "" } }, v), sub ? h("div.k", sub) : null); }

  function fieldScore(f, m) {
    if (!m) return null;
    return f.type === "binary" ? (m.tpr + m.tnr) / 2 : m.score;
  }

  function renderChart(s) {
    const canvas = document.getElementById("trend");
    if (!canvas || !window.Chart || !s.history) return;
    const acc = s.perFieldHistory || [];
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue("--muted").trim() || "#888";
    const palette = ["#3a5bd9", "#e8833a", "#2a9d6f", "#c94f7c", "#8c6bd6", "#c7a224", "#3fa5c9", "#d1495b", "#6c8f3c", "#9b5de5", "#00a6a6", "#b5651d"];
    const datasets = [
      { label: "Overall (accepted)", data: acc.map((e) => ({ x: e.step, y: e.accuracy })), borderColor: css.getPropertyValue("--text").trim(), borderWidth: 2.5, stepped: true, pointRadius: 3, tension: 0 },
      { label: "Candidates", data: s.history.filter((e) => e.kind !== "baseline").map((e) => ({ x: e.step, y: e.accuracy })), showLine: false, pointRadius: 2.5, borderColor: "rgba(127,127,127,.5)", backgroundColor: "rgba(127,127,127,.35)" },
      ...(s.fields || []).map((f, i) => ({ label: f.label || f.key, data: acc.map((e) => ({ x: e.step, y: fieldScore(f, e.perFieldMetrics[f.key]) })), borderColor: palette[i % palette.length], borderWidth: 1.2, pointRadius: 0, stepped: true, hidden: (s.fields || []).length > 6 })),
    ];
    if (D.chart) { D.chart.data.datasets = datasets; D.chart.update("none"); return; }
    D.chart = new window.Chart(canvas, {
      type: "line", data: { datasets },
      options: { animation: false, maintainAspectRatio: false, parsing: false, scales: { x: { type: "linear", title: { display: true, text: "step", color: text }, ticks: { color: text, precision: 0 } }, y: { min: 0, max: 100, ticks: { color: text, callback: (v) => `${v}%` } } }, plugins: { legend: { labels: { color: text, boxWidth: 10 } } } },
    });
  }

  function metricCell(f, m, targets) {
    if (!m) return h("td.muted", "—");
    const t = Object.assign({}, targets || {}, f.target || {});
    if (f.type === "binary") {
      const c = (v, tt) => h("span.badge", { class: v >= tt ? "ok" : v >= tt - 20 ? "warn" : "bad" }, fmt.pct(v));
      return h("td", "TPR ", c(m.tpr, t.tpr || 80), " TNR ", c(m.tnr, t.tnr || 80));
    }
    const pc = m.perClass ? Object.entries(m.perClass).map(([k, v]) => `${k} ${fmt.pct(v.recall, 0)}`).join(" · ") : null;
    return h("td", h("span.badge", { class: m.score >= (t.score || 80) ? "ok" : "warn" }, fmt.pct(m.score)), m.n !== undefined ? h("span.small.muted", ` n=${m.n}`) : null, pc ? h("div.small.muted", pc) : null);
  }

  function renderMetrics(s) {
    const fields = s.fields || [];
    const best = s.bestPerFieldMetrics || {};
    const test = (s.testEval && s.testEval.perField) || {};
    mount(els.metrics, h("div.panel-head", h("h2", "Per-field metrics"), h("span.small.muted", `pass marks: TPR ${s.targets ? s.targets.tpr : 80}% · TNR ${s.targets ? s.targets.tnr : 80}% · score ${s.targets ? s.targets.score : 80}%`)),
      h("div.table-wrap", h("table",
        h("tr", h("th", "#"), h("th", "Field"), h("th", "Type"), h("th", "Train (best prompt)"), h("th", "Test")),
        fields.map((f) => h("tr", h("td.muted", f.index), h("td", f.label || f.key), h("td.small.muted", f.type), metricCell(f, best[f.key], s.targets), metricCell(f, test[f.key], s.targets))))));
  }

  // ─── results viewer ───
  async function loadResults() {
    try { D.results = await GET(`/api/projects/${D.id}/results?which=${D.resultsWhich}`, { quiet: true }); } catch { D.results = null; }
    renderResults();
  }

  function outcome(f, ir) {
    const exp = ir.labels ? ir.labels[f.key] : undefined;
    if (exp === undefined) return null;
    const wrong = (ir.wrongFields || []).some((w) => w.fieldKey === f.key);
    if (f.type === "binary") return exp ? (wrong ? "FN" : "TP") : (wrong ? "FP" : "TN");
    return wrong ? "wrong" : "right";
  }

  function renderResults() {
    const s = D.summary || {};
    const fields = s.fields || [];
    if (!D.resultsField && fields[0]) D.resultsField = fields[0].key;
    const f = fields.find((x) => x.key === D.resultsField);
    const r = D.results;
    const controls = h("div.row",
      select([{ value: "best", label: "Training set — best prompt" }, { value: "test", label: "Test set — last test eval" }], D.resultsWhich, (v) => { D.resultsWhich = v; loadResults(); }),
      select(fields.map((x) => ({ value: x.key, label: `${x.index}: ${x.label || x.key}` })), D.resultsField, (v) => { D.resultsField = v; renderResults(); }),
      h("label.small", h("input", { type: "checkbox", checked: D.resultsWrongOnly, on: { change: (e) => { D.resultsWrongOnly = e.target.checked; renderResults(); } } }), " only wrong"));
    if (!r || !r.itemResults.length || !f) return mount(els.results, h("div.panel-head", h("h2", "Item results"), controls), h("p.empty", D.resultsWhich === "test" ? "Run a test evaluation to see test-set results." : "Results appear after the baseline."));
    const rows = r.itemResults.filter((ir) => ir.labels && f.key in ir.labels && (!D.resultsWrongOnly || (ir.wrongFields || []).some((w) => w.fieldKey === f.key)));
    const groups = new Map();
    for (const ir of rows) {
      const g = f.type === "binary" ? (ir.labels[f.key] ? "Positives" : "Negatives") : f.type === "categorical" ? `Expected: ${ir.labels[f.key]}` : (outcome(f, ir) === "wrong" ? "Incorrect" : "Correct");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ir);
    }
    const list = rows;
    mount(els.results, h("div.panel-head", h("h2", "Item results"), controls),
      [...groups.entries()].map(([g, irs]) => {
        const wrong = irs.filter((ir) => (ir.wrongFields || []).some((w) => w.fieldKey === f.key)).length;
        return h("div", h("h3", `${g} `, h("span.small.muted", `${irs.length} items · ${wrong} wrong`)),
          h("div.item-grid", irs.slice(0, 240).map((ir) => itemCard(ir, f, list))),
          irs.length > 240 ? h("p.small.muted", `…and ${irs.length - 240} more (tick "only wrong" to focus)`) : null);
      }));
  }

  function itemCard(ir, f, list) {
    const oc = outcome(f, ir);
    const wrong = oc === "FN" || oc === "FP" || oc === "wrong";
    const media = ir.kind === "image" || ir.kind === "video"
      ? h("img", { src: withToken(`/api/projects/${D.id}/items/${encodeURIComponent(ir.imageId)}/thumb?w=240`), loading: "lazy", alt: ir.imageId })
      : h("div.txt", ir.text || ir.kind || "");
    return h("div.item-card", { class: `${wrong ? "wrong" : ""} ${ir.excluded ? "excluded" : ""}`, title: ir.imageId, on: { click: () => lightbox(ir, f, list) } }, media,
      h("div.meta", h("span.badge", { class: wrong ? "bad" : "ok" }, oc || "—"), ir.error ? h("span.badge.warn", "error") : null, ir.excluded ? h("span.badge", "excluded") : null, h("span.id", ir.imageId.split("/").pop())));
  }

  async function lightbox(ir, f, list) {
    let idx = list.indexOf(ir);
    let m;
    const render = async () => {
      const cur = list[idx];
      const detail = await GET(`/api/projects/${D.id}/items/${encodeURIComponent(cur.imageId)}`, { quiet: true }).catch(() => null);
      const fields = (D.summary && D.summary.fields) || [];
      const body = h("div",
        cur.kind === "image" || cur.kind === "video" ? h("img.big", { src: withToken(`/api/projects/${D.id}/items/${encodeURIComponent(cur.imageId)}/thumb?w=1200`), alt: cur.imageId }) : null,
        detail && detail.text ? h("pre.code-box", detail.text) : null,
        h("table", { style: { marginTop: "10px" } }, h("tr", h("th", "Field"), h("th", "Expected"), h("th", "Predicted"), h("th", "")),
          fields.filter((x) => cur.labels && x.key in cur.labels).map((x) => {
            const w = (cur.wrongFields || []).some((y) => y.fieldKey === x.key);
            return h("tr", h("td", x.label || x.key), h("td", fmt.val(cur.labels[x.key])), h("td", fmt.val(cur.predicted ? cur.predicted[x.key] : undefined)), h("td", h("span.badge", { class: w ? "bad" : "ok" }, w ? "wrong" : "right")));
          })),
        cur.detectedB ? h("p.small.muted", `b = [${cur.detectedB.join(", ")}]`) : null,
        cur.summary ? h("div.callout", h("strong", "Summary: "), cur.summary) : null,
        cur.error ? h("div.callout.warn", `Error: ${cur.error}`) : null,
        detail ? h("details", h("summary.small", "Item details"), h("pre.code-box", JSON.stringify({ id: detail.id, split: detail.split, labels: detail.labels, vars: detail.vars, files: detail.files, source: detail.source }, null, 2))) : null);
      const prev = h("button", { disabled: idx <= 0, on: { click: () => { idx--; m.close(); open(); } } }, "← Prev");
      const next = h("button", { disabled: idx >= list.length - 1, on: { click: () => { idx++; m.close(); open(); } } }, "Next →");
      const excl = h("button", { class: cur.excluded ? "" : "danger", on: { click: async () => {
        await POST(`/api/projects/${D.id}/items/${encodeURIComponent(cur.imageId)}/${cur.excluded ? "include" : "exclude"}`);
        cur.excluded = !cur.excluded;
        toast(cur.excluded ? "Excluded — applies at the next step (best metrics are recomputed, no API calls)" : "Included again");
        m.close(); renderResults();
      } } }, cur.excluded ? "Include again" : "Exclude from dataset");
      return { body, actions: [excl, h("div.spacer"), h("span.small.muted", `${idx + 1} / ${list.length}`), prev, next] };
    };
    const open = async () => { const { body, actions } = await render(); m = modal(list[idx].imageId, body, actions); };
    open();
  }

  // ─── history ───
  function renderHistory(s) {
    const byStep = new Map();
    for (const e of s.history || []) { if (!byStep.has(e.step)) byStep.set(e.step, []); byStep.get(e.step).push(e); }
    const steps = [...byStep.keys()].sort((a, b) => b - a);
    const n = (s.fields || []).length;
    mount(els.history, h("div.panel-head", h("h2", "Optimisation history"), h("span.small.muted", `${(s.history || []).length} prompts evaluated`)),
      steps.length ? steps.slice(0, 200).map((st) => {
        const entries = byStep.get(st);
        const accepted = entries.some((e) => e.accepted);
        return h("div.history-step",
          h("div.row", h("strong", st === 0 ? "Baseline" : `Step ${st}`), st === 0 ? h("span.badge.accent", "base prompt") : accepted ? h("span.badge.ok", "accepted") : h("span.badge", "rejected")),
          entries.map((e) => h("div.cand",
            h("span", { style: { minWidth: "90px" } }, st === 0 ? "base" : `candidate ${e.candidateIndex + 1}`),
            h("span.badge", { class: e.accepted ? "ok" : "" }, fmt.pct(e.accuracy, 2)),
            h("span.small.muted", `${e.passing}/${n} fields pass · ${e.wrong} wrong`),
            e.placeholdersDropped ? h("span.badge.warn", { title: e.placeholdersDropped.join("\n") }, `dropped ${e.placeholdersDropped.map((x) => (x.startsWith("rule: ") ? "substitution anchor" : `{{${x}}}`)).join(", ")}`) : null,
            e.id === s.bestEntryId ? h("span.badge.accent", "current best") : null,
            h("button.small", { on: { click: () => showEntry(e.id) } }, "Prompt & wrongs"))));
      }) : h("p.empty", "History appears after the baseline."));
  }

  async function showEntry(entryId) {
    const e = await GET(`/api/projects/${D.id}/history/${encodeURIComponent(entryId)}`);
    const ws = e.wrongPredictions || [];
    modal(`${e.step === 0 ? "Baseline" : `Step ${e.step} · candidate ${e.candidateIndex + 1}`} — ${fmt.pct(e.accuracy, 2)}`, h("div",
      h("div.row", h("button.small", { on: { click: () => navigator.clipboard.writeText(e.prompt).then(() => toast("Prompt copied")) } }, "Copy prompt")),
      h("pre.code-box", e.prompt),
      h("h3", `Wrong predictions (${ws.length})`),
      ws.slice(0, 60).map((w) => h("div.callout.small", h("div", h("strong", w.imageId), ` · ${w.fieldKey}: expected ${fmt.val(w.expected)}, got ${fmt.val(w.actual)}`), w.justification ? h("pre", { style: { marginTop: "4px" } }, w.justification) : null)),
      ws.length > 60 ? h("p.small.muted", `…${ws.length - 60} more`) : null));
  }

  function renderBest(s) {
    mount(els.best, h("div.panel-head", h("h2", "Current best prompt"), h("div.row", h("button.small", { on: { click: async () => { const e = s.bestEntryId ? await GET(`/api/projects/${D.id}/history/${encodeURIComponent(s.bestEntryId)}`) : null; if (e) { await navigator.clipboard.writeText(e.prompt); toast("Best prompt copied"); } } } }, "Copy"))),
      h("div#best-prompt", h("span.muted", "Loading…")));
    if (s.bestEntryId) GET(`/api/projects/${D.id}/history/${encodeURIComponent(s.bestEntryId)}`, { quiet: true }).then((e) => mount(document.getElementById("best-prompt"), h("pre.code-box", e.prompt))).catch(() => {});
    else mount(document.getElementById("best-prompt"), h("p.muted", "No baseline yet."));
  }

  async function renderMetaList() {
    let steps = [];
    try { steps = await GET(`/api/projects/${D.id}/steps`, { quiet: true }); } catch {}
    mount(els.meta, h("div.panel-head", h("h2", "Meta-prompts"), h("span.small.muted", "exact text sent to the generator each step (last 50) and its answer")),
      steps.length ? h("div.pill-list", steps.slice().reverse().map((st) => h("button.small", { on: { click: () => showStep(st.step) } }, `Step ${st.step} · ${st.sizeKB} KB${st.candidateCount !== undefined ? ` · ${st.candidateCount} cand.` : ""}`))) : h("p.empty", "No steps yet."));
  }
  async function showStep(n) {
    const st = await GET(`/api/projects/${D.id}/steps/${n}`);
    modal(`Step ${n} — meta-prompt (${st.sizeKB} KB)`, h("div",
      h("h3", "Sent to the generator"), h("pre.code-box", st.metaPrompt),
      h("h3", "Generator answer"), st.generatorText !== undefined ? h("pre.code-box", st.generatorText) : h("p.muted", "Still generating…")));
  }

  // ─── API calls (incremental) ───
  async function pollApi(reset) {
    if (reset) { D.apiCursor = null; D.apiRecords = []; }
    try {
      const r = await GET(`/api/projects/${D.id}/apicalls?limit=150${D.apiCursor ? `&cursor=${encodeURIComponent(D.apiCursor)}` : ""}${D.apiType ? `&type=${D.apiType}` : ""}`, { quiet: true });
      D.apiCursor = r.cursor;
      if (r.records.length) D.apiRecords = D.apiRecords.concat(r.records).slice(-300);
    } catch {}
    renderApi();
  }
  function renderApi() {
    const types = [{ value: "", label: "All calls" }, { value: "TARGET_INFERENCE", label: "Candidate inference" }, { value: "TARGET_JUSTIFICATION", label: "Justification" }, { value: "GENERATOR", label: "Generator" }];
    const recs = D.apiRecords.slice().reverse().slice(0, 120);
    mount(els.api, h("div.panel-head", h("h2", "API calls"), h("div.row", select(types, D.apiType, (v) => { D.apiType = v; pollApi(true); }), h("span.small.muted", "media is logged as path + size, never base64"))),
      recs.length ? h("div.table-wrap", { style: { maxHeight: "420px", overflow: "auto" } }, h("table",
        h("tr", h("th", "Time"), h("th", "Type"), h("th", "Item"), h("th", "Latency"), h("th", "Result")),
        recs.map((r) => h("tr",
          h("td.small.muted", new Date(r.ts).toLocaleTimeString()), h("td.small", r.type), h("td.small.mono", (r.itemId || "").split("/").pop()), h("td.small", r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : ""),
          h("td.small", r.error ? h("span", { style: { color: "var(--bad)" } }, `${r.error.kind || "error"}: ${(r.error.message || "").slice(0, 120)}`) : h("details", h("summary", (r.responsePreview || "").slice(0, 80) || "(empty)"), h("pre.code-box", JSON.stringify({ request: r.request, response: r.response, parsed: r.parsed }, null, 2)))))))) : h("p.empty", "No calls yet."));
  }

  // ─── logs (incremental by byte offset) ───
  async function pollLogs() {
    try {
      const r = await GET(`/api/projects/${D.id}/logs${D.logOffset !== null ? `?offset=${D.logOffset}` : ""}`, { quiet: true });
      if (!els.logs.firstChild) mount(els.logs, h("div.panel-head", h("h2", "Live log")), h("pre.code-box#log-box", { style: { maxHeight: "360px" } }));
      const box = document.getElementById("log-box");
      if (!box) return;
      if (D.logOffset === null) box.textContent = "";
      D.logOffset = r.offset;
      if (r.text) {
        const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        box.textContent = (box.textContent + r.text).slice(-200000);
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
    } catch {}
  }

  window.WPO.dashboard = { show, stop };
})();
