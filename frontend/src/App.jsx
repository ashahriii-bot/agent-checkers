import { useState, useEffect, useRef, useCallback } from "react";
import { gameAudio } from "./audio.js";

const SIZE = 8;
const EMPTY = 0, RED = 1, BLACK = 2, RED_KING = 3, BLACK_KING = 4, DEAD = -1;
const isRed = (p) => p === RED || p === RED_KING;
const isKing = (p) => p === RED_KING || p === BLACK_KING;
const API = "/api";
const defaultConfig = { aggression: 50, risk_tolerance: 50, king_priority: 50, edge_affinity: 50, trade_down: 50 };

const SLIDER_KEYS = [
  { key: "aggression", short: "A", color: "#e74c3c" },
  { key: "risk_tolerance", short: "R", color: "#e67e22" },
  { key: "king_priority", short: "K", color: "#f1c40f" },
  { key: "edge_affinity", short: "E", color: "#3498db" },
  { key: "trade_down", short: "T", color: "#2ecc71" },
];

const TAG_COLORS = { UPSET: "#f39c12", COMEBACK: "#2ecc71", NAIL_BITER: "#3498db", DOMINANT: "#e74c3c", LAST_STAND: "#9b59b6" };
const TAG_LABELS = { UPSET: "UPSET", COMEBACK: "COMEBACK", NAIL_BITER: "NAIL-BITER", DOMINANT: "DOMINANT", LAST_STAND: "LAST STAND" };

const PERK_INFO = {
  rope_a_dope: { name: "ROPE-A-DOPE", color: "#3498db", icon: "⛨", short: "Tightens defense after being attacked", tag: "Strong vs aggressive agents" },
  press: { name: "PRESS", color: "#e67e22", icon: "▶", short: "Forces action during stalemates", tag: "Strong vs defensive agents" },
  momentum: { name: "MOMENTUM", color: "#2ecc71", icon: "⚡", short: "Captures breed more captures", tag: "Strong vs mid-range agents" },
};

const ADJECTIVE_POOLS = {
  aggression: ["Reckless", "Savage", "Furious", "Relentless", "Vicious"],
  risk_tolerance: ["Bold", "Fearless", "Daring", "Wild", "Rogue"],
  king_priority: ["Crowned", "Royal", "Ascending", "Noble", "Imperial"],
  edge_affinity: ["Fortified", "Walled", "Flanking", "Guarded", "Anchored"],
  trade_down: ["Grinding", "Patient", "Calculated", "Ruthless", "Efficient"],
};
const NOUN_POOLS = {
  aggression: ["Striker", "Raider", "Blitz", "Fang", "Storm"],
  risk_tolerance: ["Gambit", "Maverick", "Drifter", "Ace", "Phantom"],
  king_priority: ["Crown", "Monarch", "Regent", "Ascent", "Throne"],
  edge_affinity: ["Sentinel", "Bastion", "Wall", "Keep", "Rampart"],
  trade_down: ["Grinder", "Vise", "Strangler", "Anvil", "Press"],
};

const SLIDER_DESCRIPTIONS = {
  aggression: ["Avoids all conflict. Rarely captures.", "Cautious. Only captures when safe.", "Balanced. Takes good captures.", "Aggressive. Chases captures actively.", "Relentless. Captures at any cost."],
  risk_tolerance: ["Extremely cautious. Never leaves pieces exposed.", "Conservative. Avoids danger.", "Moderate. Accepts some exposure.", "Bold. Advances despite threats.", "Reckless. Ignores danger completely."],
  king_priority: ["Ignores promotion. Plays for material.", "Low promotion focus. Prefers captures.", "Balanced promotion and material play.", "Pushes for kings. Values promotion.", "Obsessed with promotion. Races for king row."],
  edge_affinity: ["Avoids edges. Plays center board.", "Slight center preference.", "No positional bias.", "Gravitates toward edges. Builds walls.", "Hugs the edges. Full fortress mode."],
  trade_down: ["Avoids trading. Preserves all pieces.", "Reluctant trader.", "Trades when favorable.", "Trades actively when ahead.", "Forces trades relentlessly when ahead."],
};

function getSliderDesc(key, value) {
  const idx = value <= 20 ? 0 : value <= 40 ? 1 : value <= 60 ? 2 : value <= 80 ? 3 : 4;
  return SLIDER_DESCRIPTIONS[key]?.[idx] || "";
}

const PRESETS_FOR_ARCHETYPE = {
  berserker: { aggression: 95, risk_tolerance: 90, king_priority: 20, edge_affinity: 20, trade_down: 30 },
  turtle: { aggression: 15, risk_tolerance: 10, king_priority: 80, edge_affinity: 70, trade_down: 40 },
  balanced: { aggression: 50, risk_tolerance: 50, king_priority: 50, edge_affinity: 50, trade_down: 50 },
  gambler: { aggression: 70, risk_tolerance: 95, king_priority: 40, edge_affinity: 30, trade_down: 60 },
  wall: { aggression: 30, risk_tolerance: 15, king_priority: 60, edge_affinity: 95, trade_down: 80 },
  shark: { aggression: 80, risk_tolerance: 40, king_priority: 50, edge_affinity: 30, trade_down: 95 },
};

function detectArchetype(config) {
  let best = null, bestDist = Infinity;
  for (const [name, preset] of Object.entries(PRESETS_FOR_ARCHETYPE)) {
    const dist = SLIDER_KEYS.reduce((s, k) => s + Math.abs(config[k.key] - preset[k.key]), 0);
    if (dist < bestDist) { bestDist = dist; best = name; }
  }
  return bestDist <= 150 ? best.toUpperCase() : "CUSTOM BUILD";
}

function localSuggestNames(config) {
  const entries = SLIDER_KEYS.map(s => ({ key: s.key, value: config[s.key] }));
  entries.sort((a, b) => b.value - a.value);
  let [primary, secondary] = [entries[0].key, entries[1].key];
  if (Math.abs(entries[0].value - entries[1].value) <= 5 && Math.random() > 0.5) [primary, secondary] = [secondary, primary];
  const suggestions = [];
  const usedA = new Set(), usedN = new Set();
  for (let i = 0; i < 3; i++) {
    const pa = ADJECTIVE_POOLS[primary].filter(a => !usedA.has(a));
    const pn = NOUN_POOLS[secondary].filter(n => !usedN.has(n));
    const adj = pa[Math.floor(Math.random() * pa.length)] || ADJECTIVE_POOLS[primary][0];
    const noun = pn[Math.floor(Math.random() * pn.length)] || NOUN_POOLS[secondary][0];
    usedA.add(adj); usedN.add(noun);
    suggestions.push(`${adj} ${noun}`);
  }
  return suggestions;
}

// --- shared components ---

function MiniBars({ config, width = "100%" }) {
  return (
    <div style={{ display: "flex", gap: 1, height: 4, width }}>
      {SLIDER_KEYS.map(s => (
        <div key={s.key} style={{ flex: 1, background: "#1a1f2b", borderRadius: 1, overflow: "hidden" }}>
          <div style={{ width: `${config[s.key]}%`, height: "100%", background: s.color, borderRadius: 1 }} />
        </div>
      ))}
    </div>
  );
}

function Piece({ type, highlight }) {
  if (type <= 0) return null;
  const red = isRed(type);
  const king = isKing(type);
  return (
    <div style={{
      width: "78%", height: "78%", borderRadius: "50%",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: red ? "radial-gradient(circle at 35% 35%, #ff6b6b, #c0392b)" : "radial-gradient(circle at 35% 35%, #f0f0f0, #95a5a6)",
      boxShadow: highlight ? `0 0 16px 4px ${red ? "rgba(231,76,60,0.6)" : "rgba(200,210,220,0.5)"}` : "0 3px 6px rgba(0,0,0,0.4), inset 0 1px 2px rgba(255,255,255,0.2)",
      border: king ? "2px solid #ffd700" : "1px solid rgba(0,0,0,0.2)",
      transition: "all 0.3s", transform: highlight ? "scale(1.05)" : "scale(1)",
    }}>
      {king && <span style={{ fontSize: 12, color: "#ffd700", textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>&#9813;</span>}
    </div>
  );
}

function BoardGrid({ board, lastMove, maxWidth = 380 }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: `repeat(${SIZE}, 1fr)`,
      width: "100%", maxWidth, aspectRatio: "1", borderRadius: 6, overflow: "hidden",
      border: "2px solid #1a1f2b", boxShadow: "0 0 40px rgba(0,0,0,0.5)",
    }}>
      {(board || Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY))).flatMap((row, r) =>
        row.map((cell, c) => {
          const dark = (r + c) % 2 === 1;
          const isDead = cell === DEAD;
          const isLastTo = lastMove && lastMove.path[lastMove.path.length - 1].row === r && lastMove.path[lastMove.path.length - 1].col === c;
          const isLastFrom = lastMove && lastMove.from.row === r && lastMove.from.col === c;
          return (
            <div key={`${r}-${c}`} style={{
              display: "flex", alignItems: "center", justifyContent: "center", aspectRatio: "1",
              background: isDead ? "#0a0406" : dark ? isLastFrom ? "#1a3a2a" : isLastTo ? "#1e4030" : "#1a2332" : "#0f1520",
              transition: "background 0.4s", position: "relative",
            }}>
              {isDead && <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(231,76,60,0.08) 3px, rgba(231,76,60,0.08) 6px)" }} />}
              {cell > 0 && <Piece type={cell} highlight={isLastTo} />}
            </div>
          );
        })
      )}
    </div>
  );
}

function OverextWarning({ config }) {
  if (config.aggression <= 70 || config.risk_tolerance <= 70) return null;
  const factor = ((config.aggression - 70) / 30) * ((config.risk_tolerance - 70) / 30);
  return (
    <div style={{ marginTop: 4, padding: "2px 6px", borderRadius: 3, background: "rgba(243,156,18,0.12)", border: "1px solid rgba(243,156,18,0.25)", fontSize: 7, color: "#f39c12", letterSpacing: 1, textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
      <span>overextension risk</span><span style={{ fontWeight: 700 }}>{Math.round(factor * 100)}%</span>
    </div>
  );
}

function Slider({ label, sliderKey, value, onChange, color, disabled, showDesc }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: 2, textTransform: "uppercase", color: "#8892a0" }}>{label}</span>
        <span style={{ fontSize: 8, fontWeight: 700, color }}>{value}</span>
      </div>
      <input type="range" min="0" max="100" value={value} disabled={disabled} onChange={(e) => onChange(parseInt(e.target.value))}
        style={{ width: "100%", background: `linear-gradient(to right, ${color} ${value}%, #1e2530 ${value}%)`, accentColor: color, opacity: disabled ? 0.5 : 1 }} />
      {showDesc && sliderKey && <div style={{ fontSize: 7, color: "#4a5568", marginTop: 1, fontStyle: "italic" }}>{getSliderDesc(sliderKey, value)}</div>}
    </div>
  );
}

function TagBadge({ tag }) {
  if (!tag) return null;
  return (
    <span style={{ fontSize: 6, fontWeight: 700, padding: "0 3px", borderRadius: 2, background: TAG_COLORS[tag] + "22", color: TAG_COLORS[tag], border: `1px solid ${TAG_COLORS[tag]}44`, letterSpacing: 0.5, whiteSpace: "nowrap" }}>
      {TAG_LABELS[tag] || tag}
    </span>
  );
}

// --- tournament components ---

