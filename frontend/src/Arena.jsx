import { useState, useEffect, useRef, useCallback } from "react";
import { gameAudio } from "./audio.js";
import Arena3D from "./Arena3D.jsx";

const API = "/api";

const SPECIES_COLORS = {
  ironjaw: "#5B8FA8",
  razorwing: "#DC143C",
  embercaster: "#FF8C00",
  warden: "#DAA520",
  hexwright: "#8A2BE2",
};

const SPECIES_ICONS = {
  ironjaw: "🦷",
  razorwing: "🦅",
  embercaster: "🔥",
  warden: "🛡️",
  hexwright: "⬡",
};

const SPECIES_ROLES = {
  ironjaw: "Bulwark",
  razorwing: "Diver",
  embercaster: "Artillery",
  warden: "Anchor",
  hexwright: "Disruptor",
};

const SPECIES_BORDER_COLORS = {
  ironjaw: "#4488cc",
  razorwing: "#cc2222",
  embercaster: "#ff6622",
  warden: "#ddaa22",
  hexwright: "#8844cc",
};

const CREATURE_IMAGES = {
  ironjaw: { lg: "/creatures/ironjaw-lg.png", md: "/creatures/ironjaw-md.png", sm: "/creatures/ironjaw-sm.png", full: "/creatures/ironjaw.png" },
  razorwing: { lg: "/creatures/razorwing-lg.png", md: "/creatures/razorwing-md.png", sm: "/creatures/razorwing-sm.png", full: "/creatures/razorwing.png" },
  embercaster: { lg: "/creatures/embercaster-lg.png", md: "/creatures/embercaster-md.png", sm: "/creatures/embercaster-sm.png", full: "/creatures/embercaster.png" },
  warden: { lg: "/creatures/warden-lg.png", md: "/creatures/warden-md.png", sm: "/creatures/warden-sm.png", full: "/creatures/warden.png" },
  hexwright: { lg: "/creatures/hexwright-lg.png", md: "/creatures/hexwright-md.png", sm: "/creatures/hexwright-sm.png", full: "/creatures/hexwright.png" },
};

// Hex grid layout (axial coords, radius 2, 19 hexes)
const BOARD_RADIUS = 2;
const ALL_HEXES = [];
for (let q = -BOARD_RADIUS; q <= BOARD_RADIUS; q++) {
  for (let r = -BOARD_RADIUS; r <= BOARD_RADIUS; r++) {
    if (Math.abs(q + r) <= BOARD_RADIUS) ALL_HEXES.push([q, r]);
  }
}

const RED_GATE = [1, -2];
const BLUE_GATE = [-1, 2];

function hexKey(q, r) { return `${q},${r}`; }
function hexDist(a, b) {
  const dq = a[0] - b[0], dr = a[1] - b[1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

function getActionDescription(event, creatures) {
  if (!event || !creatures) return null;
  const find = (id) => creatures.find(c => c.id === id);
  const tag = (c) => {
    if (!c) return "";
    // Pilot name is the primary identifier; the Guardian species is secondary (P2).
    if (c.agent_name) {
      const sp = (c.species || "");
      return `${c.agent_name.toUpperCase()}${sp ? ` (${sp.charAt(0).toUpperCase()}${sp.slice(1)})` : ""}`;
    }
    const temp = c.temperament ? `${c.temperament} ` : "";
    return `${temp}${(c.species || "").toUpperCase()}`;
  };

  if (event.type === "round_start") {
    return { text: `— ROUND ${event.data?.round || event.round} —`, style: "round" };
  }
  if (event.type === "intent") {
    const action = event.data?.action;
    if (!action) return null;
    const actor = find(event.creature_id);
    if (!actor) return null;
    const teamColor = actor.team === "red" ? "#e74c3c" : "#3498db";
    if (action.target_id) {
      const target = find(action.target_id);
      return { text: `${tag(actor)} targeting ${tag(target)}`, style: "intent", color: teamColor };
    }
    if (action.move_to) return { text: `${tag(actor)} advancing...`, style: "intent", color: teamColor };
    return { text: `${tag(actor)} preparing...`, style: "intent", color: teamColor };
  }
  if (event.type === "activation") {
    const r = event.data?.result;
    if (!r) return null;
    const action = r.action;
    const actor = find(action.creature_id);
    const teamColor = actor?.team === "red" ? "#e74c3c" : "#3498db";
    if (r.target_killed) {
      const target = find(action.target_id);
      return { text: `${tag(actor)} ELIMINATES ${tag(target)}`, style: "kill", color: "#ff4444" };
    }
    if (r.damage_dealt > 0) {
      const target = find(action.target_id);
      return { text: `${tag(actor)} hits ${tag(target)} — ${r.damage_dealt} DMG`, style: "damage", color: "#e74c3c" };
    }
    const t = action.type;
    if (t === "channel") {
      const meter = r.breach_meter_value || 0;
      const bColor = actor?.team === "red" ? "#e74c3c" : "#3498db";
      if (meter >= 3) return { text: `${tag(actor)} ONE TURN FROM BREACH!`, style: "amplified", color: bColor };
      if (meter >= 2) return { text: `${tag(actor)} CHANNELING... ${meter}/4`, style: "channel", color: bColor };
      return { text: `${tag(actor)} BEGINS BREACH CHANNEL`, style: "channel", color: bColor };
    }
    if (t === "blast") {
      const target = find(action.target_id);
      const splashCount = r.splash_damage ? Object.keys(r.splash_damage).length : 0;
      const splashText = splashCount > 0 ? ` (+${splashCount} splash)` : "";
      return { text: `${tag(actor)} BLASTS ${tag(target)}${splashText}`, style: "damage", color: "#FF8C00" };
    }
    if (t === "bulwark_pulse") return { text: `${tag(actor)} SHIELDS ALLIES`, style: "shield", color: "#f1c40f" };
    if (t === "glitch") return { text: `${tag(actor)} STUNS ${tag(find(action.target_id))}`, style: "stun", color: "#8A2BE2" };
    if (t === "displace") return { text: `${tag(actor)} SHOVES ${tag(find(action.target_id))}`, style: "displace", color: "#8A2BE2" };
    if (t === "move") return { text: `${tag(actor)} repositions`, style: "move", color: teamColor };
    if (t === "hold") return { text: `${tag(actor)} holds position`, style: "hold", color: "#4a5568" };
    return { text: `${tag(actor)} ${t.toUpperCase()}`, style: "default", color: teamColor };
  }
  if (event.type === "breach_denied") {
    const denied = creatures?.find(c => c.id === event.creature_id);
    return { text: `DENIED! ${tag(denied)} thrown off the brink.`, style: "amplified", color: "#e74c3c" };
  }
  if (event.type === "breach_complete") {
    const breacher = creatures?.find(c => c.id === event.creature_id);
    const team = event.data?.team?.toUpperCase() || "";
    return { text: `${tag(breacher)} breaks through! ${team} WINS BY GATE BREACH!`, style: "amplified", color: "#2ecc71" };
  }
  if (event.type === "breach_start") {
    const ch = creatures?.find(c => c.id === event.creature_id);
    const bColor = ch?.team === "red" ? "#e74c3c" : "#3498db";
    return { text: `${tag(ch)} INITIATES BREACH CHANNEL`, style: "amplified", color: bColor };
  }
  if (EVENT_LABELS[event.type]) {
    const color = EVENT_COLORS[event.type] || "#ffd700";
    return { text: EVENT_LABELS[event.type], style: "amplified", color };
  }
  return null;
}

// Temperament colors (match personality vibe)
const TEMPERAMENT_COLORS = {
  BERSERKER:  "#ff3333",
  HEADHUNTER: "#ff6600",
  STALKER:    "#9966ff",
  TURTLE:     "#33aaff",
  MARTYR:     "#33cc77",
  TACTICIAN:  "#ffcc00",
  ADAPTIVE:   "#8892a0",
};

const TEMPERAMENT_ICONS = {
  BERSERKER:  "⚔",
  HEADHUNTER: "🎯",
  STALKER:    "🗡",
  TURTLE:     "🛡",
  MARTYR:     "✝",
  TACTICIAN:  "♟",
  ADAPTIVE:   "◈",
};

// Temperament-keyed epitaph for a fallen Pilot on the post-match card (P2 §6.6).
const EPITAPHS = {
  BERSERKER:  "Charged the gate and never looked back.",
  HEADHUNTER: "Found the target. Couldn't escape the aftermath.",
  STALKER:    "Stayed in the shadows one turn too long.",
  TURTLE:     "The wall held. The wall fell.",
  MARTYR:     "Died so the others could push.",
  TACTICIAN:  "Played it perfectly. Almost.",
  ADAPTIVE:   "Adapted to everything except the end.",
};

// Friendly label for a slider driver-word (post-match attribution).
const DRIVER_LABEL = {
  aggression: "AGGRESSION", risk_tolerance: "RISK", target_focus: "FOCUS",
  positioning: "POSITIONING", sacrifice: "SACRIFICE",
};

// Client-side temperament derivation (mirrors backend/arena_species.py)
const SLIDER_HIGH = 65;
const SLIDER_LOW = 35;

function deriveTemperament(aggression, risk_tolerance, target_focus, positioning, sacrifice) {
  const hAgg = aggression >= SLIDER_HIGH;
  const lAgg = aggression <= SLIDER_LOW;
  const lRisk = risk_tolerance <= SLIDER_LOW;
  const hFocus = target_focus >= SLIDER_HIGH;
  const hPos = positioning >= SLIDER_HIGH;
  const hSac = sacrifice >= SLIDER_HIGH;

  if (hAgg && lRisk) return "BERSERKER";
  if (hAgg && hFocus) return "HEADHUNTER";
  if (lAgg && hFocus && hSac) return "STALKER";
  if (hPos && lAgg) return "TURTLE";
  if (hSac && lRisk) return "MARTYR";
  if (hPos && hFocus) return "TACTICIAN";
  return "ADAPTIVE";
}

// ===================== IDENTITY FORGE =====================
// Point-budget sculpting, live naming, and the radar silhouette. The agent is
// the pilot the player authors; the species/chassis is just the body.

const ARENA_BUDGET = 200;
const SLIDER_MIN = 5;
const SLIDER_MAX = 80;
const BUDGET_SLIDERS = ["aggression", "risk_tolerance", "target_focus", "positioning", "sacrifice"];

// Friendly words for the "GAVE UP" sacrifice line.
const SLIDER_WORD = {
  aggression: "aggression", risk_tolerance: "risk", target_focus: "focus",
  positioning: "positioning", sacrifice: "sacrifice",
};

// Slider row metadata. Order == BUDGET_SLIDERS == radar axis order.
const SLIDER_META = [
  { key: "aggression",     label: "AGG", abbr: "A", color: "#e74c3c" },
  { key: "risk_tolerance", label: "RSK", abbr: "R", color: "#e67e22" },
  { key: "target_focus",   label: "FOC", abbr: "F", color: "#f1c40f" },
  { key: "positioning",    label: "POS", abbr: "P", color: "#3498db" },
  { key: "sacrifice",      label: "SAC", abbr: "S", color: "#2ecc71" },
];

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// Mirrors backend ai.suggest_names() pools, re-keyed to arena slider names via the
// spec mapping (target_focus->king_priority, positioning->edge_affinity,
// sacrifice->trade_down). Adjective from the dominant slider, noun from the 2nd.
const ADJ_POOLS = {
  aggression:     ["Reckless", "Savage", "Furious", "Relentless", "Vicious"],
  risk_tolerance: ["Bold", "Fearless", "Daring", "Wild", "Rogue"],
  target_focus:   ["Crowned", "Royal", "Ascending", "Noble", "Imperial"],
  positioning:    ["Fortified", "Walled", "Flanking", "Guarded", "Anchored"],
  sacrifice:      ["Grinding", "Patient", "Calculated", "Ruthless", "Efficient"],
};
const NOUN_POOLS = {
  aggression:     ["Striker", "Raider", "Blitz", "Fang", "Storm"],
  risk_tolerance: ["Gambit", "Maverick", "Drifter", "Ace", "Phantom"],
  target_focus:   ["Crown", "Monarch", "Regent", "Ascent", "Throne"],
  positioning:    ["Sentinel", "Bastion", "Wall", "Keep", "Rampart"],
  sacrifice:      ["Grinder", "Vise", "Strangler", "Anvil", "Press"],
};

// Deterministic 3 name suggestions for a build (no RNG, so the UI doesn't jitter).
function suggestNames(sliders) {
  const sorted = BUDGET_SLIDERS.map(k => [k, sliders[k] ?? 50]).sort((a, b) => b[1] - a[1]);
  const adjs = ADJ_POOLS[sorted[0][0]];
  const nouns = NOUN_POOLS[sorted[1][0]];
  return [0, 1, 2].map(i => `${adjs[i % adjs.length]} ${nouns[i % nouns.length]}`);
}

// The two lowest sliders -> e.g. ["positioning", "focus"].
function sacrificeWords(sliders) {
  return BUDGET_SLIDERS.map(k => [k, sliders[k] ?? 50])
    .sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k]) => SLIDER_WORD[k]);
}

// Raise/lower `key` toward `requested`, keeping sum == 250 and every slider in
// [10,90]. Drains/refills the OTHER unlocked sliders proportionally to headroom.
// Returns the new set, the signed change per other slider (for cost ticks), and
// how far `key` actually moved (0 == hit the wall).
function redistribute(sliders, key, requested, locks = {}) {
  const cur = {};
  BUDGET_SLIDERS.forEach(k => { cur[k] = sliders[k] ?? 50; });
  requested = clampInt(requested, SLIDER_MIN, SLIDER_MAX);
  const delta = requested - cur[key];
  if (delta === 0) return { sliders: cur, drains: {}, moved: 0 };

  const others = BUDGET_SLIDERS.filter(k => k !== key && !locks[k]);
  const headroom = (k) => delta > 0 ? (cur[k] - SLIDER_MIN) : (SLIDER_MAX - cur[k]);
  const pool = others.reduce((s, k) => s + headroom(k), 0);
  const movable = Math.min(Math.abs(delta), pool);
  if (movable <= 0) return { sliders: cur, drains: {}, moved: 0 };

  const dir = delta > 0 ? 1 : -1;   // direction key moves
  const odir = -dir;                // others move opposite
  cur[key] += dir * movable;

  const drains = {};
  const shares = others.map(k => {
    const raw = movable * headroom(k) / pool;
    return { k, raw, base: Math.floor(raw) };
  });
  let remaining = movable;
  shares.forEach(s => { drains[s.k] = odir * s.base; remaining -= s.base; });
  shares.sort((a, b) => (b.raw - b.base) - (a.raw - a.base));
  let i = 0;
  while (remaining > 0 && i < shares.length * 5) {
    const s = shares[i % shares.length];
    if (Math.abs(drains[s.k]) < headroom(s.k)) { drains[s.k] += odir; remaining -= 1; }
    i++;
  }
  others.forEach(k => { cur[k] += (drains[k] || 0); });
  BUDGET_SLIDERS.forEach(k => { cur[k] = clampInt(cur[k], SLIDER_MIN, SLIDER_MAX); });
  return { sliders: cur, drains, moved: movable };
}

// Shape-preserving normalization to the 250 budget (carryover / re-attunement).
function normalizeBudget(sliders, locks = {}) {
  const cur = {};
  BUDGET_SLIDERS.forEach(k => { cur[k] = clampInt(sliders[k] ?? 50, SLIDER_MIN, SLIDER_MAX); });
  const adjustable = BUDGET_SLIDERS.filter(k => !locks[k]);
  for (let iter = 0; iter < 60; iter++) {
    const diff = ARENA_BUDGET - BUDGET_SLIDERS.reduce((s, k) => s + cur[k], 0);
    if (diff === 0) break;
    const dir = diff > 0 ? 1 : -1;
    const headroom = (k) => dir > 0 ? (SLIDER_MAX - cur[k]) : (cur[k] - SLIDER_MIN);
    const pool = adjustable.reduce((s, k) => s + headroom(k), 0);
    if (pool <= 0) break;
    const move = Math.min(Math.abs(diff), pool);
    const shares = adjustable.map(k => {
      const raw = move * headroom(k) / pool;
      return { k, raw, base: Math.floor(raw) };
    });
    let remaining = move;
    shares.forEach(s => { cur[s.k] += dir * s.base; remaining -= s.base; });
    shares.sort((a, b) => (b.raw - b.base) - (a.raw - a.base));
    let j = 0;
    while (remaining > 0 && j < shares.length * 5) {
      const s = shares[j % shares.length];
      if (dir > 0 ? cur[s.k] < SLIDER_MAX : cur[s.k] > SLIDER_MIN) { cur[s.k] += dir; remaining -= 1; }
      j++;
    }
    BUDGET_SLIDERS.forEach(k => { cur[k] = clampInt(cur[k], SLIDER_MIN, SLIDER_MAX); });
  }
  return cur;
}

// 7 budget-legal archetype presets (each sums to 250 and derives to its name).
// Budget-legal archetype presets (each sums to 200, each in [5,80], each derives
// to its temperament under thresholds HIGH=65 / LOW=35).
const PRESETS = [
  { temperament: "BERSERKER",  sliders: { aggression: 80, risk_tolerance: 5,  target_focus: 40, positioning: 40, sacrifice: 35 } },
  { temperament: "HEADHUNTER", sliders: { aggression: 75, risk_tolerance: 40, target_focus: 70, positioning: 10, sacrifice: 5  } },
  { temperament: "STALKER",    sliders: { aggression: 5,  risk_tolerance: 35, target_focus: 70, positioning: 20, sacrifice: 70 } },
  { temperament: "TURTLE",     sliders: { aggression: 5,  risk_tolerance: 35, target_focus: 40, positioning: 80, sacrifice: 40 } },
  { temperament: "MARTYR",     sliders: { aggression: 40, risk_tolerance: 5,  target_focus: 40, positioning: 40, sacrifice: 75 } },
  { temperament: "TACTICIAN",  sliders: { aggression: 40, risk_tolerance: 15, target_focus: 70, positioning: 70, sacrifice: 5  } },
  { temperament: "ADAPTIVE",   sliders: { aggression: 40, risk_tolerance: 40, target_focus: 40, positioning: 40, sacrifice: 40 } },
];

