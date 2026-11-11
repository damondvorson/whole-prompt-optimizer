"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const categorizer = require("../lib/dataset/categorizer");
const manifest = require("../lib/dataset/manifest");
const { hashSplit, splitFromWord } = require("../lib/dataset/split");
const { openStorage, parseLocation } = require("../lib/storage");
const legacy = require("../lib/presets/legacy");
const { loadLegacyEngine, ORIGINAL_AVAILABLE } = require("./legacy/legacy_ref");
const { tmpDir, LEGACY_DIR } = require("./helpers");

test("parseLocation recognises every source kind", () => {
  assert.deepStrictEqual(parseLocation("s3://bkt/a/b"), { kind: "s3", bucket: "bkt", prefix: "a/b" });
  assert.deepStrictEqual(parseLocation("gs://bkt"), { kind: "gcs", bucket: "bkt", prefix: "" });
  assert.deepStrictEqual(parseLocation("https://acct.blob.core.windows.net/cont/dir/x?sv=1&sig=2"), { kind: "azure", account: "acct", container: "cont", prefix: "dir/x", sas: "sv=1&sig=2" });
  assert.deepStrictEqual(parseLocation("az://cont/p"), { kind: "azure", container: "cont", prefix: "p" });
  assert.deepStrictEqual(parseLocation("https://bkt.s3.us-west-2.amazonaws.com/k/p"), { kind: "s3", bucket: "bkt", prefix: "k/p" });
  assert.deepStrictEqual(parseLocation("https://storage.googleapis.com/bkt/p"), { kind: "gcs", bucket: "bkt", prefix: "p" });
  assert.strictEqual(parseLocation("https://example.com/data.zip").kind, "https");
  assert.strictEqual(parseLocation("/tmp/x").kind, "local");
});

const LISTING = [
  { key: "falls_positive/a.mp4", size: 10 }, { key: "falls_positive/b.mp4", size: 10 },
  { key: "falls negative/c.mp4", size: 10 },
  { key: "bed exit/pos/d.mp4", size: 10 }, { key: "bed exit/neg/e.mp4", size: 10 }, { key: "bed exit/neg/sub/f.mp4", size: 10 },
  { key: "b43_positive/training/g.png", size: 5 }, { key: "b43_positive/training/g.meta.json", size: 1 }, { key: "b43_positive/test/h.png", size: 5 },
  { key: "misc/readme.txt", size: 1 }, { key: "misc/notes.docx", size: 1 },
];

test("categorizer: tree, suggestions, inheritance, overrides, multi-tag, ignore", () => {
  const tree = categorizer.buildTree(LISTING);
  assert.strictEqual(tree.recursiveFiles, 10); // .meta.json excluded
  const sug = categorizer.suggest(tree);
  const by = Object.fromEntries(sug.map((e) => [e.path, e]));
  assert.deepStrictEqual(by["falls_positive"].tags, [{ class: "falls", polarity: "positive" }]);
  assert.deepStrictEqual(by["falls negative"].tags, [{ class: "falls", polarity: "negative" }]);
  assert.deepStrictEqual(by["bed exit/pos"].tags, [{ class: "bed exit", polarity: "positive" }]);
  assert.deepStrictEqual(by["b43_positive"].tags, [{ class: "b43", polarity: "positive" }]);
  assert.strictEqual(by["b43_positive/training"].split, "train");
  const map = [
    ...sug,
    { path: "bed exit/neg", tags: [{ class: "bed exit", polarity: "negative" }, { class: "falls", polarity: "negative" }] },
    { path: "bed exit/neg/sub", ignore: true },
    { path: "falls_positive", tags: [{ class: "falls", polarity: "positive" }], split: "test" },
  ];
  const { items, fields } = categorizer.buildItems(LISTING, map, { classOrder: ["falls"] });
  assert.deepStrictEqual(fields.map((f) => f.key), ["falls", "b43", "bed_exit"]); // explicit order, then sorted folder order
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes("falls_positive/test/a"));            // split override
  assert.ok(ids.some((i) => i.startsWith("falls_negative/") && i.endsWith("/e")));    // multi-tag reuse
  assert.ok(ids.some((i) => i.startsWith("bed_exit_negative/") && i.endsWith("/e")));
  assert.ok(!ids.some((i) => i.endsWith("/f")));                // ignored subfolder
  assert.ok(ids.includes("b43_positive/training/g") && ids.includes("b43_positive/test/h"));
  assert.ok(!ids.some((i) => /readme|notes/.test(i)));          // untagged
  // order: class order → positives → negatives
  const firstNeg = ids.findIndex((i) => i.startsWith("falls_negative"));
  assert.ok(ids.indexOf("falls_positive/test/a") < firstNeg);
});

test("hash split is stable and order-independent", () => {
  const keys = Array.from({ length: 2000 }, (_, i) => `f/${i}.png`);
  const a = keys.map((k) => hashSplit(k, 0.8));
  const b = keys.slice().reverse().map((k) => hashSplit(k, 0.8)).reverse();
  assert.deepStrictEqual(a, b);
  const frac = a.filter((s) => s === "train").length / a.length;
  assert.ok(frac > 0.76 && frac < 0.84, `train fraction ${frac}`);
  assert.strictEqual(splitFromWord("Validation"), "test");
  assert.strictEqual(splitFromWord("training"), "train");
});

