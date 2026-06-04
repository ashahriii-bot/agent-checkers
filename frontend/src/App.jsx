import { useState, useEffect, useRef, useCallback } from "react";

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

function Slider({ label, value, onChange, color, disabled }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: 2, textTransform: "uppercase", color: "#8892a0" }}>{label}</span>
        <span style={{ fontSize: 8, fontWeight: 700, color }}>{value}</span>
      </div>
      <input type="range" min="0" max="100" value={value} disabled={disabled} onChange={(e) => onChange(parseInt(e.target.value))}
        style={{ width: "100%", background: `linear-gradient(to right, ${color} ${value}%, #1e2530 ${value}%)`, accentColor: color, opacity: disabled ? 0.5 : 1 }} />
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


// --- roster panel (match mode) ---

function AgentCard({ agent, selected, onClick, compact }) {
  return (
    <div onClick={onClick} style={{
      padding: compact ? "4px 6px" : "6px 8px", background: selected ? "#161b22" : "#0d1117",
      border: `1px solid ${selected ? "#2ecc71" : "#1a1f2b"}`, borderRadius: 4,
      cursor: onClick ? "pointer" : "default", marginBottom: 3, transition: "border-color 0.2s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: selected ? "#2ecc71" : "#c8d0da", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{agent.name}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#8892a0" }}>{Math.round(agent.elo)}</span>
      </div>
      <MiniBars config={agent} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ fontSize: 7, color: "#4a5568" }}>{SLIDER_KEYS.map(s => `${s.short}${agent[s.key]}`).join(" ")}</span>
        <span style={{ fontSize: 7, color: "#4a5568" }}>{agent.wins}W {agent.losses}L {agent.draws}D</span>
      </div>
    </div>
  );
}

function RosterPanel({ side, color, selectedAgent, onSelect, roster, disabled, matchElo, matchEloDelta, onRosterChange }) {
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
        <div style={{ marginTop: 6, fontSize: 7, color: "#4a5568" }}>{SLIDER_KEYS.map(s => `${s.short}${selectedAgent[s.key]}`).join("  ")}</div>
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
        {SLIDER_KEYS.map(s => <Slider key={s.key} label={s.key.replace("_", " ")} value={editConfig[s.key]} color={color} onChange={(v) => handleSliderChange(s.key, v)} disabled={false} />)}
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
            <span style={{ fontSize: 12, fontWeight: 800, color: "#c8d0da" }}>{selectedAgent.name}</span>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => openEdit(selectedAgent)} style={{ fontSize: 7, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 5px", cursor: "pointer", fontFamily: "inherit" }}>EDIT</button>
              <button onClick={() => onSelect(null)} style={{ fontSize: 7, background: "none", border: "1px solid #21262d", color: "#4a5568", borderRadius: 3, padding: "1px 5px", cursor: "pointer", fontFamily: "inherit" }}>X</button>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: "#8892a0" }}>{Math.round(selectedAgent.elo)} <span style={{ fontSize: 8, fontWeight: 400 }}>ELO</span></span>
            <span style={{ fontSize: 7, color: "#4a5568" }}>{selectedAgent.wins}W {selectedAgent.losses}L {selectedAgent.draws}D</span>
          </div>
          <MiniBars config={selectedAgent} /><OverextWarning config={selectedAgent} />
        </div>
      )}
      <div style={{ maxHeight: selectedAgent ? 140 : 240, overflowY: "auto", marginBottom: 6 }}>
        {roster.map(a => <AgentCard key={a.id} agent={a} compact selected={selectedAgent?.id === a.id} onClick={() => onSelect(a)} />)}
      </div>
      <button onClick={openCreate} style={{ width: "100%", padding: "5px 0", borderRadius: 4, fontSize: 8, background: "#161b22", border: "1px solid #21262d", color: "#8b949e", cursor: "pointer", fontFamily: "inherit", letterSpacing: 2, textTransform: "uppercase" }}>+ CREATE NEW</button>
    </div>
  );
}


// --- main app ---