// Build a fully-formed draft creature, budget-legal, with an auto-derived name.
function mkCreature(species, sliders, extra = {}) {
  const s = normalizeBudget(sliders);
  return { species, ...s, agent_id: null, name: suggestNames(s)[0], nameAuto: true, nameIdx: 0, locks: {}, ...extra };
}

// Pentagon vertex angles: AGG top, then clockwise RSK, FOC, POS, SAC.
const RADAR_ANGLES = BUDGET_SLIDERS.map((_, i) => (-90 + i * 72) * Math.PI / 180);

// The radar silhouette — one visual language across create / watch / results.
function RadarChart({ sliders, color, size = 116, showAxes = true }) {
  const cx = size / 2, cy = size / 2, R = size * 0.40;
  const vert = (val, i) => {
    const r = (clampInt(val ?? 0, 0, 100) / 100) * R;
    return [cx + r * Math.cos(RADAR_ANGLES[i]), cy + r * Math.sin(RADAR_ANGLES[i])];
  };
  const poly = BUDGET_SLIDERS.map((k, i) => vert(sliders[k], i).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      {showAxes && (
        <g>
          {[0.34, 0.67, 1].map((f, ri) => (
            <polygon key={ri} fill="none" stroke="#21262d" strokeWidth={1}
              points={BUDGET_SLIDERS.map((_, i) => [cx + R * f * Math.cos(RADAR_ANGLES[i]), cy + R * f * Math.sin(RADAR_ANGLES[i])].join(",")).join(" ")} />
          ))}
          {BUDGET_SLIDERS.map((k, i) => {
            const ex = cx + R * Math.cos(RADAR_ANGLES[i]), ey = cy + R * Math.sin(RADAR_ANGLES[i]);
            const lx = cx + (R + size * 0.085) * Math.cos(RADAR_ANGLES[i]);
            const ly = cy + (R + size * 0.085) * Math.sin(RADAR_ANGLES[i]);
            return (
              <g key={k}>
                <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="#21262d" strokeWidth={1} />
                <text x={lx} y={ly} fill="#4a5568" fontSize={size * 0.08} fontWeight={700}
                  textAnchor="middle" dominantBaseline="central">{SLIDER_META[i].abbr}</text>
              </g>
            );
          })}
        </g>
      )}
      <polygon points={poly} fill={color} fillOpacity={0.18} stroke={color}
        strokeWidth={showAxes ? 1.5 : 1} strokeLinejoin="round" />
    </svg>
  );
}

// 16px emblem = the build's radar pentagon, miniaturized. The agent's chip mark.
function Sigil({ sliders, color, size = 16 }) {
  return <RadarChart sliders={sliders} color={color} size={size} showAxes={false} />;
}

// Event type display
const EVENT_LABELS = {
  kill: "ELIMINATED",
  double_kill: "DOUBLE KILL",
  double_ko: "DOUBLE KO",
  breach_start: "BREACH ATTEMPT",
  breach_complete: "GATE BREACH",
  breach_denied: "BREACH DENIED",
  last_stand: "LAST STAND",
  last_stand_kill: "AGAINST THE ODDS",
  last_stand_victory: "LAST STAND VICTORY",
  collapse: "THE ARENA IS COLLAPSING",
  collapse_kill: "CLAIMED BY THE VOID",
  ring_out: "RING OUT",
  provoke: "PROVOKE",
  swoop: "SWOOP",
  blast: "BLAST",
  aegis: "AEGIS",
  bulwark_pulse: "BULWARK PULSE",
  displace: "DISPLACE",
  glitch: "GLITCH",
};

const EVENT_COLORS = {
  kill: "#e74c3c",
  double_kill: "#ff8c00",
  double_ko: "#e74c3c",
  breach_start: "#f39c12",
  breach_complete: "#2ecc71",
  breach_denied: "#e74c3c",
  last_stand: "#ffd700",
  last_stand_kill: "#ffd700",
  last_stand_victory: "#ffd700",
  collapse: "#8b0000",
  collapse_kill: "#8b0000",
  ring_out: "#e67e22",
  provoke: "#5B8FA8",
  swoop: "#DC143C",
  blast: "#FF8C00",
  aegis: "#DAA520",
  bulwark_pulse: "#f1c40f",
  displace: "#8A2BE2",
  glitch: "#8A2BE2",
};

// Collapse starts at round 9, 4 hexes per round
const COLLAPSE_START_ROUND = 9;
const COLLAPSE_HEXES_PER_ROUND = 4;
// Sorted spiral order (same as backend)
const COLLAPSE_RING = ALL_HEXES
  .filter(([q, r]) => !(q === 0 && r === 0))
  .sort((a, b) => {
    const da = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[0] + a[1]));
    const db = Math.max(Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[0] + b[1]));
    if (db !== da) return db - da;
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0] - b[0];
  });

function getCollapseWarningHexes(roundNum, voidedSet) {
  if (roundNum < COLLAPSE_START_ROUND - 1) return [];
  const nextCollapseRound = roundNum < COLLAPSE_START_ROUND ? COLLAPSE_START_ROUND : roundNum + 1;
  const idx = nextCollapseRound - COLLAPSE_START_ROUND;
  const start = idx * COLLAPSE_HEXES_PER_ROUND;
  const end = start + COLLAPSE_HEXES_PER_ROUND;
  return COLLAPSE_RING.slice(start, end)
    .filter(h => !voidedSet.has(hexKey(h[0], h[1])))
    .map(h => hexKey(h[0], h[1]));
}

// Detect ability type from activation event
function getAbilityType(event) {
  if (event?.type !== "activation") return null;
  const r = event.data?.result;
  if (!r) return null;
  const t = r.action?.type;
  if (t === "attack" && r.action?.creature_id) {
    const species = event._creatureSpecies;
    if (species === "razorwing" && r.effects?.includes("swoop")) return "swoop";
    if (species === "embercaster" && (r.splash_damage && Object.keys(r.splash_damage).length > 0)) return "blast";
  }
  if (t === "bulwark_pulse") return "bulwark_pulse";
  if (t === "glitch") return "glitch";
  if (t === "displace") return "displace";
  if (t === "channel") return "channel";
  return null;
}

// ----- ARENA CSS ANIMATIONS -----

const ARENA_STYLES = `
  @keyframes bannerSlideIn {
    0% { transform: scaleX(0); opacity: 0; }
    30% { transform: scaleX(1.05); opacity: 1; }
    100% { transform: scaleX(1); opacity: 1; }
  }
  @keyframes bannerFadeOut {
    0% { opacity: 1; }
    100% { opacity: 0; transform: translateY(-8px); }
  }
  @keyframes floatUp {
    0% { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-30px); }
  }
  @keyframes hexCrack {
    0%, 60% { stroke-dashoffset: 40; opacity: 0.3; }
    100% { stroke-dashoffset: 0; opacity: 0.8; }
  }
  @keyframes hexWarningPulse {
    0%, 100% { stroke: #8b000066; stroke-width: 1.5; }
    50% { stroke: #ff000088; stroke-width: 2.5; }
  }
  @keyframes voidEdgeGlow {
    0%, 100% { stroke: #1a0000; stroke-width: 1; }
    50% { stroke: #44000088; stroke-width: 1.5; }
  }
  @keyframes provokeRingExpand {
    0% { r: 5; opacity: 0.8; stroke-width: 3; }
    100% { r: 45; opacity: 0; stroke-width: 0.5; }
  }
  @keyframes blastExpand {
    0% { r: 5; opacity: 0.7; }
    100% { r: 55; opacity: 0; }
  }
  @keyframes shieldBubble {
    0% { r: 5; opacity: 0.8; stroke-width: 3; }
    60% { r: 40; opacity: 0.5; stroke-width: 2; }
    100% { r: 45; opacity: 0; stroke-width: 0.5; }
  }
  @keyframes glitchFlicker {
    0%, 20%, 40%, 60%, 80%, 100% { opacity: 1; }
    10%, 30%, 50%, 70%, 90% { opacity: 0.2; }
  }
  @keyframes displaceWave {
    0% { opacity: 0.8; stroke-dashoffset: 0; }
    100% { opacity: 0; stroke-dashoffset: -20; }
  }
  @keyframes decayPulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 0.2; }
  }
  @keyframes shatterOut {
    0% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(1.15); }
    100% { opacity: 0; transform: scale(0.3); }
  }
  @keyframes lastStandSpotlight {
    0% { opacity: 0; r: 10; }
    50% { opacity: 0.25; r: 50; }
    100% { opacity: 0; r: 60; }
  }
  .arena-hex-warning { animation: hexWarningPulse 1s ease-in-out infinite; }
  .arena-void-edge { animation: voidEdgeGlow 2s ease-in-out infinite; }
  .arena-provoke-ring { animation: provokeRingExpand 0.8s ease-out forwards; }
  .arena-blast-ring { animation: blastExpand 0.6s ease-out forwards; }
  .arena-shield-ring { animation: shieldBubble 0.8s ease-out forwards; }
  .arena-glitch-target { animation: glitchFlicker 0.4s step-end 2; }
  .arena-decay-body { animation: decayPulse 2s ease-in-out infinite; }
  @keyframes breachRingPulse {
    0%, 100% { stroke-opacity: 0.8; stroke-width: 3; }
    50% { stroke-opacity: 0.4; stroke-width: 2.5; }
  }
  .arena-breach-ring { animation: breachRingPulse 1.5s ease-in-out infinite; }
  @keyframes breachRingUrgent {
    0%, 100% { stroke-opacity: 1; stroke-width: 3.5; }
    50% { stroke-opacity: 0.5; stroke-width: 2.5; }
  }
  .arena-breach-ring-urgent { animation: breachRingUrgent 0.6s ease-in-out infinite; }
  @keyframes breachGateGlow {
    0%, 100% { opacity: 0.12; }
    50% { opacity: 0.28; }
  }
  .arena-breach-gate-glow { animation: breachGateGlow 2s ease-in-out infinite; }
  @keyframes tempPop {
    0% { transform: scale(1); }
    40% { transform: scale(1.32); }
    100% { transform: scale(1); }
  }
  @keyframes costTick {
    0% { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-18px); }
  }
  @keyframes wallFlash {
    0% { opacity: 0.9; }
    100% { opacity: 0; }
  }
  @keyframes summonTitle { 0% { opacity: 0; letter-spacing: 2px; } 100% { opacity: 1; letter-spacing: 6px; } }
  @keyframes summonName { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
  @keyframes summonBar { 0% { transform: scaleX(1); } 100% { transform: scaleX(0); } }
`;

// ----- AMPLIFIED BANNER OVERLAY -----