function TournamentSetup({ roster, onStart, onBack, loading }) {
  const [selected, setSelected] = useState(new Set());
  const defaultBS = roster.length >= 5 ? 8 : 4;
  const [bracketSize, setBracketSize] = useState(defaultBS);
  const [seeding, setSeeding] = useState("elo");

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < bracketSize) next.add(id);
    setSelected(next);
  };

  const randomFill = bracketSize - selected.size;
  const btnStyle = (active) => ({
    padding: "4px 12px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer",
    background: active ? "#161b22" : "#0d1117", border: `1px solid ${active ? "#2ecc71" : "#21262d"}`,
    color: active ? "#2ecc71" : "#4a5568", borderRadius: 3, textTransform: "uppercase",
  });

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: 6, textTransform: "uppercase", background: "linear-gradient(135deg, #f39c12, #e74c3c)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Tournament</h2>
        <button onClick={onBack} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>BACK</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4 }}>BRACKET</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => { setBracketSize(4); setSelected(s => { const n = new Set(s); while (n.size > 4) n.delete([...n].pop()); return n; }); }} style={btnStyle(bracketSize === 4)}>4</button>
            <button onClick={() => setBracketSize(8)} style={btnStyle(bracketSize === 8)}>8</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4 }}>SEEDING</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setSeeding("elo")} style={btnStyle(seeding === "elo")}>SEEDED</button>
            <button onClick={() => setSeeding("random")} style={btnStyle(seeding === "random")}>RANDOM</button>
          </div>
        </div>
      </div>

      <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 6 }}>SELECT AGENTS ({selected.size}/{bracketSize})</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 6, marginBottom: 12 }}>
        {roster.map(a => {
          const sel = selected.has(a.id);
          return (
            <div key={a.id} onClick={() => toggle(a.id)} style={{
              padding: "6px 8px", background: sel ? "#161b22" : "#0d1117",
              border: `1px solid ${sel ? "#2ecc71" : "#1a1f2b"}`, borderRadius: 4, cursor: "pointer",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: sel ? "#2ecc71" : "#c8d0da" }}>{a.name}</span>
                <span style={{ fontSize: 9, color: "#8892a0" }}>{Math.round(a.elo)}</span>
              </div>
              <MiniBars config={a} />
              <div style={{ fontSize: 7, color: "#4a5568", marginTop: 2 }}>{a.wins}W {a.losses}L {a.draws}D</div>
            </div>
          );
        })}
      </div>

      {randomFill > 0 && selected.size >= 2 && (
        <div style={{ fontSize: 9, color: "#4a5568", marginBottom: 12 }}>{randomFill} random agent{randomFill > 1 ? "s" : ""} will fill remaining slots</div>
      )}

      <button onClick={() => onStart([...selected], bracketSize, seeding)} disabled={selected.size < 2 || loading}
        style={{
          padding: "10px 36px", borderRadius: 6, border: "none", fontFamily: "inherit",
          background: selected.size >= 2 ? "linear-gradient(135deg, #f39c12, #e67e22)" : "#21262d",
          color: selected.size >= 2 ? "#fff" : "#4a5568", fontWeight: 800, fontSize: 12,
          letterSpacing: 4, textTransform: "uppercase", cursor: selected.size >= 2 ? "pointer" : "not-allowed",
        }}>
        {loading ? "SIMULATING..." : "START TOURNAMENT"}
      </button>
    </div>
  );
}