export default function App() {
  const [appMode, setAppMode] = useState("match");
  const [showHelp, setShowHelp] = useState(true);
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

  useEffect(() => { loadRoster(); loadHistory(); loadLeaderboard(); }, []);
  useEffect(() => { if (roster.length >= 2 && !redAgent && !blackAgent && !boards) { setRedAgent(roster[0]); setBlackAgent(roster[1]); } }, [roster]);

  const startGame = async () => {
    if (!redAgent || !blackAgent) { setError("select agents for both sides"); return; }
    setError(null); setLoading(true); setResult(null); setBoards(null); setMoves(null); setEvents([]); setCurrentStep(0);
    try {
      const res = await fetch(`${API}/game/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ red_agent_id: redAgent.id, black_agent_id: blackAgent.id }) });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setBoards(data.boards); setMoves(data.moves); setEvents(data.events || []); setResult(data);
      maxStepRef.current = data.boards.length - 1; stepRef.current = 0; setCurrentStep(0);
      playingRef.current = true; setPlaying(true); playNext();
      loadRoster(); loadHistory(); loadLeaderboard();
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
  const resetGame = () => { setBoards(null); setMoves(null); setResult(null); setEvents([]); setCurrentStep(0); loadRoster(); };

  const board = boards ? boards[currentStep] : null;
  const lastMove = moves && currentStep > 0 ? moves[currentStep - 1] : null;
  const activeShrinkEvent = events.find(e => e.type === "shrink" && e.move === currentStep);
  const activeFatigueEvent = events.find(e => e.type === "fatigue" && e.move === currentStep);
  const activeOverextEvent = events.find(e => e.type === "overextension" && e.move === currentStep && e.pieces_lost >= 2);
  const currentPhase = (() => { if (!events.length) return null; const pc = events.filter(e => e.type === "phase_change" && e.move <= currentStep); return pc.length ? pc[pc.length - 1].phase : "opening"; })();
  const counts = board ? (() => { let r = 0, b = 0; for (let row of board) for (let cell of row) { if (cell === RED || cell === RED_KING) r++; if (cell === BLACK || cell === BLACK_KING) b++; } return { red: r, black: b }; })() : { red: 12, black: 12 };
  const isFinished = result && currentStep >= (boards?.length || 1) - 1;
  const redElo = result?.elo?.red_after || null;
  const blackElo = result?.elo?.black_after || null;
  const redEloDelta = result ? (result.elo.red_after - result.elo.red_before) : null;
  const blackEloDelta = result ? (result.elo.black_after - result.elo.black_before) : null;
  const canGo = redAgent && blackAgent && !boards && !loading;

  if (appMode === "tournament") {
    return <Tournament roster={roster} onBack={() => { setAppMode("match"); loadRoster(); }} loadRoster={loadRoster} />;
  }

  return (
    <div style={{ minHeight: "100vh", padding: "16px 12px" }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: "clamp(16px, 4vw, 26px)", fontWeight: 800, letterSpacing: 6, textTransform: "uppercase", background: "linear-gradient(135deg, #e74c3c, #f39c12, #2ecc71)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Agent Checkers</h1>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6 }}>
          <button onClick={() => setAppMode("match")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#161b22", border: "1px solid #2ecc71", color: "#2ecc71", borderRadius: 3, textTransform: "uppercase" }}>MATCH</button>
          <button onClick={() => setAppMode("tournament")} style={{ padding: "4px 16px", fontSize: 9, fontWeight: 700, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", background: "#0d1117", border: "1px solid #f39c1266", color: "#f39c12", borderRadius: 3, textTransform: "uppercase" }}>TOURNAMENT</button>
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

      <div style={{ display: "flex", gap: 12, maxWidth: 1060, margin: "0 auto", alignItems: "flex-start", flexWrap: "wrap", justifyContent: "center" }}>
        <div style={{ width: 220, flexShrink: 0 }}>
          <RosterPanel side="red" color="#e74c3c" selectedAgent={redAgent} onSelect={setRedAgent} roster={roster} disabled={playing || loading || !!boards} onRosterChange={loadRoster} matchElo={isFinished ? redElo : null} matchEloDelta={isFinished ? redEloDelta : null} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 280, maxWidth: 400 }}>
          {activeShrinkEvent && <div style={{ background: "rgba(231,76,60,0.15)", border: "1px solid rgba(231,76,60,0.3)", borderRadius: 4, padding: "4px 10px", marginBottom: 6, fontSize: 10, color: "#e74c3c", letterSpacing: 1, textTransform: "uppercase" }}>board shrinking: {activeShrinkEvent.killed.length} squares eliminated</div>}
          {activeFatigueEvent && <div style={{ background: "rgba(241,196,15,0.15)", border: "1px solid rgba(241,196,15,0.3)", borderRadius: 4, padding: "4px 10px", marginBottom: 6, fontSize: 10, color: "#f1c40f", letterSpacing: 1, textTransform: "uppercase" }}>king fatigue: idle kings demoted</div>}
          {activeOverextEvent && <div style={{ background: "rgba(230,126,34,0.15)", border: "1px solid rgba(230,126,34,0.3)", borderRadius: 4, padding: "4px 10px", marginBottom: 6, fontSize: 10, color: "#e67e22", letterSpacing: 1, textTransform: "uppercase" }}>overextension: {activeOverextEvent.side} lost {activeOverextEvent.pieces_lost} pieces on a bad trade</div>}

          {!boards && redAgent && blackAgent && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#e74c3c" }}>{redAgent.name}</span>
              <span style={{ fontSize: 9, color: "#4a5568" }}>vs</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#ecf0f1" }}>{blackAgent.name}</span>
            </div>
          )}

          <BoardGrid board={board} lastMove={lastMove} />

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap", justifyContent: "center" }}>
            {canGo && <button onClick={startGame} style={{ padding: "10px 36px", borderRadius: 6, border: "none", background: "linear-gradient(135deg, #2ecc71, #27ae60)", color: "#fff", fontWeight: 800, fontSize: 14, letterSpacing: 4, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", boxShadow: "0 0 24px rgba(46,204,113,0.3)" }}>GO</button>}
            {!boards && !loading && (!redAgent || !blackAgent) && <span style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1 }}>SELECT BOTH AGENTS</span>}
            {loading && <span style={{ fontSize: 11, color: "#4a5568", letterSpacing: 2 }}>SIMULATING...</span>}
            {boards && playing && <button onClick={pause} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #e67e22", background: "transparent", color: "#e67e22", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>PAUSE</button>}
            {boards && !playing && !isFinished && <button onClick={resume} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>RESUME</button>}
            {isFinished && (
              <>
                <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: result.winner === "red" ? "#e74c3c" : result.winner === "black" ? "#ecf0f1" : "#f39c12" }}>{result.winner === "draw" ? "DRAW" : `${result.winner === "red" ? (result.red_agent?.name || "RED") : (result.black_agent?.name || "BLACK")} wins`}</span>
                <button onClick={resetGame} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid #2ecc71", background: "transparent", color: "#2ecc71", fontWeight: 700, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>REMATCH</button>
              </>
            )}
          </div>

          {error && <p style={{ color: "#e74c3c", fontSize: 10, marginTop: 6 }}>{error}</p>}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap", justifyContent: "center", fontSize: 9, color: "#4a5568", textTransform: "uppercase", letterSpacing: 1 }}>
            <span>MOVE {currentStep}/{boards ? boards.length - 1 : 0}</span>
            <span style={{ color: "#e74c3c" }}>R {counts.red}</span>
            <span style={{ color: "#ecf0f1" }}>B {counts.black}</span>
            {currentPhase && currentStep > 0 && <span style={{ color: currentPhase === "opening" ? "#3498db" : currentPhase === "midgame" ? "#e67e22" : "#e74c3c", fontWeight: 700 }}>{currentPhase.toUpperCase()}</span>}
            {currentStep >= 60 && <span style={{ color: "#e74c3c", fontWeight: 700 }}>SHRINKING</span>}
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span>SPD</span>
              <input type="range" min="50" max="800" value={850 - speed} onChange={(e) => setSpeed(850 - parseInt(e.target.value))} style={{ width: 50, background: "#1a1f2b", accentColor: "#2ecc71" }} />
            </div>
          </div>

          {moves && currentStep > 0 && (
            <div style={{ marginTop: 8, width: "100%", background: "#0d1117", border: "1px solid #1a1f2b", borderRadius: 6, padding: "4px 8px", maxHeight: 70, overflowY: "auto" }}>
              {moves.slice(0, currentStep).reverse().slice(0, 6).map((m, i) => {
                const dest = m.path[m.path.length - 1];
                const label = `${m.side === "red" ? "RED" : "BLK"} ${String.fromCharCode(65 + m.from.col)}${SIZE - m.from.row} > ${String.fromCharCode(65 + dest.col)}${SIZE - dest.row}${m.captures.length > 0 ? ` x${m.captures.length}` : ""}`;
                return <div key={i} style={{ fontSize: 8, padding: "1px 0", color: i === 0 ? "#c8d0da" : "#3a4450" }}>{label}</div>;
              })}
            </div>
          )}

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
          <RosterPanel side="black" color="#ecf0f1" selectedAgent={blackAgent} onSelect={setBlackAgent} roster={roster} disabled={playing || loading || !!boards} onRosterChange={loadRoster} matchElo={isFinished ? blackElo : null} matchEloDelta={isFinished ? blackEloDelta : null} />
        </div>
      </div>
    </div>
  );
}
