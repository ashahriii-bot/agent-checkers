// Arena3D — Three.js holographic overhaul of the Agent Arena board.
//
// Replaces the 2D SVG <HexBoard>. A lit hex platform floats in dark space;
// creature GLBs render as holographic projections (see shaders/holographic.js).
// All game state arrives as props and is reconciled into the scene every frame
// from a single requestAnimationFrame loop — React never re-creates the scene.
//
// Camera orbit is implemented by hand with trigonometry (no OrbitControls, which
// is intentionally not used). Everything is disposed on unmount so switching to
// Checkers mode leaves nothing behind.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { createHolographicMaterial } from "./shaders/holographic.js";

// ---------------------------------------------------------------------------
// Layout / constants (mirror the axial grid used by the engine + Arena.jsx)
// ---------------------------------------------------------------------------

const HEX_SIZE = 1.0;        // hex "radius" in world units
const HEX_HEIGHT = 0.12;     // prism thickness
const TILE_TOP = HEX_HEIGHT;  // creatures sit on top of the tile
const RED_GATE = [1, -2];
const BLUE_GATE = [-1, 2];

const SPECIES = ["ironjaw", "razorwing", "embercaster", "warden", "hexwright"];

const SPECIES_COLORS = {
  ironjaw: 0x5b8fa8,
  razorwing: 0xdc143c,
  embercaster: 0xff8c00,
  warden: 0xdaa520,
  hexwright: 0x8a2be2,
};

const SPECIES_IDLE = {
  ironjaw: { type: "breathe", speed: 1.5, amp: 0.04 },
  razorwing: { type: "rock", speed: 2.5, amp: 0.06 },
  embercaster: { type: "flicker", speed: 2.0, amp: 0.05 },
  warden: { type: "spin", speed: 1.2, amp: 0.03 },
  hexwright: { type: "sway", speed: 1.8, amp: 0.08 },
};

// Pointy-top axial -> world (x, z). Matches Arena.jsx hexToPixel orientation.
function axialToWorld(q, r) {
  return {
    x: HEX_SIZE * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    z: HEX_SIZE * (1.5 * r),
  };
}
const hexKey = (q, r) => `${q},${r}`;

// Accept either [[q,r],...] or ["q,r",...] -> Set<"q,r">
function toHexKeySet(list) {
  const s = new Set();
  for (const h of list || []) {
    if (Array.isArray(h)) s.add(hexKey(h[0], h[1]));
    else if (typeof h === "string") s.add(h);
  }
  return s;
}

const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

// ---------------------------------------------------------------------------
// Model loading (module-level cache: load the 290MB of GLBs at most once)
// ---------------------------------------------------------------------------

const modelCache = {};      // species -> THREE.Group (template, never added to a scene)
let loaderSingleton = null;

function getLoader() {
  if (!loaderSingleton) {
    loaderSingleton = new GLTFLoader();
    // Meshopt-compressed GLBs load transparently if the assets are ever
    // optimised (gltfpack / gltf-transform). Uncompressed GLBs are unaffected.
    try { loaderSingleton.setMeshoptDecoder(MeshoptDecoder); } catch { /* optional */ }
  }
  return loaderSingleton;
}

// Normalise a freshly-loaded gltf scene: scale to ~80% of a hex, centre
// horizontally, drop onto the tile surface. Returns a reusable template.
function normalizeModel(scene) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = (HEX_SIZE * 1.25) / maxDim;
  scene.scale.setScalar(scale);

  // Re-measure after scaling and re-centre so the model's feet rest at y=0.
  const box2 = new THREE.Box3().setFromObject(scene);
  const center = box2.getCenter(new THREE.Vector3());
  scene.position.x -= center.x;
  scene.position.z -= center.z;
  scene.position.y -= box2.min.y; // feet on the ground
  return scene;
}

async function loadCreatureModels(onProgress) {
  const loader = getLoader();
  let done = 0;
  await Promise.allSettled(
    SPECIES.map(async (species) => {
      if (modelCache[species]) { done++; onProgress?.(done, SPECIES.length); return; }
      try {
        const gltf = await loader.loadAsync(`/creatures/${species}.glb`);
        modelCache[species] = normalizeModel(gltf.scene);
      } catch (e) {
        modelCache[species] = null; // mark failed -> fallback primitive
        console.warn(`[Arena3D] failed to load ${species}.glb`, e);
      }
      done++;
      onProgress?.(done, SPECIES.length);
    })
  );
}

// A clone whose materials are independent (so per-creature uniforms differ)
// but whose geometry is shared with the template (keeps memory sane).
function instantiateModel(species, material) {
  const template = modelCache[species];
  let root;
  if (template) {
    root = template.clone(true);
    root.traverse((child) => {
      if (child.isMesh) {
        child.material = material;
        child.castShadow = false;
        child.receiveShadow = false;
        child.frustumCulled = false; // groups move; avoid pop-out
      }
    });
  } else {
    // Fallback: a faceted crystal in the team tint when a GLB is missing/broken.
    const geo = new THREE.OctahedronGeometry(HEX_SIZE * 0.45, 0);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.y = HEX_SIZE * 0.5;
    root = new THREE.Group();
    root.add(mesh);
    root.userData.fallbackGeo = geo;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

// A glowing beam (thin cylinder) between two world points — intent / defense lines.
function makeBeam(from, to, color, radius, disposables) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length() || 0.001;
  const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
  geo.translate(0, len / 2, 0);
  geo.rotateX(Math.PI / 2); // align +Y cylinder to +Z, then orient
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from);
  mesh.lookAt(to);
  disposables?.add(geo); disposables?.add(mat);
  return mesh;
}