test("manifest: CSV with quotes, roles guessed, typed labels, partial labels", () => {
  const csv = "﻿id,image,caption,split,is_fall,people,count,room\n" +
    "1,img/a.png,\"A long, quoted caption with \"\"quotes\"\" that goes on and on and on for a while\",train,1,2,3,A1\n" +
    "2,img/b.png,\"Another long caption text that is definitely longer than sixty characters ok\",test,0,1,,B2\n" +
    "3,img/c.jpg,short,val,,3+,5,C3\n";
  const parsed = manifest.parseManifest(csv, "labels.csv");
  assert.deepStrictEqual(parsed.columns, ["id", "image", "caption", "split", "is_fall", "people", "count", "room"]);
  assert.strictEqual(parsed.rows[0].caption, "A long, quoted caption with \"quotes\" that goes on and on and on for a while");
  const roles = manifest.guessRoles(parsed.columns, parsed.rows);
  assert.strictEqual(roles.id.role, "id");
  assert.strictEqual(roles.image.role, "file");
  assert.strictEqual(roles.split.role, "split");
  assert.strictEqual(roles.is_fall.type, "binary");
  roles.count = { role: "label", type: "number" };
  roles.caption = { role: "text" };
  const { fields, items } = manifest.buildItemsFromRows(parsed.rows, roles);
  const f = Object.fromEntries(fields.map((x) => [x.key, x]));
  assert.strictEqual(f.people.type, "categorical");
  assert.deepStrictEqual(f.people.classes, ["1", "2", "3+"]);
  assert.strictEqual(items[0].labels.is_fall, true);
  assert.strictEqual(items[1].labels.is_fall, false);
  assert.ok(!("is_fall" in items[2].labels)); // blank = unlabelled
  assert.strictEqual(items[0].labels.count, 3);
  assert.ok(!("count" in items[1].labels));
  assert.strictEqual(items[2].split, "test"); // val → test
  assert.strictEqual(items[0].input.fileRef, "img/a.png");
});

test("manifest: JSONL with nested records", () => {
  const jsonl = '{"id":"a","text":"hello","labels":{"intent":"greet","urgent":true}}\n{"id":"b","text":"bye","labels":{"intent":"leave","urgent":false}}\n';
  const parsed = manifest.parseManifest(jsonl, "data.jsonl");
  assert.ok(parsed.columns.includes("labels.intent"));
  const roles = manifest.guessRoles(parsed.columns, parsed.rows);
  roles.text = { role: "text" };
  const built = manifest.buildItemsFromRows(parsed.rows, roles);
  assert.deepStrictEqual(built.items[0].labels, { labels_intent: "greet", labels_urgent: true });
});

const GRIDS = path.join(LEGACY_DIR, "grids");
const RUNNERS = ["staff", "alerts", "health"].map((c) => path.join(LEGACY_DIR, `wpo_video_${c}.js`));

test("legacy grids imported through the categorizer = original buildImageList (ids + order, train and test)",
  { skip: !ORIGINAL_AVAILABLE || !fs.existsSync(GRIDS) || !RUNNERS.every((p) => fs.existsSync(p)) }, async () => {
    const storage = openStorage(GRIDS);
    const listing = await storage.listAll();
    const tree = categorizer.buildTree(listing);
    const suggestions = categorizer.suggest(tree);
    const expectedCounts = { staff: [1932, 479], alerts: [1567, 389], health: [1317, 327] };
    for (const runner of RUNNERS) {
      const cfg = legacy.importLegacyRunner(runner);
      // restrict the map to this runner's fields (what the user would tag)
      const keys = new Set(cfg.fields.map((f) => f.key));
      const map = suggestions.filter((e) => !e.tags || e.tags.every((t) => keys.has(t.class)));
      const { items } = categorizer.buildItems(listing, map, { classOrder: cfg.fields.map((f) => f.key) });
      const dir = tmpDir();
      fs.symlinkSync(GRIDS, path.join(dir, "grids"));
      const { api } = loadLegacyEngine({ categoryName: cfg.categoryName, port: 0, photosBase: "./grids", checkpointPath: path.join(dir, "cp.json"), logFile: "l", pauseFile: "p", fields: cfg.fields }, { dir, noMain: true });
      for (const [split, ours] of [["training", "train"], ["test", "test"]]) {
        const orig = api.buildImageList(split).map((x) => x.imageItem.id);
        const mine = items.filter((i) => i.split === ours).map((i) => i.id);
        assert.deepStrictEqual(mine, JSON.parse(JSON.stringify(orig)), `${cfg.categoryName} ${split}`);
      }
      assert.deepStrictEqual([items.filter((i) => i.split === "train").length, items.filter((i) => i.split === "test").length], expectedCounts[cfg.categoryName]);
    }
  });