function BracketSlot({ red, black, winnerSlot, tag, onClick, active, revealed }) {
  if (!revealed) {
    return (
      <div style={{ padding: "4px 6px", background: "#0a0c10", borderRadius: 3, minWidth: 130, opacity: 0.3, border: "1px solid #1a1f2b" }}>
        <div style={{ fontSize: 8, color: "#3a4450", padding: "1px 0" }}>TBD</div>
        <div style={{ fontSize: 8, color: "#3a4450", padding: "1px 0" }}>TBD</div>
      </div>
    );
  }
  const redWon = winnerSlot === red.slot;
  const blackWon = winnerSlot === black.slot;
  return (
    <div onClick={onClick} style={{ cursor: onClick ? "pointer" : "default", borderRadius: 3, border: active ? "1px solid #2ecc7188" : "1px solid transparent", background: active ? "#0d1a0d" : "transparent", padding: 1 }}>
      <div style={{ padding: "2px 6px", background: redWon ? "#111a11" : "#0d1117", borderRadius: "3px 3px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 8, color: redWon ? "#c8d0da" : "#3a4450", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 100 }}>
          <span style={{ color: "#4a5568" }}>#{red.seed}</span> {red.name}
        </span>
        {redWon && tag && <TagBadge tag={tag} />}
      </div>
      <div style={{ padding: "2px 6px", background: blackWon ? "#111a11" : "#0d1117", borderRadius: "0 0 3px 3px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 8, color: blackWon ? "#c8d0da" : "#3a4450", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 100 }}>
          <span style={{ color: "#4a5568" }}>#{black.seed}</span> {black.name}
        </span>
        {blackWon && tag && <TagBadge tag={tag} />}
      </div>
    </div>
  );
}

function TournamentBracket({ data, onBack, onNewTournament, roster }) {
  const [watchRound, setWatchRound] = useState(null);
  const [watchMatch, setWatchMatch] = useState(null);
  const [boardStep, setBoardStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showAwards, setShowAwards] = useState(false);
  const playRef = useRef(false);
  const stepRef = useRef(0);
  const speedRef = useRef(300);

  const agents = data.bracket.agents;
  const agentBySlot = {};
  agents.forEach(a => { agentBySlot[a.slot] = a; });

  const allRoundKeys = Object.keys(data.matches).sort((a, b) => {
    if (a === "final") return 1; if (b === "final") return -1;
    return a.localeCompare(b);
  });

  const getMatchData = (rk, mi) => data.matches[rk]?.[mi];

  const watchingData = watchRound !== null ? getMatchData(allRoundKeys[watchRound], watchMatch) : null;
  const watchBoard = watchingData?.boards?.[boardStep] || null;
  const watchLastMove = watchingData && boardStep > 0 ? watchingData.moves[boardStep - 1] : null;

  const playNext = useCallback(() => {
    if (!playRef.current) return;
    const md = getMatchData(allRoundKeys[watchRound], watchMatch);
    if (!md || stepRef.current >= md.boards.length - 1) { playRef.current = false; setPlaying(false); return; }
    stepRef.current += 1; setBoardStep(stepRef.current);
    setTimeout(playNext, speedRef.current);
  }, [watchRound, watchMatch]);

  const startWatch = (ri, mi) => {
    playRef.current = false; setPlaying(false);
    setWatchRound(ri); setWatchMatch(mi); setBoardStep(0); stepRef.current = 0;
  };
  const playMatch = () => { playRef.current = true; setPlaying(true); playNext(); };
  const pauseMatch = () => { playRef.current = false; setPlaying(false); };

  if (showAwards) {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 12px", textAlign: "center" }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, color: "#4a5568", textTransform: "uppercase", marginBottom: 8 }}>Tournament Complete</h2>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#ffd700", marginBottom: 4 }}>{data.champion.name}</div>
        <div style={{ fontSize: 9, color: "#4a5568", marginBottom: 16 }}>Seed #{data.champion.seed}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 20 }}>
          {data.awards.map((a, i) => (
            <div key={i} style={{ padding: "8px 12px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, minWidth: 120, textAlign: "left" }}>
              <div style={{ fontSize: 8, color: i === 0 ? "#ffd700" : "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 }}>{a.award}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#c8d0da" }}>{a.agent_name}</div>
              <div style={{ fontSize: 8, color: "#4a5568", marginTop: 1 }}>{a.detail}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 9, color: "#4a5568", marginBottom: 12 }}>ELO CHANGES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 20 }}>
          {data.elo_changes.map((e, i) => (
            <div key={i} style={{ fontSize: 9, padding: "2px 8px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 3 }}>
              <span style={{ color: "#c8d0da" }}>{e.name}</span>
              <span style={{ color: e.delta > 0 ? "#2ecc71" : e.delta < 0 ? "#e74c3c" : "#4a5568", fontWeight: 700, marginLeft: 4 }}>{e.delta > 0 ? "+" : ""}{e.delta}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={() => setShowAwards(false)} style={{ padding: "6px 16px", borderRadius: 4, border: "1px solid #21262d", background: "transparent", color: "#8892a0", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, cursor: "pointer" }}>VIEW BRACKET</button>
          <button onClick={onNewTournament} style={{ padding: "6px 16px", borderRadius: 4, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, cursor: "pointer" }}>NEW TOURNAMENT</button>
          <button onClick={onBack} style={{ padding: "6px 16px", borderRadius: 4, border: "1px solid #21262d", background: "transparent", color: "#4a5568", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, cursor: "pointer" }}>BACK TO MATCHES</button>
        </div>
      </div>
    );
  }

  const bracketRounds = data.bracket.rounds;
  const bracketHeight = data.bracket_size === 8 ? 320 : 180;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, textTransform: "uppercase", background: "linear-gradient(135deg, #f39c12, #e74c3c)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Tournament</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowAwards(true)} style={{ fontSize: 8, background: "none", border: "1px solid #ffd70066", color: "#ffd700", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>AWARDS</button>
          <button onClick={onNewTournament} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>NEW</button>
          <button onClick={onBack} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>BACK</button>
        </div>
      </div>

      <div style={{ fontSize: 8, color: "#4a5568", marginBottom: 8, letterSpacing: 1 }}>CLICK ANY MATCH TO WATCH THE REPLAY</div>

      {/* bracket */}
      <div style={{ display: "flex", gap: 6, alignItems: "stretch", height: bracketHeight, marginBottom: 12, overflowX: "auto" }}>
        {bracketRounds.map((rd, ri) => (
          <div key={ri} style={{ display: "flex", flexDirection: "column", justifyContent: "space-around", minWidth: 140, flex: 1 }}>
            <div style={{ fontSize: 7, color: "#4a5568", textAlign: "center", letterSpacing: 1, marginBottom: 2, textTransform: "uppercase" }}>{rd.name}</div>
            {rd.matches.map((m, mi) => {
              const redA = agentBySlot[m.red_slot];
              const blackA = agentBySlot[m.black_slot];
              if (!redA || !blackA) {
                return <BracketSlot key={mi} red={{name:"TBD",seed:"?",slot:-1}} black={{name:"TBD",seed:"?",slot:-1}} winnerSlot={-1} tag={null} revealed={false} />;
              }
              return (
                <BracketSlot key={mi} red={redA} black={blackA} winnerSlot={m.winner_slot} tag={m.tag}
                  revealed={true} active={watchRound === ri && watchMatch === mi}
                  onClick={() => startWatch(ri, mi)} />
              );
            })}
          </div>
        ))}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 100 }}>
          <div style={{ fontSize: 7, color: "#4a5568", textAlign: "center", letterSpacing: 1, marginBottom: 2, textTransform: "uppercase" }}>Champion</div>
          <div style={{ padding: "6px 8px", background: "#111a11", border: "1px solid #ffd70044", borderRadius: 4, textAlign: "center" }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#ffd700" }}>{data.champion.name}</div>
            <div style={{ fontSize: 7, color: "#4a5568" }}>Seed #{data.champion.seed}</div>
          </div>
        </div>
      </div>

      {/* match replay area */}
      {watchingData && (
        <div style={{ background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 6, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#e74c3c" }}>#{watchingData.red.seed} {watchingData.red.name}</span>
              <span style={{ fontSize: 9, color: "#4a5568", margin: "0 6px" }}>vs</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#ecf0f1" }}>#{watchingData.black.seed} {watchingData.black.name}</span>
              {watchingData.tag && <span style={{ marginLeft: 8 }}><TagBadge tag={watchingData.tag} /></span>}
            </div>
            <div style={{ fontSize: 8, color: "#4a5568" }}>
              Move {boardStep}/{watchingData.boards.length - 1} | {watchingData.move_count} total
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <BoardGrid board={watchBoard} lastMove={watchLastMove} maxWidth={280} />
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                {!playing ? (
                  <button onClick={playMatch} style={{ padding: "4px 12px", borderRadius: 3, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontSize: 8, fontFamily: "inherit", cursor: "pointer", letterSpacing: 1 }}>PLAY</button>
                ) : (
                  <button onClick={pauseMatch} style={{ padding: "4px 12px", borderRadius: 3, border: "1px solid #e67e22", background: "transparent", color: "#e67e22", fontSize: 8, fontFamily: "inherit", cursor: "pointer", letterSpacing: 1 }}>PAUSE</button>
                )}
                <button onClick={() => { setBoardStep(0); stepRef.current = 0; }} style={{ padding: "4px 8px", borderRadius: 3, border: "1px solid #21262d", background: "transparent", color: "#4a5568", fontSize: 8, fontFamily: "inherit", cursor: "pointer" }}>|&lt;</button>
                <button onClick={() => { const mx = watchingData.boards.length - 1; setBoardStep(mx); stepRef.current = mx; }} style={{ padding: "4px 8px", borderRadius: 3, border: "1px solid #21262d", background: "transparent", color: "#4a5568", fontSize: 8, fontFamily: "inherit", cursor: "pointer" }}>&gt;|</button>
              </div>
              <div style={{ fontSize: 9, fontWeight: 700, color: watchingData.winner === "red" ? "#e74c3c" : "#ecf0f1", marginBottom: 4 }}>
                {watchingData.winner === "draw" ? "DRAW" : `${watchingData.winner_name} wins`}
              </div>
              <div style={{ fontSize: 8, color: "#4a5568" }}>R {watchingData.final_red} / B {watchingData.final_black} pieces</div>
              <div style={{ fontSize: 8, color: "#4a5568" }}>{watchingData.move_count} moves</div>
              {watchingData.tag && <div style={{ marginTop: 4 }}><TagBadge tag={watchingData.tag} /></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Tournament({ roster, onBack, loadRoster }) {
  const [phase, setPhase] = useState("setup");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const startTournament = async (agentIds, bracketSize, seeding) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/tournaments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_ids: agentIds, bracket_size: bracketSize, seeding }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const d = await res.json();
      setData(d); setPhase("bracket"); loadRoster();
    } catch (e) { alert(e.message); } finally { setLoading(false); }
  };

  if (phase === "setup") return <TournamentSetup roster={roster} onStart={startTournament} onBack={onBack} loading={loading} />;
  if (phase === "bracket") return <TournamentBracket data={data} onBack={onBack} onNewTournament={() => { setPhase("setup"); setData(null); }} roster={roster} />;
  return null;
}


function LevelBadge({ level }) {
  const gold = level >= 5;
  return (
    <span style={{ fontSize: 7, fontWeight: 700, padding: "0 3px", borderRadius: 2, background: gold ? "#ffd70022" : "#1a1f2b", color: gold ? "#ffd700" : "#4a5568", border: `1px solid ${gold ? "#ffd70044" : "#21262d"}` }}>
      Lv.{level}{gold ? " ★" : ""}
    </span>
  );
}

function XpBar({ xp, xpNext, level }) {
  if (!xpNext) return <span style={{ fontSize: 7, color: "#ffd700" }}>MAX</span>;
  const prevThreshold = { 1: 0, 2: 5, 3: 15, 4: 30, 5: 50 }[level] || 0;
  const progress = (xp - prevThreshold) / (xpNext - prevThreshold);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ flex: 1, height: 3, background: "#1a1f2b", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, progress * 100)}%`, height: "100%", background: "#4a5568", borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 6, color: "#3a4450", whiteSpace: "nowrap" }}>{xp}/{xpNext}</span>
    </div>
  );
}

function PerkBadge({ perk }) {
  if (!perk) return null;
  const info = PERK_INFO[perk];
  if (!info) return null;
  return (
    <span style={{ fontSize: 7, padding: "0 4px", borderRadius: 2, background: info.color + "18", color: info.color, border: `1px solid ${info.color}33` }}>
      {info.icon} {info.name}
    </span>
  );
}

function PerkSelector({ agentId, onSelect }) {
  const [saving, setSaving] = useState(false);
  const [chosen, setChosen] = useState(null);

  const confirm = async () => {
    if (!chosen) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/agents/${agentId}/perk`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ perk: chosen }),
      });
      if (res.ok) { const d = await res.json(); onSelect(d); }
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: 8, background: "#0a0c10", border: "1px solid #ffd70033", borderRadius: 6, marginTop: 6 }}>
      <div style={{ fontSize: 8, fontWeight: 700, color: "#ffd700", letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" }}>Choose a Perk</div>
      {Object.entries(PERK_INFO).map(([key, info]) => (
        <div key={key} onClick={() => setChosen(key)} style={{
          padding: "6px 8px", marginBottom: 4, borderRadius: 4, cursor: "pointer",
          background: chosen === key ? info.color + "15" : "#0d1117",
          border: `1px solid ${chosen === key ? info.color + "66" : "#1a1f2b"}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
            <span style={{ fontSize: 12 }}>{info.icon}</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: info.color }}>{info.name}</span>
          </div>
          <div style={{ fontSize: 8, color: "#8892a0" }}>{info.short}</div>
          <div style={{ fontSize: 7, color: "#4a5568", marginTop: 1 }}>{info.tag}</div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <button onClick={confirm} disabled={!chosen || saving} style={{
          flex: 1, padding: "4px 0", borderRadius: 3, border: "none", fontFamily: "inherit",
          background: chosen ? "#ffd70033" : "#21262d", color: chosen ? "#ffd700" : "#4a5568",
          fontSize: 8, fontWeight: 700, letterSpacing: 1, cursor: chosen ? "pointer" : "not-allowed",
        }}>{saving ? "..." : "CONFIRM"}</button>
      </div>
      <div style={{ fontSize: 7, color: "#3a4450", marginTop: 3, textAlign: "center" }}>you can change your perk anytime</div>
    </div>
  );
}

// --- roster panel (match mode) ---

function FormBadge({ form }) {
  if (form === "hot") return <span style={{ fontSize: 9 }} title="Hot: 4+ wins in last 5">🔥</span>;
  if (form === "cold") return <span style={{ fontSize: 9, opacity: 0.6 }} title="Cold: 4+ losses in last 5">🧊</span>;
  return null;
}

function AgentCard({ agent, selected, onClick, compact }) {
  return (
    <div onClick={onClick} style={{
      padding: compact ? "4px 6px" : "6px 8px", background: selected ? "#161b22" : "#0d1117",
      border: `1px solid ${selected ? "#2ecc71" : agent.form === "hot" ? "#e67e2244" : "#1a1f2b"}`, borderRadius: 4,
      cursor: onClick ? "pointer" : "default", marginBottom: 3, transition: "border-color 0.2s",
      opacity: agent.form === "cold" ? 0.8 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
          <LevelBadge level={agent.level || 1} />
          <FormBadge form={agent.form} />
          <span style={{ fontSize: 10, fontWeight: 700, color: selected ? "#2ecc71" : "#c8d0da", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</span>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#8892a0", flexShrink: 0 }}>{Math.round(agent.elo)}</span>
      </div>
      <MiniBars config={agent} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
        <span style={{ fontSize: 7, color: "#4a5568" }}>{agent.wins}W {agent.losses}L {agent.draws}D</span>
        {agent.perk && <PerkBadge perk={agent.perk} />}
      </div>
    </div>
  );
}

function RosterPanel({ side, color, selectedAgent, onSelect, roster, disabled, matchElo, matchEloDelta, onRosterChange, perkStatus }) {
  const [mode, setMode] = useState("roster");
  const [editConfig, setEditConfig] = useState({ ...defaultConfig });
  const [editName, setEditName] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);

  const refreshSuggestions = (cfg) => setSuggestions(localSuggestNames(cfg));

  const openCreate = () => { setEditConfig({ ...defaultConfig }); setEditName(""); setSuggestions(localSuggestNames(defaultConfig)); setEditingAgent(null); setMode("editor"); };
  const openEdit = (agent) => {
    const cfg = { aggression: agent.aggression, risk_tolerance: agent.risk_tolerance, king_priority: agent.king_priority, edge_affinity: agent.edge_affinity, trade_down: agent.trade_down };
    setEditConfig(cfg); setEditName(agent.name); setSuggestions([]); setEditingAgent(agent); setMode("editor");
  };
  const handleSliderChange = (key, val) => { const next = { ...editConfig, [key]: val }; setEditConfig(next); if (!editingAgent) refreshSuggestions(next); };
  const handleSave = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const url = editingAgent ? `${API}/agents/${editingAgent.id}` : `${API}/agents`;
      const method = editingAgent ? "PUT" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editName, ...editConfig }) });
      if (!res.ok) { const e = await res.json(); alert(e.detail || "save failed"); return; }
      const result = await res.json();
      onRosterChange(); onSelect(result); setMode("roster");
    } finally { setSaving(false); }
  };

  if (disabled && selectedAgent) {
    return (
      <div style={{ background: "#0d1117", border: `1px solid ${color}33`, borderRadius: 8, padding: 10, width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
          <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700, color }}>{side === "red" ? "RED" : "BLACK"}</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#c8d0da", marginBottom: 2 }}>{selectedAgent.name}</div>
        {matchElo !== null && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: "#c8d0da" }}>{Math.round(matchElo)}</span>
            <span style={{ fontSize: 8, color: "#4a5568" }}>ELO</span>
            {matchEloDelta != null && <span style={{ fontSize: 10, fontWeight: 700, color: matchEloDelta > 0 ? "#2ecc71" : matchEloDelta < 0 ? "#e74c3c" : "#4a5568" }}>{matchEloDelta > 0 ? "+" : ""}{Math.round(matchEloDelta)}</span>}
          </div>
        )}
        <MiniBars config={selectedAgent} /><OverextWarning config={selectedAgent} />
        <div style={{ marginTop: 4, fontSize: 7, color: "#4a5568" }}>{SLIDER_KEYS.map(s => `${s.short}${selectedAgent[s.key]}`).join("  ")}</div>
        {selectedAgent.perk && <div style={{ marginTop: 2 }}><PerkBadge perk={selectedAgent.perk} /></div>}
        {perkStatus && perkStatus.remaining > 0 && (() => {
          const pi = PERK_INFO[perkStatus.perk];
          return pi ? (
            <div style={{ marginTop: 4, padding: "3px 6px", borderRadius: 3, background: pi.color + "15", border: `1px solid ${pi.color}33`, transition: "all 0.2s" }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: pi.color }}>{pi.icon} {pi.name} ACTIVE</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                <div style={{ flex: 1, height: 3, background: "#1a1f2b", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${(perkStatus.remaining / (perkStatus.perk === "press" ? 4 : perkStatus.perk === "rope_a_dope" ? 3 : 2)) * 100}%`, height: "100%", background: pi.color, borderRadius: 2, transition: "width 0.3s" }} />
                </div>
                <span style={{ fontSize: 7, color: pi.color }}>{perkStatus.remaining}</span>
              </div>
            </div>
          ) : null;
        })()}
        {selectedAgent.form && selectedAgent.form !== "neutral" && (
          <div style={{ marginTop: 3, fontSize: 7, color: selectedAgent.form === "hot" ? "#e67e22" : "#3498db" }}>
            {selectedAgent.form === "hot" ? "🔥 HOT" : "🧊 COLD"}
          </div>
        )}
      </div>
    );
  }

  if (mode === "editor") {
    return (
      <div style={{ background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 8, padding: 10, width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700, color: "#8892a0" }}>{editingAgent ? "EDIT AGENT" : "NEW AGENT"}</span>
          <button onClick={() => setMode("roster")} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 6px", cursor: "pointer", fontFamily: "inherit" }}>CANCEL</button>
        </div>
        {editingAgent && <div style={{ fontSize: 7, color: "#e67e22", background: "rgba(230,126,34,0.1)", border: "1px solid rgba(230,126,34,0.2)", borderRadius: 3, padding: "2px 6px", marginBottom: 6 }}>changing config resets elo and record to 0</div>}
        <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Agent name..."
          style={{ width: "100%", padding: "5px 8px", fontSize: 11, fontWeight: 700, background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#c8d0da", fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" }} />
        {!editingAgent && suggestions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 8 }}>
            {suggestions.map(s => (
              <button key={s} onClick={() => setEditName(s)} style={{ fontSize: 7, padding: "1px 5px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", background: editName === s ? "#2ecc7122" : "#161b22", border: `1px solid ${editName === s ? "#2ecc71" : "#21262d"}`, color: editName === s ? "#2ecc71" : "#8b949e" }}>{s}</button>
            ))}
          </div>
        )}
        {SLIDER_KEYS.map(s => <Slider key={s.key} sliderKey={s.key} label={s.key.replace("_", " ")} value={editConfig[s.key]} color={color} onChange={(v) => handleSliderChange(s.key, v)} disabled={false} showDesc={true} />)}
        <div style={{ fontSize: 8, color: "#8892a0", marginTop: 2, padding: "2px 0" }}>ARCHETYPE: <span style={{ fontWeight: 700 }}>{detectArchetype(editConfig)}</span></div>
        <OverextWarning config={editConfig} />
        <button onClick={handleSave} disabled={saving || !editName.trim()} style={{
          width: "100%", marginTop: 8, padding: "6px 0", borderRadius: 4, border: "none",
          background: editName.trim() ? "linear-gradient(135deg, #2ecc71, #27ae60)" : "#21262d",
          color: editName.trim() ? "#fff" : "#4a5568", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase",
          cursor: editName.trim() ? "pointer" : "not-allowed", fontFamily: "inherit",
        }}>{saving ? "SAVING..." : editingAgent ? "SAVE CHANGES" : "SAVE AGENT"}</button>
      </div>
    );
  }

  return (
    <div style={{ background: "#0d1117", border: `1px solid ${color}33`, borderRadius: 8, padding: 10, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
        <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700, color }}>{side === "red" ? "RED AGENT" : "BLACK AGENT"}</span>
      </div>
      {selectedAgent && (
        <div style={{ marginBottom: 6, padding: "6px 8px", background: "#161b22", border: `1px solid ${color}44`, borderRadius: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <LevelBadge level={selectedAgent.level || 1} />
              <span style={{ fontSize: 12, fontWeight: 800, color: "#c8d0da" }}>{selectedAgent.name}</span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => openEdit(selectedAgent)} style={{ fontSize: 7, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 5px", cursor: "pointer", fontFamily: "inherit" }}>EDIT</button>
              <button onClick={() => onSelect(null)} style={{ fontSize: 7, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 5px", cursor: "pointer", fontFamily: "inherit" }}>X</button>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: "#8892a0" }}>{Math.round(selectedAgent.elo)} <span style={{ fontSize: 8, fontWeight: 400 }}>ELO</span></span>
            <span style={{ fontSize: 7, color: "#4a5568" }}>{selectedAgent.wins}W {selectedAgent.losses}L {selectedAgent.draws}D</span>
          </div>
          <XpBar xp={selectedAgent.xp || 0} xpNext={selectedAgent.xp_next} level={selectedAgent.level || 1} />
          <MiniBars config={selectedAgent} /><OverextWarning config={selectedAgent} />
          {selectedAgent.perk && <div style={{ marginTop: 3 }}><PerkBadge perk={selectedAgent.perk} /></div>}
          {(selectedAgent.level || 1) >= 5 && !selectedAgent.perk && (
            <PerkSelector agentId={selectedAgent.id} onSelect={(updated) => { onSelect(updated); onRosterChange(); }} />
          )}
        </div>
      )}
      <div style={{ maxHeight: selectedAgent ? 140 : 240, overflowY: "auto", marginBottom: 6 }}>
        {roster.map(a => <AgentCard key={a.id} agent={a} compact selected={selectedAgent?.id === a.id} onClick={() => onSelect(a)} />)}
      </div>
      <button onClick={openCreate} style={{ width: "100%", padding: "5px 0", borderRadius: 4, fontSize: 8, background: "#161b22", border: "1px solid #21262d", color: "#8b949e", cursor: "pointer", fontFamily: "inherit", letterSpacing: 2, textTransform: "uppercase" }}>+ CREATE NEW</button>
    </div>
  );
}


// --- multiplayer ---

function MultiplayerLobby({ roster, onBack }) {
  const [authToken, setAuthToken] = useState(null);
  const [player, setPlayer] = useState(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authError, setAuthError] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [betAmount, setBetAmount] = useState(0);
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [queueStatus, setQueueStatus] = useState(null);
  const [matchResult, setMatchResult] = useState(null);
  const [matchFound, setMatchFound] = useState(null);
  const [onlineCount, setOnlineCount] = useState(0);
  const wsRef = useRef(null);

  // poll online count
  useEffect(() => {
    const poll = () => fetch(`${API}/players/online`).then(r => r.json()).then(d => setOnlineCount(d.count)).catch(() => {});
    poll();
    const iv = setInterval(poll, 10000);
    return () => clearInterval(iv);
  }, []);

  const doAuth = async (mode) => {
    setAuthError(null);
    const url = mode === "register" ? `${API}/auth/register` : `${API}/auth/login`;
    const body = mode === "register" ? { username, display_name: displayName || username, password } : { username, password };
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json(); setAuthError(e.detail || "failed"); return; }
      const d = await res.json();
      setAuthToken(d.token); setPlayer(d);
    } catch { setAuthError("connection failed"); }
  };

  const connectWs = () => {
    if (!authToken) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/play?token=${authToken}`);
    wsRef.current = ws;
    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => { setWsStatus("disconnected"); setQueueStatus(null); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "connected") setWsStatus("connected");
      if (msg.type === "queue_status") setQueueStatus(msg);
      if (msg.type === "match_found") setMatchFound(msg);
      if (msg.type === "match_result") { setMatchResult(msg); setMatchFound(null); setQueueStatus(null); }
      if (msg.type === "bot_fallback") setQueueStatus({ ...queueStatus, bot_fallback: true });
      if (msg.type === "queue_cancelled") setQueueStatus(null);
    };
  };

  useEffect(() => { if (authToken) connectWs(); return () => wsRef.current?.close(); }, [authToken]);

  const joinQueue = () => {
    if (!selectedAgent || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "queue_join", agent_id: selectedAgent.id, bet_amount: betAmount }));
    setQueueStatus({ wait_time: 0 });
  };
  const cancelQueue = () => { wsRef.current?.send(JSON.stringify({ type: "queue_cancel" })); setQueueStatus(null); };

  // auth screen
  if (!authToken) {
    return (
      <div style={{ maxWidth: 400, margin: "40px auto", padding: "20px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: 4, color: "#9b59b6", textTransform: "uppercase" }}>Multiplayer</h2>
          <button onClick={onBack} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>BACK</button>
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <button onClick={() => setAuthMode("login")} style={{ flex: 1, padding: "4px 0", fontSize: 9, fontFamily: "inherit", cursor: "pointer", borderRadius: 3, background: authMode === "login" ? "#161b22" : "#0d1117", border: `1px solid ${authMode === "login" ? "#9b59b6" : "#21262d"}`, color: authMode === "login" ? "#9b59b6" : "#4a5568", letterSpacing: 1 }}>LOGIN</button>
          <button onClick={() => setAuthMode("register")} style={{ flex: 1, padding: "4px 0", fontSize: 9, fontFamily: "inherit", cursor: "pointer", borderRadius: 3, background: authMode === "register" ? "#161b22" : "#0d1117", border: `1px solid ${authMode === "register" ? "#9b59b6" : "#21262d"}`, color: authMode === "register" ? "#9b59b6" : "#4a5568", letterSpacing: 1 }}>REGISTER</button>
        </div>
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" style={{ width: "100%", padding: "6px 10px", fontSize: 11, background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#c8d0da", fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" }} />
        {authMode === "register" && <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Display name" style={{ width: "100%", padding: "6px 10px", fontSize: 11, background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#c8d0da", fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" }} />}
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" style={{ width: "100%", padding: "6px 10px", fontSize: 11, background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#c8d0da", fontFamily: "inherit", marginBottom: 8, boxSizing: "border-box" }} />
        {authError && <div style={{ fontSize: 9, color: "#e74c3c", marginBottom: 6 }}>{authError}</div>}
        <button onClick={() => doAuth(authMode)} style={{ width: "100%", padding: "8px 0", borderRadius: 4, border: "none", background: "linear-gradient(135deg, #9b59b6, #8e44ad)", color: "#fff", fontWeight: 700, fontSize: 11, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit" }}>
          {authMode === "register" ? "CREATE ACCOUNT" : "LOGIN"}
        </button>
      </div>
    );
  }

  // match result screen
  if (matchResult) {
    const won = matchResult.winner === matchResult.your_side;
    const opp = matchResult.opponent_reveal;
    return (
      <div style={{ maxWidth: 500, margin: "20px auto", padding: "16px" }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: 4, color: won ? "#2ecc71" : "#e74c3c", textTransform: "uppercase", textAlign: "center", marginBottom: 8 }}>
          {won ? "YOU WIN" : "YOU LOSE"}
        </h2>
        {matchResult.bet_result && (
          <div style={{ textAlign: "center", fontSize: 16, fontWeight: 800, color: matchResult.bet_result.result === "win" ? "#2ecc71" : "#e74c3c", marginBottom: 8 }}>
            {matchResult.bet_result.result === "win" ? `+${matchResult.bet_result.payout}` : `${matchResult.bet_result.net}`} coins
          </div>
        )}
        <div style={{ textAlign: "center", fontSize: 9, color: "#8892a0", marginBottom: 12 }}>
          Elo: {matchResult.elo_change.before} -> {matchResult.elo_change.after} ({matchResult.elo_change.delta > 0 ? "+" : ""}{matchResult.elo_change.delta})
        </div>
        <div style={{ padding: "8px 12px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4, textTransform: "uppercase" }}>Opponent revealed</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#e67e22" }}>{opp.agent_name}</div>
          <MiniBars config={opp} />
          <div style={{ fontSize: 7, color: "#8892a0", marginTop: 2 }}>A{opp.aggression} R{opp.risk_tolerance} K{opp.king_priority} E{opp.edge_affinity} T{opp.trade_down}</div>
          {opp.perk && <div style={{ marginTop: 2 }}><PerkBadge perk={opp.perk} /></div>}
        </div>
        <div style={{ maxWidth: 320, margin: "0 auto" }}>
          <BoardGrid board={matchResult.boards[matchResult.boards.length - 1]} lastMove={null} maxWidth={320} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
          <button onClick={() => { setMatchResult(null); setMatchFound(null); }} style={{ padding: "6px 16px", borderRadius: 4, border: "1px solid #9b59b6", background: "transparent", color: "#9b59b6", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, cursor: "pointer" }}>PLAY AGAIN</button>
          <button onClick={onBack} style={{ padding: "6px 16px", borderRadius: 4, border: "1px solid #21262d", background: "transparent", color: "#4a5568", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, cursor: "pointer" }}>BACK</button>
        </div>
      </div>
    );
  }

  // match found countdown
  if (matchFound) {
    return (
      <div style={{ maxWidth: 500, margin: "40px auto", padding: "20px 16px", textAlign: "center" }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, color: "#9b59b6", textTransform: "uppercase", marginBottom: 12 }}>Match Found</h2>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 20, marginBottom: 16 }}>
          <div><div style={{ fontSize: 12, fontWeight: 700, color: "#e74c3c" }}>{selectedAgent?.name}</div><div style={{ fontSize: 9, color: "#4a5568" }}>{selectedAgent?.elo} elo</div></div>
          <span style={{ fontSize: 11, color: "#4a5568" }}>vs</span>
          <div><div style={{ fontSize: 12, fontWeight: 700, color: "#ecf0f1" }}>{matchFound.opponent.agent_name}</div><div style={{ fontSize: 9, color: "#4a5568" }}>{matchFound.opponent.agent_elo} elo</div></div>
        </div>
        {matchFound.bet_amount > 0 && <div style={{ fontSize: 9, color: "#ffd700" }}>Bet: {matchFound.bet_amount} coins at {matchFound.odds}x</div>}
        <div style={{ fontSize: 11, color: "#4a5568", marginTop: 8 }}>Simulating...</div>
      </div>
    );
  }

  // lobby
  return (
    <div style={{ maxWidth: 500, margin: "20px auto", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, color: "#9b59b6", textTransform: "uppercase" }}>Multiplayer</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 8, color: "#4a5568" }}>Online: {onlineCount}</span>
          <span style={{ fontSize: 8, color: wsStatus === "connected" ? "#2ecc71" : "#e74c3c" }}>{wsStatus === "connected" ? "CONNECTED" : "OFFLINE"}</span>
          <button onClick={onBack} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>BACK</button>
        </div>
      </div>
      <div style={{ fontSize: 9, color: "#8892a0", marginBottom: 4 }}>Logged in as {player?.display_name}</div>

      <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4, marginTop: 12, textTransform: "uppercase" }}>Your agent</div>
      <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 12 }}>
        {roster.map(a => <AgentCard key={a.id} agent={a} selected={selectedAgent?.id === a.id} onClick={() => setSelectedAgent(a)} compact />)}
      </div>

      {selectedAgent && !queueStatus && (
        <>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4, textTransform: "uppercase" }}>Bet on yourself</div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {[0, 10, 50, 100, 250].map(amt => (
              <button key={amt} onClick={() => setBetAmount(amt)} style={{
                padding: "3px 10px", borderRadius: 3, fontSize: 8, fontFamily: "inherit", cursor: "pointer",
                background: betAmount === amt ? "#9b59b622" : "#161b22",
                border: `1px solid ${betAmount === amt ? "#9b59b6" : "#21262d"}`,
                color: betAmount === amt ? "#9b59b6" : "#8892a0",
              }}>{amt === 0 ? "SKIP" : amt}</button>
            ))}
          </div>
          <button onClick={joinQueue} style={{ width: "100%", padding: "10px 0", borderRadius: 6, border: "none", background: "linear-gradient(135deg, #9b59b6, #8e44ad)", color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: 4, cursor: "pointer", fontFamily: "inherit" }}>FIND MATCH</button>
        </>
      )}

      {queueStatus && (
        <div style={{ textAlign: "center", padding: "12px", background: "#0d1117", border: "1px solid #9b59b633", borderRadius: 6, marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#9b59b6", letterSpacing: 2, marginBottom: 4 }}>SEARCHING...</div>
          <div style={{ fontSize: 9, color: "#4a5568" }}>Wait: {queueStatus.wait_time}s | Elo range: {queueStatus.elo_range || 200}</div>
          {queueStatus.bot_fallback && <div style={{ fontSize: 9, color: "#e67e22", marginTop: 4 }}>No opponent found. Try VS BOT from the main menu.</div>}
          <button onClick={cancelQueue} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 3, border: "1px solid #e74c3c44", background: "transparent", color: "#e74c3c", fontSize: 8, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>CANCEL</button>
        </div>
      )}
    </div>
  );
}


// --- main app ---

export default function App() {
  const [appMode, setAppMode] = useState("match");
  const [matchMode, setMatchMode] = useState("vsbot");
  const [showHelp, setShowHelp] = useState(true);
  const [muted, setMuted] = useState(false);
  useEffect(() => { gameAudio.ensureInit(); }, []);
  const [wallet, setWallet] = useState({ balance: 1000, win_streak: 0 });
  const [jackpotPool, setJackpotPool] = useState(0);
  const [currentBet, setCurrentBet] = useState(null);
  const [betOdds, setBetOdds] = useState(null);
  const [coaches, setCoaches] = useState([]);
  const [selectedCoach, setSelectedCoach] = useState(null);
  const [roster, setRoster] = useState([]);
  const [redAgent, setRedAgent] = useState(null);
  const [blackAgent, setBlackAgent] = useState(null);
  const [boards, setBoards] = useState(null);
  const [moves, setMoves] = useState(null);
  const [events, setEvents] = useState([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState(400);
  const [history, setHistory] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [activeTab, setActiveTab] = useState("none");
  const [error, setError] = useState(null);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const stepRef = useRef(0);
  const maxStepRef = useRef(0);

  useEffect(() => { speedRef.current = speed; }, [speed]);

  const loadRoster = async () => { try { const res = await fetch(`${API}/agents`); if (res.ok) { const d = await res.json(); setRoster(d.agents); } } catch {} };
  const loadHistory = async () => { try { const res = await fetch(`${API}/history?limit=20`); if (res.ok) setHistory(await res.json()); } catch {} };
  const loadLeaderboard = async () => { try { const res = await fetch(`${API}/leaderboard?limit=15`); if (res.ok) { const d = await res.json(); setLeaderboard(d.agents || []); } } catch {} };
  const loadWallet = async () => { try { const res = await fetch(`${API}/wallet`); if (res.ok) setWallet(await res.json()); } catch {} };
  const loadJackpot = async () => { try { const res = await fetch(`${API}/jackpot`); if (res.ok) { const d = await res.json(); setJackpotPool(d.pool); } } catch {} };
  const loadOdds = async (rElo, bElo) => { try { const res = await fetch(`${API}/odds/match?red_elo=${rElo}&black_elo=${bElo}`); if (res.ok) setBetOdds(await res.json()); } catch {} };
  const loadCoaches = async () => { try { const res = await fetch(`${API}/coaches`); if (res.ok) { const d = await res.json(); setCoaches(d.coaches); } } catch {} };

  useEffect(() => { loadRoster(); loadHistory(); loadLeaderboard(); loadWallet(); loadCoaches(); loadJackpot(); }, []);
  useEffect(() => { if (roster.length >= 2 && !redAgent && !blackAgent && !boards) { setRedAgent(roster[0]); setBlackAgent(roster[1]); } }, [roster]);
  useEffect(() => {
    if (matchMode === "vsbot" && redAgent && selectedCoach) loadOdds(redAgent.elo, redAgent.elo);
    else if (matchMode === "sandbox" && redAgent && blackAgent) loadOdds(redAgent.elo, blackAgent.elo);
    else setBetOdds(null);
  }, [redAgent?.id, blackAgent?.id, selectedCoach?.id, matchMode]);

  const startGame = async () => {
    if (!redAgent || !blackAgent) { setError("select agents for both sides"); return; }
    setError(null); setLoading(true); setResult(null); setBoards(null); setMoves(null); setEvents([]); setCurrentStep(0);
    try {
      const body = {};
      if (matchMode === "vsbot" && selectedCoach) {
        body.red_agent_id = redAgent.id;
        body.vs_bot = { coach_id: selectedCoach.id };
      } else {
        body.red_agent_id = redAgent.id;
        body.black_agent_id = blackAgent.id;
      }
      if (currentBet) body.bet = currentBet;
      const res = await fetch(`${API}/game/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setBoards(data.boards); setMoves(data.moves); setEvents(data.events || []); setResult(data);
      maxStepRef.current = data.boards.length - 1; stepRef.current = 0; setCurrentStep(0);
      playingRef.current = true; setPlaying(true); playNext();
      loadRoster(); loadHistory(); loadLeaderboard(); loadWallet(); loadJackpot();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  const playNext = useCallback(() => {
    if (!playingRef.current) return;
    if (stepRef.current >= maxStepRef.current) { playingRef.current = false; setPlaying(false); return; }
    stepRef.current += 1; setCurrentStep(stepRef.current);
    setTimeout(playNext, speedRef.current);
  }, []);

  const pause = () => { playingRef.current = false; setPlaying(false); };
  const resume = () => { if (stepRef.current >= maxStepRef.current) return; playingRef.current = true; setPlaying(true); playNext(); };
  const resetGame = () => { setBoards(null); setMoves(null); setResult(null); setEvents([]); setCurrentStep(0); setCurrentBet(null); loadRoster(); loadWallet(); };

  const board = boards ? boards[currentStep] : null;
  const lastMove = moves && currentStep > 0 ? moves[currentStep - 1] : null;

  // sound effects on step change
  const prevStepRef = useRef(-1);
  useEffect(() => {
    if (!boards || !moves || currentStep === prevStepRef.current || currentStep === 0) { prevStepRef.current = currentStep; return; }
    prevStepRef.current = currentStep;
    const mv = moves[currentStep - 1];
    if (!mv) return;
    const isFast = speed < 150;
    if (mv.captures && mv.captures.length > 0) {
      if (mv.captures.length > 1) gameAudio.playCaptureChain(mv.captures.length);
      else gameAudio.playCapture();
    } else if (!isFast) {
      gameAudio.playMove();
    }
    // check for shrink event
    if (events.some(e => e.type === "shrink" && e.move === currentStep)) gameAudio.playShrink();
    // check for king promotion (compare boards)
    if (boards[currentStep] && boards[currentStep - 1]) {
      const prevKings = boards[currentStep - 1].flat().filter(c => c === RED_KING || c === BLACK_KING).length;
      const curKings = boards[currentStep].flat().filter(c => c === RED_KING || c === BLACK_KING).length;
      if (curKings > prevKings) gameAudio.playKingPromotion();
    }
  }, [currentStep]);
  const activeShrinkEvent = events.find(e => e.type === "shrink" && e.move === currentStep);
  const activeFatigueEvent = events.find(e => e.type === "fatigue" && e.move === currentStep);
  const activeOverextEvent = events.find(e => e.type === "overextension" && e.move === currentStep && e.pieces_lost >= 2);
  const activePerkEvent = events.find(e => e.type === "perk_activate" && e.move === currentStep);
  const activePerkStates = (() => {
    const states = {};
    for (const e of events) {
      if (e.move > currentStep) break;
      if (e.type === "perk_activate") states[e.side] = { perk: e.perk, remaining: e.duration - (currentStep - e.move) };
      if (e.type === "perk_deactivate" && e.move <= currentStep) delete states[e.side];
    }
    const result = {};
    for (const [side, s] of Object.entries(states)) {
      if (s.remaining > 0) result[side] = s;
    }
    return result;
  })();
  const currentPhase = (() => { if (!events.length) return null; const pc = events.filter(e => e.type === "phase_change" && e.move <= currentStep); return pc.length ? pc[pc.length - 1].phase : "opening"; })();
  const counts = board ? (() => { let r = 0, b = 0; for (let row of board) for (let cell of row) { if (cell === RED || cell === RED_KING) r++; if (cell === BLACK || cell === BLACK_KING) b++; } return { red: r, black: b }; })() : { red: 12, black: 12 };
  const isFinished = result && currentStep >= (boards?.length || 1) - 1;
  const redElo = result?.elo?.red_after || null;
  const blackElo = result?.elo?.black_after || null;
  const redEloDelta = result ? (result.elo.red_after - result.elo.red_before) : null;
  const blackEloDelta = result ? (result.elo.black_after - result.elo.black_before) : null;
  const canGo = redAgent && ((matchMode === "vsbot" && selectedCoach) || (matchMode === "sandbox" && blackAgent)) && !boards && !loading;

  if (appMode === "tournament") {
    return <Tournament roster={roster} onBack={() => { setAppMode("match"); loadRoster(); }} loadRoster={loadRoster} />;
  }
  if (appMode === "multiplayer") {
    return <MultiplayerLobby roster={roster} onBack={() => { setAppMode("match"); loadRoster(); }} />;
  }

  return (
    <div style={{ minHeight: "100vh", padding: "16px 12px" }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16 }}>
          <h1 style={{ fontSize: "clamp(16px, 4vw, 26px)", fontWeight: 800, letterSpacing: 6, textTransform: "uppercase", background: "linear-gradient(135deg, #e74c3c, #f39c12, #2ecc71)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Agent Checkers</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", background: "#161b22", border: "1px solid #ffd70033", borderRadius: 4 }}>
            <span style={{ fontSize: 14 }}>&#x1FA99;</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: "#ffd700" }}>{wallet.balance?.toLocaleString()}</span>
          </div>
          {wallet.win_streak >= 3 && (
            <span style={{ fontSize: 11, padding: "2px 6px", background: "#161b22", border: "1px solid #e67e2233", borderRadius: 4 }}>
              {wallet.win_streak >= 10 ? "💎" : wallet.win_streak >= 7 ? "🔥🔥🔥" : wallet.win_streak >= 5 ? "🔥🔥" : "🔥"}
              <span style={{ fontSize: 9, color: "#e67e22", marginLeft: 2 }}>{wallet.win_streak} ({wallet.win_streak >= 10 ? "5" : wallet.win_streak >= 7 ? "3" : wallet.win_streak >= 5 ? "2" : "1.5"}x)</span>
            </span>
          )}
          {jackpotPool > 0 && (
            <span style={{ fontSize: 10, padding: "2px 6px", background: "#161b22", border: "1px solid #9b59b633", borderRadius: 4, color: "#9b59b6" }}>
              💎 {jackpotPool.toLocaleString()}
            </span>
          )}
          <button onClick={() => { const next = !muted; setMuted(next); gameAudio.setMuted(next); }} style={{ padding: "3px 8px", background: "#0d1117", border: "1px solid #21262d", borderRadius: 4, color: muted ? "#4a5568" : "#8892a0", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6 }}>
          <button onClick={() => setAppMode("match")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#161b22", border: "1px solid #2ecc71", color: "#2ecc71", borderRadius: 3, textTransform: "uppercase" }}>MATCH</button>
          <button onClick={() => setAppMode("tournament")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#0d1117", border: "1px solid #f39c1266", color: "#f39c12", borderRadius: 3, textTransform: "uppercase" }}>TOURNAMENT</button>
          <button onClick={() => setAppMode("multiplayer")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#0d1117", border: "1px solid #9b59b666", color: "#9b59b6", borderRadius: 3, textTransform: "uppercase" }}>MULTIPLAYER</button>
        </div>
      </div>

      {showHelp ? (
        <div style={{ maxWidth: 480, margin: "0 auto 12px", padding: "8px 14px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, fontSize: 9, color: "#8892a0", lineHeight: 1.6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 2, color: "#4a5568", textTransform: "uppercase" }}>How it works</span>
            <button onClick={() => setShowHelp(false)} style={{ fontSize: 8, background: "none", border: "none", color: "#4a5568", cursor: "pointer", fontFamily: "inherit" }}>X</button>
          </div>
          <div>1. Pick two AI agents from your roster (or create your own)</div>
          <div>2. Each agent has a personality: aggressive, defensive, reckless, calculated</div>
          <div>3. Hit GO and watch them play checkers against each other. Best personality wins.</div>
        </div>
      ) : (
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <button onClick={() => setShowHelp(true)} style={{ fontSize: 10, background: "none", border: "1px solid #1a1f2b", color: "#4a5568", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>?</button>
        </div>
      )}

      {!boards && (
        <div style={{ display: "flex", justifyContent: "center", gap: 4, marginBottom: 8 }}>
          {["vsbot", "sandbox"].map(m => (
            <button key={m} onClick={() => { setMatchMode(m); setCurrentBet(null); if (m === "vsbot") setBlackAgent(null); else setSelectedCoach(null); }}
              style={{ padding: "3px 12px", fontSize: 8, fontWeight: 700, letterSpacing: 1, fontFamily: "inherit", cursor: "pointer", borderRadius: 3, textTransform: "uppercase", background: matchMode === m ? "#161b22" : "#0d1117", border: `1px solid ${matchMode === m ? "#2ecc71" : "#1a1f2b"}`, color: matchMode === m ? "#2ecc71" : "#4a5568" }}>
              {m === "vsbot" ? "VS BOT" : "SANDBOX"}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, maxWidth: 1060, margin: "0 auto", alignItems: "flex-start", flexWrap: "wrap", justifyContent: "center" }}>
        <div style={{ width: 220, flexShrink: 0 }}>
          <RosterPanel side="red" color="#e74c3c" selectedAgent={redAgent} onSelect={setRedAgent} roster={roster} disabled={playing || loading || !!boards} onRosterChange={loadRoster} matchElo={isFinished ? redElo : null} matchEloDelta={isFinished ? redEloDelta : null} perkStatus={activePerkStates?.red} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 280, maxWidth: 400 }}>
          {!boards && redAgent && (matchMode === "sandbox" ? blackAgent : selectedCoach) && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#e74c3c" }}>{redAgent.name}</span>
              <span style={{ fontSize: 9, color: "#4a5568" }}>vs</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: matchMode === "vsbot" ? "#e67e22" : "#ecf0f1" }}>
                {matchMode === "vsbot" ? selectedCoach?.name : blackAgent?.name}
              </span>
            </div>
          )}

          {/* stable board container: NEVER shifts position */}
          <div style={{ position: "relative", width: "100%", maxWidth: 380 }}>
            {/* win probability meter - inside stable container */}
            {boards && result?.win_probability && (() => {
              const wp = result.win_probability[currentStep] || 0.5;
              const redPct = Math.round(wp * 100);
              const blackPct = 100 - redPct;
              return (
                <div style={{ marginBottom: 2 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 1 }}>
                    <span style={{ fontSize: redPct >= 50 ? 10 : 8, fontWeight: redPct >= 50 ? 800 : 400, color: "#e74c3c" }}>{redPct}%</span>
                    <span style={{ fontSize: blackPct >= 50 ? 10 : 8, fontWeight: blackPct >= 50 ? 800 : 400, color: "#ecf0f1" }}>{blackPct}%</span>
                  </div>
                  <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#1a1f2b" }}>
                    <div style={{ width: `${redPct}%`, background: redPct > 60 ? "#e74c3c" : "#c0392b88", transition: "width 0.2s ease" }} />
                    <div style={{ flex: 1, background: blackPct > 60 ? "#bdc3c7" : "#95a5a688", transition: "width 0.2s ease" }} />
                  </div>
                </div>
              );
            })()}
            {/* material bar */}
            {boards && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                <span style={{ fontSize: 8, fontWeight: 700, color: "#e74c3c", width: 14, textAlign: "right" }}>{counts.red}</span>
                <div style={{ flex: 1, height: 4, background: "#1a1f2b", borderRadius: 2, overflow: "hidden", display: "flex" }}>
                  <div style={{ width: `${(counts.red / Math.max(counts.red + counts.black, 1)) * 100}%`, background: counts.red > counts.black + 1 ? "#e74c3c" : "#c0392b88", transition: "width 0.3s ease" }} />
                  <div style={{ flex: 1, background: counts.black > counts.red + 1 ? "#bdc3c7" : "#95a5a688", transition: "width 0.3s ease" }} />
                </div>
                <span style={{ fontSize: 8, fontWeight: 700, color: "#ecf0f1", width: 14 }}>{counts.black}</span>
              </div>
            )}

            {/* board with overlaid event banners */}
            <div style={{ position: "relative" }}>
              <BoardGrid board={board} lastMove={lastMove} />
              {/* overlay banners: position absolute, no layout shift */}
              {activeShrinkEvent && <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "6px 12px", background: "rgba(231,76,60,0.88)", borderRadius: "6px 6px 0 0", fontSize: 10, color: "#fff", letterSpacing: 1, textTransform: "uppercase", textAlign: "center", zIndex: 10 }}>board shrinking: {activeShrinkEvent.killed.length} squares eliminated</div>}
              {activeFatigueEvent && <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "6px 12px", background: "rgba(241,196,15,0.88)", borderRadius: "6px 6px 0 0", fontSize: 10, color: "#0d1117", letterSpacing: 1, textTransform: "uppercase", textAlign: "center", zIndex: 10 }}>king fatigue: idle kings demoted</div>}
              {activeOverextEvent && <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "6px 12px", background: "rgba(230,126,34,0.88)", borderRadius: "0 0 6px 6px", fontSize: 10, color: "#fff", letterSpacing: 1, textTransform: "uppercase", textAlign: "center", zIndex: 10 }}>overextension: {activeOverextEvent.side} lost {activeOverextEvent.pieces_lost} pieces</div>}
              {activePerkEvent && (() => { const pi = PERK_INFO[activePerkEvent.perk]; return pi ? (
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "4px 12px", background: pi.color + "dd", borderRadius: "6px 6px 0 0", fontSize: 9, color: "#fff", letterSpacing: 1, textTransform: "uppercase", textAlign: "center", zIndex: 10 }}>
                  {activePerkEvent.side}: {pi.name} ({activePerkEvent.duration} moves)
                </div>
              ) : null; })()}
            </div>
          </div>

          {/* betting panel / bet indicator */}
          {canGo && !currentBet && betOdds && (
            <div style={{ width: "100%", padding: "8px 12px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, marginTop: 8 }}>
              <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 2, textTransform: "uppercase", textAlign: "center", marginBottom: 4 }}>Place your bet</div>
              {wallet.win_streak >= 3 && <div style={{ fontSize: 8, color: "#e67e22", textAlign: "center", marginBottom: 4 }}>🔥 Streak bonus: {wallet.win_streak >= 10 ? "5" : wallet.win_streak >= 7 ? "3" : wallet.win_streak >= 5 ? "2" : "1.5"}x on all payouts</div>}
              <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 6 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: "#e74c3c" }}>RED</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#e74c3c" }}>{betOdds.red}x</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: "#4a5568" }}>DRAW</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#4a5568" }}>{betOdds.draw}x</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: "#ecf0f1" }}>BLACK</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#ecf0f1" }}>{betOdds.black}x</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, justifyContent: "center", marginBottom: 6 }}>
                {[10, 50, 100, 250].filter(a => a <= wallet.balance).map(amt => (
                  <button key={amt} onClick={() => {
                    setCurrentBet(prev => prev?.amount === amt ? { ...prev } : null);
                    setCurrentBet(null);
                  }} style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "#161b22", border: "1px solid #21262d", color: "#8892a0", cursor: "pointer", fontFamily: "inherit" }}>{amt}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                {["red", "black", "draw"].map(side => {
                  const colors = { red: "#e74c3c", black: "#ecf0f1", draw: "#4a5568" };
                  return [10, 50, 100, 250].filter(a => a <= wallet.balance).length > 0 ? (
                    <button key={side} onClick={() => {
                      const amt = Math.min(100, wallet.balance);
                      setCurrentBet({ side, amount: amt });
                    }} style={{ padding: "4px 12px", borderRadius: 3, border: `1px solid ${colors[side]}44`, background: "transparent", color: colors[side], fontSize: 8, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase" }}>BET {side.toUpperCase()}</button>
                  ) : null;
                })}
                <button onClick={startGame} style={{ padding: "4px 16px", borderRadius: 3, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontSize: 8, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>SKIP</button>
              </div>
              <div style={{ textAlign: "center", fontSize: 7, color: "#3a4450", marginTop: 4 }}>Balance: {wallet.balance?.toLocaleString()}</div>
            </div>
          )}
          {canGo && currentBet && (
            <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 8, padding: "6px 12px", background: "#0d1117", border: "1px solid #ffd70033", borderRadius: 6 }}>
              <span style={{ fontSize: 9, color: "#ffd700" }}>BET: {currentBet.amount} on {currentBet.side.toUpperCase()} ({betOdds?.[currentBet.side]}x)</span>
              <span style={{ fontSize: 8, color: "#4a5568" }}>Potential: {Math.floor(currentBet.amount * (betOdds?.[currentBet.side] || 1))}</span>
              <button onClick={() => setCurrentBet(null)} style={{ fontSize: 7, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 6px", cursor: "pointer", fontFamily: "inherit" }}>CANCEL</button>
              <button onClick={startGame} style={{ padding: "6px 24px", borderRadius: 4, border: "none", background: "linear-gradient(135deg, #2ecc71, #27ae60)", color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: 3, cursor: "pointer", fontFamily: "inherit" }}>GO</button>
            </div>
          )}
          {canGo && !betOdds && <button onClick={startGame} style={{ marginTop: 8, padding: "10px 36px", borderRadius: 6, border: "none", background: "linear-gradient(135deg, #2ecc71, #27ae60)", color: "#fff", fontWeight: 800, fontSize: 14, letterSpacing: 4, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", boxShadow: "0 0 24px rgba(46,204,113,0.3)" }}>GO</button>}

          {/* bet indicator during match */}
          {boards && result?.bet && (
            <div style={{ width: "100%", padding: "3px 10px", background: result.bet.side === "red" ? "rgba(231,76,60,0.08)" : result.bet.side === "black" ? "rgba(236,240,241,0.06)" : "rgba(74,85,104,0.1)", borderRadius: 3, textAlign: "center", fontSize: 8, color: "#ffd700", marginTop: 4 }}>
              &#x1FA99; {result.bet.amount} on {result.bet.side.toUpperCase()} ({result.bet.odds}x) = {Math.floor(result.bet.amount * result.bet.odds)} potential
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {!boards && !loading && (!redAgent || !blackAgent) && <span style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1 }}>SELECT BOTH AGENTS</span>}
            {loading && <span style={{ fontSize: 11, color: "#4a5568", letterSpacing: 2 }}>SIMULATING...</span>}
            {boards && playing && <button onClick={pause} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #e67e22", background: "transparent", color: "#e67e22", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>PAUSE</button>}
            {boards && !playing && !isFinished && <button onClick={resume} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>RESUME</button>}
            {isFinished && result?.bet && (
              <div style={{ padding: "6px 16px", borderRadius: 6, textAlign: "center", background: result.bet.result === "win" ? "rgba(46,204,113,0.1)" : "rgba(231,76,60,0.1)", border: `1px solid ${result.bet.result === "win" ? "rgba(46,204,113,0.3)" : "rgba(231,76,60,0.3)"}` }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: result.bet.result === "win" ? "#2ecc71" : "#e74c3c" }}>
                  {result.bet.result === "win" ? `+${result.bet.payout}` : `${result.bet.net}`}
                </div>
                <div style={{ fontSize: 9, color: "#8892a0" }}>{result.bet.amount} bet on {result.bet.side.toUpperCase()} at {result.bet.odds}x</div>
                {result.bet.bankrupt && <div style={{ fontSize: 9, color: "#ffd700", marginTop: 2 }}>Bankrupt! Here's 500 coins to get back in the game.</div>}
                {result.bet.streak && <div style={{ fontSize: 8, color: "#e67e22", marginTop: 2 }}>{result.bet.result === "win" ? `🔥 Streak: ${result.bet.streak.streak}` : "Streak broken"}</div>}
                {result.bet.effective_odds && result.bet.effective_odds !== result.bet.odds && (
                  <div style={{ fontSize: 8, color: "#4a5568", marginTop: 1 }}>Streak boosted: {result.bet.odds}x * {result.bet.streak_mult}x = {result.bet.effective_odds}x</div>
                )}
              </div>
            )}
            {/* near-miss for lost bets */}
            {isFinished && result?.bet?.result === "loss" && boards && (() => {
              const side = result.bet.side;
              let bestAdv = -Infinity, bestMove = 0;
              for (let i = 0; i < boards.length; i++) {
                let r = 0, b = 0;
                for (const row of boards[i]) for (const c of row) { if (c === RED || c === RED_KING) r++; if (c === BLACK || c === BLACK_KING) b++; }
                const adv = side === "red" ? r - b : b - r;
                if (adv > bestAdv) { bestAdv = adv; bestMove = i; }
              }
              if (bestAdv >= 2) return (
                <div style={{ padding: "4px 10px", background: "rgba(231,76,60,0.06)", border: "1px solid rgba(231,76,60,0.15)", borderRadius: 4, fontSize: 8, color: "#e67e22", textAlign: "center" }}>
                  SO CLOSE: Your side was ahead by {bestAdv} at move {bestMove}
                </div>
              );
              if (bestAdv >= 0) return (
                <div style={{ padding: "4px 10px", background: "rgba(231,76,60,0.06)", border: "1px solid rgba(231,76,60,0.15)", borderRadius: 4, fontSize: 8, color: "#4a5568", textAlign: "center" }}>
                  Close game. Tied at move {bestMove}.
                </div>
              );
              return null;
            })()}
            {isFinished && (
              <>
                <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: result.winner === "red" ? "#e74c3c" : result.winner === "black" ? "#ecf0f1" : "#f39c12" }}>{result.winner === "draw" ? "DRAW" : `${result.winner === "red" ? (result.red_agent?.name || "RED") : (result.black_agent?.name || "BLACK")} wins`}</span>
                <button onClick={resetGame} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>REMATCH</button>
              </>
            )}
            {isFinished && boards && moves && result.winner !== "draw" && (() => {
              // turning point analysis
              const balances = boards.map(b => {
                let r = 0, bl = 0;
                for (const row of b) for (const c of row) { if (c === RED || c === RED_KING) r++; if (c === BLACK || c === BLACK_KING) bl++; }
                return r - bl;
              });
              const w = result.winner;
              let turningMove = -1;
              for (let i = 0; i < balances.length; i++) {
                const adv = w === "red" ? balances[i] : -balances[i];
                if (adv >= 1) {
                  let held = true;
                  for (let j = i; j < balances.length; j++) { if ((w === "red" ? balances[j] : -balances[j]) < 1) { held = false; break; } }
                  if (held) { turningMove = i; break; }
                }
              }
              const leadChanges = balances.reduce((c, b, i) => i > 0 && Math.sign(b) !== Math.sign(balances[i - 1]) && balances[i - 1] !== 0 ? c + 1 : c, 0);
              let tpText = "";
              if (turningMove >= 0 && turningMove < balances.length - 5) {
                const mv = moves[Math.max(0, turningMove - 1)];
                const caps = mv?.captures?.length || 0;
                const rp = w === "red" ? balances[turningMove] + (balances[turningMove] < 0 ? 12 : 12 - balances[turningMove]) : 12;
                tpText = `Move ${turningMove}${caps > 0 ? `: ${caps > 1 ? caps + "x capture" : "capture"}` : ""}. ${w === "red" ? "Red" : "Black"} took the lead and held it.`;
              } else {
                tpText = leadChanges > 2 ? `Close match. Lead changed ${leadChanges} times. Decided in the final moves.` : `Gradual advantage. No single turning point.`;
              }
              // perk impact
              const perkActs = events.filter(e => e.type === "perk_activate");
              const perkLines = [];
              for (const side of ["red", "black"]) {
                const acts = perkActs.filter(e => e.side === side);
                if (acts.length > 0) {
                  const perkName = PERK_INFO[acts[0].perk]?.name || acts[0].perk;
                  perkLines.push(`${side === "red" ? "Red" : "Black"}'s ${perkName} activated ${acts.length} time${acts.length > 1 ? "s" : ""}`);
                }
              }
              // suggestion for the loser
              const loser = w === "red" ? "black" : "red";
              const loserAgent = loser === "red" ? result.red_agent : result.black_agent;
              const loserCfg = loserAgent || {};
              let suggestion = "Tough loss. Try a different perk or adjust sliders for this matchup.";
              if ((loserCfg.aggression || 50) > 70 && result.move_count < 60) suggestion = "Your agent overextended. Consider lowering risk tolerance or adding Rope-a-Dope.";
              else if ((loserCfg.aggression || 50) < 30) suggestion = "Your agent was too passive. Consider raising aggression or adding Press.";
              else if (turningMove > 0 && turningMove < result.move_count * 0.4) suggestion = "Your agent fell behind early. Consider a more aggressive opening config.";
              else if (result.move_count > 80) suggestion = "Long match. Consider raising king priority for better endgame play.";
              return (
                <div style={{ width: "100%", padding: "6px 10px", background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 4, fontSize: 8, marginTop: 4 }}>
                  <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 3 }}>Post-match breakdown</div>
                  <div style={{ color: "#8892a0", marginBottom: 2 }}><span style={{ color: "#4a5568" }}>TURNING POINT:</span> {tpText}</div>
                  {perkLines.length > 0 && <div style={{ color: "#8892a0", marginBottom: 2 }}><span style={{ color: "#4a5568" }}>PERKS:</span> {perkLines.join(". ")}</div>}
                  <div style={{ color: "#e67e22" }}><span style={{ color: "#4a5568" }}>TIP:</span> {suggestion}</div>
                </div>
              );
            })()}
            {isFinished && result.level_ups && result.level_ups.map((lu, i) => (
              <div key={i} style={{ padding: "4px 10px", borderRadius: 4, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", background: lu.perk_unlocked ? "rgba(255,215,0,0.12)" : "rgba(46,204,113,0.12)", border: `1px solid ${lu.perk_unlocked ? "rgba(255,215,0,0.3)" : "rgba(46,204,113,0.3)"}`, color: lu.perk_unlocked ? "#ffd700" : "#2ecc71" }}>
                {lu.name} reached Level {lu.new_level}{lu.perk_unlocked ? " -- Choose a perk!" : ""}
              </div>
            ))}
            {/* new personal bests */}
            {isFinished && result.new_records && result.new_records.length > 0 && (
              <div style={{ padding: "4px 10px", background: "rgba(255,215,0,0.06)", border: "1px solid rgba(255,215,0,0.15)", borderRadius: 4, fontSize: 8 }}>
                <div style={{ color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 }}>{result.winner !== "red" ? "Loss, but..." : ""} New personal bests</div>
                {result.new_records.map((r, i) => (
                  <div key={i} style={{ color: "#ffd700" }}>🏆 {r.record.replace("_", " ")}: {r.value} {r.previous > 0 ? `(was ${r.previous})` : ""}</div>
                ))}
              </div>
            )}
            {/* rivalry update */}
            {isFinished && result.rivalry && result.rivalry.is_nemesis && (
              <div style={{ padding: "4px 10px", background: "rgba(231,76,60,0.08)", border: "1px solid rgba(231,76,60,0.2)", borderRadius: 4, fontSize: 8 }}>
                <span style={{ color: "#e74c3c" }}>⚔ NEMESIS: {result.rivalry.opponent_label}</span>
                <span style={{ color: "#4a5568", marginLeft: 6 }}>{result.rivalry.wins}W {result.rivalry.losses}L</span>
              </div>
            )}
            {isFinished && result.rivalry && !result.rivalry.is_nemesis && result.rivalry.wins > 0 && result.rivalry.losses > 0 && (
              <div style={{ padding: "4px 10px", fontSize: 8, color: "#4a5568" }}>
                Rivalry with {result.rivalry.opponent_label}: {result.rivalry.wins}W {result.rivalry.losses}L
              </div>
            )}
            {/* revenge offer */}
            {isFinished && result.revenge_available && (
              <div style={{ padding: "6px 10px", background: "rgba(230,126,34,0.08)", border: "1px solid rgba(230,126,34,0.25)", borderRadius: 4, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#e67e22", fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>⚔ REVENGE MATCH</div>
                <div style={{ fontSize: 8, color: "#8892a0", marginBottom: 4 }}>Same opponent. Odds boosted 1.5x.</div>
                <button onClick={async () => {
                  const body = { agent_id: redAgent.id, opponent_config: result.revenge_available.opponent_config, opponent_perk: result.revenge_available.opponent_perk };
                  try {
                    const res = await fetch(`${API}/game/revenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                    if (res.ok) { const d = await res.json(); setBoards(d.boards); setMoves(d.moves); setEvents(d.events || []); setResult(d); maxStepRef.current = d.boards.length - 1; stepRef.current = 0; setCurrentStep(0); playingRef.current = true; setPlaying(true); playNext(); loadWallet(); loadJackpot(); }
                  } catch {}
                }} style={{ padding: "4px 16px", borderRadius: 3, border: "none", background: "#e67e22", color: "#fff", fontWeight: 700, fontSize: 9, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>ACCEPT REVENGE</button>
              </div>
            )}
          </div>

          {error && <p style={{ color: "#e74c3c", fontSize: 10, marginTop: 6 }}>{error}</p>}

          {/* playback controls + scrubber */}
          {boards && (() => {
            const maxStep = boards.length - 1;
            const stepBack = () => { if (currentStep > 0) { playingRef.current = false; setPlaying(false); stepRef.current = currentStep - 1; setCurrentStep(currentStep - 1); } };
            const stepFwd = () => { if (currentStep < maxStep) { playingRef.current = false; setPlaying(false); stepRef.current = currentStep + 1; setCurrentStep(currentStep + 1); } };
            const jumpStart = () => { playingRef.current = false; setPlaying(false); stepRef.current = 0; setCurrentStep(0); };
            const jumpEnd = () => { playingRef.current = false; setPlaying(false); stepRef.current = maxStep; setCurrentStep(maxStep); };
            const onScrub = (e) => { const v = parseInt(e.target.value); playingRef.current = false; setPlaying(false); stepRef.current = v; setCurrentStep(v); };
            const ctrlBtn = (label, fn) => <button onClick={fn} style={{ padding: "2px 6px", borderRadius: 3, border: "1px solid #21262d", background: "#0d1117", color: "#8892a0", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>{label}</button>;
            return (
              <div style={{ width: "100%", maxWidth: 380, marginTop: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center", marginBottom: 4 }}>
                  {ctrlBtn("|<", jumpStart)} {ctrlBtn("<", stepBack)}
                  {playing ? ctrlBtn("||", pause) : ctrlBtn("▶", resume)}
                  {ctrlBtn(">", stepFwd)} {ctrlBtn(">|", jumpEnd)}
                  <span style={{ fontSize: 8, color: "#4a5568", marginLeft: 6 }}>Move {currentStep}/{maxStep}</span>
                  {currentPhase && currentStep > 0 && <span style={{ fontSize: 7, fontWeight: 700, color: currentPhase === "opening" ? "#3498db" : currentPhase === "midgame" ? "#e67e22" : "#e74c3c", marginLeft: 4 }}>{currentPhase.toUpperCase()}</span>}
                  <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
                    <span style={{ fontSize: 7, color: "#4a5568" }}>SPD</span>
                    <input type="range" min="50" max="800" value={850 - speed} onChange={(e) => setSpeed(850 - parseInt(e.target.value))} style={{ width: 40, background: "#1a1f2b", accentColor: "#2ecc71" }} />
                  </div>
                </div>
                {/* scrubber bar with event markers */}
                <div style={{ position: "relative", width: "100%", height: 12 }}>
                  <input type="range" min={0} max={maxStep} value={currentStep} onChange={onScrub}
                    style={{ width: "100%", height: 4, position: "absolute", top: 4, accentColor: "#2ecc71", background: "#1a1f2b", cursor: "pointer" }} />
                  {maxStep > 0 && events.filter(e => e.type === "shrink" || (e.type === "perk_activate")).map((e, i) => (
                    <div key={i} onClick={() => { stepRef.current = e.move; setCurrentStep(e.move); }} style={{
                      position: "absolute", top: 1, width: 4, height: 4, borderRadius: "50%", cursor: "pointer",
                      left: `${(e.move / maxStep) * 100}%`,
                      background: e.type === "shrink" ? "#8b0000" : "#e67e22",
                    }} />
                  ))}
                  {maxStep > 0 && moves && moves.map((m, i) => m.captures.length > 0 ? (
                    <div key={`c${i}`} onClick={() => { stepRef.current = i + 1; setCurrentStep(i + 1); }} style={{
                      position: "absolute", top: 2, width: 3, height: 3, borderRadius: "50%", cursor: "pointer",
                      left: `${((i + 1) / maxStep) * 100}%`, background: "#e74c3c44",
                    }} />
                  ) : null)}
                </div>
                {/* perk states */}
                {Object.keys(activePerkStates).length > 0 && (
                  <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 2 }}>
                    {Object.entries(activePerkStates).map(([side, s]) => { const pi = PERK_INFO[s.perk]; return pi ? (
                      <span key={side} style={{ color: pi.color, fontSize: 7 }}>{side === "red" ? "R" : "B"}: {pi.name} ({s.remaining})</span>
                    ) : null; })}
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ width: "100%", marginTop: 10 }}>
            <div style={{ display: "flex", gap: 0 }}>
              {["history", "leaderboard"].map((tab) => (
                <button key={tab} onClick={() => { setActiveTab(activeTab === tab ? "none" : tab); if (tab === "leaderboard") loadLeaderboard(); if (tab === "history") loadHistory(); }}
                  style={{ flex: 1, padding: "5px 0", fontSize: 8, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "inherit", cursor: "pointer", background: activeTab === tab ? "#161b22" : "#0d1117", border: `1px solid ${activeTab === tab ? "#2ecc71" : "#1a1f2b"}`, color: activeTab === tab ? "#2ecc71" : "#4a5568", borderRadius: tab === "history" ? "4px 0 0 4px" : "0 4px 4px 0" }}>{tab === "history" ? "HISTORY" : "LEADERBOARD"}</button>
              ))}
            </div>
            {activeTab === "history" && (
              <div style={{ background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: "0 0 4px 4px", borderTop: "none", padding: 6, maxHeight: 160, overflowY: "auto" }}>
                {history.length === 0 && <p style={{ fontSize: 8, color: "#3a4450" }}>no matches yet</p>}
                {history.map((m) => (
                  <div key={m.id} style={{ padding: "4px 0", borderBottom: "1px solid #1a1f2b", fontSize: 8, color: "#8892a0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>#{m.id}</span>
                      <span style={{ fontWeight: 700, color: m.winner === "red" ? "#e74c3c" : m.winner === "black" ? "#ecf0f1" : "#f39c12" }}>{m.winner === "draw" ? "DRAW" : `${m.winner.toUpperCase()}`}</span>
                    </div>
                    <div style={{ color: "#3a4450" }}>{m.move_count} moves</div>
                  </div>
                ))}
              </div>
            )}
            {activeTab === "leaderboard" && (
              <div style={{ background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: "0 0 4px 4px", borderTop: "none", padding: 6, maxHeight: 160, overflowY: "auto" }}>
                {leaderboard.length === 0 && <p style={{ fontSize: 8, color: "#3a4450" }}>play 3+ matches with an agent to rank it</p>}
                {leaderboard.map((a, i) => (
                  <div key={a.id} style={{ padding: "4px 6px", borderBottom: "1px solid #1a1f2b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 10, fontWeight: 700, color: i === 0 ? "#ffd700" : i === 1 ? "#bdc3c7" : i === 2 ? "#cd7f32" : "#8892a0" }}>#{i + 1}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: "#c8d0da", marginLeft: 6 }}>{a.name}</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#c8d0da" }}>{Math.round(a.elo)}</span>
                      <div style={{ fontSize: 7, color: "#4a5568" }}>{a.wins}W {a.losses}L / {a.win_rate}%</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ width: 220, flexShrink: 0 }}>
          {matchMode === "sandbox" ? (
            <RosterPanel side="black" color="#ecf0f1" selectedAgent={blackAgent} onSelect={setBlackAgent} roster={roster} disabled={playing || loading || !!boards} onRosterChange={loadRoster} matchElo={isFinished ? blackElo : null} matchEloDelta={isFinished ? blackEloDelta : null} />
          ) : (
            <div style={{ background: "#0d1117", border: "1px solid #e67e2233", borderRadius: 8, padding: 10, width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700, color: "#e67e22" }}>OPPONENT</span>
              </div>
              {/* during/after match: show bot info */}
              {boards && result?.bot_opponent && (
                <div style={{ padding: "6px 8px", background: "#161b22", border: "1px solid #e67e2244", borderRadius: 4, marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#e67e22" }}>{result.bot_opponent.name}</div>
                  <div style={{ fontSize: 8, color: "#4a5568", marginBottom: 4 }}>{result.bot_opponent.coach_name}</div>
                  {isFinished ? (
                    <>
                      <MiniBars config={result.bot_opponent} />
                      <div style={{ fontSize: 7, color: "#8892a0", marginTop: 2 }}>
                        {SLIDER_KEYS.map(s => `${s.short}${result.bot_opponent[s.key]}`).join("  ")}
                      </div>
                      {result.bot_opponent.perk && <div style={{ marginTop: 2 }}><PerkBadge perk={result.bot_opponent.perk} /></div>}
                    </>
                  ) : (
                    <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                      {SLIDER_KEYS.map(s => <span key={s.key} style={{ flex: 1, textAlign: "center", fontSize: 14, color: "#21262d" }}>?</span>)}
                    </div>
                  )}
                </div>
              )}
              {/* coach selector */}
              {!boards && (
                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                  {coaches.map(c => {
                    const sel = selectedCoach?.id === c.id;
                    const diffColor = c.difficulty === "easy" ? "#2ecc71" : c.difficulty === "medium" ? "#e67e22" : "#e74c3c";
                    return (
                      <div key={c.id} onClick={() => setSelectedCoach(c)} style={{
                        padding: "6px 8px", marginBottom: 3, borderRadius: 4, cursor: "pointer",
                        background: sel ? "#1a1510" : "#0d1117", border: `1px solid ${sel ? "#e67e2266" : "#1a1f2b"}`,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: sel ? "#e67e22" : "#c8d0da" }}>{c.icon} {c.name}</span>
                          <span style={{ fontSize: 7, fontWeight: 700, color: diffColor, textTransform: "uppercase" }}>{c.difficulty}</span>
                        </div>
                        <div style={{ fontSize: 8, color: "#8892a0", fontStyle: "italic" }}>"{c.title}"</div>
                        {sel && <div style={{ fontSize: 7, color: "#4a5568", marginTop: 2 }}>{c.strategy}</div>}
                      </div>
                    );
                  })}
                  <div onClick={() => setSelectedCoach({ id: "random", name: "Random", title: "Surprise me", icon: "🎲" })}
                    style={{ padding: "5px 8px", borderRadius: 4, cursor: "pointer", textAlign: "center",
                      background: selectedCoach?.id === "random" ? "#1a1510" : "#0d1117",
                      border: `1px solid ${selectedCoach?.id === "random" ? "#e67e2266" : "#1a1f2b"}`,
                      fontSize: 8, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase",
                    }}>
                    🎲 RANDOM OPPONENT
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
