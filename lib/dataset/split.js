// split.js — stable train/test assignment.
// An item's split depends only on its own key (relative path / id), never on what else is in the
// dataset, so re-syncing new files never moves existing items between train and test.
"use strict";
const { sha1 } = require("./files");

const SPLIT_WORDS = {
  train: ["train", "training", "trn"],
  test: ["test", "testing", "tst", "val", "valid", "validation", "eval", "evaluation", "dev", "holdout"],
};

function splitFromWord(word) {
  const w = String(word || "").trim().toLowerCase();
  if (SPLIT_WORDS.train.includes(w)) return "train";
  if (SPLIT_WORDS.test.includes(w)) return "test";
  return null;
}

function hashSplit(key, trainRatio = 0.8, seed = "wpo") {
  if (trainRatio >= 1) return "train";
  if (trainRatio <= 0) return "test";
  const h = sha1(`${seed}:${key}`);
  const x = parseInt(h.slice(0, 8), 16) / 0x100000000;
  return x < trainRatio ? "train" : "test";
}

module.exports = { SPLIT_WORDS, splitFromWord, hashSplit };
