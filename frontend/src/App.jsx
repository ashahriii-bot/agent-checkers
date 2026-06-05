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
  rope_a_dope: { name: "COUNTER", color: "#3498db", icon: "🛡️", short: "Tightens defense after being attacked", tag: "Strong vs aggressive fighters", unlock: 5 },
  press: { name: "SURGE", color: "#e67e22", icon: "⚡", short: "Forces action during stalemates", tag: "Strong vs defensive fighters", unlock: 5 },
  momentum: { name: "FRENZY", color: "#2ecc71", icon: "🔥", short: "Captures breed more captures", tag: "Strong vs mid-range fighters", unlock: 5 },
  anchor: { name: "ANCHOR", color: "#16a085", icon: "⚓", short: "Back-row pieces become a fortress", tag: "Strong vs aggressors", unlock: 15 },
  phantom: { name: "PHANTOM", color: "#9b59b6", icon: "👻", short: "Calculated counter-attack while behind", tag: "Strong vs grinders", unlock: 15 },
  siege: { name: "SIEGE", color: "#e74c3c", icon: "🏰", short: "Kings become assault weapons", tag: "Strong vs turtles", unlock: 25 },
  flux: { name: "FLUX", color: "#f1c40f", icon: "🌀", short: "Playstyle shifts every 8 moves", tag: "Strong vs adaptive foes", unlock: 25 },
};
const EDGE_ORDER = ["rope_a_dope", "press", "momentum", "anchor", "phantom", "siege", "flux"];

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

function Piece({ type, highlight, level = 1, flashColor = null }) {
  if (type <= 0) return null;
  const red = isRed(type);
  const king = isKing(type);
  // cosmetic confidence by level band (visual only, no gameplay effect -- spec Layer 4):
  // 1-4 standard / 5-9 subtle glow / 10-14 defined glow+sharper shadow / 15-19 veteran
  // stripe ring / 20-24 gold-tinted ring / 25+ full gold ring, confident glow, larger shadow.
  const tier = level >= 25 ? 5 : level >= 20 ? 4 : level >= 15 ? 3 : level >= 10 ? 2 : level >= 5 ? 1 : 0;
  const glowRGB = red ? "231,76,60" : "210,220,235";
  const baseShadow = highlight
    ? `0 0 16px 4px ${flashColor || (red ? "rgba(231,76,60,0.6)" : "rgba(200,210,220,0.5)")}`
    : (tier >= 5 ? "0 4px 9px rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.2)"
       : tier >= 2 ? "0 3px 7px rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.2)"
       : "0 3px 6px rgba(0,0,0,0.4), inset 0 1px 2px rgba(255,255,255,0.2)");
  const veteranGlow = ["", `, 0 0 5px rgba(${glowRGB},0.28)`, `, 0 0 8px rgba(${glowRGB},0.42)`,
    `, 0 0 9px rgba(${glowRGB},0.45)`, `, 0 0 12px rgba(255,215,0,0.4)`, `, 0 0 16px rgba(255,215,0,0.55)`][tier];
  const veteranRing = tier >= 5 ? "2.5px solid rgba(255,215,0,0.85)"
    : tier === 4 ? "2px solid rgba(255,215,0,0.6)"
    : tier === 3 ? "2px solid rgba(220,225,235,0.5)"
    : (king ? "2px solid #ffd700" : "1px solid rgba(0,0,0,0.2)");
  return (
    <div style={{
      width: "78%", height: "78%", borderRadius: "50%",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: red ? "radial-gradient(circle at 35% 35%, #ff6b6b, #c0392b)" : "radial-gradient(circle at 35% 35%, #f0f0f0, #95a5a6)",
      boxShadow: baseShadow + veteranGlow,
      border: veteranRing,
      transition: "all 0.3s", transform: highlight ? "scale(1.05)" : "scale(1)",
    }}>
      {king && <span style={{ fontSize: 12, color: "#ffd700", textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>&#9813;</span>}
    </div>
  );
}

function BoardGrid({ board, lastMove, maxWidth = 380, redLevel = 1, blackLevel = 1, flashColor = null }) {
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
              {cell > 0 && <Piece type={cell} highlight={isLastTo} level={isRed(cell) ? redLevel : blackLevel} flashColor={isLastTo ? flashColor : null} />}
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
  const [opponent, setOpponent] = useState("open");
  const [tournMode, setTournMode] = useState("live");

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < (opponent === "mirror" ? Math.floor(bracketSize / 2) : bracketSize)) next.add(id);
    setSelected(next);
  };

  const maxAgents = opponent === "mirror" ? Math.floor(bracketSize / 2) : bracketSize;
  const randomFill = opponent === "mirror" ? 0 : bracketSize - selected.size;
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

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4 }}>MODE</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setTournMode("live")} style={{ ...btnStyle(tournMode === "live"), color: tournMode === "live" ? "#f39c12" : "#4a5568", borderColor: tournMode === "live" ? "#f39c12" : "#21262d" }}>🎰 LIVE</button>
            <button onClick={() => setTournMode("instant")} style={btnStyle(tournMode === "instant")}>⚡ INSTANT</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4 }}>OPPONENT</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => { setOpponent("open"); }} style={btnStyle(opponent === "open")}>OPEN</button>
            <button onClick={() => { setOpponent("mirror"); setSelected(s => { const n = new Set(s); while (n.size > Math.floor(bracketSize / 2)) n.delete([...n].pop()); return n; }); }}
              style={{ ...btnStyle(opponent === "mirror"), color: opponent === "mirror" ? "#9b59b6" : "#4a5568", borderColor: opponent === "mirror" ? "#9b59b6" : "#21262d" }}>🪞 MIRROR</button>
          </div>
        </div>
      </div>

      {opponent === "mirror" && <div style={{ fontSize: 9, color: "#9b59b6", marginBottom: 8 }}>Pick up to {maxAgents} agents. The Mirror will generate {maxAgents} counter-agents to fill the bracket.</div>}

      <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 6 }}>SELECT AGENTS ({selected.size}/{maxAgents})</div>
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

      {randomFill > 0 && selected.size >= 2 && opponent === "open" && (
        <div style={{ fontSize: 9, color: "#4a5568", marginBottom: 12 }}>{randomFill} random agent{randomFill > 1 ? "s" : ""} will fill remaining slots</div>
      )}

      <button onClick={() => onStart([...selected], bracketSize, seeding, opponent === "mirror" ? "mirror" : null, tournMode)} disabled={selected.size < 2 || loading}
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