function AmplifiedBanner({ banner }) {
  if (!banner) return null;
  const color = EVENT_COLORS[banner.type] || "#ffd700";
  const label = banner.label || EVENT_LABELS[banner.type] || banner.type;
  const isLarge = ["last_stand", "last_stand_victory", "double_kill", "double_ko",
    "breach_complete", "collapse", "bulwark_pulse"].includes(banner.type);

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      pointerEvents: "none", zIndex: 20,
    }}>
      {/* Backdrop flash */}
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(ellipse at center, ${color}15 0%, transparent 70%)`,
      }} />
      {/* Banner text */}
      <div style={{
        fontSize: isLarge ? 18 : 13, fontWeight: 900, letterSpacing: isLarge ? 5 : 3,
        color, textShadow: `0 0 20px ${color}88, 0 0 40px ${color}44`,
        animation: "bannerSlideIn 0.3s ease-out",
        padding: "6px 20px", borderTop: `2px solid ${color}66`, borderBottom: `2px solid ${color}66`,
        background: `linear-gradient(90deg, transparent, ${color}0a, transparent)`,
      }}>
        {label}
      </div>
      {/* Subtext */}
      {banner.sub && (
        <div style={{
          fontSize: 8, color: `${color}aa`, letterSpacing: 2, marginTop: 4,
          animation: "bannerSlideIn 0.4s ease-out",
        }}>
          {banner.sub}
        </div>
      )}
      {/* Floating stat text (for Last Stand buffs) */}
      {banner.floats && banner.floats.map((f, i) => (
        <div key={i} style={{
          fontSize: 10, fontWeight: 700, color: "#ffd700",
          animation: `floatUp 1.5s ease-out ${i * 0.2}s forwards`,
          marginTop: 4,
        }}>
          {f}
        </div>
      ))}
    </div>
  );
}

// ----- CREATURE DRAFT -----

function CreaturePortrait({ species, size, selected, style: extraStyle, px: pxOverride }) {
  const borderColor = SPECIES_BORDER_COLORS[species] || "#444";
  const src = size === "lg" ? CREATURE_IMAGES[species]?.lg
    : size === "sm" ? CREATURE_IMAGES[species]?.sm
    : CREATURE_IMAGES[species]?.md;
  const px = pxOverride || (size === "lg" ? 64 : size === "sm" ? 32 : 48);
  const radius = size === "lg" ? 12 : "50%";
  return (
    <div style={{
      width: px, height: px, borderRadius: radius, overflow: "hidden",
      border: `2px solid ${selected ? borderColor : borderColor + "66"}`,
      boxShadow: selected ? `0 0 12px ${borderColor}88, 0 0 4px ${borderColor}44` : `0 0 6px ${borderColor}33`,
      background: "#0a0a0a", flexShrink: 0, transition: "all 0.2s ease",
      ...extraStyle,
    }}>
      <img src={src} alt={species} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  );
}

// One agent card — the Identity Forge. Owns its own ephemeral UI (cost ticks,
// wall flash, temperament pop, debounced naming). Emits the full updated
// creature object via onChange.
function AgentCard({ creature, color, onChange, onRemove, speciesList, agents, lockSpecies = false, lockRoster = false, benchedIds = [] }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [ticks, setTicks] = useState([]);
  const [walledSlider, setWalledSlider] = useState(null);
  const [wallKey, setWallKey] = useState(0);
  const [tempPop, setTempPop] = useState(0);
  const tickId = useRef(0);
  const prevTemp = useRef(null);

  const sliders = {
    aggression: creature.aggression, risk_tolerance: creature.risk_tolerance,
    target_focus: creature.target_focus, positioning: creature.positioning, sacrifice: creature.sacrifice,
  };
  const locks = creature.locks || {};
  const hasAgent = !!creature.agent_id;
  const temp = deriveTemperament(sliders.aggression, sliders.risk_tolerance, sliders.target_focus, sliders.positioning, sliders.sacrifice);
  const accent = TEMPERAMENT_COLORS[temp] || "#8892a0";
  const info = speciesList.find(s => s.id === creature.species);
  const gaveUp = sacrificeWords(sliders);
  const displayName = creature.name || suggestNames(sliders)[0];
  const total = BUDGET_SLIDERS.reduce((s, k) => s + (sliders[k] ?? 0), 0);
  // Upgrade tiers are gated by the controlling Pilot's level (P7 §4). A custom
  // (unsaved) Pilot is level 1; a saved Pilot uses its stored level.
  const pilotLevel = hasAgent ? (agents.find(a => a.id === creature.agent_id)?.level || 1) : 1;
  const upgrades = info?.upgrades || [];

  // Handlers read the latest committed creature (not the render closure) so that
  // rapid synchronous edits — e.g. locking two sliders in one tick — compose
  // correctly instead of clobbering each other.
  const latest = useRef(creature);
  latest.current = creature;
  const emit = (next) => { latest.current = next; onChange(next); };
  const pickSliders = (c) => ({
    aggression: c.aggression, risk_tolerance: c.risk_tolerance,
    target_focus: c.target_focus, positioning: c.positioning, sacrifice: c.sacrifice,
  });

  // Temperament change -> scale-pop + rising chime (skip first mount).
  useEffect(() => {
    if (prevTemp.current !== null && prevTemp.current !== temp) {
      setTempPop(p => p + 1);
      gameAudio.playTemperamentChime();
    }
    prevTemp.current = temp;
  }, [temp]);

  // Default the equipped upgrade to the highest tier the Pilot's level unlocks
  // (re-defaults when the Guardian species or controlling Pilot changes).
  useEffect(() => {
    const ups = (speciesList.find(s => s.id === creature.species)?.upgrades) || [];
    if (!ups.length) return;
    const valid = creature.upgrade && ups.some(u => u.key === creature.upgrade && u.level <= pilotLevel);
    if (valid) return;
    const unlocked = ups.filter(u => u.level <= pilotLevel);
    const best = unlocked.length ? unlocked[unlocked.length - 1].key : null;
    if (best !== (creature.upgrade ?? null)) emit({ ...latest.current, upgrade: best });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creature.species, pilotLevel, speciesList.length]);

  // Debounced live name suggestion while in auto mode.
  useEffect(() => {
    if (creature.nameAuto === false || hasAgent) return;
    const t = setTimeout(() => {
      const c = latest.current;
      const nm = suggestNames(pickSliders(c))[(c.nameIdx || 0) % 3];
      if (nm !== c.name) emit({ ...c, name: nm });
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sliders.aggression, sliders.risk_tolerance, sliders.target_focus, sliders.positioning, sliders.sacrifice, creature.nameAuto, creature.nameIdx, hasAgent]);

  const spawnTicks = (drains) => {
    const fresh = Object.entries(drains).filter(([, v]) => v !== 0)
      .map(([key, amount]) => ({ id: ++tickId.current, key, amount }));
    if (!fresh.length) return;
    setTicks(prev => [...prev, ...fresh]);
    setTimeout(() => {
      const ids = new Set(fresh.map(f => f.id));
      setTicks(prev => prev.filter(t => !ids.has(t.id)));
    }, 600);
  };

  const onSlider = (key, requested) => {
    const c = latest.current;
    if ((c.locks && c.locks[key]) || c.agent_id) return;
    const { sliders: next, drains, moved } = redistribute(pickSliders(c), key, requested, c.locks || {});
    if (moved === 0) {              // hit the wall — snap back (value unchanged) + flash + thunk
      setWalledSlider(key); setWallKey(k => k + 1);
      gameAudio.playWallThunk();
      return;
    }
    spawnTicks(drains);
    emit({ ...c, ...next });
  };

  const toggleLock = (key) => {
    const c = latest.current;
    if (c.agent_id) return;
    const cur = { ...(c.locks || {}) };
    if (cur[key]) delete cur[key];
    else { if (Object.values(cur).filter(Boolean).length >= 3) return; cur[key] = true; }
    emit({ ...c, locks: cur });
  };

  const rollName = () => {
    const c = latest.current;
    const idx = ((c.nameIdx || 0) + 1) % 3;
    emit({ ...c, nameAuto: true, nameIdx: idx, name: suggestNames(pickSliders(c))[idx] });
  };

  const editName = (v) => { const c = latest.current; emit({ ...c, name: v, nameAuto: false }); };

  const assignAgent = (val) => {
    const c = latest.current;
    if (!val) { emit({ ...c, agent_id: null, nameAuto: true, name: suggestNames(pickSliders(c))[c.nameIdx || 0] }); return; }
    const agent = agents.find(a => a.id === parseInt(val));
    if (!agent) return;
    const norm = normalizeBudget({
      aggression: agent.aggression, risk_tolerance: agent.risk_tolerance,
      target_focus: agent.king_priority, positioning: agent.edge_affinity, sacrifice: agent.trade_down,
    });
    emit({ ...c, ...norm, agent_id: agent.id, name: agent.name, nameAuto: false });
  };

  const applyPreset = (p) => {
    const c = latest.current;
    emit({ ...c, ...normalizeBudget(p.sliders), locks: {}, nameAuto: true, name: suggestNames(p.sliders)[c.nameIdx || 0] });
    setPresetsOpen(false);
  };

  return (
    <div style={{ background: "#161b22", borderRadius: 8, padding: 10, marginBottom: 8, border: `1px solid ${accent}33`, position: "relative" }}>
      {!lockRoster && (
        <button onClick={onRemove} title="Remove"
          style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", color: "#e74c3c55", cursor: "pointer", fontSize: 11, lineHeight: 1, zIndex: 2 }}>✕</button>
      )}

      {/* 1. AGENT NAME (sigil + editable name + re-roll) */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, paddingRight: 14 }}>
        <Sigil sliders={sliders} color={accent} size={16} />
        <input value={displayName} spellCheck={false}
          onChange={(e) => editName(e.target.value)}
          onFocus={(e) => { e.target.style.borderBottomColor = accent + "55"; }}
          onBlur={(e) => { e.target.style.borderBottomColor = "transparent"; }}
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", borderBottom: "1px solid transparent",
            color: accent, fontSize: 18, fontWeight: 700, fontFamily: "inherit", letterSpacing: 0.3, padding: "1px 2px", outline: "none" }} />
        <button onClick={rollName} title="Re-roll name" disabled={hasAgent}
          style={{ background: "none", border: "none", cursor: hasAgent ? "default" : "pointer", fontSize: 13, opacity: hasAgent ? 0.25 : 0.7, padding: 0 }}>🎲</button>
      </div>

      {/* 2. TEMPERAMENT pill */}
      <div style={{ marginBottom: 6 }}>
        <span key={tempPop} style={{ display: "inline-flex", alignItems: "center", gap: 3,
          fontSize: 10, fontWeight: 700, letterSpacing: 1, color: accent,
          background: accent + "15", border: `1px solid ${accent}33`, padding: "1px 8px", borderRadius: 10,
          animation: tempPop ? "tempPop 0.25s ease-out" : "none" }}>
          {TEMPERAMENT_ICONS[temp]} {temp}
        </span>
      </div>

      {/* 3 + 4 + 5. RADAR (left) | sacrifice line + chassis (right) */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ flexShrink: 0 }}><RadarChart sliders={sliders} color={accent} size={116} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 8, color: "#6a7480", letterSpacing: 0.5, marginBottom: 6 }}>
            GAVE UP: {gaveUp.join(", ")}
          </div>
          <div style={{ fontSize: 8, color: "#8892a0", letterSpacing: 1, marginBottom: 3, fontWeight: 700 }}>GUARDIAN{lockSpecies ? " 🔒" : ""}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ cursor: lockSpecies ? "default" : "pointer" }} onClick={lockSpecies ? undefined : () => setPickerOpen(o => !o)}>
              <CreaturePortrait species={creature.species} size="md" px={40} selected />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: SPECIES_BORDER_COLORS[creature.species], letterSpacing: 0.5 }}>
                {(creature.species || "").toUpperCase()}
              </div>
              <div style={{ fontSize: 7, color: "#4a5568" }}>{SPECIES_ROLES[creature.species]}</div>
              {info && (
                <div style={{ display: "flex", gap: 5, marginTop: 2 }}>
                  {[["HP", info.hp], ["ATK", info.atk], ["DEF", info.def], ["SPD", info.spd]].map(([l, v]) => (
                    <span key={l} style={{ fontSize: 6, color: "#4a5568" }}>{l}<span style={{ color: "#8892a0", fontWeight: 700 }}> {v}</span></span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={{ fontSize: 6, color: "#3a4450", marginTop: 3, fontStyle: "italic" }}>{lockSpecies ? "Guardian locked for the series" : "the body the Pilot flies"}</div>
        </div>
      </div>

      {/* Species (chassis) picker */}
      {pickerOpen && !lockSpecies && speciesList.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 6, padding: 4, background: "#0d1117", borderRadius: 6, border: "1px solid #21262d", flexWrap: "wrap", justifyContent: "center" }}>
          {speciesList.map(s => {
            const isSelected = creature.species === s.id;
            return (
              <div key={s.id} onClick={() => { onChange({ ...creature, species: s.id }); setPickerOpen(false); }}
                style={{ cursor: "pointer", textAlign: "center", padding: 3, borderRadius: 6,
                  background: isSelected ? `${SPECIES_BORDER_COLORS[s.id]}15` : "transparent",
                  border: `1px solid ${isSelected ? SPECIES_BORDER_COLORS[s.id] + "66" : "transparent"}` }}>
                <CreaturePortrait species={s.id} size="md" px={36} selected={isSelected} />
                <div style={{ fontSize: 6, color: SPECIES_BORDER_COLORS[s.id], fontWeight: 700, marginTop: 2, letterSpacing: 1 }}>{s.name.toUpperCase()}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Upgrade selector (P7) — one tier per level gate, inline effect text */}
      {upgrades.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 8, color: "#8892a0", letterSpacing: 1, fontWeight: 700, marginBottom: 3 }}>UPGRADE</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {upgrades.map(u => {
              const locked = u.level > pilotLevel;
              const selected = creature.upgrade === u.key && !locked;
              return (
                <button key={u.key} disabled={locked}
                  onClick={() => emit({ ...latest.current, upgrade: u.key })}
                  style={{ textAlign: "left", display: "flex", alignItems: "flex-start", gap: 5, padding: "3px 6px",
                    borderRadius: 4, border: `1px solid ${selected ? accent : "#21262d"}`,
                    background: selected ? accent + "15" : "transparent", cursor: locked ? "default" : "pointer",
                    fontFamily: "inherit", opacity: locked ? 0.55 : 1, width: "100%" }}>
                  <span style={{ fontSize: 9, color: locked ? "#3a4450" : selected ? accent : "#4a5568", lineHeight: "12px" }}>
                    {locked ? "🔒" : selected ? "●" : "○"}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 8, fontWeight: 700, color: locked ? "#4a5568" : selected ? accent : "#c8d0da" }}>
                      {u.name} <span style={{ color: "#4a5568", fontWeight: 400 }}>[L{u.level}]</span>
                    </span>
                    <div style={{ fontSize: 6, color: locked ? "#3a4450" : "#6a7480", lineHeight: 1.3 }}>
                      {locked ? `Pilot Lv ${u.level} needed` : u.description}
                    </div>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Saved-agent assignment */}
      <select value={creature.agent_id || ""} onChange={(e) => assignAgent(e.target.value || null)}
        style={{ width: "100%", background: "#0d1117", border: "1px solid #21262d", borderRadius: 3, color: "#8892a0", fontSize: 8, fontFamily: "inherit", padding: "3px 4px", marginBottom: 6 }}>
        <option value="">Custom Pilot</option>
        {agents.filter(a => !benchedIds.includes(a.id) || a.id === creature.agent_id)
          .map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>

      {/* Archetype presets */}
      {!hasAgent && (
        <div style={{ marginBottom: 6 }}>
          <button onClick={() => setPresetsOpen(o => !o)}
            style={{ background: "none", border: "none", color: "#4a5568", fontSize: 7, letterSpacing: 1, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
            {presetsOpen ? "▾" : "▸"} ARCHETYPES
          </button>
          {presetsOpen && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
              {PRESETS.map(p => {
                const pc = TEMPERAMENT_COLORS[p.temperament] || "#8892a0";
                return (
                  <button key={p.temperament} onClick={() => applyPreset(p)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 6px", borderRadius: 10,
                      border: `1px solid ${pc}44`, background: pc + "12", color: pc, fontSize: 7, fontWeight: 700,
                      letterSpacing: 0.5, cursor: "pointer", fontFamily: "inherit" }}>
                    {TEMPERAMENT_ICONS[p.temperament]} {p.temperament}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 6. BUDGET bar + sliders */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
          <span style={{ fontSize: 7, color: "#8892a0", letterSpacing: 1, fontWeight: 700 }}>ALLOCATED</span>
          <span style={{ fontSize: 8, color: total === ARENA_BUDGET ? "#2ecc71" : "#f39c12", fontWeight: 700 }}>{total} / {ARENA_BUDGET}</span>
        </div>
        <div style={{ height: 3, background: "#0d1117", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
          <div style={{ width: `${Math.min(100, total / ARENA_BUDGET * 100)}%`, height: "100%", background: accent, transition: "width 0.18s ease-out" }} />
        </div>
        {hasAgent && (() => {
          const pilot = agents.find(a => a.id === creature.agent_id);
          const played = pilot ? (pilot.arena_wins || 0) + (pilot.arena_losses || 0) : 0;
          return (
            <div style={{ fontSize: 7, color: "#4a5568", marginBottom: 5 }}>
              {pilot && <span style={{ color: accent, fontWeight: 700 }}>
                Lv {pilot.level || 1} · {played > 0 ? `${pilot.arena_wins}–${pilot.arena_losses} · ${pilot.arena_kills || 0} kills` : "no Arena record yet"}
              </span>}
              {pilot ? " — " : ""}saved Pilot. Switch to Custom to sculpt.
            </div>
          );
        })()}
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {SLIDER_META.map(({ key, label, color: sc }) => {
            const locked = !!locks[key];
            const walled = walledSlider === key;
            const rowTicks = ticks.filter(t => t.key === key);
            return (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
                <button onClick={() => toggleLock(key)} title={locked ? "Unlock" : "Lock (max 3)"} disabled={hasAgent}
                  style={{ background: "none", border: "none", cursor: hasAgent ? "default" : "pointer", fontSize: 8, padding: 0, width: 12, opacity: locked ? 1 : 0.3 }}>📌</button>
                <span style={{ fontSize: 6, color: sc, width: 20, textAlign: "right" }}>{label}</span>
                <input type="range" min={SLIDER_MIN} max={SLIDER_MAX} value={sliders[key]}
                  disabled={locked || hasAgent}
                  onChange={(e) => onSlider(key, parseInt(e.target.value))}
                  style={{ flex: 1, height: 3, accentColor: locked ? "#4a5568" : sc, opacity: (locked || hasAgent) ? 0.5 : 1 }} />
                <span style={{ fontSize: 7, color: "#8892a0", width: 16 }}>{sliders[key]}</span>
                {walled && (
                  <div key={wallKey} onAnimationEnd={() => setWalledSlider(null)}
                    style={{ position: "absolute", left: 36, right: 18, top: -1, bottom: -1, border: "1px solid #ff3333", borderRadius: 3, pointerEvents: "none", animation: "wallFlash 0.18s ease-out forwards" }} />
                )}
                {rowTicks.map(t => (
                  <span key={t.id} style={{ position: "absolute", right: 20, top: -3, pointerEvents: "none",
                    fontSize: 8, fontWeight: 700, color: t.amount < 0 ? "#e74c3c" : "#2ecc71", animation: "costTick 0.6s ease-out forwards" }}>
                    {t.amount > 0 ? `+${t.amount}` : t.amount}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CreatureDraft({ team, color, label, creatures, onUpdate, speciesList, agents, lockSpecies = false, lockRoster = false, benchedIds = [] }) {
  const addCreature = () => {
    if (creatures.length >= 3) return;
    onUpdate([...creatures, mkCreature("ironjaw", { aggression: 40, risk_tolerance: 40, target_focus: 40, positioning: 40, sacrifice: 40 })]);
  };
  const removeCreature = (idx) => onUpdate(creatures.filter((_, i) => i !== idx));
  const updateCreature = (idx, next) => { const arr = [...creatures]; arr[idx] = next; onUpdate(arr); };

  return (
    <div style={{ background: "#0d1117", border: `1px solid ${color}33`, borderRadius: 8, padding: 10, width: "100%" }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, letterSpacing: 2, fontWeight: 700, color }}>{label}</span>
          {!lockRoster && creatures.length < 3 && (
            <button onClick={addCreature} style={{ padding: "2px 8px", borderRadius: 4, border: `1px solid ${color}44`, background: "transparent", color, fontSize: 8, cursor: "pointer", fontFamily: "inherit" }}>+ DEPLOY</button>
          )}
        </div>
        <div style={{ fontSize: 6, color: "#4a5568", letterSpacing: 0.5, marginTop: 2 }}>
          {lockSpecies ? "Guardian species locked · swap Pilots, retune, change upgrades" : "You design the Pilot. The Guardian is just a body."}
        </div>
      </div>
      {creatures.map((c, idx) => (
        <AgentCard key={idx} creature={c} color={color}
          onChange={(next) => updateCreature(idx, next)} onRemove={() => removeCreature(idx)}
          speciesList={speciesList} agents={agents} lockSpecies={lockSpecies} lockRoster={lockRoster} benchedIds={benchedIds} />
      ))}
      {creatures.length === 0 && (
        <div style={{ textAlign: "center", padding: 16, color: "#3a4450", fontSize: 9 }}>Deploy up to 3 Pilots</div>
      )}
    </div>
  );
}

// ----- EVENT LOG -----

function EventLog({ events, currentIdx, creatures }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [currentIdx]);

  const displayEvents = events.slice(0, currentIdx + 1).filter(e =>
    ["kill", "breach_start", "breach_complete", "breach_denied", "last_stand",
      "collapse", "collapse_kill", "activation", "round_start"].includes(e.type)
  );

  const cMap = {};
  for (const c of (creatures || [])) { cMap[c.id] = c; }
  const creatureTag = (id) => {
    const c = cMap[id];
    if (!c) return null;
    const temp = c.temperament;
    const tColor = TEMPERAMENT_COLORS[temp] || "#8892a0";
    return { name: `${temp || ""} ${(c.species || "").toUpperCase()}`.trim(), tColor };
  };

  return (
    <div ref={ref} style={{ background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, padding: 6, maxHeight: 200, overflowY: "auto", width: "100%" }}>
      <div style={{ fontSize: 8, letterSpacing: 2, color: "#4a5568", marginBottom: 4, fontWeight: 700 }}>MATCH LOG</div>
      {displayEvents.map((e, i) => {
        if (e.type === "round_start") {
          return (
            <div key={i} style={{ fontSize: 7, color: "#4a5568", borderTop: "1px solid #1a1f2b", paddingTop: 2, marginTop: 2, letterSpacing: 1 }}>
              — ROUND {e.data?.round || e.round} —
            </div>
          );
        }
        if (e.type === "activation") {
          const r = e.data?.result;
          if (!r) return null;
          const act = r.action;
          const actorInfo = creatureTag(act.creature_id);
          let suffix = "";
          if (r.damage_dealt) suffix += ` (${r.damage_dealt} dmg)`;
          if (r.target_killed) suffix += " — KILL!";
          const targetInfo = act.target_id ? creatureTag(act.target_id) : null;
          return (
            <div key={i} style={{ fontSize: 7, color: "#8892a0", padding: "1px 0" }}>
              <span style={{ color: actorInfo?.tColor || (act.creature_id?.startsWith("red") ? "#e74c3c" : "#3498db"), fontWeight: 700 }}>
                {actorInfo?.name || act.creature_id}
              </span>
              {" "}{act.type.toUpperCase()}
              {targetInfo ? <>{" → "}<span style={{ color: targetInfo.tColor, fontWeight: 700 }}>{targetInfo.name}</span></> : act.target_id ? ` → ${act.target_id}` : null}
              {suffix}
            </div>
          );
        }
        const label = EVENT_LABELS[e.type] || e.type;
        const color = EVENT_COLORS[e.type] || "#8892a0";
        const evtInfo = e.creature_id ? creatureTag(e.creature_id) : null;
        return (
          <div key={i} style={{ fontSize: 8, fontWeight: 700, color, padding: "2px 0", letterSpacing: 1 }}>
            {label}{evtInfo ? <>{" ("}<span style={{ color: evtInfo.tColor }}>{evtInfo.name}</span>{")"}</> : e.creature_id ? ` (${e.creature_id})` : ""}
          </div>
        );
      })}
    </div>
  );
}

// ----- TEAM STATUS PANEL (during match) -----

function TeamPanel({ team, creatures, teamColor }) {
  if (!creatures || creatures.length === 0) return null;
  const teamCreatures = creatures.filter(c => c.team === team);
  if (teamCreatures.length === 0) return null;

  return (
    <div style={{ background: "#0d1117", border: `1px solid ${teamColor}22`, borderRadius: 6, padding: 6, width: "100%" }}>
      <div style={{ fontSize: 7, letterSpacing: 2, fontWeight: 700, color: teamColor, marginBottom: 4 }}>
        {team.toUpperCase()} TEAM
      </div>
      {teamCreatures.map(c => {
        const hpPct = c.hp / c.max_hp;
        const isDead = !c.alive;
        const borderCol = SPECIES_BORDER_COLORS[c.species];
        return (
          <div key={c.id} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "3px 0",
            opacity: isDead ? 0.5 : 1,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%", overflow: "hidden", flexShrink: 0,
              border: `2px solid ${c.in_last_stand ? "#ffd700" : borderCol}`,
              boxShadow: c.in_last_stand ? "0 0 8px #ffd70088" : "none",
              filter: isDead ? "grayscale(1)" : "none",
              position: "relative",
              animation: c.in_last_stand ? "teamLastStand 1.2s ease-in-out infinite" : "none",
            }}>
              <img src={CREATURE_IMAGES[c.species]?.md} alt={c.species}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              {isDead && (
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  background: "rgba(0,0,0,0.5)", color: "#e74c3c", fontWeight: 900, fontSize: 14,
                }}>✕</div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                {c.temperament && <span style={{ fontSize: 8 }}>{TEMPERAMENT_ICONS[c.temperament]}</span>}
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                  color: TEMPERAMENT_COLORS[c.temperament] || borderCol,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.agent_name || (c.species || "").toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 6, color: "#6a7480", letterSpacing: 0.5 }}>
                → {(c.species || "").charAt(0).toUpperCase() + (c.species || "").slice(1)}{c.temperament ? ` · ${c.temperament}` : ""}
              </div>
              {isDead ? (
                <div style={{ fontSize: 7, color: "#e74c3c", fontWeight: 700 }}>DEAD</div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: 1, height: 4, background: "#1a1f2b", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      width: `${hpPct * 100}%`, height: "100%", borderRadius: 2,
                      background: hpPct > 0.5 ? "#2ecc71" : hpPct > 0.25 ? "#f39c12" : "#e74c3c",
                      transition: "width 0.3s ease",
                    }} />
                  </div>
                  <span style={{ fontSize: 7, color: "#8892a0", flexShrink: 0 }}>{c.hp}/{c.max_hp}</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ----- MATCH RESULT PANEL -----

// Aggregate per-Pilot stats from the event stream (kills, damage, death round,
// and the honest dominant decision driver) for the post-match cards.
function pilotMatchStats(events, finalCreatures) {
  const stats = {};
  for (const c of finalCreatures || []) stats[c.id] = { kills: 0, damage: 0, dom: {}, killDrv: {}, diedRound: null };
  for (const e of (events || [])) {
    if (e.type === "activation") {
      const r = e.data?.result; if (!r) continue;
      const aid = r.action?.creature_id;
      if (aid && stats[aid]) {
        if (r.damage_dealt) stats[aid].damage += r.damage_dealt;
        const dom = e.data?.dominant_driver;
        if (dom) stats[aid].dom[dom] = (stats[aid].dom[dom] || 0) + 1;
        if (r.target_killed) {
          stats[aid].kills += 1;
          if (dom) stats[aid].killDrv[dom] = (stats[aid].killDrv[dom] || 0) + 1;
        }
      }
    } else if (e.type === "kill" && e.creature_id && stats[e.creature_id] && stats[e.creature_id].diedRound == null) {
      stats[e.creature_id].diedRound = e.round;
    }
  }
  return stats;
}

function MatchResult({ result, finalCreatures, events, hadLastStandVictory }) {
  if (!result) return null;
  const winColor = result.winner === "red" ? "#e74c3c" : result.winner === "blue" ? "#3498db" : "#f39c12";
  const stats = pilotMatchStats(events, finalCreatures);

  const card = (c, idx) => {
    const isDead = !c.alive;
    const temp = c.temperament;
    const accent = TEMPERAMENT_COLORS[temp] || SPECIES_BORDER_COLORS[c.species] || "#8892a0";
    const st = stats[c.id] || { kills: 0, damage: 0, dom: {}, killDrv: {}, diedRound: null };
    const isWinner = c.team === result.winner;
    const sliders = { aggression: c.aggression, risk_tolerance: c.risk_tolerance, target_focus: c.target_focus, positioning: c.positioning, sacrifice: c.sacrifice };
    const hasSliders = c.aggression != null;
    const domKeys = Object.keys(st.dom);
    const dominant = domKeys.length ? domKeys.reduce((a, b) => (st.dom[b] > st.dom[a] ? b : a)) : null;
    // Honest attribution: only claim what the real drivers support.
    const attribution = (st.kills > 0 && dominant && st.killDrv[dominant])
      ? `${DRIVER_LABEL[dominant]}-LED — ${st.killDrv[dominant]} of ${st.kills} kill${st.kills > 1 ? "s" : ""} from ${dominant.replace("_", " ")} plays`
      : null;
    const epitaph = (isDead && !isWinner && temp) ? EPITAPHS[temp] : null;
    return (
      <div key={`pc-${idx}`} style={{
        display: "flex", gap: 8, padding: 8, borderRadius: 6, marginBottom: 6,
        border: `1px solid ${isWinner ? accent + "66" : "#1a1f2b"}`,
        background: isWinner ? accent + "0c" : "transparent", opacity: isDead ? 0.72 : 1,
      }}>
        {hasSliders
          ? <div style={{ flexShrink: 0, filter: isDead ? "grayscale(0.8)" : "none" }}><RadarChart sliders={sliders} color={accent} size={64} showAxes={false} /></div>
          : <div style={{ width: 48, height: 48, borderRadius: "50%", overflow: "hidden", flexShrink: 0, filter: isDead ? "grayscale(1)" : "none" }}><img src={CREATURE_IMAGES[c.species]?.md} alt={c.species} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {temp && <span style={{ fontSize: 9 }}>{TEMPERAMENT_ICONS[temp]}</span>}
            <span style={{ fontSize: 11, fontWeight: 700, color: accent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.agent_name || (c.species || "").toUpperCase()}
            </span>
            <span style={{ fontSize: 6, color: c.team === "red" ? "#e74c3c" : "#3498db" }}>({c.team})</span>
          </div>
          <div style={{ fontSize: 6, color: "#6a7480", marginBottom: 2 }}>
            {(c.species || "").charAt(0).toUpperCase() + (c.species || "").slice(1)}{temp ? ` · ${temp}` : ""}
          </div>
          <div style={{ fontSize: 7, color: "#8892a0", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span>⚔ {st.kills} {st.kills === 1 ? "kill" : "kills"}</span>
            <span>{st.damage} dmg</span>
            <span style={{ color: isDead ? "#e74c3c" : "#2ecc71" }}>{isDead ? `died R${st.diedRound ?? "?"}` : `survived ${c.hp}/${c.max_hp}`}</span>
          </div>
          {attribution && <div style={{ fontSize: 6, color: accent, marginTop: 2, letterSpacing: 0.3 }}>{attribution}</div>}
          {epitaph && <div style={{ fontSize: 7, color: "#8892a0", fontStyle: "italic", marginTop: 2 }}>&ldquo;{epitaph}&rdquo;</div>}
        </div>
      </div>
    );
  };

  const ordered = [...(finalCreatures || [])].sort((a, b) => (b.team === result.winner ? 1 : 0) - (a.team === result.winner ? 1 : 0));

  return (
    <div style={{ background: "#0d1117", border: `1px solid ${winColor}33`, borderRadius: 8, padding: 12, width: "100%" }}>
      {hadLastStandVictory && (
        <div style={{ fontSize: 9, fontWeight: 900, color: "#ffd700", letterSpacing: 3, marginBottom: 4, textAlign: "center", textShadow: "0 0 12px #ffd70066" }}>
          LAST STAND VICTORY
        </div>
      )}
      <div style={{ fontSize: 20, fontWeight: 800, color: winColor, letterSpacing: 3, marginBottom: 2, textAlign: "center" }}>
        {result.winner === "draw" ? "DRAW" : `${result.winner.toUpperCase()} WINS`}
      </div>
      <div style={{ fontSize: 10, color: "#8892a0", letterSpacing: 1, marginBottom: 8, textAlign: "center" }}>
        {result.win_method.replace("_", " ").toUpperCase()} — {result.total_rounds} ROUNDS
      </div>
      <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, marginBottom: 4, textAlign: "center" }}>PILOT PERFORMANCE</div>
      {ordered.map(card)}
    </div>
  );
}

// ----- MAIN ARENA COMPONENT -----

// Slim a draft team to the fields the backend expects (drop UI-only state like
// locks / nameAuto / nameIdx). `withName` carries the agent identity through.
const corePayload = (c) => ({
  species: c.species, agent_id: c.agent_id ?? null,
  aggression: c.aggression, risk_tolerance: c.risk_tolerance, target_focus: c.target_focus,
  positioning: c.positioning, sacrifice: c.sacrifice, upgrade: c.upgrade ?? null,
});
const teamPayload = (team) => (team || []).map(corePayload);
const teamPayloadNamed = (team) => (team || []).map(c => ({ ...corePayload(c), name: c.name || "" }));

// --- Series UI (P3, §5.2 / §5.5) ---

function SeriesPips({ score, needed, color }) {
  return (
    <span style={{ letterSpacing: 3 }}>
      {Array.from({ length: needed }).map((_, i) => (
        <span key={i} style={{ color: i < score ? color : "#2a3340" }}>{i < score ? "●" : "○"}</span>
      ))}
    </span>
  );
}

// Always-on series score header (spec §11: "series-score header always").
function SeriesScoreBar({ series }) {
  if (!series) return null;
  const { red_score, blue_score, games_needed, format } = series;
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center", gap: 14,
      padding: "4px 14px", borderRadius: 6, border: "1px solid #21262d", background: "#0d1117",
      fontFamily: "'JetBrains Mono', monospace", width: "100%", maxWidth: 380,
    }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: "#e74c3c", letterSpacing: 1 }}>
        RED <SeriesPips score={red_score} needed={games_needed} color="#e74c3c" />
      </span>
      <span style={{ fontSize: 7, color: "#6a7480", letterSpacing: 2 }}>
        {(format || "").toUpperCase()} · FIRST TO {games_needed}
      </span>
      <span style={{ fontSize: 10, fontWeight: 800, color: "#3498db", letterSpacing: 1 }}>
        <SeriesPips score={blue_score} needed={games_needed} color="#3498db" /> BLUE
      </span>
    </div>
  );
}

// The single most important prev-game stat (§5.5 result card): top fragger.
function topFragger(events) {
  if (!events) return null;
  const kills = {}, nameOf = {};
  for (const e of events) {
    if (e.type === "kill") { const k = e.data?.killer; if (k) kills[k] = (kills[k] || 0) + 1; }
    const b = e.board_state;
    if (b) for (const c of (b.creatures || [])) nameOf[c.id] = c.agent_name || (c.species || "").toUpperCase();
  }
  let best = null;
  for (const id in kills) if (!best || kills[id] > kills[best]) best = id;
  return best ? { name: nameOf[best] || best.toUpperCase(), kills: kills[best] } : null;
}

// One scalable between-games screen (§5.5): result card → adjust (children) → keep/lock.
function BetweenGames({ series, lastGame, secondsLeft, loading, onKeep, onForfeit, adjusting, setAdjusting, agents = [], children }) {
  const wColor = lastGame?.winner === "red" ? "#e74c3c" : lastGame?.winner === "blue" ? "#3498db" : "#f39c12";
  const mvp = topFragger(lastGame?.events);
  const matchPoint = series.red_score === series.games_needed - 1 || series.blue_score === series.games_needed - 1;
  // Survival (§5.4): how the just-played game cost the player, the running BENCH
  // shelf, and whether the roster can still field a lineup.
  const pgr = series.per_game_results || [];
  const benchedThisGame = pgr.length ? (pgr[pgr.length - 1].benched || []) : [];
  const redLostLast = lastGame?.winner === "blue";
  const depleted = series.survival && series.red_can_field === false;
  const pilotName = (id) => { const a = agents.find(x => x.id === id); return a ? a.name : `Pilot #${id}`; };
  return (
    <div style={{
      width: "100%", maxWidth: 420, marginTop: 6, padding: "14px 16px", borderRadius: 10,
      border: `1px solid ${depleted ? "#e74c3c55" : "#21262d"}`, background: "linear-gradient(135deg,#0d1117,#11161f)",
      fontFamily: "'JetBrains Mono', monospace", textAlign: "center",
    }}>
      <div style={{ fontSize: 8, letterSpacing: 3, color: "#6a7480", marginBottom: 8 }}>GAME {series.game_index} COMPLETE</div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16, marginBottom: 6 }}>
        <span style={{ fontSize: 24, fontWeight: 900, color: "#e74c3c" }}>{series.red_score}</span>
        <span style={{ fontSize: 9, color: "#6a7480", letterSpacing: 2 }}>SERIES</span>
        <span style={{ fontSize: 24, fontWeight: 900, color: "#3498db" }}>{series.blue_score}</span>
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, color: wColor, letterSpacing: 1, marginBottom: 4 }}>
        {lastGame?.winner === "draw" ? "DRAWN GAME" : `${(lastGame?.winner || "").toUpperCase()} TOOK THE GAME`}
        {" — "}{(lastGame?.win_method || "").replace(/_/g, " ").toUpperCase()} · {lastGame?.total_rounds} RDS
      </div>
      {mvp && <div style={{ fontSize: 8, color: "#9fd0ff", marginBottom: 6 }}>⚔ {mvp.name} — {mvp.kills} {mvp.kills === 1 ? "KILL" : "KILLS"}</div>}

      {/* Survival win-cost framing (§5.4): the asymmetry must read as intentional. */}
      {series.survival && (
        <div style={{
          fontSize: 8, fontWeight: 700, letterSpacing: 1, margin: "2px 0 6px", padding: "3px 8px",
          borderRadius: 4, display: "inline-block",
          color: benchedThisGame.length ? "#e74c3c" : redLostLast ? "#2ecc71" : "#6a7480",
          background: benchedThisGame.length ? "#e74c3c12" : redLostLast ? "#2ecc7112" : "transparent",
        }}>
          {benchedThisGame.length
            ? `💀 LOST — ${benchedThisGame.length} PILOT${benchedThisGame.length > 1 ? "S" : ""} BENCHED`
            : redLostLast ? "🛡 LOST — PILOTS PRESERVED (clean loss · retool & strike back)"
            : "✓ ROSTER INTACT — winners keep all"}
        </div>
      )}

      {/* BENCH shelf: grayscaled, locked Pilot chips (§5.4 legibility). */}
      {series.survival && series.benched && series.benched.length > 0 && (
        <div style={{ margin: "4px 0 8px", padding: "6px 8px", borderRadius: 6, background: "#0d1117", border: "1px solid #21262d" }}>
          <div style={{ fontSize: 7, letterSpacing: 1, color: "#6a7480", marginBottom: 4 }}>BENCHED FOR THE SERIES</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "center" }}>
            {series.benched.map(id => (
              <span key={id} style={{
                fontSize: 7, fontWeight: 700, color: "#5a6470", padding: "2px 7px", borderRadius: 10,
                border: "1px solid #2a3340", background: "#161b22", filter: "grayscale(1)", opacity: 0.7,
              }}>🔒 {pilotName(id)}</span>
            ))}
          </div>
        </div>
      )}
      {matchPoint && <div style={{ fontSize: 9, fontWeight: 800, color: "#f39c12", letterSpacing: 2, marginBottom: 6 }}>⚠ SERIES POINT</div>}

      {depleted ? (
        /* §5.4 attrition: the roster can't field 3 un-benched Pilots → concede. */
        <>
          <div style={{ fontSize: 9, fontWeight: 800, color: "#e74c3c", letterSpacing: 1, margin: "4px 0 8px" }}>
            ROSTER DEPLETED — you can no longer field 3 Pilots
          </div>
          <button onClick={onForfeit} disabled={loading}
            style={{ padding: "9px 24px", borderRadius: 6, border: "1px solid #e74c3c", background: "rgba(231,76,60,0.1)",
              color: "#e74c3c", fontWeight: 800, fontSize: 11, letterSpacing: 2, cursor: loading ? "default" : "pointer",
              fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
            {loading ? "…" : "💀 CONCEDE SERIES"}
          </button>
        </>
      ) : (<>
        {/* Adjust-lineup expander (P4 swaps + P7 upgrades, §5.5). Opening it cancels
            the auto-advance so the player can retool without the clock running out. */}
        <button onClick={() => setAdjusting(!adjusting)}
          style={{ background: "none", border: "none", color: adjusting ? "#ffd700" : "#6a7480", fontSize: 8,
            letterSpacing: 1, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: "4px 0", marginTop: 2 }}>
          {adjusting ? "▾ ADJUST LINEUP" : series.survival ? "▸ ADJUST LINEUP (sub in / swap upgrades)" : "▸ ADJUST LINEUP (swap Pilots / upgrades)"}
        </button>
        {adjusting && <div style={{ marginTop: 4, textAlign: "left" }}>{children}</div>}

        <button onClick={onKeep} disabled={loading}
          style={{ marginTop: 10, padding: "9px 26px", borderRadius: 6, border: "1px solid #2ecc71",
            background: "rgba(46,204,113,0.08)", color: "#2ecc71", fontWeight: 800, fontSize: 11,
            letterSpacing: 2, cursor: loading ? "default" : "pointer", fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
          {loading ? "SIMULATING…" : adjusting ? "LOCK LINEUP & PLAY ▸" : "KEEP LINEUP & PLAY ▸"}
        </button>
        {secondsLeft != null && !loading && !adjusting && (
          <div style={{ fontSize: 7, color: "#4a5568", marginTop: 6, letterSpacing: 1 }}>
            Guardians locked · Pilots &amp; upgrades may change · auto-advance in {secondsLeft}s
          </div>
        )}
      </>)}
    </div>
  );
}

// Series betting (P3, §7.2). Free-play only — server prices via the lineup-
// conditional Monte-Carlo (/api/arena/series/price); resolution is client-side,
// matching the existing free-play arena prop book. Series moneyline leads; sweep
// + go-the-distance sit behind "More markets," all priced from one consistent
// distribution so the correlated legs can't be arbitraged (audited, §7.3).
function SeriesMarkets({ odds, pricing, onPrice, bets, onBet, wallet }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const placed = (m, s) => bets.some(b => b.market === m && b.selection === s);
  const Bet = ({ market, sel, label, o, color }) => {
    const has = placed(market, sel);
    const disabled = !o || (wallet < 50 && !has) || has;
    return (
      <button onClick={() => onBet(market, sel, o)} disabled={disabled}
        style={{ flex: 1, padding: "5px 4px", borderRadius: 5, fontFamily: "inherit",
          border: `1px solid ${has ? "#2ecc71" : (color || "#21262d")}`,
          background: has ? "rgba(46,204,113,0.12)" : "transparent",
          color: has ? "#2ecc71" : (color || "#8892a0"), fontSize: 9, fontWeight: 700,
          cursor: disabled ? "default" : "pointer", opacity: (!o || (wallet < 50 && !has)) ? 0.4 : 1 }}>
        {label} {o ? `${o}x` : "--"}{has ? " ✓" : ""}
      </button>
    );
  };
  return (
    <div style={{ width: "100%", maxWidth: 380, padding: "10px 12px", borderRadius: 8,
      border: "1px solid #21262d", background: "#0d1117", fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 9, letterSpacing: 2, fontWeight: 800, color: "#c8d0da" }}>SERIES MARKETS</span>
        <span style={{ fontSize: 6, letterSpacing: 1, color: "#f39c12", border: "1px solid #f39c1255", borderRadius: 3, padding: "1px 5px" }}>FREE PLAY · 50 ea</span>
      </div>
      {!odds ? (
        <button onClick={onPrice} disabled={pricing}
          style={{ width: "100%", padding: "7px", borderRadius: 5, border: "1px solid #3498db",
            background: "transparent", color: "#3498db", fontSize: 9, fontWeight: 700, letterSpacing: 1,
            cursor: pricing ? "default" : "pointer", fontFamily: "inherit", opacity: pricing ? 0.6 : 1 }}>
          {pricing ? "PRICING SERIES…" : "PRICE SERIES ODDS"}
        </button>
      ) : (<>
        <div style={{ fontSize: 7, color: "#6a7480", letterSpacing: 1, marginBottom: 3 }}>SERIES WINNER</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <Bet market="series_win" sel="red" label="RED" o={odds.series_win?.red} color="#e74c3c" />
          <Bet market="series_win" sel="blue" label="BLUE" o={odds.series_win?.blue} color="#3498db" />
        </div>
        <button onClick={() => setMoreOpen(o => !o)}
          style={{ background: "none", border: "none", color: "#6a7480", fontSize: 7, letterSpacing: 1,
            fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: "2px 0" }}>
          {moreOpen ? "▾ MORE MARKETS" : "▸ MORE MARKETS"}
        </button>
        {moreOpen && (<>
          <div style={{ fontSize: 7, color: "#6a7480", letterSpacing: 1, margin: "4px 0 3px" }}>EITHER TEAM SWEEPS</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 5 }}>
            <Bet market="sweep" sel="yes" label="YES" o={odds.sweep?.yes} />
            <Bet market="sweep" sel="no" label="NO" o={odds.sweep?.no} />
          </div>
          <div style={{ fontSize: 7, color: "#6a7480", letterSpacing: 1, marginBottom: 3 }}>GO THE DISTANCE</div>
          <div style={{ display: "flex", gap: 6 }}>
            <Bet market="go_distance" sel="yes" label="YES" o={odds.go_distance?.yes} />
            <Bet market="go_distance" sel="no" label="NO" o={odds.go_distance?.no} />
          </div>
          <div style={{ fontSize: 6, color: "#4a5568", marginTop: 6, fontStyle: "italic" }}>
            Priced live from a Monte-Carlo of the full series · draws void
          </div>
        </>)}
        {bets.length > 0 && (
          <div style={{ fontSize: 7, color: "#2ecc71", marginTop: 7, letterSpacing: 0.5 }}>
            {bets.length} bet{bets.length > 1 ? "s" : ""} placed · settles when the series ends
          </div>
        )}
      </>)}
    </div>
  );
}

