// Converts a Boostcamp history CSV (per-set rows) into seed-data.js for Lift Log.
// Usage: node tools/import-boostcamp.js <path-to-csv>
"use strict";
const fs = require("fs");

const csvPath = process.argv[2];
const text = fs.readFileSync(csvPath, "utf8");

/* ---- tiny CSV parser (handles quoted fields with commas) ---- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = parseCSV(text);
const header = raw[0].map(h => h.trim().toLowerCase());
const col = name => header.indexOf(name);
const rows = raw.slice(1).map(r => ({
  workout: r[col("workout")].trim(),
  date: r[col("date")].trim(),
  exercise: r[col("exercise")].trim(),
  set: parseInt(r[col("set")], 10) || 0,
  weight: r[col("weight")] === "" ? null : parseFloat(r[col("weight")]),
  unit: (r[col("unit")] || "").trim().toLowerCase() === "kg" ? "kg" : "lbs",
  reps: r[col("reps")] === "" ? null : parseInt(r[col("reps")], 10),
}));

/* ---- date disambiguation ----
   File mixes DD/MM/YY and MM/DD/YY. File is ordered newest-first, so walk
   top-to-bottom keeping a "previous date" and pick the valid candidate
   (not in the future) that is <= previous and closest to it. */
const TODAY = new Date().toISOString().slice(0, 10);
function candidates(s) {
  const [a, b, y] = s.split("/").map(Number);
  const year = 2000 + y;
  const out = [];
  const mk = (m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const iso = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso <= TODAY) out.push(iso);
  };
  mk(b, a); // DD/MM
  if (a !== b) mk(a, b); // MM/DD
  return [...new Set(out)].sort().reverse(); // newest first
}
let prev = TODAY;
const dateMap = new Map(); // raw string (in walk order) resolved per occurrence run
const resolved = [];
for (const r of rows) {
  const key = r.date;
  let iso;
  const cands = candidates(key);
  if (!cands.length) throw new Error("Unparseable date: " + key);
  iso = cands.find(c => c <= prev) || cands[cands.length - 1];
  resolved.push(iso);
  prev = iso;
}
rows.forEach((r, i) => r.iso = resolved[i]);

/* ---- exercise name aliases: Boostcamp -> Lift Log program names ---- */
const ALIAS = {
  "Bench Press (Barbell)": "Bench Press",
  "Incline Bench Press (Barbell)": "Incline Bench",
  "Incline Bench Press (Dumbbell)": "Incline DB Bench",
  "wide pull up": "Wide Pull-Up",
  "Chin-Up (Weighted)": "Chin-Up",
  "Dip (Weighted)": "Dips",
  "Squat (Barbell)": "Squat",
  "Deadlift (Barbell)": "Deadlift",
  "Romanian Deadlift (Barbell)": "Romanian Deadlift",
  "Calf Raise (Leg Press)": "Leg Press Calves",
  "Decline Sit Up (Weighted)": "Decline Sit-Up",
  "Side Bend (Dumbbell)": "Side Bend",
  "Split Jerk": "Jerk",
  "Pullover (Dumbbell)": "DB Pullover",
  "jefferson curl": "Jefferson Curl",
  "Tricep Pushdown (Cable)": "Tricep Pushdown",
  "Overhead Press (Barbell)": "Overhead Press",
  "Deadlift (Deficit)": "Deficit Deadlift",
  "Leg Curl": "Seated Leg Curl",
};

/* ---- build exercise table ---- */
let counter = 0;
const uid = () => "ex" + (++counter).toString(36).padStart(4, "0");
const byName = new Map();
function ensureEx(name) {
  if (!byName.has(name)) byName.set(name, { id: uid(), name });
  return byName.get(name).id;
}
// program exercises first so they always exist
const PROGRAM = {
  name: "My Program",
  days: [
    ["Monday", ["Hang Power Snatch", "Bench Press", "Chin-Up", "AD Press",
      "Behind-the-Neck Press (Barbell)", "@CSR", "Incline DB Bench", "DB Pullover"]],
    ["Tuesday", ["Vertical Jumps", "Hang Clean", "Hack Squat", "Deficit Deadlift",
      "Pendlay Row", "Leg Extension", "Leg Press Calves", "Side Bend"]],
    ["Thursday", ["Jerk", "Incline Bench", "Wide Pull-Up", "Dips", "Cable Row",
      "@LATRAISE", "Neck Flex/Ext"]],
    ["Friday", ["Lateral Jumps", "Power Clean", "Pin Front Squat", "Jefferson Curl",
      "Pistol Squat", "Seated Leg Curl", "Decline Sit-Up"]],
  ],
};
// most recently used variant pickers
function mostRecent(names) {
  let best = null, bestDate = "";
  for (const r of rows) {
    const final = ALIAS[r.exercise] || r.exercise;
    if (names.includes(final) && r.iso >= bestDate) { bestDate = r.iso; best = final; }
  }
  return best;
}
const PICKERS = {
  "@CSR": mostRecent(["Chest Supported Row (Dumbbell)", "Chest Supported Row (Machine)"]) || "Chest Supported Row",
  "@LATRAISE": mostRecent(["Lateral Raise (Machine)", "Lateral Raise (Cable)", "Lateral Raise (Dumbbell)"]) || "Lat Raises",
};