function LiveTournament({ data, onBack, onNewTournament }) {
  const agents = data.bracket.agents;
  const agentBySlot = {};
  agents.forEach(a => { agentBySlot[a.slot] = a; });

  const allRoundKeys = Object.keys(data.matches).sort((a, b) => {
    if (a === "final") return 1; if (b === "final") return -1;
    return a.localeCompare(b);
  });

  const [phase, setPhase] = useState("betting"); // betting | revealing | summary | awards
  const [currentRound, setCurrentRound] = useState(0);
  const [revealIndex, setRevealIndex] = useState(-1);
  const [roundBets, setRoundBets] = useState({});
  const [pnl, setPnl] = useState({ total: 0, rounds: {} });
  const [settled, setSettled] = useState({});
  const revealTimer = useRef(null);

  const roundMatches = data.matches[allRoundKeys[currentRound]] || [];
  const roundName = data.bracket.rounds[currentRound]?.name || `Round ${currentRound + 1}`;
  const isLastRound = currentRound >= allRoundKeys.length - 1;
  const isFinal = allRoundKeys[currentRound] === "final";
  const luckyMatch = data.lucky_match;
  const finalHeat = data.final_heat || 1.5;

  const placeBet = (mi, side, amount) => {
    const m = roundMatches[mi];
    if (!m) return;
    const odds = side === "red" ? data.bracket.rounds[currentRound]?.matches[mi]?.red_odds || 1.8 : 1.8;
    // compute odds from elo
    const rElo = m.red?.elo || 1200;
    const bElo = m.black?.elo || 1200;
    const pRed = 1 / (1 + Math.pow(10, (bElo - rElo) / 400));
    const sideOdds = side === "red" ? Math.round((1 / (pRed * 0.94)) * 100) / 100 : Math.round((1 / ((1 - pRed) * 0.94)) * 100) / 100;
    setRoundBets(prev => ({ ...prev, [`${currentRound}-${mi}`]: { side, amount, odds: sideOdds } }));
  };

  const lockBets = () => {
    setPhase("revealing");
    setRevealIndex(0);
  };

  // auto-reveal timer
  useEffect(() => {
    if (phase !== "revealing" || revealIndex < 0) return;
    const hasBet = !!roundBets[`${currentRound}-${revealIndex}`];
    const delay = isFinal ? 4000 : hasBet ? 3500 : 2000;
    revealTimer.current = setTimeout(() => {
      // settle bet for this match
      const bet = roundBets[`${currentRound}-${revealIndex}`];
      const m = roundMatches[revealIndex];
      if (bet && m) {
        const won = m.winner === bet.side;
        let eff = bet.odds;
        const isLucky = luckyMatch && luckyMatch.round === currentRound + 1 && luckyMatch.match_index === revealIndex;
        if (isLucky) eff *= 2;
        if (isFinal) eff *= finalHeat;
        const payout = won ? Math.floor(bet.amount * eff) : 0;
        const net = payout - bet.amount;
        setSettled(prev => ({ ...prev, [`${currentRound}-${revealIndex}`]: { won, payout, net, odds: eff } }));
        setPnl(prev => ({ ...prev, total: prev.total + net, rounds: { ...prev.rounds, [currentRound]: (prev.rounds[currentRound] || 0) + net } }));
      }
      if (revealIndex < roundMatches.length - 1) {
        setRevealIndex(revealIndex + 1);
      } else {
        setPhase("summary");
      }
    }, delay);
    return () => clearTimeout(revealTimer.current);
  }, [phase, revealIndex, currentRound]);

  // auto-advance from summary
  useEffect(() => {
    if (phase !== "summary") return;
    const t = setTimeout(() => {
      if (isLastRound) {
        setPhase("awards");
      } else {
        setCurrentRound(currentRound + 1);
        setRevealIndex(-1);
        setPhase("betting");
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [phase, currentRound]);

  // awards screen
  if (phase === "awards") {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 12px", textAlign: "center" }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, color: "#f39c12", textTransform: "uppercase", marginBottom: 4 }}>Fight Night Complete</h2>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#ffd700", marginBottom: 4 }}>🏆 {data.champion.name}</div>
        <div style={{ fontSize: 9, color: "#4a5568", marginBottom: 12 }}>Seed #{data.champion.seed}</div>
        <div style={{ padding: "8px 16px", background: pnl.total >= 0 ? "rgba(46,204,113,0.1)" : "rgba(231,76,60,0.1)", border: `1px solid ${pnl.total >= 0 ? "rgba(46,204,113,0.3)" : "rgba(231,76,60,0.3)"}`, borderRadius: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: pnl.total >= 0 ? "#2ecc71" : "#e74c3c" }}>{pnl.total >= 0 ? "+" : ""}{pnl.total} chips</div>
          <div style={{ fontSize: 8, color: "#4a5568" }}>Tournament P&L</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 16 }}>
          {data.awards.map((a, i) => (
            <div key={i} style={{ padding: "6px 10px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 4, minWidth: 100, textAlign: "left" }}>
              <div style={{ fontSize: 7, color: i === 0 ? "#ffd700" : "#4a5568", letterSpacing: 1, textTransform: "uppercase" }}>{a.award}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#c8d0da" }}>{a.agent_name}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={onNewTournament} style={{ padding: "8px 24px", borderRadius: 4, border: "none", background: "linear-gradient(135deg, #f39c12, #e67e22)", color: "#fff", fontWeight: 800, fontSize: 11, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit" }}>RUN IT BACK</button>
          <button onClick={onBack} style={{ padding: "8px 16px", borderRadius: 4, border: "1px solid #21262d", background: "transparent", color: "#4a5568", fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>DONE</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, textTransform: "uppercase", color: "#f39c12" }}>{isFinal ? "THE FINAL" : roundName}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 8, color: "#4a5568" }}>{phase === "betting" ? "PLACE YOUR BETS" : phase === "revealing" ? "REVEALING..." : "COMPLETE"}</span>
          <button onClick={onNewTournament} title="Leave this tournament and return to setup" style={{ fontSize: 8, background: "none", border: "1px solid #e74c3c44", color: "#e74c3c", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>EXIT TOURNAMENT</button>
        </div>
      </div>

      {/* P&L bar */}
      <div style={{ padding: "3px 10px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 3, marginBottom: 8, display: "flex", justifyContent: "space-between", fontSize: 8 }}>
        <span style={{ color: "#4a5568" }}>SESSION P&L:</span>
        <span style={{ fontWeight: 700, color: pnl.total >= 0 ? "#2ecc71" : "#e74c3c" }}>{pnl.total >= 0 ? "+" : ""}{pnl.total}</span>
      </div>

      {/* match cards */}
      <div style={{ display: "grid", gridTemplateColumns: roundMatches.length > 2 ? "1fr 1fr" : "1fr", gap: 8 }}>
        {roundMatches.map((m, mi) => {
          const key = `${currentRound}-${mi}`;
          const bet = roundBets[key];
          const result = settled[key];
          const revealed = phase === "revealing" ? mi <= revealIndex : phase === "summary" || phase === "awards";
          const isRevealing = phase === "revealing" && mi === revealIndex;
          const isLucky = luckyMatch && luckyMatch.round === currentRound + 1 && luckyMatch.match_index === mi;

          // compute odds
          const rElo = m.red?.elo || 1200;
          const bElo = m.black?.elo || 1200;
          const pRed = 1 / (1 + Math.pow(10, (bElo - rElo) / 400));
          const redOdds = Math.round((1 / (pRed * 0.94)) * 100) / 100;
          const blackOdds = Math.round((1 / ((1 - pRed) * 0.94)) * 100) / 100;

          return (
            <div key={mi} style={{
              padding: "8px 10px", borderRadius: 6,
              background: isRevealing ? "#161b22" : isLucky && phase === "betting" ? "#1a1510" : "#0d1117",
              border: `1px solid ${isRevealing ? "#f39c1266" : isLucky && phase === "betting" ? "#ffd70044" : "#1a1f2b"}`,
              transition: "all 0.3s",
            }}>
              {isLucky && phase === "betting" && <div style={{ fontSize: 8, color: "#ffd700", fontWeight: 700, textAlign: "center", marginBottom: 4 }}>✨ LUCKY MATCH ✨ 2x PAYOUT</div>}
              {isFinal && phase === "betting" && <div style={{ fontSize: 8, color: "#f39c12", fontWeight: 700, textAlign: "center", marginBottom: 4 }}>🔥 FINAL ROUND HEAT: 1.5x BOOST</div>}

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: revealed && m.winner === "red" ? "#2ecc71" : revealed && m.winner !== "red" ? "#3a4450" : "#e74c3c" }}>#{m.red?.seed} {m.red?.name}</div>
                  <div style={{ fontSize: 8, color: "#4a5568" }}>{m.red?.elo} elo {phase === "betting" ? `| ${redOdds}x` : ""}</div>
                </div>
                <span style={{ fontSize: 9, color: "#4a5568", alignSelf: "center" }}>vs</span>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: revealed && m.winner === "black" ? "#2ecc71" : revealed && m.winner !== "black" ? "#3a4450" : "#ecf0f1" }}>#{m.black?.seed} {m.black?.name}</div>
                  <div style={{ fontSize: 8, color: "#4a5568" }}>{m.black?.elo} elo {phase === "betting" ? `| ${blackOdds}x` : ""}</div>
                </div>
              </div>

              {revealed && m.tag && <div style={{ textAlign: "center", marginBottom: 2 }}><TagBadge tag={m.tag} /></div>}
              {revealed && result && (
                <div style={{ textAlign: "center", fontSize: 12, fontWeight: 800, color: result.won ? "#2ecc71" : "#e74c3c", marginTop: 2 }}>
                  {result.won ? `+${result.payout}` : `-${roundBets[key]?.amount || 0}`}
                </div>
              )}
              {revealed && m.move_count && <div style={{ textAlign: "center", fontSize: 7, color: "#4a5568" }}>{m.move_count} moves</div>}

              {phase === "betting" && !bet && (
                <div style={{ display: "flex", gap: 3, justifyContent: "center", marginTop: 4 }}>
                  {[50, 100].map(amt => (
                    <div key={amt} style={{ display: "flex", gap: 2 }}>
                      <button onClick={() => placeBet(mi, "red", amt)} style={{ fontSize: 7, padding: "2px 6px", borderRadius: 2, background: "#161b22", border: "1px solid #e74c3c33", color: "#e74c3c", cursor: "pointer", fontFamily: "inherit" }}>{amt} RED</button>
                      <button onClick={() => placeBet(mi, "black", amt)} style={{ fontSize: 7, padding: "2px 6px", borderRadius: 2, background: "#161b22", border: "1px solid #ecf0f133", color: "#ecf0f1", cursor: "pointer", fontFamily: "inherit" }}>{amt} BLK</button>
                    </div>
                  ))}
                </div>
              )}
              {phase === "betting" && bet && (
                <div style={{ textAlign: "center", fontSize: 8, color: "#ffd700", marginTop: 4 }}>
                  🔒 {bet.amount} on {bet.side.toUpperCase()} ({bet.odds}x)
                </div>
              )}
            </div>
          );
        })}
      </div>

      {phase === "betting" && (
        <button onClick={lockBets} style={{ width: "100%", marginTop: 12, padding: "10px 0", borderRadius: 6, border: "none", background: "linear-gradient(135deg, #f39c12, #e67e22)", color: "#fff", fontWeight: 800, fontSize: 11, letterSpacing: 3, cursor: "pointer", fontFamily: "inherit" }}>
          LOCK BETS & BEGIN {roundName.toUpperCase()}
        </button>
      )}

      {phase === "summary" && (
        <div style={{ marginTop: 12, padding: "8px 12px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, textAlign: "center" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#f39c12", letterSpacing: 2 }}>{roundName.toUpperCase()} COMPLETE</div>
          <div style={{ fontSize: 9, color: "#8892a0", marginTop: 4 }}>Round P&L: <span style={{ fontWeight: 700, color: (pnl.rounds[currentRound] || 0) >= 0 ? "#2ecc71" : "#e74c3c" }}>{(pnl.rounds[currentRound] || 0) >= 0 ? "+" : ""}{pnl.rounds[currentRound] || 0}</span></div>
          <div style={{ fontSize: 8, color: "#4a5568", marginTop: 2 }}>{isLastRound ? "Advancing to awards..." : `Next: ${data.bracket.rounds[currentRound + 1]?.name || "next round"}...`}</div>
        </div>
      )}
    </div>
  );
}


function Tournament({ roster, onBack, loadRoster }) {
  const [phase, setPhase] = useState("setup");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const [tournMode, setTournMode] = useState("live");

  const startTournament = async (agentIds, bracketSize, seeding, mirrorCoach, mode) => {
    setLoading(true);
    setTournMode(mode || "live");
    try {
      const body = { agent_ids: agentIds, bracket_size: bracketSize, seeding };
      if (mirrorCoach) body.vs_bot = { coach_id: mirrorCoach };
      const res = await fetch(`${API}/tournaments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const d = await res.json();
      setData(d); setPhase(mode === "live" ? "live" : "bracket"); loadRoster();
    } catch (e) { alert(e.message); } finally { setLoading(false); }
  };

  if (phase === "setup") return <TournamentSetup roster={roster} onStart={startTournament} onBack={onBack} loading={loading} />;
  if (phase === "live") return <LiveTournament data={data} onBack={onBack} onNewTournament={() => { setPhase("setup"); setData(null); }} />;
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

function XpBar({ xp, xpNext, xpCurrent = 0, level }) {
  if (!xpNext) return <span style={{ fontSize: 7, color: "#ffd700" }}>MAX</span>;
  const prevThreshold = xpCurrent;
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

function PerkSelector({ agentId, agentLevel = 5, onSelect }) {
  const [saving, setSaving] = useState(false);
  const [chosen, setChosen] = useState(null);
  const unlockedCount = EDGE_ORDER.filter(k => agentLevel >= PERK_INFO[k].unlock).length;

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
      <div style={{ fontSize: 8, fontWeight: 700, color: "#ffd700", letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" }}>Choose your Edge ({unlockedCount} of {EDGE_ORDER.length} unlocked)</div>
      {EDGE_ORDER.map((key) => {
        const info = PERK_INFO[key];
        const locked = agentLevel < info.unlock;
        return (
          <div key={key} onClick={() => !locked && setChosen(key)} style={{
            padding: "6px 8px", marginBottom: 4, borderRadius: 4, cursor: locked ? "not-allowed" : "pointer",
            background: chosen === key ? info.color + "15" : "#0d1117",
            border: `1px solid ${chosen === key ? info.color + "66" : "#1a1f2b"}`,
            opacity: locked ? 0.45 : 1,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 12 }}>{info.icon}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: locked ? "#4a5568" : info.color }}>{info.name}</span>
              </span>
              {locked && <span style={{ fontSize: 7, color: "#8892a0" }}>🔒 Level {info.unlock}</span>}
            </div>
            <div style={{ fontSize: 8, color: "#8892a0" }}>{info.short}</div>
            <div style={{ fontSize: 7, color: "#4a5568", marginTop: 1 }}>{info.tag}</div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <button onClick={confirm} disabled={!chosen || saving} style={{
          flex: 1, padding: "4px 0", borderRadius: 3, border: "none", fontFamily: "inherit",
          background: chosen ? "#ffd70033" : "#21262d", color: chosen ? "#ffd700" : "#4a5568",
          fontSize: 8, fontWeight: 700, letterSpacing: 1, cursor: chosen ? "pointer" : "not-allowed",
        }}>{saving ? "..." : "CONFIRM"}</button>
      </div>
      <div style={{ fontSize: 7, color: "#3a4450", marginTop: 3, textAlign: "center" }}>you can change your edge anytime</div>
    </div>
  );
}

function EvolutionDeltas({ agent }) {
  const orig = agent.original;
  if (!orig) return null;
  const anyDrift = SLIDER_KEYS.some(s => agent[s.key] !== orig[s.key]);
  if (!anyDrift) return null;
  return (
    <div style={{ marginTop: 3, fontSize: 7, color: "#4a5568", display: "flex", gap: 6, flexWrap: "wrap" }}>
      <span style={{ color: "#8892a0" }}>EVOLVED:</span>
      {SLIDER_KEYS.map(s => {
        const cur = agent[s.key], o = orig[s.key], d = cur - o;
        if (d === 0) return null;
        return <span key={s.key}>{s.short} {cur}<span style={{ color: "#3a4450" }}>←{o}</span> <span style={{ color: d > 0 ? "#2ecc71" : "#e74c3c" }}>({d > 0 ? "+" : ""}{d})</span></span>;
      })}
    </div>
  );
}

function FamiliarityBars({ familiarity }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 6, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 1 }}>Matchup experience</div>
      {familiarity.filter(f => f.matches_faced > 0).map(f => (
        <div key={f.type} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 1 }} title={`${f.matches_faced} bouts, ${f.wins} wins`}>
          <span style={{ fontSize: 6, color: "#8892a0", width: 52 }}>{f.label}</span>
          <div style={{ flex: 1, height: 3, background: "#1a1f2b", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${Math.round(f.familiarity_score * 100)}%`, height: "100%", background: "#16a085", borderRadius: 2 }} />
          </div>
          <span style={{ fontSize: 6, color: "#4a5568", width: 38, textAlign: "right" }}>{Math.round(f.familiarity_score * 100)}% ({f.matches_faced})</span>
        </div>
      ))}
    </div>
  );
}

// --- roster panel (match mode) ---

function FormBadge({ form }) {
  if (form === "hot") return <span style={{ fontSize: 9 }} title="On Fire: 4+ wins in last 5">🔥</span>;
  if (form === "cold") return <span style={{ fontSize: 9, opacity: 0.6 }} title="Ice Cold: 4+ losses in last 5">🧊</span>;
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
  const [editingEdge, setEditingEdge] = useState(false);
  const [familiarity, setFamiliarity] = useState(null);

  // load familiarity + reset edge picker when the selected agent changes
  useEffect(() => {
    setEditingEdge(false);
    if (selectedAgent?.id) {
      fetch(`${API}/agents/${selectedAgent.id}/familiarity`).then(r => r.json()).then(d => setFamiliarity(d.familiarity)).catch(() => setFamiliarity(null));
    } else { setFamiliarity(null); }
  }, [selectedAgent?.id]);

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
            {selectedAgent.form === "hot" ? "🔥 ON FIRE" : "🧊 ICE COLD"}
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
            <span style={{ fontSize: 14, fontWeight: 800, color: "#8892a0" }}>{Math.round(selectedAgent.elo)} <span style={{ fontSize: 8, fontWeight: 400 }}>ELO</span></span>
            <span style={{ fontSize: 7, color: "#4a5568" }}>{selectedAgent.wins}W {selectedAgent.losses}L {selectedAgent.draws}D</span>
          </div>
          <XpBar xp={selectedAgent.xp || 0} xpNext={selectedAgent.xp_next} xpCurrent={selectedAgent.xp_current || 0} level={selectedAgent.level || 1} />
          <MiniBars config={selectedAgent} /><OverextWarning config={selectedAgent} />
          <EvolutionDeltas agent={selectedAgent} />
          {familiarity && familiarity.some(f => f.matches_faced > 0) && <FamiliarityBars familiarity={familiarity} />}
          {selectedAgent.perk && (
            <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
              <PerkBadge perk={selectedAgent.perk} />
              <button onClick={() => setEditingEdge(v => !v)} style={{ fontSize: 6, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 4px", cursor: "pointer", fontFamily: "inherit" }}>CHANGE EDGE</button>
            </div>
          )}
          {(selectedAgent.level || 1) >= 5 && (editingEdge || !selectedAgent.perk) && (
            <PerkSelector agentId={selectedAgent.id} agentLevel={selectedAgent.level || 1} onSelect={(updated) => { onSelect(updated); onRosterChange(); setEditingEdge(false); }} />
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

function CryptoModal({ kind, balance, onClose, doDeposit, doWithdraw }) {
  const [info, setInfo] = useState(null);
  const [amount, setAmount] = useState("");
  const [toAddr, setToAddr] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind === "deposit") { doDeposit(5).then(d => setInfo(d)); }
  }, [kind]);

  const submitWithdraw = async () => {
    setBusy(true); setMsg(null);
    const r = await doWithdraw(parseFloat(amount), toAddr.trim());
    setBusy(false);
    if (r.ok) setMsg({ ok: true, text: `Sent. tx: ${r.tx_hash?.slice(0, 14)}…` });
    else setMsg({ ok: false, text: r.error });
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 360, maxWidth: "90vw", padding: 16, background: "#0d1117", border: "1px solid #2ecc7144", borderRadius: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: "#2ecc71", textTransform: "uppercase" }}>{kind === "deposit" ? "Add Funds" : "Withdraw"}</span>
          <button onClick={onClose} style={{ fontSize: 9, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>X</button>
        </div>

        {kind === "deposit" && (
          <div>
            <div style={{ fontSize: 9, color: "#8892a0", marginBottom: 6 }}>Send USDC (Base network) to your game wallet:</div>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              <input readOnly value={info?.deposit_address || "loading…"} style={{ flex: 1, fontSize: 9, padding: "4px 6px", background: "#161b22", border: "1px solid #21262d", borderRadius: 3, color: "#c8d0da", fontFamily: "inherit" }} />
              <button onClick={() => info?.deposit_address && navigator.clipboard?.writeText(info.deposit_address)} style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "#161b22", border: "1px solid #2ecc7144", color: "#2ecc71", cursor: "pointer", fontFamily: "inherit" }}>COPY</button>
            </div>
            {info?.onramp_url && <a href={info.onramp_url} target="_blank" rel="noreferrer" style={{ display: "block", textAlign: "center", fontSize: 9, padding: "6px 0", borderRadius: 4, background: "#161b22", border: "1px solid #2ecc7144", color: "#2ecc71", textDecoration: "none", marginBottom: 6 }}>BUY WITH CARD (MoonPay)</a>}
            <div style={{ fontSize: 8, color: "#4a5568" }}>Balance: ${(balance?.usdc ?? 0).toFixed(2)} USDC · minimum deposit $1.00</div>
          </div>
        )}

        {kind === "withdraw" && (
          <div>
            <div style={{ fontSize: 8, color: "#4a5568", marginBottom: 2 }}>Amount (USDC)</div>
            <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ width: "100%", fontSize: 11, padding: "5px 8px", background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#c8d0da", fontFamily: "inherit", marginBottom: 8, boxSizing: "border-box" }} />
            <div style={{ fontSize: 8, color: "#4a5568", marginBottom: 2 }}>To address (Base)</div>
            <input value={toAddr} onChange={e => setToAddr(e.target.value)} placeholder="0x…" style={{ width: "100%", fontSize: 9, padding: "5px 8px", background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#c8d0da", fontFamily: "inherit", marginBottom: 8, boxSizing: "border-box" }} />
            <div style={{ fontSize: 8, color: "#4a5568", marginBottom: 8 }}>Available: ${(balance?.usdc ?? 0).toFixed(2)} · minimum $1.00 · gas sponsored</div>
            <button onClick={submitWithdraw} disabled={busy || !amount || !toAddr} style={{ width: "100%", padding: "8px 0", borderRadius: 4, border: "none", background: (busy || !amount || !toAddr) ? "#21262d" : "linear-gradient(135deg, #2ecc71, #27ae60)", color: (busy || !amount || !toAddr) ? "#4a5568" : "#fff", fontWeight: 700, fontSize: 10, letterSpacing: 2, cursor: (busy || !amount || !toAddr) ? "not-allowed" : "pointer", fontFamily: "inherit" }}>{busy ? "SENDING…" : "WITHDRAW"}</button>
            {msg && <div style={{ fontSize: 9, marginTop: 6, color: msg.ok ? "#2ecc71" : "#e74c3c" }}>{msg.text}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [queuedCount, setQueuedCount] = useState(0);
  const [notice, setNotice] = useState(null);
  const [crypto, setCrypto] = useState({ enabled: false, bet_tiers_usdc: [], min_bet_usdc: 0.01, max_bet_usdc: 10 });
  const [playMode, setPlayMode] = useState("free");  // "free" | "real"
  const [realBal, setRealBal] = useState(null);       // { usdc, wallet_address } or null
  const [realBet, setRealBet] = useState(0);          // USDC stake
  const [modal, setModal] = useState(null);           // "deposit" | "withdraw" | "txs" | null
  const wsRef = useRef(null);

  useEffect(() => { fetch(`${API}/crypto/status`).then(r => r.json()).then(setCrypto).catch(() => {}); }, []);

  const loadRealBalance = () => {
    if (!authToken) return;
    fetch(`${API}/wallet/balance`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json()).then(d => setRealBal(d.real_play)).catch(() => {});
  };
  useEffect(() => { if (authToken && crypto.enabled) loadRealBalance(); }, [authToken, crypto.enabled]);

  // poll online count
  useEffect(() => {
    const poll = () => fetch(`${API}/players/online`).then(r => r.json()).then(d => {
      setOnlineCount(d.count);
      setQueuedCount((d.players || []).filter(p => p.status === "in_queue").length);
    }).catch(() => {});
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
      if (msg.type === "match_found") { setMatchFound(msg); setNotice(null); }
      if (msg.type === "match_result") { setMatchResult(msg); setMatchFound(null); setQueueStatus(null); if (msg.mode === "real") loadRealBalance(); }
      if (msg.type === "queue_timeout") { setQueueStatus(null); setNotice(msg.message || "No opponents found. Try again later."); }
      if (msg.type === "error") { setQueueStatus(null); setNotice(msg.message || "Something went wrong."); }
      if (msg.type === "queue_cancelled") setQueueStatus(null);
    };
  };

  useEffect(() => { if (authToken) connectWs(); return () => wsRef.current?.close(); }, [authToken]);

  const joinQueue = () => {
    if (!selectedAgent || !wsRef.current) return;
    setNotice(null);
    const join = playMode === "real"
      ? { type: "queue_join", agent_id: selectedAgent.id, bet_amount: realBet, mode: "real" }
      : { type: "queue_join", agent_id: selectedAgent.id, bet_amount: betAmount, mode: "free" };
    wsRef.current.send(JSON.stringify(join));
    setQueueStatus({ wait_time: 0 });
  };

  const doDeposit = async (amount) => {
    const res = await fetch(`${API}/wallet/deposit`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` }, body: JSON.stringify({ amount }) });
    if (res.ok) return res.json();
    return null;
  };
  const doWithdraw = async (amount, toAddress) => {
    const res = await fetch(`${API}/wallet/withdraw`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` }, body: JSON.stringify({ amount, to_address: toAddress }) });
    const d = await res.json();
    if (res.ok) { loadRealBalance(); return { ok: true, ...d }; }
    return { ok: false, error: d.detail || "withdrawal failed" };
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
        {matchResult.real_result && (
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: matchResult.real_result.net_usdc >= 0 ? "#2ecc71" : "#e74c3c" }}>
              {matchResult.real_result.net_usdc >= 0 ? "💰 +" : "💸 "}${Math.abs(matchResult.real_result.net_usdc).toFixed(2)}
            </div>
            <div style={{ fontSize: 8, color: "#4a5568" }}>${matchResult.real_result.stake_usdc.toFixed(2)} staked · balance ${matchResult.real_result.balance_usdc.toFixed(2)}</div>
          </div>
        )}
        <div style={{ textAlign: "center", fontSize: 9, color: "#8892a0", marginBottom: 12 }}>
          Elo: {matchResult.elo_change.before} → {matchResult.elo_change.after} ({matchResult.elo_change.delta > 0 ? "+" : ""}{matchResult.elo_change.delta})
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
        {matchFound.bet_amount > 0 && (playMode === "real"
          ? <div style={{ fontSize: 9, color: "#2ecc71" }}>💰 Staking ${Number(matchFound.bet_amount).toFixed(2)} · winner takes 95% of pot</div>
          : <div style={{ fontSize: 9, color: "#ffd700" }}>Bet: {matchFound.bet_amount} coins at {matchFound.odds}x</div>)}
        <div style={{ fontSize: 11, color: "#4a5568", marginTop: 8 }}>Simulating...</div>
      </div>
    );
  }

  // lobby
  const isReal = playMode === "real";
  return (
    <div style={{ maxWidth: 500, margin: "20px auto", padding: "16px", border: isReal ? "1px solid #2ecc7155" : "none", borderRadius: isReal ? 10 : 0, boxShadow: isReal ? "0 0 24px rgba(46,204,113,0.12) inset" : "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 4, color: "#9b59b6", textTransform: "uppercase" }}>Multiplayer</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#8892a0" }}>👥 {onlineCount} online{queuedCount > 0 ? ` · ${queuedCount} queuing` : ""}</span>
          <span style={{ fontSize: 8, color: wsStatus === "connected" ? "#2ecc71" : "#e74c3c" }}>{wsStatus === "connected" ? "CONNECTED" : "OFFLINE"}</span>
          <button onClick={onBack} style={{ fontSize: 8, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>BACK</button>
        </div>
      </div>
      <div style={{ fontSize: 9, color: "#8892a0", marginBottom: 8 }}>Logged in as {player?.display_name}</div>
      {notice && <div style={{ fontSize: 9, color: "#e67e22", background: "#1a1510", border: "1px solid #e67e2233", borderRadius: 4, padding: "5px 8px", marginBottom: 8 }}>{notice}</div>}

      {/* mode toggle: REAL only appears when the server has real play configured */}
      {crypto.enabled && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            <button onClick={() => setPlayMode("free")} style={{ flex: 1, padding: "5px 0", fontSize: 9, fontWeight: 700, letterSpacing: 1, fontFamily: "inherit", cursor: "pointer", borderRadius: 4, background: !isReal ? "#161b22" : "#0d1117", border: `1px solid ${!isReal ? "#9b59b6" : "#21262d"}`, color: !isReal ? "#9b59b6" : "#4a5568" }}>🎮 FREE PLAY</button>
            <button onClick={() => setPlayMode("real")} style={{ flex: 1, padding: "5px 0", fontSize: 9, fontWeight: 700, letterSpacing: 1, fontFamily: "inherit", cursor: "pointer", borderRadius: 4, background: isReal ? "#0e1a12" : "#0d1117", border: `1px solid ${isReal ? "#2ecc71" : "#21262d"}`, color: isReal ? "#2ecc71" : "#4a5568" }}>💰 REAL PLAY</button>
          </div>
          {isReal && (
            <div style={{ padding: "6px 10px", background: "#0d1117", border: "1px solid #2ecc7133", borderRadius: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#2ecc71" }}>${(realBal?.usdc ?? 0).toFixed(2)}</span>
                <span style={{ fontSize: 7, color: "#4a5568", marginLeft: 4 }}>USDC</span>
                {realBal?.wallet_address && <span style={{ fontSize: 7, color: "#3a4450", marginLeft: 6 }}>{realBal.wallet_address.slice(0, 6)}…{realBal.wallet_address.slice(-4)}</span>}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => setModal("deposit")} style={{ fontSize: 7, padding: "2px 8px", borderRadius: 3, background: "#161b22", border: "1px solid #2ecc7144", color: "#2ecc71", cursor: "pointer", fontFamily: "inherit" }}>DEPOSIT</button>
                <button onClick={() => setModal("withdraw")} style={{ fontSize: 7, padding: "2px 8px", borderRadius: 3, background: "#161b22", border: "1px solid #21262d", color: "#8892a0", cursor: "pointer", fontFamily: "inherit" }}>WITHDRAW</button>
              </div>
            </div>
          )}
        </div>
      )}

      {modal && <CryptoModal kind={modal} balance={realBal} onClose={() => { setModal(null); loadRealBalance(); }} doDeposit={doDeposit} doWithdraw={doWithdraw} />}

      <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4, marginTop: 12, textTransform: "uppercase" }}>Your agent {isReal && <span style={{ color: "#2ecc71" }}>(level 3+, 10+ matches)</span>}</div>
      <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 12 }}>
        {roster.map(a => <AgentCard key={a.id} agent={a} selected={selectedAgent?.id === a.id} onClick={() => setSelectedAgent(a)} compact />)}
      </div>

      {selectedAgent && !queueStatus && !isReal && (
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

      {selectedAgent && !queueStatus && isReal && (
        <>
          <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4, textTransform: "uppercase" }}>Stake (USDC) — winner takes 95% of pot</div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
            {crypto.bet_tiers_usdc.map(amt => (
              <button key={amt} disabled={amt > (realBal?.usdc ?? 0)} onClick={() => setRealBet(amt)} style={{
                padding: "3px 8px", borderRadius: 3, fontSize: 8, fontFamily: "inherit",
                cursor: amt > (realBal?.usdc ?? 0) ? "not-allowed" : "pointer",
                opacity: amt > (realBal?.usdc ?? 0) ? 0.35 : 1,
                background: realBet === amt ? "#0e1a12" : "#161b22",
                border: `1px solid ${realBet === amt ? "#2ecc71" : "#21262d"}`,
                color: realBet === amt ? "#2ecc71" : "#8892a0",
              }}>${amt.toFixed(2)}</button>
            ))}
          </div>
          {realBet > 0
            ? <button onClick={joinQueue} style={{ width: "100%", padding: "10px 0", borderRadius: 6, border: "none", background: "linear-gradient(135deg, #2ecc71, #27ae60)", color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: 3, cursor: "pointer", fontFamily: "inherit" }}>FIND MATCH · ${realBet.toFixed(2)}</button>
            : <div style={{ fontSize: 8, color: "#4a5568", textAlign: "center" }}>{(realBal?.usdc ?? 0) <= 0 ? "Deposit USDC to play for real" : "Select a stake"}</div>}
        </>
      )}

      {queueStatus && (
        <div style={{ textAlign: "center", padding: "12px", background: "#0d1117", border: "1px solid #9b59b633", borderRadius: 6, marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#9b59b6", letterSpacing: 2, marginBottom: 6 }}>SEARCHING FOR OPPONENT...</div>
          <div style={{ fontSize: 9, color: "#8892a0", marginBottom: 2 }}>Your agent: <span style={{ color: "#c8d0da", fontWeight: 700 }}>{selectedAgent?.name}</span> ({selectedAgent?.elo} elo)</div>
          <div style={{ fontSize: 9, color: "#8892a0", marginBottom: 2 }}>
            {queueStatus.matching_anyone
              ? "Search range: any opponent"
              : `Search range: ± ${queueStatus.elo_range ?? 100} elo${queueStatus.widen_in > 0 ? ` (widening in ${queueStatus.widen_in}s)` : ""}`}
          </div>
          <div style={{ fontSize: 9, color: "#8892a0" }}>Players in queue: <span style={{ color: "#9b59b6", fontWeight: 700 }}>{queueStatus.players_in_queue ?? 1}</span>{typeof queueStatus.wait_time === "number" ? ` · ${queueStatus.wait_time}s waited` : ""}</div>
          <button onClick={cancelQueue} style={{ marginTop: 10, padding: "4px 16px", borderRadius: 3, border: "1px solid #e74c3c44", background: "transparent", color: "#e74c3c", fontSize: 8, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>CANCEL</button>
        </div>
      )}
    </div>
  );
}


// --- main app ---

// --- 2v2 Tag Team ---
const AGENT_A_COLOR = "#f1c40f";   // amber
const AGENT_B_COLOR = "#3498db";   // cyan
const EDGE_SHORT = { rope_a_dope: "Counter", press: "Surge", momentum: "Frenzy", anchor: "Anchor", phantom: "Phantom", siege: "Siege", flux: "Flux" };

function clientDiversity(a, b) {
  if (!a || !b) return { frac: 0, bonus: 1.0 };
  const keys = ["aggression", "risk_tolerance", "king_priority", "edge_affinity", "trade_down"];
  const total = keys.reduce((s, k) => s + Math.abs((a[k] ?? 50) - (b[k] ?? 50)), 0);
  const frac = total / 500;
  let bonus = 1.0 + frac * 0.05;
  if (a.perk && b.perk && a.perk !== b.perk) bonus += 0.005;
  return { frac, bonus: Math.round(bonus * 1000) / 1000 };
}

function edgeComboDesc(pa, pb) {
  if (!pa && !pb) return "No edges equipped";
  if (!pa || !pb) return `${EDGE_SHORT[pa || pb] || "Edge"} on one agent`;
  const a = EDGE_SHORT[pa], b = EDGE_SHORT[pb];
  const tag = { rope_a_dope: "defend", press: "force action", momentum: "attack", anchor: "fortress", phantom: "counter", siege: "siege", flux: "chaos" };
  return `${a} + ${b} (${tag[pa] || "?"} + ${tag[pb] || "?"})`;
}

function TeamDynamicsBar({ dyn }) {
  if (!dyn) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 8, color: "#8892a0" }}>
      <span style={{ color: AGENT_A_COLOR }}>A {dyn.agent_a_lead_pct}%</span>
      <div style={{ flex: 1, height: 5, borderRadius: 3, overflow: "hidden", display: "flex", background: "#1a1f2b" }}>
        <div style={{ width: `${dyn.agent_a_lead_pct}%`, background: AGENT_A_COLOR }} />
        <div style={{ width: `${dyn.agreement_pct}%`, background: "#4a5568" }} />
        <div style={{ width: `${dyn.agent_b_lead_pct}%`, background: AGENT_B_COLOR }} />
      </div>
      <span style={{ color: AGENT_B_COLOR }}>B {dyn.agent_b_lead_pct}%</span>
      <span style={{ color: "#4a5568" }}>agree {dyn.agreement_pct}%</span>
    </div>
  );
}

function InfluenceIndicator({ inf, nameA, nameB }) {
  if (!inf) return <div style={{ fontSize: 8, color: "#3a4450", textAlign: "center", padding: 4 }}>— first move —</div>;
  const a = inf.score_a, b = inf.score_b;
  const mag = Math.max(Math.abs(a), Math.abs(b), 0.01);
  const barA = Math.max(0, Math.min(100, (a / mag) * 100));
  const barB = Math.max(0, Math.min(100, (b / mag) * 100));
  const agreePct = Math.round(inf.agreement * 100);
  const dom = inf.dominant;
  const note = dom === "equal" ? "Both agents agreed" : `Agent ${dom.toUpperCase()} ${agreePct < 50 ? "overruled" : "edged out"} ${dom === "a" ? nameB : nameA}`;
  const bar = (label, val, color, score, isDom) => (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 8 }}>
      <span style={{ color, width: 52, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span style={{ width: 26, textAlign: "right", color: "#c8d0da" }}>{score.toFixed(1)}</span>
      <div style={{ flex: 1, height: 6, background: "#1a1f2b", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${val}%`, height: "100%", background: color, opacity: isDom ? 1 : 0.5 }} />
      </div>
      {isDom && <span style={{ fontSize: 6, color, fontWeight: 800 }}>DOM</span>}
    </div>
  );
  return (
    <div style={{ width: "100%", padding: "5px 8px", background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 4 }}>
      {bar(nameA, barA, AGENT_A_COLOR, a, dom === "a")}
      {bar(nameB, barB, AGENT_B_COLOR, b, dom === "b")}
      <div style={{ fontSize: 7, color: "#6b7280", marginTop: 2, textAlign: "center" }}>Agreement {agreePct}% — {note}</div>
    </div>
  );
}

function TeamPanel({ side, color, team, dynamics, firedThisMove }) {
  if (!team) return null;
  const ag = (key, name, perk, lead) => {
    const fired = firedThisMove && firedThisMove[key];
    return (
      <div style={{ marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9 }}>
          <span style={{ width: 12, height: 12, borderRadius: 2, background: key === "a" ? AGENT_A_COLOR : AGENT_B_COLOR, color: "#0d1117", fontSize: 7, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{key.toUpperCase()}</span>
          <span style={{ color: "#c8d0da", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        </div>
        <div style={{ fontSize: 7, color: "#6b7280", marginLeft: 16 }}>
          {perk ? <span style={{ color: fired ? "#2ecc71" : "#8892a0" }}>{EDGE_SHORT[perk] || perk}{fired ? " ⚡ FIRED" : ""}</span> : "no edge"}
          {dynamics ? <span style={{ color: "#4a5568" }}>  ·  led {lead}%</span> : null}
        </div>
      </div>
    );
  };
  return (
    <div style={{ padding: 8, background: "#0d1117", border: `1px solid ${color}44`, borderRadius: 6 }}>
      <div style={{ fontSize: 8, color, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{side} team</div>
      {ag("a", team.agent_a.name, team.agent_a.perk, dynamics?.agent_a_lead_pct)}
      {ag("b", team.agent_b.name, team.agent_b.perk, dynamics?.agent_b_lead_pct)}
      <div style={{ fontSize: 7, color: "#4a5568", marginTop: 2 }}>diversity {team.diversity_pct}% · {team.diversity_bonus}x</div>
    </div>
  );
}

function TeamDynamicsBreakdown({ result }) {
  const td = result.team_dynamics;
  if (!td) return null;
  const rt = result.red_team, bt = result.black_team;
  const section = (label, team, dyn, color) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 9, fontWeight: 800, color, marginBottom: 3 }}>{label}: {team.agent_a.name} + {team.agent_b.name}</div>
      <div style={{ fontSize: 8, color: "#8892a0" }}>
        <div><span style={{ color: AGENT_A_COLOR }}>{team.agent_a.name} (A)</span> led {dyn.agent_a_lead_pct}% of decisions{dyn.agent_a_edge_count ? `, ${EDGE_SHORT[team.agent_a.perk] || "edge"} fired ${dyn.agent_a_edge_count}x` : ""}</div>
        <div><span style={{ color: AGENT_B_COLOR }}>{team.agent_b.name} (B)</span> led {dyn.agent_b_lead_pct}% of decisions{dyn.agent_b_edge_count ? `, ${EDGE_SHORT[team.agent_b.perk] || "edge"} fired ${dyn.agent_b_edge_count}x` : ""}</div>
        <div style={{ color: "#6b7280" }}>Agreement rate: {dyn.agreement_pct}% · diversity {team.diversity_pct}% ({team.diversity_bonus}x)</div>
      </div>
    </div>
  );
  return (
    <div style={{ width: "100%", padding: "8px 12px", background: "rgba(52,152,219,0.08)", border: "1px solid rgba(52,152,219,0.3)", borderRadius: 6, marginTop: 6 }}>
      <div style={{ fontSize: 8, color: "#3498db", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>Team Dynamics</div>
      {section("Your team", rt, td.red, "#e74c3c")}
      {section("Opponent", bt, td.black, "#ecf0f1")}
      <div style={{ fontSize: 7, color: "#6b7280", fontStyle: "italic", marginTop: 2 }}>
        {td.red.agreement_pct < 30 ? "These agents rarely agree — their push-pull disagreement drives the team." : td.red.agreement_pct > 70 ? "These agents almost always agree — a unified, predictable team." : "A balanced mix of agreement and creative tension."}
      </div>
    </div>
  );
}

function MatchPlayback({ game, redTeam, blackTeam, autoPlay = true, onFinish, compact = false }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef(false), stepRef = useRef(0), maxRef = useRef(0), doneRef = useRef(false);

  const playNext = () => {
    if (!playRef.current) return;
    if (stepRef.current >= maxRef.current) { playRef.current = false; setPlaying(false); return; }
    stepRef.current += 1; setStep(stepRef.current);
    setTimeout(playNext, compact ? 280 : 350);
  };
  useEffect(() => {
    doneRef.current = false;
    maxRef.current = (game.boards?.length || 1) - 1;
    stepRef.current = 0; setStep(0);
    if (autoPlay) { playRef.current = true; setPlaying(true); playNext(); }
    else { playRef.current = false; setPlaying(false); }
    return () => { playRef.current = false; };
  }, [game]);

  const maxStep = (game.boards?.length || 1) - 1;
  useEffect(() => {
    if (step >= maxStep && !doneRef.current) { doneRef.current = true; onFinish && onFinish(game); }
  }, [step, maxStep]);

  const pause = () => { playRef.current = false; setPlaying(false); };
  const resume = () => { if (stepRef.current >= maxRef.current) return; playRef.current = true; setPlaying(true); playNext(); };
  const jumpEnd = () => { playRef.current = false; setPlaying(false); stepRef.current = maxRef.current; setStep(maxRef.current); };
  const scrub = (e) => { const v = parseInt(e.target.value); playRef.current = false; setPlaying(false); stepRef.current = v; setStep(v); };

  const isFinished = step >= maxStep;
  const board = game.boards[step];
  const moves = game.moves || [];
  const events = game.events || [];
  const influence = game.influence_per_move || [];
  const lastMove = step > 0 ? moves[step - 1] : null;
  const curInf = step > 0 ? influence[step - 1] : null;
  const td = game.team_dynamics || {};
  let flashColor = null;
  if (curInf) {
    if (curInf.score_a > curInf.score_b * 1.3) flashColor = AGENT_A_COLOR;
    else if (curInf.score_b > curInf.score_a * 1.3) flashColor = AGENT_B_COLOR;
  }
  const fired = { red: {}, black: {} };
  if (lastMove) for (const e of events) if (e.type === "perk_activate" && e.move === step && e.agent) fired[e.side][e.agent] = true;
  const movingTeam = lastMove?.side === "black" ? blackTeam : redTeam;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 12, alignItems: "start" }}>
        <TeamPanel side="red" color="#e74c3c" team={redTeam} dynamics={isFinished ? td.red : null} firedThisMove={fired.red} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <BoardGrid board={board} lastMove={lastMove} maxWidth={compact ? 320 : 360} redLevel={redTeam?.agent_a?.level || 1} blackLevel={blackTeam?.agent_a?.level || 1} flashColor={flashColor} />
          <div style={{ fontSize: 8, color: "#4a5568" }}>Move {step}/{maxStep}{isFinished && game.winner ? ` · ${game.winner.toUpperCase()} WINS` : ""}</div>
          <input type="range" min={0} max={maxStep} value={step} onChange={scrub} style={{ width: "100%", accentColor: "#1abc9c" }} />
          <div style={{ display: "flex", gap: 8 }}>
            {playing ? <button onClick={pause} style={{ fontSize: 10, padding: "4px 14px", borderRadius: 4, border: "1px solid #e67e22", background: "transparent", color: "#e67e22", cursor: "pointer", fontFamily: "inherit" }}>❚❚ PAUSE</button>
              : <button onClick={resume} style={{ fontSize: 10, padding: "4px 14px", borderRadius: 4, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", cursor: "pointer", fontFamily: "inherit" }}>▶ PLAY</button>}
            <button onClick={jumpEnd} style={{ fontSize: 10, padding: "4px 14px", borderRadius: 4, border: "1px solid #21262d", background: "transparent", color: "#8892a0", cursor: "pointer", fontFamily: "inherit" }}>▶▶ SKIP</button>
          </div>
        </div>
        <TeamPanel side="black" color="#ecf0f1" team={blackTeam} dynamics={isFinished ? td.black : null} firedThisMove={fired.black} />
      </div>
      <div style={{ maxWidth: 360, margin: "8px auto 0" }}>
        <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, marginBottom: 2 }}>{lastMove ? `MOVE ${step} INFLUENCE · ${lastMove.side.toUpperCase()} TEAM` : "INFLUENCE"}</div>
        <InfluenceIndicator inf={curInf} nameA={movingTeam?.agent_a?.name || "A"} nameB={movingTeam?.agent_b?.name || "B"} />
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 7, color: "#4a5568", marginBottom: 1 }}>RED TEAM DYNAMICS (full match)</div>
          <TeamDynamicsBar dyn={td.red} />
        </div>
      </div>
    </div>
  );
}

function matchupOdds(rElo, bElo) {
  const pRed = 1 / (1 + Math.pow(10, ((bElo || 1200) - (rElo || 1200)) / 400));
  return {
    red: Math.round((1 / (pRed * 0.94)) * 100) / 100,
    black: Math.round((1 / ((1 - pRed) * 0.94)) * 100) / 100,
  };
}

function TagTeam({ roster, onBack, loadRoster, loadWallet }) {
  const [subMode, setSubMode] = useState("match");
  const [agentA, setAgentA] = useState(null);
  const [agentB, setAgentB] = useState(null);
  const [oppMode, setOppMode] = useState("vsbot");
  const [coach, setCoach] = useState("professor");
  const [oppA, setOppA] = useState(null);
  const [oppB, setOppB] = useState(null);
  const [betSide, setBetSide] = useState(null);   // single-match main bet: null | "red" | "black"
  const [betAmt, setBetAmt] = useState(50);
  const [props, setProps] = useState({});          // {alpha_dog:"agent_a", ...}
  const [result, setResult] = useState(null);       // single-match simulate response
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  // tournament (live bet -> watch -> advance)
  const [tourney, setTourney] = useState(null);
  const [liveIdx, setLiveIdx] = useState(-1);        // index into the flat match queue
  const [livePhase, setLivePhase] = useState("bet"); // bet | watch | summary
  const [watchDone, setWatchDone] = useState(false);
  const [tBetSide, setTBetSide] = useState(null);
  const [tBetAmt, setTBetAmt] = useState(50);
  const [tSettle, setTSettle] = useState(null);
  const betsRef = useRef([]);                        // placed-bet records (synchronous, no stale closure)

  const div = clientDiversity(agentA, agentB);
  const combinedElo = agentA && agentB ? Math.round(((agentA.elo + agentB.elo) / 2) * div.bonus) : 0;
  const ready = agentA && agentB && agentA.id !== agentB.id && (oppMode === "vsbot" || (oppA && oppB && oppA.id !== oppB.id));
  const teamReady = agentA && agentB && agentA.id !== agentB.id;

  const reset = () => { setResult(null); setBetSide(null); setProps({}); };

  const start = async () => {
    setErr(null); setLoading(true);
    const body = { mode: "2v2", red_team: { agent_a_id: agentA.id, agent_b_id: agentB.id } };
    if (oppMode === "vsbot") body.vs_bot = { coach_id: coach };
    else body.black_team = { agent_a_id: oppA.id, agent_b_id: oppB.id };
    if (betSide) body.bet = { side: betSide, amount: betAmt };
    const pb = Object.entries(props).filter(([, v]) => v).map(([type, selection]) => ({ type, selection, amount: 30 }));
    if (pb.length) body.prop_bets = pb;
    try {
      const res = await fetch(`${API}/game/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json(); setErr(e.detail || "error"); setLoading(false); return; }
      setResult(await res.json()); setLoading(false); loadWallet && loadWallet();
    } catch (e) { setErr(String(e)); setLoading(false); }
  };

  const matchQueue = tourney ? tourney.rounds.flatMap((r) => r.matches.map((m) => ({ ...m, roundName: r.name }))) : [];
  const curMatch = liveIdx >= 0 && liveIdx < matchQueue.length ? matchQueue[liveIdx] : null;

  const runTourney = async () => {
    setErr(null); setLoading(true); setTourney(null); setTSettle(null); betsRef.current = [];
    try {
      const res = await fetch(`${API}/tournaments/team`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team: { agent_a_id: agentA.id, agent_b_id: agentB.id }, vs_bot: { coach_id: coach }, seeding: "elo" }) });
      if (!res.ok) { const e = await res.json(); setErr(e.detail || "error"); setLoading(false); return; }
      setTourney(await res.json()); setLiveIdx(0); setLivePhase("bet"); setWatchDone(false); setTBetSide(null); setLoading(false);
    } catch (e) { setErr(String(e)); setLoading(false); }
  };

  const watchMatch = () => { setWatchDone(false); setLivePhase("watch"); };

  const nextMatch = async () => {
    // record this match's bet into the ref (synchronous; survives re-renders)
    if (tBetSide && curMatch) {
      const odds = matchupOdds(curMatch.red_elo, curMatch.black_elo)[tBetSide];
      betsRef.current.push({ amount: tBetAmt, odds, won: curMatch.game.winner === tBetSide });
    }
    const nxt = liveIdx + 1;
    setTBetSide(null); setWatchDone(false);
    if (nxt >= matchQueue.length) {
      setLivePhase("summary");
      if (betsRef.current.length) {
        try {
          const res = await fetch(`${API}/bets/tournament-settle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bets: betsRef.current }) });
          if (res.ok) { setTSettle(await res.json()); loadWallet && loadWallet(); }
        } catch {}
      }
    } else {
      setLiveIdx(nxt); setLivePhase("bet");
    }
  };

  const resetTourney = () => { setTourney(null); setLiveIdx(-1); betsRef.current = []; setTSettle(null); setTBetSide(null); setLivePhase("bet"); };

  const pickRow = (label, val, setVal, color, exclude) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 8, color, letterSpacing: 1, marginBottom: 2 }}>{label}</div>
      <select value={val?.id || ""} onChange={(e) => setVal(roster.find((a) => a.id === parseInt(e.target.value)) || null)}
        style={{ width: "100%", padding: "5px", fontSize: 9, background: "#0d1117", color: "#c8d0da", border: "1px solid #21262d", borderRadius: 4, fontFamily: "inherit" }}>
        <option value="">— select —</option>
        {roster.filter((a) => !exclude || a.id !== exclude.id).map((a) => (
          <option key={a.id} value={a.id}>{a.name} (Lv.{a.level || 1}{a.perk ? " " + (EDGE_SHORT[a.perk] || a.perk) : ""})</option>
        ))}
      </select>
    </div>
  );

  // compact bet/prop controls for the single match
  const propBtn = (type, sel, label) => (
    <button onClick={() => setProps((p) => ({ ...p, [type]: p[type] === sel ? null : sel }))}
      style={{ flex: 1, fontSize: 8, padding: "3px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit",
        background: props[type] === sel ? "#161b22" : "#0d1117", border: `1px solid ${props[type] === sel ? "#1abc9c" : "#21262d"}`, color: props[type] === sel ? "#1abc9c" : "#4a5568" }}>{label}</button>
  );

  const playerSlotInCur = curMatch ? (curMatch.red_is_player ? "red" : curMatch.black_is_player ? "black" : null) : null;

  // --- tournament elimination tracking (single-elim: lose once = out) ---
  const playerTeamName = (m) => (m.red_is_player ? m.red_name : m.black_is_player ? m.black_name : null);
  const watchedCount = watchDone ? liveIdx + 1 : liveIdx;   // matches fully watched so far
  const lossMatch = matchQueue.slice(0, Math.max(0, watchedCount)).find((m) => {
    const ptn = playerTeamName(m);
    return ptn && m.winner_name !== ptn;
  });
  const playerEliminated = !!lossMatch;
  const tourneyHasRemaining = liveIdx + 1 < matchQueue.length;
  const pendingBetCount = betsRef.current.length + (tBetSide ? 1 : 0);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0" }}>
        <button onClick={onBack} style={{ fontSize: 9, background: "none", border: "1px solid #21262d", color: "#8892a0", borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>← BACK</button>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => { setSubMode("match"); resetTourney(); }} style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "3px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", background: subMode === "match" ? "#161b22" : "#0d1117", border: `1px solid ${subMode === "match" ? "#1abc9c" : "#21262d"}`, color: subMode === "match" ? "#1abc9c" : "#4a5568" }}>SINGLE MATCH</button>
          <button onClick={() => { setSubMode("tournament"); reset(); }} style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "3px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", background: subMode === "tournament" ? "#161b22" : "#0d1117", border: `1px solid ${subMode === "tournament" ? "#f39c12" : "#21262d"}`, color: subMode === "tournament" ? "#f39c12" : "#4a5568" }}>TOURNAMENT</button>
        </div>
      </div>
      <h2 style={{ textAlign: "center", fontSize: 16, letterSpacing: 4, color: "#1abc9c", margin: "4px 0 12px" }}>TAG TEAM 2v2</h2>
      {err && <div style={{ color: "#e74c3c", fontSize: 9, textAlign: "center", marginBottom: 6 }}>{err}</div>}

      {/* TEAM SELECTION */}
      {!result && !tourney && (
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 14, maxWidth: 560, margin: "0 auto" }}>
          <div style={{ fontSize: 9, color: "#8892a0", letterSpacing: 2, marginBottom: 8 }}>SELECT YOUR TEAM</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            {pickRow("AGENT A", agentA, setAgentA, AGENT_A_COLOR, agentB)}
            {pickRow("AGENT B", agentB, setAgentB, AGENT_B_COLOR, agentA)}
          </div>
          {agentA && agentB && (
            <div style={{ background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 6, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, marginBottom: 4 }}>TEAM STATS</div>
              <div style={{ fontSize: 11, color: "#1abc9c", fontWeight: 800 }}>Diversity: {Math.round(div.frac * 100)}% → {div.bonus}x bonus</div>
              <div style={{ fontSize: 9, color: "#8892a0", marginTop: 2 }}>Combined Elo: {combinedElo}</div>
              <div style={{ fontSize: 9, color: "#8892a0" }}>Edge combo: {edgeComboDesc(agentA.perk, agentB.perk)}</div>
              {div.frac < 0.05 && <div style={{ fontSize: 8, color: "#e67e22", marginTop: 2 }}>⚠ near-clone pair — no diversity bonus</div>}
            </div>
          )}
          {subMode === "match" && (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button onClick={() => setOppMode("vsbot")} style={{ flex: 1, fontSize: 9, padding: "4px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", background: oppMode === "vsbot" ? "#161b22" : "#0d1117", border: `1px solid ${oppMode === "vsbot" ? "#1abc9c" : "#21262d"}`, color: oppMode === "vsbot" ? "#1abc9c" : "#4a5568" }}>VS BOT</button>
                <button onClick={() => setOppMode("sandbox")} style={{ flex: 1, fontSize: 9, padding: "4px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", background: oppMode === "sandbox" ? "#161b22" : "#0d1117", border: `1px solid ${oppMode === "sandbox" ? "#1abc9c" : "#21262d"}`, color: oppMode === "sandbox" ? "#1abc9c" : "#4a5568" }}>SANDBOX</button>
              </div>
              {oppMode === "vsbot" ? (
                <select value={coach} onChange={(e) => setCoach(e.target.value)} style={{ width: "100%", padding: "5px", fontSize: 9, background: "#0d1117", color: "#c8d0da", border: "1px solid #21262d", borderRadius: 4, fontFamily: "inherit", marginBottom: 8 }}>
                  <option value="blitz">Coach Blitz (two aggressors)</option>
                  <option value="fortress">The Fortress (two walls)</option>
                  <option value="shark">The Shark (aggressive + trader)</option>
                  <option value="professor">The Professor (high-diversity pair)</option>
                  <option value="wildcard">Wildcard (random pair)</option>
                  <option value="mirror">The Mirror (counters your pair)</option>
                </select>
              ) : (
                <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                  {pickRow("OPP A", oppA, setOppA, "#ecf0f1", oppB)}
                  {pickRow("OPP B", oppB, setOppB, "#ecf0f1", oppA)}
                </div>
              )}
              {/* main bet (optional) */}
              <div style={{ background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 6, padding: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, marginBottom: 4 }}>BET (optional)</div>
                <div style={{ display: "flex", gap: 6, marginBottom: betSide ? 6 : 0 }}>
                  {[["none", "NO BET", "#4a5568"], ["red", "RED", "#e74c3c"], ["black", "BLACK", "#ecf0f1"]].map(([v, lbl, col]) => (
                    <button key={v} onClick={() => setBetSide(v === "none" ? null : v)} style={{ flex: 1, fontSize: 8, padding: "3px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", background: (betSide === v || (v === "none" && !betSide)) ? "#161b22" : "#0d1117", border: `1px solid ${(betSide === v || (v === "none" && !betSide)) ? col : "#21262d"}`, color: (betSide === v || (v === "none" && !betSide)) ? col : "#4a5568" }}>{lbl}</button>
                  ))}
                </div>
                {betSide && <input type="number" value={betAmt} min={10} onChange={(e) => setBetAmt(Math.max(10, parseInt(e.target.value) || 10))} style={{ width: "100%", padding: "4px", fontSize: 9, background: "#0d1117", color: "#c8d0da", border: "1px solid #21262d", borderRadius: 4, fontFamily: "inherit" }} />}
                {/* 2v2 side action props */}
                <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, margin: "6px 0 3px" }}>SIDE ACTION (30 each)</div>
                <div style={{ display: "flex", gap: 4, marginBottom: 3 }}><span style={{ fontSize: 7, color: "#6b7280", width: 60 }}>Alpha Dog</span>{propBtn("alpha_dog", "agent_a", "Agent A")}{propBtn("alpha_dog", "agent_b", "Agent B")}</div>
                <div style={{ display: "flex", gap: 4, marginBottom: 3 }}><span style={{ fontSize: 7, color: "#6b7280", width: 60 }}>Team Clash</span>{propBtn("team_clash", "over", "Over 50%")}{propBtn("team_clash", "under", "Under 50%")}</div>
                <div style={{ display: "flex", gap: 4 }}><span style={{ fontSize: 7, color: "#6b7280", width: 60 }}>Double Edge</span>{propBtn("double_edge", "yes", "Both fire")}{propBtn("double_edge", "no", "Not both")}</div>
              </div>
              <button disabled={!ready || loading} onClick={start} style={{ width: "100%", padding: "9px", borderRadius: 6, border: "none", background: ready ? "linear-gradient(135deg,#1abc9c,#16a085)" : "#1a1f2b", color: ready ? "#fff" : "#4a5568", fontWeight: 800, fontSize: 12, letterSpacing: 3, cursor: ready ? "pointer" : "default", fontFamily: "inherit" }}>{loading ? "..." : "TAG TEAM FIGHT"}</button>
            </>
          )}
          {subMode === "tournament" && (
            <>
              <select value={coach} onChange={(e) => setCoach(e.target.value)} style={{ width: "100%", padding: "5px", fontSize: 9, background: "#0d1117", color: "#c8d0da", border: "1px solid #21262d", borderRadius: 4, fontFamily: "inherit", marginBottom: 8 }}>
                <option value="mixed">Mixed coaches (3 different bot teams)</option>
                <option value="blitz">All Coach Blitz teams</option>
                <option value="professor">All Professor teams</option>
                <option value="shark">All Shark teams</option>
              </select>
              <div style={{ fontSize: 8, color: "#6b7280", marginBottom: 8, textAlign: "center" }}>You'll bet on each match, then watch it play out live.</div>
              <button disabled={!teamReady || loading} onClick={runTourney} style={{ width: "100%", padding: "9px", borderRadius: 6, border: "none", background: teamReady ? "linear-gradient(135deg,#f39c12,#e67e22)" : "#1a1f2b", color: teamReady ? "#fff" : "#4a5568", fontWeight: 800, fontSize: 12, letterSpacing: 3, cursor: teamReady ? "pointer" : "default", fontFamily: "inherit" }}>{loading ? "..." : "ENTER 4-TEAM BRACKET"}</button>
            </>
          )}
        </div>
      )}

      {/* SINGLE-MATCH PLAYBACK */}
      {result && (
        <div>
          <MatchPlayback key="single" game={result} redTeam={result.red_team} blackTeam={result.black_team} />
          <div style={{ maxWidth: 560, margin: "8px auto 0" }}>
            {result.bet && <div style={{ textAlign: "center", fontSize: 11, fontWeight: 800, color: result.bet.result === "win" ? "#2ecc71" : "#e74c3c" }}>Bet: {result.bet.result === "win" ? `+${result.bet.payout}` : result.bet.net} coins</div>}
            {result.prop_results && result.prop_results.length > 0 && (
              <div style={{ width: "100%", padding: "4px 8px", background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 4, fontSize: 8, marginTop: 4 }}>
                <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, marginBottom: 2 }}>SIDE ACTION</div>
                {result.prop_results.map((pr, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", color: pr.result === "win" ? "#2ecc71" : "#e74c3c" }}>
                    <span>{pr.result === "win" ? "✅" : "❌"} {pr.label}: {pr.selection}</span>
                    <span style={{ color: "#6b7280" }}>{pr.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {result.mirror_data && <div style={{ fontSize: 8, color: "#9b59b6", textAlign: "center", marginTop: 4 }}>🪞 {result.mirror_data.mirror_strategy} (read: {result.mirror_data.pair_read})</div>}
            <TeamDynamicsBreakdown result={result} />
            <div style={{ textAlign: "center", marginTop: 8 }}>
              <button onClick={reset} style={{ fontSize: 10, padding: "5px 18px", borderRadius: 4, border: "1px solid #1abc9c", background: "transparent", color: "#1abc9c", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>NEW MATCH</button>
            </div>
          </div>
        </div>
      )}

      {/* LIVE TOURNAMENT */}
      {tourney && (
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {/* seeded bracket overview */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            {tourney.bracket.map((t) => (
              <div key={t.slot} style={{ padding: 7, borderRadius: 6, background: t.is_player ? "rgba(26,188,156,0.1)" : "#0d1117", border: `1px solid ${t.is_player ? "#1abc9c" : "#21262d"}` }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: t.is_player ? "#1abc9c" : "#c8d0da" }}>#{t.seed} {t.agent_a} + {t.agent_b}{t.is_player ? " (YOU)" : ""}</div>
                <div style={{ fontSize: 7, color: "#6b7280" }}>{t.coach_name || "your team"} · div {t.diversity_pct}% ({t.diversity_bonus}x) · elo {t.team_elo}</div>
              </div>
            ))}
          </div>
          {/* match list reveals as you watch */}
          <div style={{ marginBottom: 10 }}>
            {matchQueue.map((m, gi) => {
              const watched = gi < liveIdx || livePhase === "summary";
              const active = gi === liveIdx && livePhase !== "summary";
              // a later-round match's participants are spoilers until we reach it (feeders unplayed)
              const firstRound = tourney.rounds[0] && m.roundName === tourney.rounds[0].name;
              const known = gi <= liveIdx || firstRound;
              const ip = known && (m.red_is_player || m.black_is_player);
              const redLbl = known ? m.red_name : "TBD";
              const blackLbl = known ? m.black_name : "TBD";
              return (
                <div key={gi} style={{ fontSize: 9, padding: "3px 8px", background: active ? "rgba(243,156,18,0.1)" : "#0a0c10", border: `1px solid ${active ? "#f39c12" : "#161b22"}`, borderRadius: 4, marginBottom: 3 }}>
                  <span style={{ fontSize: 7, color: "#4a5568" }}>{m.roundName}{ip ? " · YOUR MATCH" : ""}  </span>
                  <span style={{ color: watched && m.winner_name === m.red_name ? "#2ecc71" : "#8892a0" }}>{redLbl}</span>
                  <span style={{ color: "#4a5568" }}> vs </span>
                  <span style={{ color: watched && m.winner_name === m.black_name ? "#2ecc71" : "#8892a0" }}>{blackLbl}</span>
                  {watched ? <span style={{ color: "#6b7280", fontSize: 7 }}> · {m.game.winner} in {m.game.move_count}</span> : active ? <span style={{ color: "#f39c12", fontSize: 7 }}> · ▶ NOW</span> : <span style={{ color: "#3a4450", fontSize: 7 }}> · {known ? "upcoming" : "awaiting semis"}</span>}
                </div>
              );
            })}
          </div>

          {/* BET phase */}
          {livePhase === "bet" && curMatch && (() => {
            const odds = matchupOdds(curMatch.red_elo, curMatch.black_elo);
            return (
              <div style={{ background: "#0d1117", border: "1px solid #f39c1244", borderRadius: 8, padding: 12, maxWidth: 460, margin: "0 auto" }}>
                <div style={{ fontSize: 8, color: "#f39c12", letterSpacing: 1, marginBottom: 4 }}>{curMatch.roundName} — PLACE YOUR BET{playerSlotInCur ? " · YOUR MATCH" : ""}</div>
                <div style={{ fontSize: 10, color: "#c8d0da", marginBottom: 8 }}>
                  <span style={{ color: "#e74c3c" }}>{curMatch.red_name}</span> ({odds.red}x) <span style={{ color: "#4a5568" }}>vs</span> <span style={{ color: "#ecf0f1" }}>{curMatch.black_name}</span> ({odds.black}x)
                </div>
                <div style={{ display: "flex", gap: 6, marginBottom: tBetSide ? 6 : 0 }}>
                  {[["none", "SKIP", "#4a5568"], ["red", `RED ${odds.red}x`, "#e74c3c"], ["black", `BLACK ${odds.black}x`, "#ecf0f1"]].map(([v, lbl, col]) => (
                    <button key={v} onClick={() => setTBetSide(v === "none" ? null : v)} style={{ flex: 1, fontSize: 9, padding: "5px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", background: (tBetSide === v || (v === "none" && !tBetSide)) ? "#161b22" : "#0d1117", border: `1px solid ${(tBetSide === v || (v === "none" && !tBetSide)) ? col : "#21262d"}`, color: (tBetSide === v || (v === "none" && !tBetSide)) ? col : "#4a5568" }}>{lbl}</button>
                  ))}
                </div>
                {tBetSide && <input type="number" value={tBetAmt} min={10} onChange={(e) => setTBetAmt(Math.max(10, parseInt(e.target.value) || 10))} style={{ width: "100%", padding: "5px", fontSize: 9, background: "#0d1117", color: "#c8d0da", border: "1px solid #21262d", borderRadius: 4, fontFamily: "inherit", marginBottom: 6 }} />}
                <button onClick={watchMatch} style={{ width: "100%", padding: "8px", borderRadius: 6, border: "none", background: "linear-gradient(135deg,#1abc9c,#16a085)", color: "#fff", fontWeight: 800, fontSize: 11, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit", marginTop: 6 }}>▶ WATCH MATCH</button>
              </div>
            );
          })()}

          {/* WATCH phase */}
          {livePhase === "watch" && curMatch && (
            <div>
              <MatchPlayback key={liveIdx} game={curMatch.game} redTeam={curMatch.red_team} blackTeam={curMatch.black_team} compact onFinish={() => setWatchDone(true)} />
              {watchDone && (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#c8d0da" }}>{curMatch.winner_name} wins</div>
                  {tBetSide && <div style={{ fontSize: 10, fontWeight: 700, color: curMatch.game.winner === tBetSide ? "#2ecc71" : "#e74c3c", marginTop: 2 }}>{curMatch.game.winner === tBetSide ? `Bet won +${Math.floor(tBetAmt * matchupOdds(curMatch.red_elo, curMatch.black_elo)[tBetSide])}` : `Bet lost -${tBetAmt}`}</div>}
                  {playerEliminated && tourneyHasRemaining ? (
                    <div style={{ marginTop: 10, padding: "10px 12px", background: "rgba(231,76,60,0.08)", border: "1px solid #e74c3c44", borderRadius: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#e74c3c", letterSpacing: 1 }}>YOUR TEAM WAS ELIMINATED</div>
                      {lossMatch && <div style={{ fontSize: 9, color: "#8892a0", marginTop: 3 }}>{playerTeamName(lossMatch)} lost to {lossMatch.winner_name}</div>}
                      {pendingBetCount > 0 && <div style={{ fontSize: 8, color: "#e67e22", marginTop: 5 }}>You have active bets on this tournament. Exiting will forfeit pending winnings.</div>}
                      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }}>
                        <button onClick={nextMatch} style={{ fontSize: 10, padding: "6px 16px", borderRadius: 4, border: "1px solid #f39c12", background: "transparent", color: "#f39c12", fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>WATCH REMAINING</button>
                        <button onClick={resetTourney} style={{ fontSize: 10, padding: "6px 16px", borderRadius: 4, border: "none", background: "linear-gradient(135deg,#e74c3c,#c0392b)", color: "#fff", fontWeight: 800, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>EXIT TOURNAMENT</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={nextMatch} style={{ fontSize: 11, padding: "6px 20px", borderRadius: 4, border: "none", background: "linear-gradient(135deg,#f39c12,#e67e22)", color: "#fff", fontWeight: 800, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit", marginTop: 8 }}>{liveIdx + 1 >= matchQueue.length ? "SEE RESULTS" : "NEXT MATCH ▶"}</button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SUMMARY */}
          {livePhase === "summary" && (
            <div style={{ textAlign: "center", maxWidth: 460, margin: "0 auto" }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: tourney.champion.is_player ? "#2ecc71" : "#f39c12", marginBottom: 6 }}>🏆 {tourney.champion.name}{tourney.champion.is_player ? " — YOU WIN!" : ""}</div>
              {tSettle ? (
                <div style={{ padding: "8px 16px", background: tSettle.net >= 0 ? "rgba(46,204,113,0.1)" : "rgba(231,76,60,0.1)", border: `1px solid ${tSettle.net >= 0 ? "rgba(46,204,113,0.3)" : "rgba(231,76,60,0.3)"}`, borderRadius: 6, marginBottom: 10 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: tSettle.net >= 0 ? "#2ecc71" : "#e74c3c" }}>{tSettle.net >= 0 ? "+" : ""}{tSettle.net} coins</div>
                  <div style={{ fontSize: 8, color: "#4a5568" }}>tournament P&L · balance {tSettle.balance}</div>
                </div>
              ) : <div style={{ fontSize: 9, color: "#4a5568", marginBottom: 10 }}>No bets placed</div>}
              <button onClick={resetTourney} style={{ fontSize: 10, padding: "6px 20px", borderRadius: 4, border: "1px solid #f39c12", background: "transparent", color: "#f39c12", cursor: "pointer", fontFamily: "inherit", letterSpacing: 1 }}>NEW BRACKET</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [appMode, setAppMode] = useState("match");
  const [matchMode, setMatchMode] = useState("vsbot");
  const [showHelp, setShowHelp] = useState(true);
  const [muted, setMuted] = useState(false);
  useEffect(() => { gameAudio.ensureInit(); }, []);
  const [wallet, setWallet] = useState({ balance: 1000, win_streak: 0 });
  const [jackpotPool, setJackpotPool] = useState(0);
  const [currentBet, setCurrentBet] = useState(null);
  const [betChoice, setBetChoice] = useState(100);  // selected stake for VS BOT / sandbox free-play bets
  const [propBets, setPropBets] = useState([]);
  const [propOdds, setPropOdds] = useState(null);
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
    if (matchMode === "vsbot" && redAgent && selectedCoach) { loadOdds(redAgent.elo, redAgent.elo); fetch(`${API}/odds/props?red_agent_id=${redAgent.id}`).then(r => r.json()).then(d => setPropOdds(d.props)).catch(() => {}); }
    else if (matchMode === "sandbox" && redAgent && blackAgent) { loadOdds(redAgent.elo, blackAgent.elo); fetch(`${API}/odds/props?red_agent_id=${redAgent.id}&black_agent_id=${blackAgent.id}`).then(r => r.json()).then(d => setPropOdds(d.props)).catch(() => {}); }
    else { setBetOdds(null); setPropOdds(null); }
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
      if (propBets.length > 0) body.prop_bets = propBets;
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
  const resetGame = () => { setBoards(null); setMoves(null); setResult(null); setEvents([]); setCurrentStep(0); setCurrentBet(null); setPropBets([]); loadRoster(); loadWallet(); loadJackpot(); };

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
  if (appMode === "tagteam") {
    return <TagTeam roster={roster} onBack={() => { setAppMode("match"); loadRoster(); }} loadRoster={loadRoster} loadWallet={loadWallet} />;
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
              <span style={{ fontSize: 8, color: "#e67e22", marginLeft: 2 }}>HOT STREAK {wallet.win_streak}</span>
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
        <div style={{ fontSize: "clamp(10px, 2.6vw, 13px)", color: "#8892a0", marginTop: 6, letterSpacing: 1, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
          Configure AI agents. Watch them fight. Bet on the outcome.
        </div>
        <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          <button onClick={() => setAppMode("match")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#161b22", border: "1px solid #2ecc71", color: "#2ecc71", borderRadius: 3, textTransform: "uppercase" }}>MATCH</button>
          <button onClick={() => setAppMode("tournament")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#0d1117", border: "1px solid #f39c1266", color: "#f39c12", borderRadius: 3, textTransform: "uppercase" }}>TOURNAMENT</button>
          <button onClick={() => setAppMode("multiplayer")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#0d1117", border: "1px solid #9b59b666", color: "#9b59b6", borderRadius: 3, textTransform: "uppercase" }}>MULTIPLAYER</button>
          <button onClick={() => setAppMode("tagteam")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#0d1117", border: "1px solid #1abc9c66", color: "#1abc9c", borderRadius: 3, textTransform: "uppercase" }}>TAG TEAM</button>
        </div>
      </div>

      {showHelp ? (
        <div style={{ maxWidth: 480, margin: "0 auto 12px", padding: "8px 14px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, fontSize: 9, color: "#8892a0", lineHeight: 1.6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 2, color: "#4a5568", textTransform: "uppercase" }}>How it works</span>
            <button onClick={() => setShowHelp(false)} style={{ fontSize: 8, background: "none", border: "none", color: "#4a5568", cursor: "pointer", fontFamily: "inherit" }}>X</button>
          </div>
          <div>1. Pick your agent, then choose an opponent — a coach bot, or another agent in Sandbox.</div>
          <div>2. Each agent has 5 personality sliders: aggression, risk, king priority, edge play, trade-down.</div>
          <div>3. Optionally bet on the winner, then watch them play it out. Best personality wins.</div>
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

      {!boards && !loading && redAgent && (matchMode === "vsbot" ? !selectedCoach : !blackAgent) && (
        <div style={{ textAlign: "center", marginBottom: 10, fontSize: 11, color: "#e67e22", letterSpacing: 1 }}>
          {matchMode === "vsbot"
            ? "👇 Pick an opponent below, then hit WATCH to start your first match"
            : "👇 Pick a second agent (black) below, then hit WATCH to start"}
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
              {board ? (
                <BoardGrid board={board} lastMove={lastMove} redLevel={redAgent?.level || 1} blackLevel={blackAgent?.level || 1} />
              ) : (
                /* pre-match: a compact placeholder instead of a full empty board, so the
                   opponent picker stays near the top (critical on mobile / first run). */
                <div style={{ width: "100%", maxWidth: 380, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed #1a1f2b", borderRadius: 8, background: "#0a0c10", padding: "26px 16px" }}>
                  <div style={{ textAlign: "center", color: "#3a4450", fontSize: 10, letterSpacing: 1, lineHeight: 1.6 }}>
                    {canGo ? "▶ Press WATCH or GO — the match plays out here" : "Pick your agent + an opponent — the match plays out here"}
                  </div>
                </div>
              )}
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
              <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 2, textTransform: "uppercase", textAlign: "center", marginBottom: 2 }}>Place your bet</div>
              <div style={{ fontSize: 7, color: "#6b7280", textAlign: "center", marginBottom: 4 }}>Practice chips — free play. Real stakes are in Multiplayer.</div>
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
                  <button key={amt} onClick={() => setBetChoice(amt)} style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: betChoice === amt ? "#9b59b622" : "#161b22", border: `1px solid ${betChoice === amt ? "#9b59b6" : "#21262d"}`, color: betChoice === amt ? "#9b59b6" : "#8892a0", cursor: "pointer", fontFamily: "inherit" }}>{amt}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                {["red", "black", "draw"].map(side => {
                  const colors = { red: "#e74c3c", black: "#ecf0f1", draw: "#4a5568" };
                  return [10, 50, 100, 250].filter(a => a <= wallet.balance).length > 0 ? (
                    <button key={side} onClick={() => {
                      const amt = Math.min(betChoice, wallet.balance);
                      setCurrentBet({ side, amount: amt });
                    }} style={{ padding: "4px 12px", borderRadius: 3, border: `1px solid ${colors[side]}44`, background: "transparent", color: colors[side], fontSize: 8, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase" }}>BET {side.toUpperCase()}</button>
                  ) : null;
                })}
                <button onClick={startGame} title="Start the match without betting" style={{ padding: "4px 16px", borderRadius: 3, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontSize: 8, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>WATCH ▶</button>
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

          {/* prop bets panel */}
          {canGo && propOdds && propOdds.length > 0 && (
            <div style={{ width: "100%", marginTop: 6, padding: "6px 10px", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6 }}>
              <div style={{ fontSize: 8, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4, textAlign: "center" }}>Prop bets (up to 4)</div>
              <div style={{ maxHeight: 160, overflowY: "auto" }}>
                {propOdds.map(p => {
                  const existing = propBets.find(b => b.type === p.type);
                  return (
                    <div key={p.type} style={{ padding: "4px 6px", marginBottom: 3, background: existing ? "#161b22" : "#0a0c10", border: `1px solid ${existing ? "#2ecc7144" : "#1a1f2b"}`, borderRadius: 3 }}>
                      <div style={{ fontSize: 8, fontWeight: 700, color: "#8892a0" }}>{p.icon} {p.label}</div>
                      <div style={{ display: "flex", gap: 3, marginTop: 2 }}>
                        {p.options.map(o => (
                          <button key={o.selection} onClick={() => {
                            if (propBets.length >= 4 && !existing) return;
                            setPropBets(prev => {
                              const filtered = prev.filter(b => b.type !== p.type);
                              if (existing?.selection === o.selection) return filtered;
                              return [...filtered, { type: p.type, selection: o.selection, amount: 20 }];
                            });
                          }} style={{
                            padding: "1px 6px", borderRadius: 2, fontSize: 7, fontFamily: "inherit", cursor: "pointer",
                            background: existing?.selection === o.selection ? "#2ecc7122" : "#0d1117",
                            border: `1px solid ${existing?.selection === o.selection ? "#2ecc71" : "#21262d"}`,
                            color: existing?.selection === o.selection ? "#2ecc71" : "#4a5568",
                          }}>{o.label} {o.odds}x</button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {propBets.length > 0 && <div style={{ fontSize: 7, color: "#4a5568", textAlign: "center", marginTop: 3 }}>Props: {propBets.length}/4 | Cost: {propBets.reduce((s, b) => s + b.amount, 0)}</div>}
            </div>
          )}

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
                {result.bet.streak && <div style={{ fontSize: 8, color: "#e67e22", marginTop: 2 }}>{result.bet.result === "win" ? `🔥 HOT STREAK: ${result.bet.streak.streak}` : "HOT STREAK broken"}</div>}
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
                <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: result.winner === "red" ? "#e74c3c" : result.winner === "black" ? "#ecf0f1" : "#f39c12" }}>{result.winner === "draw" ? "DRAW" : `${result.winner === "red" ? (result.red_agent?.name || "RED") : (result.black_agent?.name || result.bot_opponent?.name || "BLACK")} wins`}</span>
                <button onClick={resetGame} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>REMATCH</button>
              </>
            )}
            {/* mirror-specific post-bout feedback */}
            {isFinished && result.mirror_data && (
              <div style={{ width: "100%", padding: "6px 10px", background: "#0a0610", border: "1px solid #9b59b633", borderRadius: 4, fontSize: 8, marginTop: 4 }}>
                <div style={{ fontSize: 7, color: "#9b59b6", letterSpacing: 1, textTransform: "uppercase", marginBottom: 3 }}>🪞 Mirror Analysis</div>
                <div style={{ color: "#8892a0", marginBottom: 2 }}>{result.mirror_data.mirror_strategy}</div>
                {result.mirror_data.tendencies_exploited && <div style={{ color: "#6c5ce7", marginBottom: 2 }}>Exploited: {result.mirror_data.tendencies_exploited}</div>}
                <div style={{ color: "#4a5568" }}>Bout #{result.mirror_data.bout_number} | {result.mirror_data.series_record} | Adaptation: {result.mirror_data.adaptation_level}%</div>
                {result.mirror_data.milestone && <div style={{ color: "#9b59b6", fontStyle: "italic", marginTop: 2 }}>{result.mirror_data.milestone}</div>}
              </div>
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
              if ((loserCfg.aggression || 50) > 70 && result.move_count < 60) suggestion = "Your agent overextended. Consider lowering risk tolerance or adding Counter.";
              else if ((loserCfg.aggression || 50) < 30) suggestion = "Your agent was too passive. Consider raising aggression or adding Surge.";
              else if (turningMove > 0 && turningMove < result.move_count * 0.4) suggestion = "Your agent fell behind early. Consider a more aggressive opening config.";
              else if (result.move_count > 80) suggestion = "Long match. Consider raising king priority for better endgame play.";
              return (
                <div style={{ width: "100%", padding: "6px 10px", background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 4, fontSize: 8, marginTop: 4 }}>
                  <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 3 }}>Post-match breakdown</div>
                  <div style={{ color: "#8892a0", marginBottom: 2 }}><span style={{ color: "#4a5568" }}>TURNING POINT:</span> {tpText}</div>
                  {perkLines.length > 0 && <div style={{ color: "#8892a0", marginBottom: 2 }}><span style={{ color: "#4a5568" }}>EDGES:</span> {perkLines.join(". ")}</div>}
                  <div style={{ color: "#e67e22" }}><span style={{ color: "#4a5568" }}>TIP:</span> {suggestion}</div>
                </div>
              );
            })()}
            {isFinished && result.level_ups && result.level_ups.map((lu, i) => (
              <div key={i}>
                <div style={{ padding: "4px 10px", borderRadius: 4, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", background: lu.perk_unlocked ? "rgba(255,215,0,0.12)" : "rgba(46,204,113,0.12)", border: `1px solid ${lu.perk_unlocked ? "rgba(255,215,0,0.3)" : "rgba(46,204,113,0.3)"}`, color: lu.perk_unlocked ? "#ffd700" : "#2ecc71" }}>
                  {lu.name} reached Level {lu.new_level}{lu.perk_unlocked ? " -- Choose an edge!" : ""}
                </div>
                {lu.new_level >= 15 && lu.old_level < 15 && (
                  <div style={{ padding: "3px 10px", marginTop: 2, borderRadius: 4, fontSize: 8, background: "rgba(22,160,133,0.12)", border: "1px solid rgba(22,160,133,0.3)", color: "#16a085" }}>NEW EDGES UNLOCKED: Anchor ⚓ and Phantom 👻</div>
                )}
                {lu.new_level >= 25 && lu.old_level < 25 && (
                  <div style={{ padding: "3px 10px", marginTop: 2, borderRadius: 4, fontSize: 8, background: "rgba(231,76,60,0.12)", border: "1px solid rgba(231,76,60,0.3)", color: "#e74c3c" }}>NEW EDGES UNLOCKED: Siege 🏰 and Flux 🌀</div>
                )}
              </div>
            ))}
            {/* evolution notification */}
            {isFinished && result.evolution && (
              <div style={{ width: "100%", padding: "5px 10px", background: "rgba(155,89,182,0.1)", border: "1px solid rgba(155,89,182,0.3)", borderRadius: 4, fontSize: 8 }}>
                <div style={{ fontSize: 7, color: "#9b59b6", letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 }}>🧬 Evolution · {result.evolution.matches_analyzed} bouts analyzed</div>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#c8d0da", marginBottom: 2 }}>{result.evolution.agent_name} evolved</div>
                {Object.entries(result.evolution.changes).map(([s, c]) => (
                  <div key={s} style={{ color: "#8892a0" }}>{s.replace("_", " ")}: {c.from} → {c.to} <span style={{ color: (c.to - c.from) > 0 ? "#2ecc71" : "#e74c3c" }}>({(c.to - c.from) > 0 ? "+" : ""}{c.to - c.from})</span></div>
                ))}
                <div style={{ fontSize: 7, color: "#6b7280", marginTop: 2, fontStyle: "italic" }}>Sliders nudged toward what's been winning over the last {result.evolution.matches_analyzed} competitive bouts.</div>
              </div>
            )}
            {/* prop bet results */}
            {isFinished && result.prop_results && result.prop_results.length > 0 && (
              <div style={{ width: "100%", padding: "4px 8px", background: "#0a0c10", border: "1px solid #1a1f2b", borderRadius: 4, fontSize: 8, marginTop: 4 }}>
                <div style={{ fontSize: 7, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 }}>Prop results</div>
                {result.prop_results.map((pr, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0", color: pr.result === "win" ? "#2ecc71" : pr.result === "push" ? "#f39c12" : "#e74c3c" }}>
                    <span>{pr.result === "win" ? "✅" : pr.result === "push" ? "↩" : "❌"} {pr.label}: {pr.selection}{pr.resolved_at_move ? ` (move ${pr.resolved_at_move})` : ""}</span>
                    <span style={{ fontWeight: 700 }}>{pr.result === "win" ? `+${pr.payout}` : pr.result === "push" ? `↩${pr.payout}` : `-${pr.amount}`}</span>
                  </div>
                ))}
                <div style={{ borderTop: "1px solid #1a1f2b", marginTop: 2, paddingTop: 2, display: "flex", justifyContent: "space-between", color: "#8892a0" }}>
                  <span>Props net:</span>
                  <span style={{ fontWeight: 700, color: result.prop_results.reduce((s, p) => s + (p.result === "win" || p.result === "push" ? p.payout : 0) - p.amount, 0) >= 0 ? "#2ecc71" : "#e74c3c" }}>
                    {result.prop_results.reduce((s, p) => s + (p.result === "win" || p.result === "push" ? p.payout : 0) - p.amount, 0) >= 0 ? "+" : ""}{result.prop_results.reduce((s, p) => s + (p.result === "win" || p.result === "push" ? p.payout : 0) - p.amount, 0)}
                  </span>
                </div>
              </div>
            )}
            {/* live prop tracker during match */}
            {boards && !isFinished && result?.prop_results && result.prop_results.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", marginTop: 2 }}>
                {result.prop_results.map((pr, i) => {
                  const resolved = pr.resolved_at_move != null && pr.resolved_at_move <= currentStep;
                  return (
                    <span key={i} style={{ fontSize: 7, padding: "1px 4px", borderRadius: 2, background: resolved ? (pr.result === "win" ? "#2ecc7122" : "#e74c3c22") : "#161b22", border: `1px solid ${resolved ? (pr.result === "win" ? "#2ecc71" : "#e74c3c") : "#21262d"}`, color: resolved ? (pr.result === "win" ? "#2ecc71" : "#e74c3c") : "#4a5568" }}>
                      {pr.label}: {pr.selection} {resolved ? (pr.result === "win" ? "✅" : "❌") : "..."}
                    </span>
                  );
                })}
              </div>
            )}
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
                <div style={{ fontSize: 9, color: "#e67e22", fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>⚔ RUNBACK</div>
                <div style={{ fontSize: 8, color: "#8892a0", marginBottom: 4 }}>Same opponent. 1.5x odds boost.</div>
                <button onClick={async () => {
                  const body = { agent_id: redAgent.id, opponent_config: result.revenge_available.opponent_config, opponent_perk: result.revenge_available.opponent_perk };
                  try {
                    const res = await fetch(`${API}/game/revenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                    if (res.ok) { const d = await res.json(); setBoards(d.boards); setMoves(d.moves); setEvents(d.events || []); setResult(d); maxStepRef.current = d.boards.length - 1; stepRef.current = 0; setCurrentStep(0); playingRef.current = true; setPlaying(true); playNext(); loadWallet(); loadJackpot(); }
                  } catch {}
                }} style={{ padding: "4px 16px", borderRadius: 3, border: "none", background: "#e67e22", color: "#fff", fontWeight: 700, fontSize: 9, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>ACCEPT RUNBACK</button>
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
                  {/* The Mirror - special adaptive opponent */}
                  <div style={{ borderTop: "1px solid #1a1f2b", marginTop: 6, paddingTop: 6 }}>
                    <div onClick={() => setSelectedCoach({ id: "mirror", name: "The Mirror", title: "I've been watching.", icon: "🪞" })}
                      style={{
                        padding: "8px 10px", borderRadius: 4, cursor: "pointer",
                        background: selectedCoach?.id === "mirror" ? "#0f0a1a" : "#080610",
                        border: `1px solid ${selectedCoach?.id === "mirror" ? "#9b59b666" : "#1a1a2e"}`,
                      }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: selectedCoach?.id === "mirror" ? "#9b59b6" : "#8e7cc3" }}>🪞 THE MIRROR</span>
                        <span style={{ fontSize: 7, fontWeight: 700, color: "#9b59b6", textTransform: "uppercase" }}>ADAPTIVE</span>
                      </div>
                      <div style={{ fontSize: 8, color: "#6c5ce7", fontStyle: "italic" }}>"I've been watching."</div>
                      {selectedCoach?.id === "mirror" && (
                        <div style={{ fontSize: 7, color: "#4a5568", marginTop: 3 }}>
                          Learns from your entire match history. Adapts to counter your tendencies. Gets smarter with every bout.
                        </div>
                      )}
                    </div>
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