function SeriesComplete({ series, onNew, betResults }) {
  const w = series.series_winner;
  const wColor = w === "red" ? "#e74c3c" : w === "blue" ? "#3498db" : "#f39c12";
  return (
    <div style={{
      width: "100%", maxWidth: 420, marginTop: 8, padding: 16, borderRadius: 12,
      border: `2px solid ${wColor}`, background: `${wColor}10`,
      fontFamily: "'JetBrains Mono', monospace", textAlign: "center",
    }}>
      <div style={{ fontSize: 8, letterSpacing: 4, color: "#6a7480" }}>{(series.format || "").toUpperCase()} SERIES</div>
      <div style={{ fontSize: 16, fontWeight: 900, color: wColor, letterSpacing: 3, margin: "6px 0" }}>
        {w ? `${w.toUpperCase()} WINS THE SERIES` : "SERIES DRAWN"}
      </div>
      <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>
        <span style={{ color: "#e74c3c" }}>{series.red_score}</span>
        <span style={{ color: "#6a7480" }}> — </span>
        <span style={{ color: "#3498db" }}>{series.blue_score}</span>
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", marginBottom: 12 }}>
        {(series.per_game_results || []).map((g) => {
          const gc = g.winner === "red" ? "#e74c3c" : g.winner === "blue" ? "#3498db" : "#f39c12";
          return (
            <div key={g.game} style={{ padding: "4px 8px", borderRadius: 5, border: `1px solid ${gc}55`, background: `${gc}10`, minWidth: 52 }}>
              <div style={{ fontSize: 7, color: "#6a7480" }}>G{g.game}</div>
              <div style={{ fontSize: 9, fontWeight: 800, color: gc }}>{(g.winner || "—").toUpperCase()}</div>
              <div style={{ fontSize: 6, color: "#6a7480" }}>{(g.win_method || "").replace(/_/g, " ")}</div>
            </div>
          );
        })}
      </div>
      {betResults && betResults.length > 0 && (
        <div style={{ marginBottom: 10, padding: "6px 8px", borderRadius: 6, background: "#0d1117", border: "1px solid #21262d" }}>
          <div style={{ fontSize: 7, letterSpacing: 1, color: "#6a7480", marginBottom: 4 }}>SERIES BETS</div>
          {betResults.map((r, i) => {
            const c = r.won === null ? "#8892a0" : r.won ? "#2ecc71" : "#e74c3c";
            const tag = r.won === null ? "VOID — refunded" : r.won ? `WON +${r.payout}` : `LOST -${r.amount}`;
            return (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: c, padding: "1px 0" }}>
                <span>{r.label}</span><span style={{ fontWeight: 700 }}>{tag}</span>
              </div>
            );
          })}
        </div>
      )}
      <button onClick={onNew} style={{ padding: "7px 20px", borderRadius: 6, border: "1px solid #3498db", background: "transparent", color: "#3498db", fontWeight: 700, fontSize: 10, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit" }}>NEW SERIES</button>
    </div>
  );
}