// A burst of points exploding outward. Returns a self-contained particle system.
function makeParticleBurst(origin, color, count, speed, opts = {}) {
  const { gravity = 4.0, life = 0.7, size = 0.09, spread = 1.0, upBias = 0.0 } = opts;
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = origin.x;
    positions[i * 3 + 1] = origin.y;
    positions[i * 3 + 2] = origin.z;
    // random direction on a hemisphere-ish sphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const sp = speed * (0.4 + Math.random() * 0.6);
    velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * sp * spread;
    velocities[i * 3 + 1] = Math.abs(Math.cos(phi)) * sp * (0.6 + upBias) + upBias;
    velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * sp * spread;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color, size, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, geo, mat, velocities, positions, age: 0, life, gravity, count };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Arena3D({
  creatures = [],
  bodies = [],
  hexes = [],                 // all board hexes as [q,r]
  collapsedHexes = [],        // voided hexes ([q,r] or "q,r")
  warningHexes = [],          // cracking hexes ("q,r" or [q,r])
  breachData = null,          // { active, gate:[q,r], teamColor, channelerId, meter, defenders:[{id,pos}], defendingTeamColor }
  lastStandCreatureId = null,
  activeCreatureId = null,
  intentData = null,          // { from:[q,r], to:[q,r], color, type }
  abilityEffect = null,       // { type, actorId, targetId }  (transient)
  winningTeam = null,         // "red" | "blue" | "draw" | null
  teamColors = { red: "#e74c3c", blue: "#3498db" },
  summonNonce = 0,            // bump to play the neural-link materialize (P2/§6.3)
  onReady,
}) {
  const mountRef = useRef(null);
  const propsRef = useRef({});
  const [loadState, setLoadState] = useState({ loading: true, done: 0, total: SPECIES.length });
  const readyFiredRef = useRef(false);

  // keep the latest props readable from the rAF loop without re-running setup
  propsRef.current = {
    creatures, bodies, hexes, collapsedHexes, warningHexes, breachData,
    lastStandCreatureId, activeCreatureId, intentData, abilityEffect,
    winningTeam, teamColors, summonNonce,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const isMobile = window.innerWidth <= 768;
    const PARTICLES = isMobile ? 18 : 40;

    // --- core three objects ---------------------------------------------------
    const scene = new THREE.Scene();
    const width = mount.clientWidth || 400;
    const height = Math.round(width * 0.74);
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "auto";

    const disposables = new Set();    // geometries / materials / textures to dispose
    const track = (x) => { disposables.add(x); return x; };

    // --- lighting -------------------------------------------------------------
    const ambient = new THREE.AmbientLight(0x223055, 0.6);
    scene.add(ambient);
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.7);
    mainLight.position.set(2, 10, 5);
    scene.add(mainLight);
    const rimLight = new THREE.PointLight(0x4466aa, 0.6, 24);
    rimLight.position.set(0, -2.5, 0); // projection source from below
    scene.add(rimLight);
    // transient lights (kill flash / last stand / breach) — reused
    const killLight = new THREE.PointLight(0xff2200, 0, 8);
    scene.add(killLight);
    const lastStandLight = new THREE.PointLight(0xffd700, 0, 10);
    scene.add(lastStandLight);
    const breachSpot = new THREE.SpotLight(0xffffff, 0, 25, Math.PI / 6, 0.4, 1.0);
    breachSpot.position.set(0, 9, 0);
    scene.add(breachSpot);
    scene.add(breachSpot.target);

    // --- void backdrop --------------------------------------------------------
    const voidGeo = track(new THREE.PlaneGeometry(60, 60));
    const voidMat = track(new THREE.MeshBasicMaterial({ color: 0x05060a, transparent: true, opacity: 0.9 }));
    const voidPlane = new THREE.Mesh(voidGeo, voidMat);
    voidPlane.rotation.x = -Math.PI / 2;
    voidPlane.position.y = -6;
    scene.add(voidPlane);

    // base plane with subtle grid under the platform
    const grid = new THREE.GridHelper(24, 24, 0x223055, 0x141a2e);
    grid.position.y = -0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    scene.add(grid);
    disposables.add(grid.geometry); disposables.add(grid.material);

    // --- hex platform ---------------------------------------------------------
    const hexMeshes = new Map(); // "q,r" -> { mesh, edges, mat, edgeMat, baseY, state, t, crackGroup }
    const hexShape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const x = HEX_SIZE * Math.cos(a);
      const z = HEX_SIZE * Math.sin(a);
      if (i === 0) hexShape.moveTo(x, z); else hexShape.lineTo(x, z);
    }
    hexShape.closePath();
    const hexGeo = track(new THREE.ExtrudeGeometry(hexShape, { depth: HEX_HEIGHT, bevelEnabled: false }));
    const hexEdgeGeo = track(new THREE.EdgesGeometry(hexGeo));

    function isGate(q, r) {
      if (q === RED_GATE[0] && r === RED_GATE[1]) return "red";
      if (q === BLUE_GATE[0] && r === BLUE_GATE[1]) return "blue";
      return null;
    }

    function buildHex(q, r) {
      const key = hexKey(q, r);
      if (hexMeshes.has(key)) return;
      const gate = isGate(q, r);
      const mat = new THREE.MeshStandardMaterial({
        color: gate === "red" ? 0x2a0f12 : gate === "blue" ? 0x0f1428 : 0x12162a,
        emissive: gate === "red" ? 0x3a0d10 : gate === "blue" ? 0x10204a : 0x1a2348,
        emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.7, transparent: true, opacity: 1,
      });
      const edgeMat = new THREE.LineBasicMaterial({
        color: gate === "red" ? 0xe74c3c : gate === "blue" ? 0x3498db : 0x4466aa,
        transparent: true, opacity: 0.4,
      });
      const mesh = new THREE.Mesh(hexGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      const pos = axialToWorld(q, r);
      const group = new THREE.Group();
      group.position.set(pos.x, 0, pos.z);
      mesh.position.y = 0;
      group.add(mesh);
      const edges = new THREE.LineSegments(hexEdgeGeo, edgeMat);
      edges.rotation.x = -Math.PI / 2;
      group.add(edges);
      // P3 gate clarity: each gate reads as an OBJECTIVE — a glowing portal ring +
      // upward energy beam in the owner's color, always visible. The words
      // (DEFEND / BREACH / how-to-win) live in the HTML layer, per the mobile-safe
      // "no text in the 3D scene" rule (§6.4).
      if (gate) {
        const gcol = gate === "red" ? 0xe74c3c : 0x3498db;
        const ringGeo = track(new THREE.TorusGeometry(HEX_SIZE * 0.58, 0.05, 8, 36));
        const ringMat = new THREE.MeshBasicMaterial({ color: gcol, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2; ring.position.y = TILE_TOP + 0.04;
        group.add(ring); disposables.add(ringMat);
        const beamGeo = track(new THREE.CylinderGeometry(HEX_SIZE * 0.34, HEX_SIZE * 0.46, 7, 18, 1, true));
        const beamMat = new THREE.MeshBasicMaterial({ color: gcol, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const beam = new THREE.Mesh(beamGeo, beamMat);
        beam.position.y = TILE_TOP + 3.5;
        group.add(beam); disposables.add(beamMat);
      }
      scene.add(group);
      disposables.add(mat); disposables.add(edgeMat);
      hexMeshes.set(key, {
        group, mesh, edges, mat, edgeMat, gate,
        baseY: 0, state: "solid", t: 0, phase: Math.random() * Math.PI * 2,
        worldPos: new THREE.Vector3(pos.x, TILE_TOP, pos.z), crack: null,
      });
    }

    // build all hexes the parent knows about (fallback to a radius-2 board)
    const initialHexes = (propsRef.current.hexes && propsRef.current.hexes.length)
      ? propsRef.current.hexes
      : (() => { const out = []; for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) if (Math.abs(q + r) <= 2) out.push([q, r]); return out; })();
    for (const [q, r] of initialHexes) buildHex(q, r);

    function hexWorld(qr) {
      const h = hexMeshes.get(hexKey(qr[0], qr[1]));
      if (h) return h.worldPos.clone();
      const p = axialToWorld(qr[0], qr[1]);
      return new THREE.Vector3(p.x, TILE_TOP, p.z);
    }

    // --- shared small geometries ---------------------------------------------
    const poolGeo = track(new THREE.CircleGeometry(HEX_SIZE * 0.5, 28));
    const sphereGeo = track(new THREE.SphereGeometry(1, 16, 16)); // reused for projectiles/explosions
    const hpBarGeo = track(new THREE.PlaneGeometry(1, 1));

    // registry of all holographic materials so we can pump `time` + envTint cheaply
    const holoMaterials = new Set();

    // --- entity bookkeeping ---------------------------------------------------
    const creatureEntries = new Map(); // id -> entry
    const bodyEntries = new Map();     // id -> entry
    const particleSystems = [];        // active bursts
    const projectiles = [];            // active projectiles (+ transient displace beams)
    // Pooled intent/defense beams — reused across frames (no per-frame geometry alloc).
    const beamUnitGeo = track(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true));
    beamUnitGeo.translate(0, 0.5, 0); beamUnitGeo.rotateX(Math.PI / 2); // unit length-1 beam along +Z
    const beamPool = [];               // [{ mesh, mat }]
    let breachGroup = null;            // { col, ring, meter } recreated as needed

    function makeHoloMaterial(colorHex) {
      const m = createHolographicMaterial(colorHex, { simplify: isMobile });
      holoMaterials.add(m);
      // per-instance: disposed via removeCreature/removeBody — deliberately NOT
      // added to the shared `disposables` set (that set is for build-once scene
      // resources; routing per-entity mats there leaks refs + double-disposes).
      return m;
    }

    function makeHpBar() {
      const group = new THREE.Group();
      // per-instance materials — disposed in removeCreature, not tracked globally
      const bgMat = new THREE.MeshBasicMaterial({ color: 0x10151f, transparent: true, opacity: 0.85, depthWrite: false });
      const bg = new THREE.Mesh(hpBarGeo, bgMat);
      bg.scale.set(0.9, 0.12, 1);
      const fillMat = new THREE.MeshBasicMaterial({ color: 0x2ecc71, transparent: true, depthWrite: false });
      const fill = new THREE.Mesh(hpBarGeo, fillMat);
      fill.scale.set(0.86, 0.08, 1);
      fill.position.z = 0.01;
      group.add(bg); group.add(fill);
      group.userData = { fill, fillMat, bgMat };
      return group;
    }

    function spawnCreature(c) {
      const teamHex = c.team === "red" ? propsRef.current.teamColors.red : propsRef.current.teamColors.blue;
      const mat = makeHoloMaterial(teamHex);
      const model = instantiateModel(c.species, mat);
      const group = new THREE.Group();
      group.add(model);

      // projection pool
      const poolMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(teamHex), transparent: true, opacity: 0.25,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pool = new THREE.Mesh(poolGeo, poolMat); // poolMat disposed in removeCreature
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = TILE_TOP + 0.01;
      group.add(pool);

      // hp bar
      const hpBar = makeHpBar();
      hpBar.position.y = TILE_TOP + 1.5;
      group.add(hpBar);

      // species point light (skip on mobile)
      let light = null;
      if (!isMobile) {
        light = new THREE.PointLight(SPECIES_COLORS[c.species] || 0xffffff, 0.25, 3);
        light.position.y = TILE_TOP + 0.6;
        group.add(light);
      }

      const p = axialToWorld(c.pos[0], c.pos[1]);
      group.position.set(p.x, 0, p.z);
      scene.add(group);

      const entry = {
        id: c.id, species: c.species, team: c.team, group, model, material: mat,
        pool, poolMat, hpBar, light,
        baseScale: model.scale?.x || 1,
        targetPos: new THREE.Vector3(p.x, 0, p.z),
        phase: (c.id || "x").charCodeAt(0) * 0.7,
        dying: false, deathT: 0, swoop: null, hp: c.hp, maxHp: c.max_hp,
      };
      creatureEntries.set(c.id, entry);
      return entry;
    }

    function disposeModelMaterialsOnly(entry) {
      // geometry is shared with the template; only dispose per-instance fallback geo
      entry.model?.traverse?.((ch) => { if (ch.userData?.fallbackGeo) ch.userData.fallbackGeo.dispose(); });
    }

    function removeCreature(entry) {
      scene.remove(entry.group);
      holoMaterials.delete(entry.material);
      entry.material.dispose();
      entry.poolMat.dispose();
      entry.hpBar?.userData?.bgMat?.dispose();
      entry.hpBar?.userData?.fillMat?.dispose();
      disposeModelMaterialsOnly(entry);
      creatureEntries.delete(entry.id);
    }

    function spawnBody(b) {
      const species = b.species || "ironjaw";
      const mat = makeHoloMaterial(0x888888);
      mat.uniforms.uDead.value = 1;
      mat.uniforms.uOpacity.value = 0.3;
      const model = instantiateModel(species, mat);
      const group = new THREE.Group();
      group.add(model);
      const p = axialToWorld(b.pos[0], b.pos[1]);
      group.position.set(p.x, 0, p.z);
      scene.add(group);
      const entry = { id: b.id, group, model, material: mat, species };
      bodyEntries.set(b.id, entry);
      return entry;
    }

    function removeBody(entry) {
      scene.remove(entry.group);
      holoMaterials.delete(entry.material);
      entry.material.dispose();
      disposeModelMaterialsOnly(entry);
      bodyEntries.delete(entry.id);
    }

    // --- death sequence -------------------------------------------------------
    function startDeath(entry) {
      if (entry.dying) return;
      entry.dying = true;
      entry.deathT = 0;
      const worldPos = new THREE.Vector3();
      entry.group.getWorldPosition(worldPos);
      worldPos.y += 0.6;
      const burst = makeParticleBurst(worldPos, new THREE.Color(SPECIES_COLORS[entry.species] || 0xffffff), PARTICLES, 3.2, { life: 0.8, size: 0.11 });
      scene.add(burst.points);
      particleSystems.push(burst);
      // camera kill zoom
      camImpulse("kill", worldPos, 320);
    }

    // --- projectiles ----------------------------------------------------------
    function spawnProjectile(fromV, toV, color, kind) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      const r = kind === "blast" ? 0.22 : 0.12;
      mesh.scale.setScalar(r);
      mesh.position.copy(fromV);
      scene.add(mesh);
      const arcHeight = kind === "blast" ? 3.2 : 0.8;
      const speed = kind === "blast" ? 2.6 : 5.0; // units/sec along ground dist
      const dist = fromV.distanceTo(toV) || 0.001;
      projectiles.push({
        mesh, mat, from: fromV.clone(), to: toV.clone(), arcHeight, kind, color,
        t: 0, dur: Math.max(0.25, dist / speed), trailTimer: 0,
      });
    }

    function explode(at, color, kind) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.copy(at);
      mesh.scale.setScalar(0.2);
      scene.add(mesh);
      projectiles.push({ mesh, mat, explosion: true, t: 0, dur: kind === "blast" ? 0.5 : 0.3, maxScale: kind === "blast" ? 2.2 : 1.0 });
      const burst = makeParticleBurst(at, new THREE.Color(color), PARTICLES, kind === "blast" ? 3.6 : 2.4, { life: 0.6, size: 0.1 });
      scene.add(burst.points);
      particleSystems.push(burst);
    }

    // --- camera system --------------------------------------------------------
    const cam = {
      angle: Math.PI * 0.25,
      radius: 10.5, height: 7.8,
      curRadius: 10.5, curHeight: 7.8,
      look: new THREE.Vector3(0, TILE_TOP, 0),
      curLook: new THREE.Vector3(0, TILE_TOP, 0),
      orbitSpeed: 0.0087, // ~0.5 deg/s
      impulse: null,      // { kind, look, until, radiusMul }
    };
    function camImpulse(kind, lookV, ms, radiusMul = 0.9) {
      cam.impulse = { kind, look: lookV ? lookV.clone() : null, until: clockElapsed + ms / 1000, radiusMul };
    }

    // --- env / mood -----------------------------------------------------------
    const envColor = new THREE.Color(0.82, 0.86, 1.0);
    const envTarget = new THREE.Color(0.82, 0.86, 1.0);

    // ----- per-frame reconciliation ------------------------------------------
    function reconcile(dt) {
      const P = propsRef.current;

      // hexes: collapse / warning state
      const voidSet = toHexKeySet(P.collapsedHexes);
      const warnSet = toHexKeySet(P.warningHexes);
      let newlyCollapsed = 0;
      hexMeshes.forEach((h, key) => {
        const shouldVoid = voidSet.has(key);
        if (shouldVoid && h.state === "solid") {
          h.state = "falling"; h.t = 0; newlyCollapsed++;
          // debris
          const burst = makeParticleBurst(h.worldPos.clone(), new THREE.Color(0x442222), Math.round(PARTICLES * 0.6), 2.2, { life: 0.9, size: 0.08, gravity: 6 });
          scene.add(burst.points); particleSystems.push(burst);
        } else if (!shouldVoid && h.state !== "solid") {
          // scrubbed back: restore
          h.state = "solid"; h.t = 0;
          h.group.position.y = 0; h.group.rotation.set(0, 0, 0);
          h.mat.opacity = 1; h.edgeMat.opacity = 0.4; h.group.visible = true;
        }
        const isWarn = warnSet.has(key) && h.state === "solid";
        h.warn = isWarn;
      });
      if (newlyCollapsed > 0) camImpulse("collapse", null, 1400, 1.18);

      // creatures: add / update / death
      const aliveIds = new Set();
      for (const c of P.creatures || []) {
        if (c.alive === false) continue;
        aliveIds.add(c.id);
        let e = creatureEntries.get(c.id);
        if (!e) { if (Object.keys(modelCache).length) e = spawnCreature(c); else continue; }
        if (e.dying) {
          // scrubbed back onto a creature that is alive again mid-dissolve → cancel death
          e.dying = false; e.deathT = 0; e._lsBurst = false;
          e.material.uniforms.uDissolve.value = 0;
          if (e.poolMat) e.poolMat.opacity = 0.25;
        }
        const p = axialToWorld(c.pos[0], c.pos[1]);
        e.targetPos.set(p.x, 0, p.z);
        e.hp = c.hp; e.maxHp = c.max_hp;
        e.lastStand = c.in_last_stand || P.lastStandCreatureId === c.id;
        e.channeling = c.channeling;
        e.breachMeter = c.breach_meter || 0;
        e.stunned = c.stunned;
        e.shielded = c.shielded;
        e.active = P.activeCreatureId === c.id;
      }
      // deaths: entries present but no longer alive
      creatureEntries.forEach((e) => {
        if (!aliveIds.has(e.id) && !e.dying) startDeath(e);
      });

      // bodies (ghost corpses)
      const bodyIds = new Set();
      for (const b of P.bodies || []) {
        if (b.id == null) continue;
        bodyIds.add(b.id);
        let be = bodyEntries.get(b.id);
        // avoid a double-render: the same-id creature may still be playing its
        // ~0.6s death dissolve — wait for it to finish before the ghost appears
        if (!be && creatureEntries.has(b.id)) continue;
        if (!be) { if (Object.keys(modelCache).length) be = spawnBody(b); else continue; }
        if (be) {
          const decay = b.rounds_remaining ?? 3;
          be.material.uniforms.uOpacity.value = 0.12 + decay * 0.05;
        }
      }
      bodyEntries.forEach((be) => { if (!bodyIds.has(be.id)) removeBody(be); });
    }

    // ----- intent + defense beams (pooled; reused each frame, no alloc) -------
    const _beamTo = new THREE.Vector3();
    function setBeam(i, from, to, colorHex, radius, opacity) {
      let b = beamPool[i];
      if (!b) {
        const mat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
        const mesh = new THREE.Mesh(beamUnitGeo, mat);
        mesh.frustumCulled = false; scene.add(mesh);
        b = beamPool[i] = { mesh, mat };
      }
      const len = from.distanceTo(to) || 0.001;
      b.mesh.visible = true;
      b.mesh.position.copy(from);
      b.mesh.scale.set(radius, radius, len);
      b.mesh.lookAt(to);
      b.mat.color.set(colorHex);
      b.mat.opacity = opacity;
    }
    function updateBeams() {
      const P = propsRef.current;
      let n = 0;
      if (P.intentData?.from && P.intentData?.to) {
        const from = hexWorld(P.intentData.from); from.y = TILE_TOP + 0.4;
        const to = hexWorld(P.intentData.to); to.y = TILE_TOP + 0.4;
        setBeam(n++, from, to, P.intentData.color || 0xffffff, 0.035, 0.55);
      }
      if (P.breachData?.active && P.breachData.defenders && P.breachData.channelerId) {
        const ch = creatureEntries.get(P.breachData.channelerId);
        if (ch) {
          _beamTo.copy(ch.group.position); _beamTo.y = TILE_TOP + 0.4;
          for (const d of P.breachData.defenders) {
            const from = hexWorld(d.pos); from.y = TILE_TOP + 0.4;
            setBeam(n++, from, _beamTo, P.breachData.defendingTeamColor || 0xffffff, 0.02, 0.3);
          }
        }
      }
      for (let i = n; i < beamPool.length; i++) beamPool[i].mesh.visible = false;
    }

    // ----- breach column + ring ----------------------------------------------
    function updateBreach() {
      const P = propsRef.current;
      const active = P.breachData?.active;
      if (active && !breachGroup) {
        const gate = P.breachData.gate || RED_GATE;
        const wp = hexWorld(gate);
        const col = new THREE.Color(P.breachData.teamColor || 0xffffff);
        const colGeo = new THREE.CylinderGeometry(HEX_SIZE * 0.35, HEX_SIZE * 0.45, 5, 20, 1, true);
        const colMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
        const column = new THREE.Mesh(colGeo, colMat);
        column.position.set(wp.x, TILE_TOP + 2.5, wp.z);
        const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(HEX_SIZE * 0.6, 0.06, 8, 40, 0.001), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(wp.x, TILE_TOP + 0.2, wp.z);
        const g = new THREE.Group(); g.add(column); g.add(ring);
        scene.add(g);
        breachGroup = { group: g, column, colMat, colGeo, ring, ringMat, meter: -1, gate, color: col };
        breachSpot.position.set(wp.x, 9, wp.z);
        breachSpot.target.position.set(wp.x, 0, wp.z);
        breachSpot.color.set(col);
      } else if (!active && breachGroup) {
        scene.remove(breachGroup.group);
        breachGroup.colGeo.dispose(); breachGroup.colMat.dispose();
        breachGroup.ring.geometry.dispose(); breachGroup.ringMat.dispose();
        breachGroup = null;
        breachSpot.intensity = 0;
      }
      if (active && breachGroup) {
        const meter = Math.max(0, Math.min(4, P.breachData.meter || 0));
        if (meter !== breachGroup.meter) {
          breachGroup.meter = meter;
          breachGroup.ring.geometry.dispose();
          const arc = Math.max(0.001, (meter / 4) * Math.PI * 2);
          breachGroup.ring.geometry = new THREE.TorusGeometry(HEX_SIZE * 0.6, 0.06, 8, 40, arc);
        }
        breachSpot.intensity = 1.6;
      }
    }

    // ----- ability effects (transient projectiles / auras) -------------------
    let lastAbility = null;
    function handleAbility() {
      const P = propsRef.current;
      const a = P.abilityEffect;
      if (a === lastAbility) return;
      lastAbility = a;
      if (!a) return;
      const actor = creatureEntries.get(a.actorId);
      const from = actor ? actor.group.position.clone() : null;
      if (from) from.y = TILE_TOP + 0.6;
      const target = a.targetId ? creatureEntries.get(a.targetId) : null;
      const to = target ? target.group.position.clone() : null;
      if (to) to.y = TILE_TOP + 0.6;
      const speciesCol = SPECIES_COLORS[actor?.species] || 0xffffff;

      switch (a.type) {
        case "blast": {
          const dest = to || from;
          if (from && dest) { spawnProjectile(from, dest, 0xff7722, "blast"); }
          break;
        }
        case "melee": {
          if (from && to) spawnProjectile(from, to, speciesCol, "melee");
          break;
        }
        case "swoop": {
          if (actor && to) {
            actor.swoop = { t: 0, dur: 0.6, from: actor.group.position.clone(), to: to.clone() };
          }
          if (from && to) {
            const burst = makeParticleBurst(from, new THREE.Color(0xdc143c), PARTICLES, 2.0, { life: 0.5, size: 0.08 });
            scene.add(burst.points); particleSystems.push(burst);
          }
          break;
        }
        case "displace": {
          if (from) {
            const dest = to || from;
            // purple wave: a brief beam Hexwright -> target + an expanding ring
            const beam = makeBeam(from, dest, 0x8a2be2, 0.05);
            scene.add(beam);
            projectiles.push({ mesh: beam, mat: beam.material, geo: beam.geometry, beamFade: true, t: 0, dur: 0.4 });
            ringPulse(from, 0x8a2be2);
          }
          break;
        }
        case "bulwark_pulse": {
          if (from) domePulse(from, 0xf1c40f);
          break;
        }
        case "glitch": {
          if (to) { ringPulse(to, 0x8a2be2); }
          break;
        }
        case "provoke": {
          if (from) ringPulse(from, 0x5b8fa8);
          break;
        }
        default: break;
      }
    }

    function ringPulse(at, color) {
      const geo = new THREE.RingGeometry(0.1, 0.18, 32);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(at); ring.position.y = TILE_TOP + 0.05;
      scene.add(ring);
      projectiles.push({ mesh: ring, mat, ring: true, geo, t: 0, dur: 0.7, maxScale: 6 });
    }
    function domePulse(at, color) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: false });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.copy(at);
      mesh.scale.setScalar(0.2);
      scene.add(mesh);
      projectiles.push({ mesh, mat, explosion: true, t: 0, dur: 0.8, maxScale: 1.6 });
    }

    // ----- animation loop -----------------------------------------------------
    let clockElapsed = 0;
    let lastT = performance.now();
    let rafId = 0;
    let lastWidth = width;
    const _tmpV = new THREE.Vector3();      // scratch for per-frame lerps
    const _trailColor = new THREE.Color();  // scratch for trail tints
    // Neural-link summon (P2/§6.3): on summonNonce bump, materialize every living
    // Guardian by ramping its holographic uDissolve 1->0 with an accent bloom.
    const SUMMON_MS = 1100;
    let summonNonceSeen = 0;
    let summonStart = -1;

    function frame() {
      rafId = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      clockElapsed += dt;
      const P = propsRef.current;

      // Detect a summon trigger and compute materialize progress (0..1).
      if (P.summonNonce && P.summonNonce !== summonNonceSeen) {
        summonNonceSeen = P.summonNonce;
        summonStart = now;
      }
      const summonK = summonStart >= 0 ? Math.min(1, (now - summonStart) / SUMMON_MS) : 1;
      const summoning = summonStart >= 0 && summonK < 1;

      reconcile(dt);
      updateBeams();
      updateBreach();
      handleAbility();

      // env mood target
      if (P.breachData?.active) envTarget.setRGB(0.5, 0.55, 0.8);
      else if (P.collapsedHexes && P.collapsedHexes.length > 0) envTarget.setRGB(1.0, 0.6, 0.55);
      else envTarget.setRGB(0.82, 0.86, 1.0);
      envColor.lerp(envTarget, 1 - Math.exp(-2 * dt));
      ambient.intensity = damp(ambient.intensity, P.breachData?.active ? 0.28 : 0.6, 3, dt);

      // pump holographic materials
      holoMaterials.forEach((m) => {
        m.uniforms.time.value = clockElapsed;
        m.uniforms.uEnvTint.value.copy(envColor);
      });

      // hex animation (edge pulse, warning, collapse fall)
      hexMeshes.forEach((h) => {
        if (h.state === "solid") {
          const pulse = 0.4 + 0.1 * Math.sin(clockElapsed * 1.6 + h.phase);
          h.edgeMat.opacity = h.warn ? 0.5 + 0.4 * Math.sin(clockElapsed * 6) : pulse;
          if (h.warn) {
            h.mat.emissive.setHex(0x551111);
            h.mat.emissiveIntensity = 0.4 + 0.3 * Math.sin(clockElapsed * 6);
          } else {
            h.mat.emissiveIntensity = 0.35;
            h.mat.emissive.setHex(h.gate === "red" ? 0x3a0d10 : h.gate === "blue" ? 0x10204a : 0x1a2348);
          }
        } else if (h.state === "falling") {
          h.t += dt / 0.9;
          const k = Math.min(1, h.t);
          h.group.position.y = -k * 6;
          h.group.rotation.x = k * 0.8;
          h.group.rotation.z = k * 0.5;
          h.mat.opacity = 1 - k;
          h.edgeMat.opacity = (1 - k) * 0.4;
          if (k >= 1) { h.state = "void"; h.group.visible = false; }
        }
      });

      // creatures
      creatureEntries.forEach((e) => {
        const idle = SPECIES_IDLE[e.species] || SPECIES_IDLE.ironjaw;
        const lsBoost = e.lastStand ? 1.5 : 1.0;

        if (e.dying) {
          e.deathT += dt / 0.6;
          const k = Math.min(1, e.deathT);
          e.material.uniforms.uDissolve.value = k;
          // jitter
          e.group.position.x = e.targetPos.x + (Math.random() - 0.5) * 0.06 * (1 - k);
          e.group.position.z = e.targetPos.z + (Math.random() - 0.5) * 0.06 * (1 - k);
          if (e.poolMat) e.poolMat.opacity = 0.25 * (1 - k);
          if (k >= 1) removeCreature(e);
          return;
        }

        // position lerp (with optional swoop override)
        if (e.swoop) {
          e.swoop.t += dt / e.swoop.dur;
          const k = Math.min(1, e.swoop.t);
          const arc = Math.sin(k * Math.PI) * 1.2;
          const out = k < 0.5 ? k * 2 : (1 - k) * 2; // go and return
          const pos = _tmpV.lerpVectors(e.swoop.from, e.swoop.to, out);
          e.group.position.x = pos.x; e.group.position.z = pos.z;
          e.group.position.y = arc;
          // crimson trail
          if (Math.random() < 0.5) {
            const tp = e.group.position.clone(); tp.y += 0.4;
            const b = makeParticleBurst(tp, _trailColor.set(0xdc143c), 3, 0.4, { life: 0.4, size: 0.07, gravity: 0 });
            scene.add(b.points); particleSystems.push(b);
          }
          if (k >= 1) e.swoop = null;
        } else {
          e.group.position.x = damp(e.group.position.x, e.targetPos.x, 8, dt);
          e.group.position.z = damp(e.group.position.z, e.targetPos.z, 8, dt);
          // idle bob
          let y = TILE_TOP + Math.sin(clockElapsed * idle.speed * lsBoost + e.phase) * idle.amp;
          if (idle.type === "sway") y += Math.sin(clockElapsed * 1.8) * 0.03;
          e.group.position.y = damp(e.group.position.y, y, 10, dt);
        }

        // species-specific idle flourishes
        if (e.model) {
          switch (idle.type) {
            case "breathe": e.model.scale.setScalar(e.baseScale * (1 + Math.sin(clockElapsed * 1.5) * 0.012)); break;
            case "rock": e.model.rotation.z = Math.sin(clockElapsed * 2.5 * lsBoost) * 0.05; break;
            case "spin": e.model.rotation.y += 0.004 * lsBoost; break;
            case "sway": e.model.rotation.y = Math.sin(clockElapsed * 0.8) * 0.12; break;
            case "flicker":
              e.material.uniforms.uGlow.value = 0.5 + Math.sin(clockElapsed * 4) * 0.18;
              break;
            default: break;
          }
        }

        // shader state
        e.material.uniforms.uLastStand.value = e.lastStand ? 1 : 0;
        e.material.uniforms.uOpacity.value = e.active === false && P.activeCreatureId ? 0.4 : 0.82;
        // embercaster ("flicker") owns its own uGlow in the idle switch above
        if (idle.type !== "flicker") e.material.uniforms.uGlow.value = e.stunned ? (0.3 + (Math.sin(clockElapsed * 20) > 0 ? 0.5 : 0)) : 0.6;

        // neural-link summon: materialize (uDissolve 1->0) + a fading accent bloom
        if (summoning) {
          e.material.uniforms.uDissolve.value = 1 - summonK;
          e.material.uniforms.uGlow.value += (1 - summonK) * 1.1;
        } else if (e.material.uniforms.uDissolve.value !== 0) {
          e.material.uniforms.uDissolve.value = 0;
        }

        // pool pulse + colour
        if (e.poolMat) {
          const base = 0.15 + 0.12 * (0.5 + 0.5 * Math.sin(clockElapsed * 2 + e.phase));
          if (e.lastStand) { e.poolMat.color.setHex(0xffd700); e.poolMat.opacity = base * 1.8; }
          else { e.poolMat.color.set(e.team === "red" ? P.teamColors.red : P.teamColors.blue); e.poolMat.opacity = base; }
        }

        // hp bar
        if (e.hpBar) {
          e.hpBar.quaternion.copy(camera.quaternion);
          const ratio = Math.max(0, Math.min(1, e.maxHp ? e.hp / e.maxHp : 1));
          const fill = e.hpBar.userData.fill;
          fill.scale.x = 0.86 * ratio;
          fill.position.x = -0.43 * (1 - ratio);
          e.hpBar.userData.fillMat.color.setHex(ratio > 0.5 ? 0x2ecc71 : ratio > 0.25 ? 0xf39c12 : 0xe74c3c);
        }

        // breach meter ring above channeler is handled by the global breach column
      });

      // last stand light follows the survivor
      if (P.lastStandCreatureId && creatureEntries.has(P.lastStandCreatureId)) {
        const e = creatureEntries.get(P.lastStandCreatureId);
        lastStandLight.position.copy(e.group.position); lastStandLight.position.y = TILE_TOP + 1.0;
        lastStandLight.intensity = damp(lastStandLight.intensity, 0.8, 3, dt);
        if (!e._lsBurst) {
          e._lsBurst = true;
          const wp = e.group.position.clone(); wp.y += 0.6;
          const burst = makeParticleBurst(wp, new THREE.Color(0xffd700), PARTICLES, 3.0, { life: 1.0, size: 0.12 });
          scene.add(burst.points); particleSystems.push(burst);
        }
      } else {
        lastStandLight.intensity = damp(lastStandLight.intensity, 0, 4, dt);
      }
      killLight.intensity = damp(killLight.intensity, 0, 5, dt);

      // particle systems
      for (let i = particleSystems.length - 1; i >= 0; i--) {
        const ps = particleSystems[i];
        ps.age += dt;
        const arr = ps.positions;
        for (let j = 0; j < ps.count; j++) {
          ps.velocities[j * 3 + 1] -= ps.gravity * dt;
          arr[j * 3] += ps.velocities[j * 3] * dt;
          arr[j * 3 + 1] += ps.velocities[j * 3 + 1] * dt;
          arr[j * 3 + 2] += ps.velocities[j * 3 + 2] * dt;
        }
        ps.geo.attributes.position.needsUpdate = true;
        ps.mat.opacity = Math.max(0, 1 - ps.age / ps.life);
        if (ps.age >= ps.life) {
          scene.remove(ps.points); ps.geo.dispose(); ps.mat.dispose();
          particleSystems.splice(i, 1);
        }
      }

      // projectiles + explosions + rings
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const pr = projectiles[i];
        pr.t += dt;
        if (pr.beamFade) {
          const k = Math.min(1, pr.t / pr.dur);
          pr.mat.opacity = 0.6 * (1 - k);
          if (k >= 1) { scene.remove(pr.mesh); pr.geo.dispose(); pr.mat.dispose(); projectiles.splice(i, 1); }
        } else if (pr.explosion) {
          const k = Math.min(1, pr.t / pr.dur);
          pr.mesh.scale.setScalar(lerp(0.2, pr.maxScale, easeOutCubic(k)));
          pr.mat.opacity = 0.6 * (1 - k);
          if (k >= 1) { scene.remove(pr.mesh); pr.mat.dispose(); projectiles.splice(i, 1); }
        } else if (pr.ring) {
          const k = Math.min(1, pr.t / pr.dur);
          pr.mesh.scale.setScalar(lerp(1, pr.maxScale, easeOutCubic(k)));
          pr.mat.opacity = 0.8 * (1 - k);
          if (k >= 1) { scene.remove(pr.mesh); pr.geo.dispose(); pr.mat.dispose(); projectiles.splice(i, 1); }
        } else {
          const k = Math.min(1, pr.t / pr.dur);
          const pos = _tmpV.lerpVectors(pr.from, pr.to, k);
          pos.y += Math.sin(k * Math.PI) * pr.arcHeight;
          pr.mesh.position.copy(pos);
          // trail
          pr.trailTimer += dt;
          if (pr.trailTimer > 0.02) {
            pr.trailTimer = 0;
            const b = makeParticleBurst(pos.clone(), _trailColor.set(pr.color), 2, 0.3, { life: 0.35, size: 0.06, gravity: 0 });
            scene.add(b.points); particleSystems.push(b);
          }
          if (k >= 1) {
            explode(pr.to.clone(), pr.color, pr.kind);
            scene.remove(pr.mesh); pr.mat.dispose(); projectiles.splice(i, 1);
          }
        }
      }

      // ---- camera ----
      cam.angle += cam.orbitSpeed * dt;
      let desiredRadius = cam.radius, desiredHeight = cam.height;
      let desiredLook = cam.look;

      // priority: match end > last stand > breach > impulse
      if (P.winningTeam) {
        // hero angle on winner survivors
        const survivors = (P.creatures || []).filter((c) => c.alive !== false && c.team === P.winningTeam);
        if (survivors.length) {
          const centroid = new THREE.Vector3();
          for (const c of survivors) { const p = axialToWorld(c.pos[0], c.pos[1]); centroid.add(new THREE.Vector3(p.x, TILE_TOP + 0.5, p.z)); }
          centroid.multiplyScalar(1 / survivors.length);
          desiredLook = centroid; desiredRadius = 7.5; desiredHeight = 5.5;
        }
        cam.orbitSpeed = 0.018;
      } else if (P.lastStandCreatureId && creatureEntries.has(P.lastStandCreatureId)) {
        const e = creatureEntries.get(P.lastStandCreatureId);
        desiredLook = e.group.position.clone(); desiredLook.y += 0.6;
        desiredRadius = 12.5; desiredHeight = 8.5;
        cam.orbitSpeed = 0.0087;
      } else if (P.breachData?.active && breachGroup) {
        desiredLook = breachGroup.ring.position.clone();
        desiredRadius = 9.0; desiredHeight = 6.5;
        cam.orbitSpeed = 0.0087;
      } else {
        cam.orbitSpeed = 0.0087;
      }
      if (cam.impulse) {
        if (clockElapsed > cam.impulse.until) cam.impulse = null;
        else {
          if (cam.impulse.look) desiredLook = cam.impulse.look;
          desiredRadius *= cam.impulse.radiusMul;
        }
      }
      cam.curRadius = damp(cam.curRadius, desiredRadius, 4, dt);
      cam.curHeight = damp(cam.curHeight, desiredHeight, 4, dt);
      cam.curLook.lerp(desiredLook, 1 - Math.exp(-5 * dt));
      camera.position.set(
        Math.sin(cam.angle) * cam.curRadius,
        cam.curHeight,
        Math.cos(cam.angle) * cam.curRadius
      );
      camera.lookAt(cam.curLook);

      // rim light subtle move
      rimLight.position.x = Math.sin(clockElapsed * 0.4) * 1.5;

      renderer.render(scene, camera);

      // responsive resize
      const w = mount.clientWidth || lastWidth;
      if (Math.abs(w - lastWidth) > 1) {
        lastWidth = w;
        const h = Math.round(w * 0.74);
        renderer.setSize(w, h);
        camera.aspect = w / h; camera.updateProjectionMatrix();
      }
    }

    // kick off
    let cancelled = false;
    frame(); // render the platform immediately
    loadCreatureModels((done, total) => {
      if (cancelled) return;
      setLoadState({ loading: done < total, done, total });
    }).then(() => {
      if (cancelled) return;
      setLoadState({ loading: false, done: SPECIES.length, total: SPECIES.length });
      if (!readyFiredRef.current) { readyFiredRef.current = true; onReady?.(); }
    });

    // ----- cleanup -----------------------------------------------------------
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      // remove dynamic entities
      creatureEntries.forEach((e) => removeCreature(e));
      bodyEntries.forEach((be) => removeBody(be));
      for (const ps of particleSystems) { scene.remove(ps.points); ps.geo.dispose(); ps.mat.dispose(); }
      for (const pr of projectiles) { scene.remove(pr.mesh); pr.mat?.dispose?.(); pr.geo?.dispose?.(); }
      for (const b of beamPool) { scene.remove(b.mesh); b.mat.dispose(); } // beamUnitGeo freed via `disposables`
      if (breachGroup) { breachGroup.colGeo.dispose(); breachGroup.colMat.dispose(); breachGroup.ring.geometry.dispose(); breachGroup.ringMat.dispose(); }
      disposables.forEach((d) => { try { d.dispose?.(); } catch { /* noop */ } });
      renderer.dispose();
      renderer.forceContextLoss(); // release the WebGL context — dispose() alone does not
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // scene built once; props are read live via propsRef

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", lineHeight: 0 }} />
      {loadState.loading && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", pointerEvents: "none",
          color: "#4466aa", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 2,
        }}>
          <div style={{ fontSize: 9 }}>PROJECTING HOLOGRAMS…</div>
          <div style={{ fontSize: 8, color: "#2a3550", marginTop: 4 }}>{loadState.done}/{loadState.total} MODELS</div>
        </div>
      )}
    </div>
  );
}