for (const [, names] of PROGRAM.days)
  for (const n of names) ensureEx(PICKERS[n] || n);
for (const r of rows) ensureEx(ALIAS[r.exercise] || r.exercise);

/* ---- group rows into logs: one log per (date, workout name) ---- */
const groups = new Map(); // key -> {date, name, entries: Map(exId -> sets[])}
for (const r of rows) {
  if (r.weight == null && r.reps == null) continue;
  const key = r.iso + "||" + r.workout;
  if (!groups.has(key)) groups.set(key, { date: r.iso, name: r.workout, entries: new Map() });
  const g = groups.get(key);
  const exId = ensureEx(ALIAS[r.exercise] || r.exercise);
  if (!g.entries.has(exId)) g.entries.set(exId, []);
  g.entries.get(exId).push({ set: r.set, weight: r.weight, reps: r.reps, unit: r.unit });
}
let logN = 0;
const logs = [...groups.values()]
  .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  .map(g => ({
    id: "bc" + (++logN).toString(36).padStart(4, "0"),
    date: g.date, dayId: null, dayName: g.name,
    entries: [...g.entries.entries()].map(([exerciseId, sets]) => ({
      exerciseId, swappedFromId: null,
      sets: sets.sort((a, b) => a.set - b.set).map(s => ({ weight: s.weight, reps: s.reps, unit: s.unit })),
    })),
  }));

/* ---- per-exercise unit = unit of most recent set logged ---- */
const unitOf = new Map();
for (const r of rows) {
  const exId = ensureEx(ALIAS[r.exercise] || r.exercise);
  const cur = unitOf.get(exId);
  if (!cur || r.iso >= cur.date) unitOf.set(exId, { date: r.iso, unit: r.unit });
}
for (const [name, e] of byName) {
  const u = unitOf.get(e.id);
  if (u) e.unit = u.unit;
}
// Boostcamp allows mixing units within one exercise's history; normalize every
// set to its exercise's final unit so the numbers stay comparable over time
function convertWeight(w, from, to) {
  if (w == null || from === to) return w;
  return to === "kg" ? Math.round(w / 2.2046226 * 4) / 4 : Math.round(w * 2.2046226 * 2) / 2;
}
const unitById = new Map([...byName.values()].map(e => [e.id, e.unit || "lbs"]));
let converted = 0;
for (const log of logs) for (const en of log.entries) for (const s of en.sets) {
  const target = unitById.get(en.exerciseId);
  if (s.unit !== target) { s.weight = convertWeight(s.weight, s.unit, target); converted++; }
  delete s.unit;
}
console.log("sets converted to exercise unit:", converted);

/* ---- assemble db ---- */
const dayIds = ["mon", "tue", "thu", "fri"];
const db = {
  settings: { units: "lbs" },
  exercises: [...byName.values()],
  program: {
    name: PROGRAM.name,
    days: PROGRAM.days.map(([name, items], i) => ({
      id: dayIds[i], name,
      items: items.map(n => ({ exerciseId: byName.get(PICKERS[n] || n).id, sets: 3, reps: "" })),
    })),
  },
  logs,
  draft: null,
};

fs.writeFileSync("seed-data.js",
  "// Generated by tools/import-boostcamp.js from Boostcamp history export\n" +
  "window.SEED_DB = " + JSON.stringify(db) + ";\n");

/* ---- report ---- */
console.log("exercises:", db.exercises.length);
console.log("logs:", logs.length, "| dates", logs[0].date, "to", logs[logs.length - 1].date);
console.log("total sets:", logs.reduce((n, l) => n + l.entries.reduce((m, e) => m + e.sets.length, 0), 0));
console.log("CSR pick:", PICKERS["@CSR"], "| Lat raise pick:", PICKERS["@LATRAISE"]);
const last = exName => { // show last-time for key program lifts
  const e = [...byName.values()].find(x => x.name === exName);
  for (let i = logs.length - 1; i >= 0; i--) {
    const en = logs[i].entries.find(x => x.exerciseId === e.id);
    if (en) return logs[i].date + ": " + en.sets.map(s => s.weight + "x" + s.reps).join(", ") + " " + (e.unit || "lbs");
  }
  return "(no history)";
};
for (const n of ["Bench Press", "Squat", "Jerk", "Hack Squat", "Incline Bench", "Wide Pull-Up", "Power Clean", "Seated Leg Curl"])
  console.log("last " + n + " ->", last(n));