export default function Arena({ agents = [] }) {
  const [speciesList, setSpeciesList] = useState([]);
  const [arenaMode, setArenaMode] = useState("sandbox"); // "sandbox" or "multiplayer"
  // Defaults are budget-legal (each sums to 200, every slider in [5,80]); names auto-derive.
  const [redTeam, setRedTeam] = useState(() => [
    mkCreature("ironjaw", { aggression: 5, risk_tolerance: 35, target_focus: 40, positioning: 80, sacrifice: 40 }),
    mkCreature("razorwing", { aggression: 80, risk_tolerance: 5, target_focus: 40, positioning: 40, sacrifice: 35 }),
    mkCreature("embercaster", { aggression: 75, risk_tolerance: 40, target_focus: 70, positioning: 10, sacrifice: 5 }),
  ]);
  const [blueTeam, setBlueTeam] = useState(() => [
    mkCreature("warden", { aggression: 5, risk_tolerance: 35, target_focus: 40, positioning: 80, sacrifice: 40 }),
    mkCreature("hexwright", { aggression: 40, risk_tolerance: 15, target_focus: 70, positioning: 70, sacrifice: 5 }),
    mkCreature("razorwing", { aggression: 80, risk_tolerance: 5, target_focus: 40, positioning: 40, sacrifice: 35 }),
  ]);
  const [matchResult, setMatchResult] = useState(null);
  const [events, setEvents] = useState([]);
  const [currentEventIdx, setCurrentEventIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState(1200);
  const [props, setProps] = useState([]);
  const [bets, setBets] = useState([]);          // { propType, selection, amount, odds }
  const [betResults, setBetResults] = useState([]);
  const [wallet, setWallet] = useState(0);
  const [banner, setBanner] = useState(null);
  const [abilityEffect, setAbilityEffect] = useState(null);
  // Series (P3, §5.2): format selector (single | bo3 | bo5, default Bo3) and the
  // live series state from the backend (null = single-match mode).
  const [format, setFormat] = useState("bo3");
  const [survival, setSurvival] = useState(false);       // P5 Survival ruleset (opt-in, off default)
  const [series, setSeries] = useState(null);
  const [betweenSecs, setBetweenSecs] = useState(null);  // §5.5 12s adjust countdown
  const [adjusting, setAdjusting] = useState(false);     // between-games lineup editor open
  // Series betting (P3, §7.2) — server-priced (conditional Monte-Carlo), free-play.
  const [seriesOdds, setSeriesOdds] = useState(null);
  const [pricingSeries, setPricingSeries] = useState(false);
  const [seriesBets, setSeriesBets] = useState([]);
  const [seriesBetResults, setSeriesBetResults] = useState(null);
  const seriesSettledRef = useRef(false);
  // Synchronous in-flight guards for the series-mutating POSTs. React commits
  // `loading` asynchronously, so the disabled button / `loading` checks don't stop
  // a timer-driven call and a click from both firing first. A ref set before the
  // await (cleared in finally) does. Backed up server-side by the game_index
  // precondition on /next. §5.5.
  const nextGameInFlightRef = useRef(false);
  const startSeriesInFlightRef = useRef(false);
  // Neural-link summon (P2/§6.3): a brief materialize ceremony that doubles as the
  // final bet-lock window. 1.8s the first time this session, 0.8s after.
  const [summonNonce, setSummonNonce] = useState(0);
  const [summon, setSummon] = useState(null);   // { dur } while active, else null
  const summonSeenRef = useRef(false);
  const summonTimerRef = useRef(null);
  const summonDoneRef = useRef(null);
  const [isNarrow, setIsNarrow] = useState(typeof window !== "undefined" && window.innerWidth <= 768);
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const idxRef = useRef(0);
  const killsThisRoundRef = useRef({});
  const bannerTimerRef = useRef(null);
  const [breachLiveBet, setBreachLiveBet] = useState(null);
  const breachBetRef = useRef(null);
  const wsRef = useRef(null);
  const [mpStatus, setMpStatus] = useState("idle");
  const [mpQueueInfo, setMpQueueInfo] = useState(null);
  const [mpOpponent, setMpOpponent] = useState(null);
  const [mpCountdown, setMpCountdown] = useState(null);
  const [mpSide, setMpSide] = useState(null);

  const handleWsMessage = useCallback((evt) => {
    const data = JSON.parse(evt.data);
    if (data.type === "arena_queue_joined") { setMpStatus("in_queue"); setMpQueueInfo({ team_elo: data.team_elo }); }
    else if (data.type === "arena_queue_status") { setMpQueueInfo(prev => ({ ...prev, ...data })); }
    else if (data.type === "arena_queue_cancelled" || data.type === "arena_queue_timeout") { setMpStatus("idle"); setMpQueueInfo(null); }
    else if (data.type === "arena_match_found") { setMpStatus("opponent_reveal"); setMpSide(data.your_side); setMpOpponent(data.opponent); }
    else if (data.type === "arena_countdown") { setMpStatus("countdown"); setMpCountdown(data.count); }
    else if (data.type === "arena_match_result") { setMpStatus("in_match"); setMpCountdown(null); setMatchResult(data); setEvents(data.events || []); setCurrentEventIdx(0); idxRef.current = 0; playingRef.current = true; setPlaying(true); }
    else if (data.type === "error") { setMpStatus("idle"); }
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    const token = localStorage.getItem("ac_token") || "";
    if (!token) return null;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/play?token=${token}`);
    ws.onmessage = handleWsMessage;
    ws.onclose = () => { setMpStatus("idle"); wsRef.current = null; };
    wsRef.current = ws; setMpStatus("connecting");
    return ws;
  }, [handleWsMessage]);

  const joinArenaQueue = useCallback(() => {
    const send = () => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "arena_queue_join", team: teamPayload(redTeam) })); };
    if (wsRef.current?.readyState === WebSocket.OPEN) send();
    else { const ws = connectWs(); if (ws) ws.addEventListener("open", send, { once: true }); }
  }, [redTeam, connectWs]);

  const cancelArenaQueue = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "arena_queue_cancel" }));
    setMpStatus("idle"); setMpQueueInfo(null);
  }, []);

  useEffect(() => { return () => { if (wsRef.current) wsRef.current.close(); }; }, []);

  useEffect(() => { speedRef.current = speed; }, [speed]);

  // Breach live bet: offer on breach_start, settle on breach_complete/denied
  useEffect(() => {
    const ev = events[currentEventIdx];
    if (!ev) return;
    if (ev.type === "breach_start" && !breachBetRef.current) {
      const board = ev.board_state;
      if (board) {
        const ch = board.creatures?.find(c => c.id === ev.creature_id);
        if (ch) {
          const defTeam = ch.team === "red" ? "blue" : "red";
          const defs = (board.creatures || []).filter(c => c.alive && c.team === defTeam);
          const nearDefs = defs.filter(c => {
            if (!c.pos || !ch.pos) return false;
            const dq = Math.abs(c.pos[0] - ch.pos[0]);
            const dr = Math.abs(c.pos[1] - ch.pos[1]);
            const ds = Math.abs((-c.pos[0]-c.pos[1]) - (-ch.pos[0]-ch.pos[1]));
            return Math.max(dq, dr, ds) <= 2;
          });
          const hasDisruptor = defs.some(c => c.species === "hexwright");
          let p = 0.24 - nearDefs.length * 0.06;
          if (hasDisruptor) p -= 0.08;
          if (nearDefs.length === 0) p += 0.12;
          p = Math.max(0.08, Math.min(0.75, p));
          const yesOdds = Math.round((1 / p) * 0.95 * 100) / 100;
          const noOdds = Math.round((1 / (1 - p)) * 0.95 * 100) / 100;
          setBreachLiveBet({ channelerId: ch.id, team: ch.team, yesOdds, noOdds, bet: null, settled: false });
          breachBetRef.current = ch.id;
        }
      }
    }
    if ((ev.type === "breach_complete" || ev.type === "breach_denied") && breachBetRef.current) {
      setBreachLiveBet(prev => {
        if (!prev?.bet || prev.settled) return prev ? { ...prev, settled: true, won: null } : prev;
        const won = ev.type === "breach_complete" ? prev.bet.selection === "yes" : prev.bet.selection === "no";
        if (won) {
          const odds = prev.bet.selection === "yes" ? prev.yesOdds : prev.noOdds;
          setWallet(w => w + Math.round(50 * odds));
        }
        return { ...prev, settled: true, won };
      });
    }
    if (currentEventIdx === events.length - 1 && breachBetRef.current) {
      setBreachLiveBet(prev => prev?.bet ? { ...prev, settled: true, won: null } : null);
      breachBetRef.current = null;
    }
  }, [currentEventIdx, events]);

  useEffect(() => {
    fetch(`${API}/arena/species`).then(r => r.json()).then(d => setSpeciesList(d.species)).catch(() => {});
    fetch(`${API}/wallet`).then(r => r.json()).then(d => setWallet(d.balance ?? d.coins ?? 0)).catch(() => {});
    gameAudio.ensureInit();
    Object.values(CREATURE_IMAGES).forEach(sizes => {
      Object.values(sizes).forEach(src => {
        const img = new Image();
        img.src = src;
      });
    });
  }, []);

  // Fetch props when teams change
  const fetchProps = useCallback(async () => {
    if (redTeam.length === 0 || blueTeam.length === 0) { setProps([]); return; }
    try {
      const res = await fetch(`${API}/arena/props`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ red_team: teamPayloadNamed(redTeam), blue_team: teamPayloadNamed(blueTeam) }),
      });
      if (res.ok) {
        const data = await res.json();
        setProps(data.props || []);
      }
    } catch {}
  }, [redTeam, blueTeam]);

  useEffect(() => { fetchProps(); }, [fetchProps]);

  // propKey uniquely identifies a prop (species_survivor has multiple per match)
  const propKey = (p) => p.species ? `${p.type}:${p.species}` : p.type;

  const placeBet = (key, selection, odds, propType) => {
    const amount = 50;
    if (wallet < amount) return;
    if (bets.find(b => b.key === key)) return;
    setBets(prev => [...prev, { key, propType: propType || key, selection, amount, odds }]);
    setWallet(w => w - amount);
  };

  const removeBet = (key) => {
    const bet = bets.find(b => b.key === key);
    if (bet) {
      setWallet(w => w + bet.amount);
      setBets(prev => prev.filter(b => b.key !== key));
    }
  };

  // Run the neural-link summon, then call onDone() to begin playback. 1.8s first
  // view of the session, 0.8s after; tap the overlay to skip.
  const finishSummon = () => {
    if (summonTimerRef.current) { clearTimeout(summonTimerRef.current); summonTimerRef.current = null; }
    setSummon(null);
    const cb = summonDoneRef.current; summonDoneRef.current = null;
    if (cb) cb();
  };
  const runSummon = (onDone) => {
    const dur = summonSeenRef.current ? 800 : 1800;
    summonSeenRef.current = true;
    summonDoneRef.current = onDone;
    setSummonNonce(n => n + 1);
    setSummon({ dur });
    if (summonTimerRef.current) clearTimeout(summonTimerRef.current);
    summonTimerRef.current = setTimeout(finishSummon, dur);
  };

  const simulate = async () => {
    if (redTeam.length === 0 || blueTeam.length === 0) return;
    setLoading(true);
    setMatchResult(null);
    setEvents([]);
    setCurrentEventIdx(0);
    setBetResults([]);
    setBreachLiveBet(null);
    breachBetRef.current = null;
    try {
      const res = await fetch(`${API}/arena/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ red_team: teamPayloadNamed(redTeam), blue_team: teamPayloadNamed(blueTeam) }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMatchResult(data);
      setEvents(data.events || []);
      setCurrentEventIdx(0);
      idxRef.current = 0;
      // Resolve bets locally
      if (bets.length > 0) {
        const resolved = bets.map(bet => {
          let won = false;
          const evts = data.events || [];
          if (bet.propType === "breach_completion") {
            const breached = evts.some(e => e.type === "breach_complete");
            won = (bet.selection === "yes" && breached) || (bet.selection === "no" && !breached);
          } else if (bet.propType === "first_blood") {
            const firstKill = evts.find(e => e.type === "kill");
            if (firstKill) {
              const killer = firstKill.data?.killer || "";
              const killerTeam = killer.startsWith("red") ? "red" : "blue";
              won = bet.selection === killerTeam;
            }
          } else if (bet.propType === "total_rounds_ou") {
            const rounds = data.total_rounds || 0;
            won = (bet.selection === "over" && rounds > 5) || (bet.selection === "under" && rounds <= 5);
          } else if (bet.propType === "last_stand") {
            const hadLS = evts.some(e => e.type === "last_stand");
            won = (bet.selection === "yes" && hadLS) || (bet.selection === "no" && !hadLS);
          } else if (bet.propType === "species_survivor") {
            // key is "species_survivor:razorwing" — extract species from key
            const species = bet.key?.split(":")[1] || "";
            const finalCreatures = data.final_board?.creatures || [];
            const survived = finalCreatures.some(c => c.species?.toLowerCase() === species && c.alive);
            won = (bet.selection === "yes" && survived) || (bet.selection === "no" && !survived);
          }
          const payout = won ? Math.round(bet.amount * bet.odds) : 0;
          return { ...bet, won, payout };
        });
        setBetResults(resolved);
        const totalWon = resolved.reduce((s, b) => s + b.payout, 0);
        setWallet(w => w + totalWon);
      }
      // Neural-link summon, then begin playback (the ceremony = the bet-lock window).
      runSummon(() => { playingRef.current = true; setPlaying(true); });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // --- Series flow (P3, §5.2/§5.5) ---
  // Load one game's event log and run its summon → playback. The neural-link is
  // full (1.8s) for game 1 and a 0.8s power-up for games 2..N (summonSeenRef).
  const playGame = (game) => {
    setMatchResult(game);
    setEvents(game.events || []);
    setCurrentEventIdx(0);
    idxRef.current = 0;
    setBreachLiveBet(null);
    breachBetRef.current = null;
    runSummon(() => { playingRef.current = true; setPlaying(true); });
  };

  const startSeries = async () => {
    if (redTeam.length === 0 || blueTeam.length === 0) return;
    if (startSeriesInFlightRef.current) return;  // a double-clicked START would orphan a series + records
    startSeriesInFlightRef.current = true;
    setLoading(true);
    setSeries(null); setMatchResult(null); setEvents([]); setCurrentEventIdx(0);
    setBets([]); setBetResults([]); setBetweenSecs(null); setAdjusting(false);
    setSeriesBetResults(null); seriesSettledRef.current = false;
    try {
      const res = await fetch(`${API}/arena/series/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, survival, red_team: teamPayloadNamed(redTeam), blue_team: teamPayloadNamed(blueTeam) }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSeries(data);
      playGame(data.game);
    } catch (e) { console.error(e); alert(`Couldn't start series: ${String(e.message || e).slice(0, 200)}`); }
    finally { setLoading(false); startSeriesInFlightRef.current = false; }
  };

  // Forfeit a Survival series when the roster is depleted (§5.4 attrition) — the
  // only way out when you can no longer field 3 un-benched Pilots.
  const forfeitSeries = async () => {
    if (!series || series.status !== "active") return;
    if (nextGameInFlightRef.current) return;
    nextGameInFlightRef.current = true;
    setBetweenSecs(null); setAdjusting(false); setLoading(true);
    try {
      const res = await fetch(`${API}/arena/series/${series.series_id}/forfeit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!res.ok) throw new Error(await res.text());
      setSeries(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); nextGameInFlightRef.current = false; }
  };

  const nextGame = async () => {
    if (!series || series.status !== "active") return;
    // The 12s auto-advance timer and a KEEP click can both reach here before React
    // commits `loading`; a synchronous ref is what actually keeps one /next in flight.
    if (nextGameInFlightRef.current) return;
    nextGameInFlightRef.current = true;
    setBetweenSecs(null);
    setAdjusting(false);
    setLoading(true);
    try {
      const res = await fetch(`${API}/arena/series/${series.series_id}/next`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // game_index = games we've already seen → the game we expect to play next.
        // The server rejects the POST (409) if the series has moved past it.
        body: JSON.stringify({ red_team: teamPayloadNamed(redTeam), blue_team: teamPayloadNamed(blueTeam), game_index: series.game_index }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSeries(data);
      playGame(data.game);
    } catch (e) { console.error(e); }
    finally { setLoading(false); nextGameInFlightRef.current = false; }
  };

  const resetSeries = () => {
    setMatchResult(null); setEvents([]); setCurrentEventIdx(0); setSeries(null);
    setBets([]); setBetResults([]); setBreachLiveBet(null); breachBetRef.current = null;
    setBetweenSecs(null); setAdjusting(false);
    setSeriesOdds(null); setSeriesBets([]); setSeriesBetResults(null); seriesSettledRef.current = false;
  };

  // Fetch server-authoritative conditional series odds (§7.3). On-demand so the
  // Monte-Carlo runs on a click, not on every slider tweak.
  const priceSeries = async () => {
    if (redTeam.length === 0 || blueTeam.length === 0) return;
    setPricingSeries(true);
    try {
      const res = await fetch(`${API}/arena/series/price`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, red_team: teamPayloadNamed(redTeam), blue_team: teamPayloadNamed(blueTeam) }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSeriesOdds(data.odds);
    } catch (e) { console.error(e); }
    finally { setPricingSeries(false); }
  };

  const placeSeriesBet = (market, selection, odds) => {
    if (wallet < 50) return;
    if (seriesBets.some(b => b.market === market && b.selection === selection)) return;
    const LABELS = { series_win: "Series winner", sweep: "Sweep", go_distance: "Go the distance" };
    const label = `${LABELS[market] || market}: ${selection.toUpperCase()}`;
    setSeriesBets(prev => [...prev, { market, selection, amount: 50, odds, label }]);
    setWallet(w => w - 50);
  };

  // Between-games 12s auto-advance (§5.5): when a series game finishes and the
  // series is still live, count down and play the next game with the current
  // lineup if the player doesn't act. Pauses during the summon / a sim fetch.
  useEffect(() => {
    const finished = events.length > 0 && currentEventIdx >= events.length - 1;
    // Never auto-advance a depleted Survival roster — the player must concede.
    const depleted = series && series.survival && series.red_can_field === false;
    const between = finished && series && series.status === "active" && !summon && !loading && !playing && !adjusting && !depleted;
    if (!between) { if (betweenSecs !== null) setBetweenSecs(null); return; }
    if (betweenSecs === null) { setBetweenSecs(12); return; }
    if (betweenSecs <= 0) { nextGame(); return; }
    const t = setTimeout(() => setBetweenSecs((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [events, currentEventIdx, series, summon, loading, playing, betweenSecs, adjusting]);

  // Settle series bets once, from the completed series' final state (free-play,
  // client-resolved like the prop book). Draws on the moneyline void (refund).
  useEffect(() => {
    if (!series || series.status !== "complete" || seriesSettledRef.current) return;
    if (seriesBets.length === 0) { seriesSettledRef.current = true; return; }
    seriesSettledRef.current = true;
    const needed = series.games_needed, maxg = series.max_games;
    const rs = series.red_score, bs = series.blue_score, played = (series.per_game_results || []).length;
    const swept = ((rs === needed && bs === 0) || (bs === needed && rs === 0)) && played === needed;
    const distance = played >= maxg;
    const results = seriesBets.map(b => {
      let won;  // true | false | null(void)
      if (b.market === "series_win") {
        won = series.series_winner == null ? null : b.selection === series.series_winner;
      } else if (b.market === "sweep") {
        won = (b.selection === "yes") === swept;
      } else if (b.market === "go_distance") {
        won = (b.selection === "yes") === distance;
      } else { won = false; }
      const payout = won === null ? b.amount : (won ? Math.round(b.amount * b.odds) : 0);
      return { ...b, won, payout };
    });
    setSeriesBetResults(results);
    const credited = results.reduce((s, r) => s + (r.payout || 0), 0);
    if (credited) setWallet(w => w + credited);
  }, [series, seriesBets]);

  // Pre-series ONLY: editing the lineup/format invalidates priced odds and refunds
  // any placed series bets (a bet priced on one comp must never carry into a
  // different one). Once a series is live, bets are LOCKED — a legitimate between-
  // games Pilot/upgrade swap must never refund a placed (possibly losing) bet, or
  // that is a free-play +EV bet-cancellation exploit.
  useEffect(() => {
    if (series) return;
    setSeriesOdds(null);
    setSeriesBets(prev => {
      if (prev.length) setWallet(w => w + prev.reduce((s, b) => s + b.amount, 0));
      return prev.length ? [] : prev;
    });
  }, [redTeam, blueTeam, format, series]);

  // Survival auto-sub (§5.4): when a game grounds a Pilot still in the lineup,
  // swap that (species-locked) slot to an available owned Pilot so KEEP LINEUP
  // just works. The player can still override in ADJUST; if no sub is available
  // the slot stays and the depleted→forfeit branch takes over.
  useEffect(() => {
    if (!series || !series.survival || !(series.benched || []).length) return;
    const benched = new Set(series.benched);
    setRedTeam(prev => {
      const used = new Set(prev.filter(c => c.agent_id && !benched.has(c.agent_id)).map(c => c.agent_id));
      let changed = false;
      const next = prev.map(c => {
        if (!c.agent_id || !benched.has(c.agent_id)) return c;
        const sub = agents.find(a => !benched.has(a.id) && !used.has(a.id));
        if (!sub) return c;  // depleted — forfeit path handles it
        used.add(sub.id); changed = true;
        const norm = normalizeBudget({
          aggression: sub.aggression, risk_tolerance: sub.risk_tolerance,
          target_focus: sub.king_priority, positioning: sub.edge_affinity, sacrifice: sub.trade_down,
        });
        return { ...c, ...norm, agent_id: sub.id, name: sub.name, nameAuto: false };
      });
      return changed ? next : prev;
    });
  }, [series, agents]);

  // Show a banner for a duration, then clear it
  const showBanner = useCallback((type, label, sub, floats, duration = 2000) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, label, sub, floats });
    bannerTimerRef.current = setTimeout(() => setBanner(null), duration);
  }, []);

  // Show an ability effect for a brief duration
  const showAbility = useCallback((type, actorId, targetId) => {
    setAbilityEffect({ type, actorId, targetId });
    setTimeout(() => setAbilityEffect(null), 800);
  }, []);

  // Trigger sound + banner for an event
  const amplifyEvent = useCallback((ev, evts, idx) => {
    if (!ev) return;
    const round = ev.round;

    // Helper: resolve creature_id to display name from nearest board state
    const creatureName = (cid) => {
      if (!cid) return "???";
      for (let i = idx; i >= 0; i--) {
        const board = evts[i]?.board_state;
        if (board) {
          const c = board.creatures?.find(cr => cr.id === cid);
          if (c) return `${c.temperament ? c.temperament + " " : ""}${(c.species || "").toUpperCase()}`;
        }
      }
      return cid.toUpperCase();
    };

    // --- Kill events ---
    if (ev.type === "kill") {
      const killerId = ev.data?.killer;
      // Track kills this round for double-kill detection
      if (killerId) {
        if (!killsThisRoundRef.current[round]) killsThisRoundRef.current[round] = {};
        const rk = killsThisRoundRef.current[round];
        rk[killerId] = (rk[killerId] || 0) + 1;

        if (rk[killerId] >= 2) {
          showBanner("double_kill", "DOUBLE KILL!", null, null, 2500);
          gameAudio.playDoubleKill();
          return;
        }
      }

      // Check for ring-out (collapse kill or displace into void)
      const cause = ev.data?.cause;
      const effects = ev.data?.effects || [];
      if (cause === "collapse" || effects.includes("ring_out")) {
        showBanner("ring_out", "RING OUT!", `${creatureName(ev.creature_id)} claimed by the arena!`);
        gameAudio.playRingOut();
        return;
      }

      // Check if killer is in last stand
      const prevBoard = (() => {
        for (let i = idx; i >= 0; i--) {
          if (evts[i]?.board_state) return evts[i].board_state;
        }
        return null;
      })();
      const killerCreature = prevBoard?.creatures?.find(c => c.id === killerId);
      if (killerCreature?.in_last_stand) {
        showBanner("last_stand_kill", "AGAINST THE ODDS!", null, null, 2500);
        gameAudio.playKill();
        return;
      }

      // Regular kill
      showBanner("kill", "ELIMINATED", null, null, 1800);
      gameAudio.playKill();
      return;
    }

    // --- Last Stand ---
    if (ev.type === "last_stand") {
      showBanner("last_stand", "LAST STAND!", `${creatureName(ev.creature_id)} is alone but not finished.`,
        ["+2 ATK", "+1 SPD"], 3000);
      gameAudio.playLastStand();
      return;
    }

    // --- Collapse ---
    if (ev.type === "collapse") {
      showBanner("collapse", "THE ARENA IS COLLAPSING", null, null, 2500);
      gameAudio.playCollapseVoid();
      return;
    }

    if (ev.type === "collapse_kill") {
      showBanner("collapse_kill", "CLAIMED BY THE VOID", null, null, 2000);
      gameAudio.playRingOut();
      return;
    }

    // --- Breach ---
    if (ev.type === "breach_complete") {
      const board = (() => { for (let i = idx; i >= 0; i--) { if (evts[i]?.board_state) return evts[i].board_state; } return null; })();
      const ch = board?.creatures?.find(c => c.id === ev.creature_id);
      const isBuzzer = ch && ch.hp / ch.max_hp <= 0.3;
      const teamLabel = ev.data?.team?.toUpperCase() || "";
      showBanner("breach_complete",
        isBuzzer ? "ON THE BRINK!" : "GATE BREACH!",
        `${(ch?.species || "").toUpperCase()} breaks through! ${teamLabel} WINS BY GATE BREACH!`,
        isBuzzer ? ["BUZZER BEATER"] : null, 4000);
      gameAudio.playBreachComplete();
      breachBetRef.current = null;
      return;
    }
    if (ev.type === "breach_denied") {
      showBanner("breach_denied", "DENIED!",
        "The breach is shattered!", null, 2500);
      gameAudio.playBreachDenied();
      breachBetRef.current = null;
      return;
    }
    if (ev.type === "breach_start") {
      gameAudio.playChannelHum();
      return;
    }

    // --- Ability activations ---
    if (ev.type === "activation") {
      const r = ev.data?.result;
      if (!r) return;
      const actionType = r.action?.type;
      const actorId = r.action?.creature_id;
      const targetId = r.action?.target_id;
      const effects = r.effects || [];

      if (actionType === "bulwark_pulse") {
        showBanner("bulwark_pulse", "BULWARK PULSE!", null, null, 2000);
        showAbility("bulwark_pulse", actorId);
        gameAudio.playBulwarkPulse();
      } else if (actionType === "glitch") {
        showBanner("glitch", "GLITCH!", null, null, 1500);
        showAbility("glitch", actorId, targetId);
        gameAudio.playGlitch();
      } else if (actionType === "displace") {
        if (effects.includes("ring_out")) {
          // ring-out handled by kill event
        } else {
          showBanner("displace", "DISPLACE!", null, null, 1200);
          showAbility("displace", actorId, targetId);
          gameAudio.playDisplace();
        }
      } else if (actionType === "blast") {
        // Embercaster blast (always has splash potential)
        showBanner("blast", "BLAST!", null, null, 1200);
        showAbility("blast", actorId, targetId);
        gameAudio.playBlast();
      } else if (actionType === "attack" && targetId) {
        // Pick the 3D attack projectile by species (Arena3D reads abilityEffect).
        const boardNow = (() => {
          for (let i = idx; i >= 0; i--) { if (evts[i]?.board_state) return evts[i].board_state; }
          return null;
        })();
        const attacker = boardNow?.creatures?.find(c => c.id === actorId);
        if (attacker?.species === "razorwing") {
          showAbility("swoop", actorId, targetId);   // model streaks across (crimson trail)
          gameAudio.playSwoop();
        } else if (attacker?.species === "embercaster") {
          showAbility("blast", actorId, targetId);   // fireball arc + explosion
        } else {
          showAbility("melee", actorId, targetId);   // energy-arc projectile
        }
      } else if (actionType === "channel") {
        gameAudio.playChannelTick(r.breach_meter_value || 1);
      }

      // Provoke is handled at round start, detect from board state
      // Ironjaw provoke detection: if any enemies are provoked_by this creature
    }

    // --- Round start: check for provoke and collapse warning ---
    if (ev.type === "round_start") {
      killsThisRoundRef.current[round] = {};
      const board = ev.board_state;
      if (board) {
        // Ironjaw provoke
        const provoked = board.creatures?.filter(c => c.alive && c.provoked_by);
        if (provoked?.length > 0) {
          const provoker = board.creatures?.find(c => c.id === provoked[0].provoked_by);
          if (provoker) {
            showAbility("provoke", provoker.id);
            gameAudio.playProvoke();
          }
        }
        // Collapse warning (one round before)
        if (round === COLLAPSE_START_ROUND - 1) {
          showBanner("collapse", "THE ARENA IS COLLAPSING", "Perimeter hexes will void next round!", null, 3000);
          gameAudio.playCollapseWarning();
        }
      }
    }
  }, [showBanner, showAbility]);

  // Playback loop with moment amplification
  useEffect(() => {
    if (!playing || events.length === 0) return;
    let timeout;
    const step = () => {
      if (!playingRef.current || idxRef.current >= events.length - 1) {
        playingRef.current = false;
        setPlaying(false);

        // Match end: check for last-stand victory
        if (idxRef.current >= events.length - 1 && matchResult) {
          const hadLastStand = events.some(e => e.type === "last_stand");
          if (hadLastStand) {
            // Check if the last-stand creature's team won
            const lsEvent = events.find(e => e.type === "last_stand");
            const lsCreatureId = lsEvent?.creature_id;
            const finalBoard = events[events.length - 1]?.board_state;
            const lsCreature = finalBoard?.creatures?.find(c => c.id === lsCreatureId);
            if (lsCreature?.alive && matchResult.winner === lsCreature.team) {
              const lsName = `${lsCreature.temperament ? lsCreature.temperament + " " : ""}${(lsCreature.species || "").toUpperCase()}`;
              showBanner("last_stand_victory", "LAST STAND VICTORY!",
                `UNBELIEVABLE! ${lsName} runs the table!`, null, 4000);
            }
          }
          gameAudio.playWin();
        }
        return;
      }
      idxRef.current += 1;
      setCurrentEventIdx(idxRef.current);

      const ev = events[idxRef.current];

      // Trigger moment amplification
      amplifyEvent(ev, events, idxRef.current);

      // Timing: dramatic events get longer pauses
      const isKill = ev?.type === "kill";
      const isLastStand = ev?.type === "last_stand";
      const isBreachComplete = ev?.type === "breach_complete";
      const isBigMoment = ["collapse", "collapse_kill", "last_stand"].includes(ev?.type);
      const isAbilityMoment = ev?.type === "activation" && (() => {
        const t = ev.data?.result?.action?.type;
        return ["bulwark_pulse", "glitch", "displace"].includes(t);
      })();
      const isIntent = ev?.type === "intent";

      let delay = speedRef.current;
      if (isBreachComplete) delay = speedRef.current * 4;
      else if (isLastStand) delay = speedRef.current * 3;
      else if (isBigMoment) delay = speedRef.current * 2.5;
      else if (isKill) delay = speedRef.current * 2;
      else if (isAbilityMoment) delay = speedRef.current * 1.5;
      else if (isIntent) delay = speedRef.current * 0.6;

      timeout = setTimeout(step, delay);
    };
    timeout = setTimeout(step, speedRef.current);
    return () => clearTimeout(timeout);
  }, [playing, events, amplifyEvent, matchResult]);

  const pause = () => { playingRef.current = false; setPlaying(false); };
  const resume = () => { playingRef.current = true; setPlaying(true); };

  const currentEvent = events[currentEventIdx] || null;
  // Find the most recent board state (intent events don't have one)
  let currentBoard = null;
  for (let i = currentEventIdx; i >= 0; i--) {
    if (events[i]?.board_state) { currentBoard = events[i].board_state; break; }
  }
  const isFinished = currentEventIdx >= events.length - 1 && events.length > 0;
  const voided = currentBoard?.voided_hexes || [];
  const actionDesc = getActionDescription(currentEvent, currentBoard?.creatures);
  const roundNum = currentEvent?.round || 0;
  const warningHexes = getCollapseWarningHexes(roundNum, new Set((voided || []).map(h => hexKey(h[0], h[1]))));

  const allCreatures = currentBoard?.creatures || [];
  const allBodies = currentBoard?.bodies || [];
  const seenIds = new Set(allCreatures.map(c => c.id));
  // Bodies key on creature_id (not id); a leftover corpse of a creature still in
  // the list is a duplicate, and species-less bodies have no card to render — drop
  // both so post-match cards are exactly one per Pilot.
  const finalCreatures = [
    ...allCreatures,
    ...allBodies
      .map(b => ({ ...b, id: b.id ?? b.creature_id, alive: false }))
      .filter(b => b.id && b.species && !seenIds.has(b.id)),
  ];
  const inMatch = events.length > 0;

  // ----- Derived props for the 3D board (Arena3D) -----
  const teamColors3D = { red: "#e74c3c", blue: "#3498db" };
  const activeCreatureId = (currentEvent?.type === "intent" || currentEvent?.type === "activation")
    ? (currentEvent.creature_id || null) : null;
  const lastStandCreatureId = allCreatures.find(c => c.alive && c.in_last_stand)?.id || null;
  const winningTeam = isFinished ? (matchResult?.winner || null) : null;

  // Intent line: actor -> target (attack) or actor -> destination (move)
  let intentData = null;
  if (currentEvent?.type === "intent" && currentEvent.data?.action) {
    const action = currentEvent.data.action;
    const actor = allCreatures.find(c => c.id === currentEvent.creature_id && c.alive);
    if (actor) {
      if (action.target_id) {
        const target = allCreatures.find(c => c.id === action.target_id);
        if (target) intentData = { from: actor.pos, to: target.pos, color: "#e74c3c", type: "attack" };
      } else if (action.move_to) {
        intentData = { from: actor.pos, to: action.move_to, color: "#3498db", type: "move" };
      }
    }
  }

  // Breach: active channel from a living creature toward the enemy gate
  let breachData = null;
  const channeler3D = allCreatures.find(c => c.alive && c.channeling);
  if (channeler3D) {
    const defendingTeam = channeler3D.team === "red" ? "blue" : "red";
    breachData = {
      active: true,
      gate: channeler3D.team === "red" ? BLUE_GATE : RED_GATE,
      teamColor: channeler3D.team === "red" ? "#e74c3c" : "#3498db",
      channelerId: channeler3D.id,
      meter: channeler3D.breach_meter || 0,
      defendingTeamColor: defendingTeam === "red" ? "#e74c3c" : "#3498db",
      defenders: allCreatures.filter(c => c.alive && c.team === defendingTeam).map(c => ({ id: c.id, pos: c.pos })),
    };
  }

  // Bodies normalised with a resolved species for the 3D ghost corpses
  const bodies3D = allBodies.map(b => ({
    id: b.id ?? b.creature_id,   // engine bodies carry creature_id, not id
    pos: b.pos,
    rounds_remaining: b.rounds_remaining,
    species: b.species || allCreatures.find(c => c.id === b.creature_id)?.species || "ironjaw",
  }));

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
      width: "100%", maxWidth: 900, margin: "0 auto", padding: "10px 0",
      fontFamily: "'JetBrains Mono', monospace", color: "#c8d0da",
    }}>
      <style>{ARENA_STYLES}{`
        @keyframes teamLastStand {
          0%, 100% { box-shadow: 0 0 6px #ffd70088; }
          50% { box-shadow: 0 0 14px #ffd700cc, 0 0 4px #ffaa0066; }
        }
      `}</style>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, color: "#c8d0da" }}>AGENT ARENA</div>
        <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 2 }}>YOU DON'T PLAY THE GAME. YOU DESIGN THE PLAYER.</div>
        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 6 }}>
          {["sandbox", "multiplayer"].map(m => (
            <button key={m} onClick={() => { if (!inMatch) setArenaMode(m); }}
              style={{
                padding: "3px 14px", borderRadius: 4, fontSize: 8, fontWeight: 700,
                fontFamily: "inherit", letterSpacing: 2, cursor: inMatch ? "default" : "pointer",
                border: `1px solid ${arenaMode === m ? "#ffd700" : "#21262d"}`,
                background: arenaMode === m ? "#ffd70015" : "transparent",
                color: arenaMode === m ? "#ffd700" : "#4a5568",
                transition: "all 0.2s ease",
              }}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Main layout: panels flanking the board */}
      <div style={{ display: "flex", flexDirection: isNarrow ? "column" : "row", gap: 12, width: "100%", justifyContent: "center", alignItems: isNarrow ? "stretch" : "flex-start" }}>
        {/* Left panel: Red draft or team status */}
        <div style={{ width: isNarrow ? "100%" : 220, maxWidth: isNarrow ? 420 : "none", margin: isNarrow ? "0 auto" : 0, flexShrink: 0 }}>
          {inMatch ? (
            <TeamPanel team="red" creatures={allCreatures.concat(allBodies.map(b => ({ ...b, alive: false })))} teamColor="#e74c3c" />
          ) : (
            <CreatureDraft
              team="red" color="#e74c3c" label={arenaMode === "multiplayer" ? "DEPLOY YOUR PILOTS" : "RED TEAM"}
              creatures={redTeam} onUpdate={setRedTeam}
              speciesList={speciesList} agents={agents}
            />
          )}
        </div>

        {/* Center: board + controls */}
        <div style={{ flex: 1, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, minWidth: isNarrow ? 0 : 320 }}>
          {/* Series score header (always on during a series, §11) */}
          {series && <SeriesScoreBar series={series} />}
          {/* Action description bar */}
          <div style={{
            padding: "6px 16px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            letterSpacing: actionDesc?.style === "amplified" || actionDesc?.style === "kill" ? 3 : 1,
            color: actionDesc?.color || "#4a5568",
            background: actionDesc ? `${actionDesc.color || "#4a5568"}0a` : "transparent",
            border: `1px solid ${actionDesc ? (actionDesc.color || "#4a5568") + "25" : "transparent"}`,
            textAlign: "center",
            minHeight: 24, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.2s ease",
            width: "100%", maxWidth: 380,
          }}>
            {actionDesc?.text || (events.length > 0 ? "" : "")}
          </div>

          {/* AI Commentary */}
          {(() => {
            const commentary = matchResult?.commentary || [];
            if (commentary.length === 0 || !inMatch) return null;
            // Find the most recent commentary for current round or earlier
            const active = [...commentary].filter(c => c.round <= roundNum).sort((a, b) => b.round - a.round)[0];
            if (!active) return null;
            return (
              <div style={{
                padding: "5px 14px", borderRadius: 6, fontSize: 9, fontStyle: "italic",
                color: "#ffd700", background: "#ffd70008", border: "1px solid #ffd70020",
                textAlign: "center", width: "100%", maxWidth: 420,
                letterSpacing: 0.5, lineHeight: 1.4,
                transition: "all 0.3s ease",
              }}>
                🎙 {active.text}
              </div>
            );
          })()}

          {/* Board — 3D holographic arena (Three.js). Replaces the SVG HexBoard. */}
          <div style={{ background: "#080a0f", borderRadius: 12, padding: 8, border: "1px solid #1a1f2b", width: "100%", position: "relative" }}>
            <Arena3D
              creatures={allCreatures}
              bodies={bodies3D}
              hexes={ALL_HEXES}
              collapsedHexes={voided}
              warningHexes={warningHexes}
              breachData={breachData}
              lastStandCreatureId={lastStandCreatureId}
              activeCreatureId={activeCreatureId}
              intentData={intentData}
              abilityEffect={abilityEffect}
              winningTeam={winningTeam}
              teamColors={teamColors3D}
              summonNonce={summonNonce}
            />
            {/* Empty-state hint (no match running yet) */}
            {!currentBoard && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 16, pointerEvents: "none" }}>
                <span style={{ fontSize: 9, color: "#3a4450", letterSpacing: 2 }}>{arenaMode === "multiplayer" ? "DEPLOY YOUR PILOTS AND FIND AN OPPONENT" : "DEPLOY YOUR PILOTS — THEN FIGHT"}</span>
              </div>
            )}
            {/* Amplified banner overlay (HTML, on top of the canvas) */}
            <AmplifiedBanner banner={banner} />
            {/* Neural-link summon ceremony (Pilot names type in; doubles as bet-lock) */}
            {summon && (
              <div onClick={finishSummon} style={{
                position: "absolute", inset: 0, zIndex: 22, cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                background: "radial-gradient(ellipse at center, rgba(8,10,15,0.5) 0%, rgba(8,10,15,0.8) 100%)",
              }}>
                <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 6, color: "#9fd0ff", textShadow: "0 0 14px #3aa0ff88", marginBottom: 12, animation: "summonTitle 0.5s ease-out" }}>⚡ NEURAL LINK</div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center", maxWidth: 380, padding: "0 12px" }}>
                  {allCreatures.map((c, i) => {
                    const acc = TEMPERAMENT_COLORS[c.temperament] || (c.team === "red" ? "#e74c3c" : "#3498db");
                    return (
                      <div key={c.id} style={{ textAlign: "center", animation: `summonName 0.5s ease-out ${(0.1 + i * 0.12).toFixed(2)}s both` }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: acc, letterSpacing: 0.5, textShadow: `0 0 10px ${acc}66` }}>
                          {c.temperament ? `${TEMPERAMENT_ICONS[c.temperament]} ` : ""}{c.agent_name || (c.species || "").toUpperCase()}
                        </div>
                        <div style={{ fontSize: 6, color: "#6a7480" }}>{(c.species || "").charAt(0).toUpperCase() + (c.species || "").slice(1)}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 14, fontSize: 8, fontWeight: 700, letterSpacing: 2, color: "#f39c12" }}>FINAL BETS — LOCKING IN</div>
                <div style={{ width: 140, height: 3, background: "#1a1f2b", borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
                  <div style={{ height: "100%", background: "#f39c12", width: "100%", transformOrigin: "left", animation: `summonBar ${summon.dur}ms linear forwards` }} />
                </div>
                <div style={{ fontSize: 6, color: "#4a5568", marginTop: 8 }}>tap to skip</div>
              </div>
            )}
          </div>

          {/* Breach live bet */}
          {breachLiveBet && !breachLiveBet.settled && !breachLiveBet.bet && (
            <div style={{ background: "linear-gradient(135deg, #1a1f2b, #2c3e50)", border: `2px solid ${breachLiveBet.team === "red" ? "#e74c3c" : "#3498db"}`, borderRadius: 10, padding: "10px 18px", textAlign: "center", animation: "breachRingPulse 1.5s ease-in-out infinite" }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#f39c12", fontWeight: 700, marginBottom: 4 }}>LIVE BET — BREACH ATTEMPT</div>
              <div style={{ fontSize: 10, color: "#ccc", marginBottom: 8 }}>Will the breach succeed?</div>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <button onClick={() => { setWallet(w => w - 50); setBreachLiveBet(prev => ({ ...prev, bet: { selection: "yes", amount: 50 } })); }}
                  disabled={wallet < 50}
                  style={{ padding: "6px 18px", borderRadius: 6, border: "2px solid #2ecc71", background: "rgba(46,204,113,0.1)", color: "#2ecc71", fontWeight: 700, fontSize: 11, cursor: wallet >= 50 ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: wallet < 50 ? 0.4 : 1 }}>
                  YES ({breachLiveBet.yesOdds}x)
                </button>
                <button onClick={() => { setWallet(w => w - 50); setBreachLiveBet(prev => ({ ...prev, bet: { selection: "no", amount: 50 } })); }}
                  disabled={wallet < 50}
                  style={{ padding: "6px 18px", borderRadius: 6, border: "2px solid #e74c3c", background: "rgba(231,76,60,0.1)", color: "#e74c3c", fontWeight: 700, fontSize: 11, cursor: wallet >= 50 ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: wallet < 50 ? 0.4 : 1 }}>
                  NO ({breachLiveBet.noOdds}x)
                </button>
              </div>
              <div style={{ fontSize: 8, color: "#666", marginTop: 4 }}>50 coins to play</div>
            </div>
          )}
          {breachLiveBet?.bet && !breachLiveBet.settled && (
            <div style={{ fontSize: 10, color: "#f39c12", letterSpacing: 1, fontWeight: 700 }}>
              LIVE BET: {breachLiveBet.bet.selection.toUpperCase()} ({breachLiveBet.bet.selection === "yes" ? breachLiveBet.yesOdds : breachLiveBet.noOdds}x) — PENDING...
            </div>
          )}
          {breachLiveBet?.settled && breachLiveBet?.bet && (
            <div style={{ fontSize: 11, color: breachLiveBet.won ? "#2ecc71" : "#e74c3c", letterSpacing: 1, fontWeight: 700, padding: "4px 12px", borderRadius: 6, border: `1px solid ${breachLiveBet.won ? "#2ecc71" : "#e74c3c"}`, background: breachLiveBet.won ? "rgba(46,204,113,0.1)" : "rgba(231,76,60,0.1)" }}>
              {breachLiveBet.won ? `WON +${Math.round(50 * (breachLiveBet.bet.selection === "yes" ? breachLiveBet.yesOdds : breachLiveBet.noOdds))}` : "LOST -50"} COINS
            </div>
          )}

          {/* Round indicator */}
          {currentEvent && (
            <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1 }}>
              ROUND {currentEvent.round} {currentEvent.turn ? `/ TURN ${currentEvent.turn}` : ""}
            </div>
          )}

          {/* Controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexDirection: "column" }}>
            {arenaMode === "sandbox" ? (<>
              {!matchResult && !loading && (
                (() => {
                  const rosterMin = format === "bo5" ? 5 : 4;
                  const allOwned = redTeam.length === 3 && redTeam.every(c => c.agent_id);
                  const survReady = !survival || format === "single" || (allOwned && agents.length >= rosterMin);
                  const baseDisabled = redTeam.length === 0 || blueTeam.length === 0;
                  const disabled = baseDisabled || !survReady;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                      {/* Format selector (P3, §5.2) — default Best of 3 */}
                      <div style={{ display: "flex", gap: 6 }}>
                        {[["single", "SINGLE"], ["bo3", "BEST OF 3"], ["bo5", "BEST OF 5"]].map(([v, label]) => (
                          <button key={v} onClick={() => setFormat(v)}
                            title={v === "bo5" ? "high-stakes · ~10 min" : v === "bo3" ? "default competitive" : "one game"}
                            style={{
                              padding: "3px 10px", borderRadius: 4, fontSize: 8, fontWeight: 700, fontFamily: "inherit",
                              letterSpacing: 1, cursor: "pointer",
                              border: `1px solid ${format === v ? "#ffd700" : "#21262d"}`,
                              background: format === v ? "#ffd70015" : "transparent",
                              color: format === v ? "#ffd700" : "#4a5568",
                            }}>
                            {label}{v === "bo5" ? " ~10m" : ""}
                          </button>
                        ))}
                      </div>
                      {/* Survival toggle (P5, §5.4) — opt-in, off by default, series only */}
                      {format !== "single" && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                          <button onClick={() => setSurvival(s => !s)}
                            title="SURVIVAL SERIES — loser-only death-benching: lose a game and any Guardian that DIED is grounded for the rest of the series. Lose cleanly (ring-out/breach) and keep your roster to strike back."
                            style={{
                              padding: "3px 12px", borderRadius: 4, fontSize: 8, fontWeight: 700, fontFamily: "inherit", letterSpacing: 1, cursor: "pointer",
                              border: `1px solid ${survival ? "#e74c3c" : "#21262d"}`,
                              background: survival ? "#e74c3c18" : "transparent",
                              color: survival ? "#e74c3c" : "#4a5568",
                            }}>
                            {survival ? "💀 SURVIVAL SERIES: ON" : "SURVIVAL SERIES: OFF"}
                          </button>
                          {survival && (
                            <div style={{ fontSize: 6, color: survReady ? "#6a7480" : "#f39c12", maxWidth: 320, textAlign: "center", lineHeight: 1.5 }}>
                              {survReady
                                ? `Death = benched. A clean loss keeps your roster; a wipe pays the attrition. Roster: ${agents.length}/${rosterMin}.`
                                : !allOwned ? "⚠ Assign a SAVED Pilot to all 3 Guardians (no custom builds in Survival)."
                                : `⚠ ${format.toUpperCase()} Survival needs ≥ ${rosterMin} owned Pilots (you have ${agents.length}).`}
                            </div>
                          )}
                        </div>
                      )}
                      <button onClick={format === "single" ? simulate : startSeries} disabled={disabled}
                        style={{ padding: "8px 24px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 11, letterSpacing: 3, cursor: disabled ? "default" : "pointer", fontFamily: "inherit", opacity: disabled ? 0.3 : 1 }}>
                        {format === "single" ? "FIGHT" : survival ? "START SURVIVAL" : "START SERIES"}
                      </button>
                    </div>
                  );
                })()
              )}
              {loading && <span style={{ fontSize: 11, color: "#4a5568", letterSpacing: 2 }}>SIMULATING...</span>}
            </>) : (<>
              {mpStatus === "idle" && !matchResult && <button onClick={joinArenaQueue} disabled={redTeam.length === 0} style={{ padding: "8px 24px", borderRadius: 6, border: "1px solid #ffd700", background: "transparent", color: "#ffd700", fontWeight: 700, fontSize: 11, letterSpacing: 3, cursor: "pointer", fontFamily: "inherit", opacity: redTeam.length === 0 ? 0.3 : 1 }}>FIND OPPONENT</button>}
              {mpStatus === "connecting" && <span style={{ fontSize: 10, color: "#ffd700", letterSpacing: 2 }}>CONNECTING...</span>}
              {mpStatus === "in_queue" && <div style={{ textAlign: "center" }}><div style={{ fontSize: 10, color: "#ffd700", letterSpacing: 2, marginBottom: 4 }}>SEARCHING...</div>{mpQueueInfo && <div style={{ fontSize: 7, color: "#4a5568" }}>{mpQueueInfo.wait_time > 0 ? `${mpQueueInfo.wait_time}s` : "queued"}</div>}<button onClick={cancelArenaQueue} style={{ marginTop: 6, padding: "3px 12px", borderRadius: 4, border: "1px solid #e74c3c44", background: "transparent", color: "#e74c3c88", fontSize: 8, cursor: "pointer", fontFamily: "inherit" }}>CANCEL</button></div>}
              {mpStatus === "opponent_reveal" && mpOpponent && <div style={{ textAlign: "center" }}><div style={{ fontSize: 12, color: "#ffd700", fontWeight: 800, letterSpacing: 3 }}>OPPONENT FOUND</div><div style={{ fontSize: 10, color: "#c8d0da", fontWeight: 700 }}>{mpOpponent.display_name}</div><div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 4 }}>{(mpOpponent.team || []).map((c, i) => <div key={i} style={{ textAlign: "center" }}><CreaturePortrait species={c.species} size="sm" selected={false} /><div style={{ fontSize: 6, color: TEMPERAMENT_COLORS[c.temperament] || "#8892a0", fontWeight: 700, marginTop: 2 }}>{c.temperament}</div></div>)}</div></div>}
              {mpStatus === "countdown" && <div style={{ fontSize: 36, fontWeight: 900, color: "#ffd700", letterSpacing: 6, textShadow: "0 0 20px #ffd70066" }}>{mpCountdown}</div>}
            </>)}
            {matchResult && playing && (
              <button onClick={pause} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid #e67e22", background: "transparent", color: "#e67e22", fontWeight: 700, fontSize: 10, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit" }}>PAUSE</button>
            )}
            {matchResult && !playing && !isFinished && (
              <button onClick={resume} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 10, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit" }}>RESUME</button>
            )}
            {isFinished && !series && (
              <button onClick={() => { setMatchResult(null); setEvents([]); setCurrentEventIdx(0); setBets([]); setBetResults([]); setBreachLiveBet(null); breachBetRef.current = null; setMpStatus("idle"); setMpOpponent(null); }}
                style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid #3498db", background: "transparent", color: "#3498db", fontWeight: 700, fontSize: 10, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit" }}>NEW MATCH</button>
            )}
          </div>

          {/* Series markets (P3, §7.2) — bet the series before it starts (free-play) */}
          {arenaMode === "sandbox" && !matchResult && !loading && format !== "single" && (
            <SeriesMarkets odds={seriesOdds} pricing={pricingSeries} onPrice={priceSeries}
              bets={seriesBets} onBet={placeSeriesBet} wallet={wallet} />
          )}

          {/* Playback scrubber */}
          {events.length > 1 && (
            <div style={{ width: "100%", maxWidth: 380, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="range" min={0} max={events.length - 1} value={currentEventIdx}
                onChange={(e) => { const v = parseInt(e.target.value); idxRef.current = v; setCurrentEventIdx(v); pause(); }}
                style={{ flex: 1, height: 4, accentColor: "#2ecc71", background: "#1a1f2b", cursor: "pointer" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <span style={{ fontSize: 7, color: "#4a5568" }}>SPD</span>
                <input type="range" min={100} max={1200} value={1300 - speed}
                  onChange={(e) => setSpeed(1300 - parseInt(e.target.value))}
                  style={{ width: 40, accentColor: "#e67e22" }} />
              </div>
            </div>
          )}

          {/* Between-games screen (§5.5): shown while a series is still live */}
          {isFinished && series && series.status === "active" && (
            <BetweenGames series={series} lastGame={matchResult} secondsLeft={betweenSecs} loading={loading}
              onKeep={nextGame} onForfeit={forfeitSeries} adjusting={adjusting} setAdjusting={setAdjusting} agents={agents}>
              <CreatureDraft team="red" color="#e74c3c" label="ADJUST RED LINEUP"
                creatures={redTeam} onUpdate={setRedTeam} speciesList={speciesList} agents={agents}
                lockSpecies lockRoster benchedIds={series.benched} />
            </BetweenGames>
          )}
          {/* Series result card (when the series is decided) */}
          {isFinished && series && series.status === "complete" && (
            <SeriesComplete series={series} onNew={resetSeries} betResults={seriesBetResults} />
          )}
          {/* Match result — single matches, plus the final game's Pilot cards in a series */}
          {isFinished && (!series || series.status === "complete") && <MatchResult result={matchResult} finalCreatures={finalCreatures} events={events}
            hadLastStandVictory={(() => {
              const lsEvent = events.find(e => e.type === "last_stand");
              if (!lsEvent || !matchResult) return false;
              const finalBoard = events[events.length - 1]?.board_state;
              const lsCreature = finalBoard?.creatures?.find(c => c.id === lsEvent.creature_id);
              return lsCreature?.alive && matchResult.winner === lsCreature?.team;
            })()} />}
        </div>

        {/* Right panel: Blue draft or team status */}
        <div style={{ width: isNarrow ? "100%" : 220, maxWidth: isNarrow ? 420 : "none", margin: isNarrow ? "0 auto" : 0, flexShrink: 0 }}>
          {inMatch ? (
            <TeamPanel team="blue" creatures={allCreatures.concat(allBodies.map(b => ({ ...b, alive: false })))} teamColor="#3498db" />
          ) : arenaMode === "multiplayer" ? (
            <div style={{ padding: 16, textAlign: "center" }}>
              <div style={{ fontSize: 10, letterSpacing: 2, fontWeight: 700, color: "#3498db", marginBottom: 12 }}>OPPONENT</div>
              {mpOpponent ? (<>
                <div style={{ fontSize: 12, color: "#c8d0da", fontWeight: 700, marginBottom: 8 }}>{mpOpponent.display_name}</div>
                {(mpOpponent.team || []).map((c, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "4px 8px", background: "#161b22", borderRadius: 6 }}>
                    <CreaturePortrait species={c.species} size="sm" selected={false} />
                    <div>
                      <div style={{ fontSize: 9, color: "#c8d0da", fontWeight: 700 }}>{c.species}</div>
                      <div style={{ fontSize: 7, color: TEMPERAMENT_COLORS[c.temperament] || "#8892a0", fontWeight: 700 }}>{c.temperament}</div>
                    </div>
                  </div>
                ))}
              </>) : (
                <div style={{ padding: 24, border: "1px dashed #21262d", borderRadius: 8, color: "#4a5568", fontSize: 9 }}>
                  {mpStatus === "in_queue" ? "Searching for opponent..." : "Opponent will be revealed after matching"}
                </div>
              )}
            </div>
          ) : (
            <CreatureDraft
              team="blue" color="#3498db" label="BLUE TEAM"
              creatures={blueTeam} onUpdate={setBlueTeam}
              speciesList={speciesList} agents={agents}
            />
          )}
        </div>
      </div>

      {/* Betting panel — shows before match when teams are configured */}
      {props.length > 0 && !matchResult && (
        <div style={{
          width: "100%", maxWidth: 700, background: "#0d1117",
          border: "1px solid #f39c1233", borderRadius: 8, padding: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 10, letterSpacing: 2, fontWeight: 700, color: "#f39c12" }}>PROP BETS</span>
            <span style={{ fontSize: 9, color: "#4a5568" }}>🪙 {wallet} coins</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {props.map((p, pi) => {
              const pk = propKey(p);
              const placed = bets.find(b => b.key === pk);
              return (
                <div key={pk} style={{
                  background: "#161b22", borderRadius: 6, padding: 8,
                  flex: "1 1 200px", minWidth: 180,
                  border: placed ? "1px solid #f39c1266" : "1px solid #21262d",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                    <span style={{ fontSize: 12 }}>{p.icon}</span>
                    <span style={{ fontSize: 8, fontWeight: 700, color: "#c8d0da", letterSpacing: 1 }}>{p.label}</span>
                  </div>
                  <div style={{ fontSize: 7, color: "#4a5568", marginBottom: 6 }}>{p.desc}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {p.options.map((opt, oi) => {
                      const isSelected = placed?.selection === opt.selection;
                      return (
                        <button key={oi}
                          onClick={() => placed ? (isSelected ? removeBet(pk) : null) : placeBet(pk, opt.selection, opt.odds, p.type)}
                          disabled={!!placed && !isSelected}
                          style={{
                            padding: "3px 8px", borderRadius: 4, fontSize: 8, fontFamily: "inherit",
                            border: isSelected ? "1px solid #f39c12" : "1px solid #21262d",
                            background: isSelected ? "#f39c1215" : "transparent",
                            color: isSelected ? "#f39c12" : "#8892a0",
                            cursor: (placed && !isSelected) ? "default" : "pointer",
                            opacity: (placed && !isSelected) ? 0.3 : 1,
                            fontWeight: isSelected ? 700 : 400,
                          }}>
                          {opt.label} <span style={{ color: "#f39c12", fontWeight: 700 }}>{opt.odds}x</span>
                        </button>
                      );
                    })}
                  </div>
                  {placed && (
                    <div style={{ fontSize: 7, color: "#f39c12", marginTop: 3 }}>🎲 {placed.amount} on {placed.selection}</div>
                  )}
                </div>
              );
            })}
          </div>
          {bets.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 8, color: "#f39c12", textAlign: "center" }}>
              {bets.length} bet{bets.length > 1 ? "s" : ""} placed — {bets.reduce((s, b) => s + b.amount, 0)} coins at risk
            </div>
          )}
        </div>
      )}

      {/* Bet results — shows after match finishes */}
      {betResults.length > 0 && isFinished && (
        <div style={{
          width: "100%", maxWidth: 700, background: "#0d1117",
          border: "1px solid #f39c1233", borderRadius: 8, padding: 12,
        }}>
          <div style={{ fontSize: 10, letterSpacing: 2, fontWeight: 700, color: "#f39c12", marginBottom: 8 }}>
            BET RESULTS
          </div>
          {betResults.map((b, i) => {
            const p = props.find(pp => propKey(pp) === b.key) || props.find(pp => pp.type === b.propType);
            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "4px 8px", borderRadius: 4, marginBottom: 4,
                background: b.won ? "#2ecc7110" : "#e74c3c10",
                border: `1px solid ${b.won ? "#2ecc7133" : "#e74c3c33"}`,
              }}>
                <span style={{ fontSize: 8, color: "#c8d0da" }}>
                  {p?.icon} {p?.label} — {b.selection} @ {b.odds}x
                </span>
                <span style={{ fontSize: 9, fontWeight: 700, color: b.won ? "#2ecc71" : "#e74c3c" }}>
                  {b.won ? `+${b.payout}` : `-${b.amount}`}
                </span>
              </div>
            );
          })}
          <div style={{
            textAlign: "center", marginTop: 6, fontSize: 10, fontWeight: 700,
            color: betResults.reduce((s, b) => s + (b.won ? b.payout : -b.amount), 0) >= 0 ? "#2ecc71" : "#e74c3c",
          }}>
            NET: {betResults.reduce((s, b) => s + (b.won ? b.payout : -b.amount), 0) > 0 ? "+" : ""}
            {betResults.reduce((s, b) => s + (b.won ? b.payout : -b.amount), 0)} coins
          </div>
        </div>
      )}

      {/* Event log */}
      {events.length > 0 && (
        <div style={{ width: "100%", maxWidth: 500 }}>
          <EventLog events={events} currentIdx={currentEventIdx} creatures={allCreatures.concat(allBodies.map(b => ({ ...b, alive: false })))} />
        </div>
      )}
    </div>
  );
}
