// Holographic projection material for Arena3D creature models.
//
// The 5 creature GLBs are AI-generated (Tripo3D from DALL-E portraits) and
// imperfect. This shader hides those imperfections behind transparency, scan
// lines, a fresnel edge-glow "shell", team-color tinting and flicker — so the
// models read as projected holograms rather than solid props.
//
// Mobile builds compile with `#define SIMPLIFY` (no scan lines, no dissolve
// fragmentation) to keep the per-fragment cost low; transparency + glow remain.

import * as THREE from "three";

export const HOLO_VERTEX = /* glsl */ `
  varying vec3 vNormalV;   // view-space normal
  varying vec3 vViewPos;   // view-space position
  varying vec3 vWorldPos;  // world-space position
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vNormalV = normalize(normalMatrix * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vec4 viewPos = viewMatrix * worldPos;
    vViewPos = viewPos.xyz;
    gl_Position = projectionMatrix * viewPos;
  }
`;

export const HOLO_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float time;
  uniform vec3  uColor;       // team tint
  uniform vec3  uEnvTint;     // global mood multiply (normal play ~ slightly cool white)
  uniform float uOpacity;
  uniform float uScanSpeed;
  uniform float uScanCount;
  uniform float uGlow;
  uniform float uFresnelPower;
  uniform float uLastStand;   // 0 / 1
  uniform float uDead;        // 0 / 1
  uniform float uDissolve;    // 0..1  (death destabilisation)

  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 baseColor = uColor;

    // Fresnel: brighter at grazing angles -> holographic shell silhouette.
    // DoubleSide: flip back-face normals (three does not auto-flip them for a
    // custom ShaderMaterial), else back faces get fres=1 and fill the interior
    // with solid glow instead of reading as a see-through shell.
    vec3 viewDir = normalize(-vViewPos);
    vec3 N = normalize(vNormalV);
    if (!gl_FrontFacing) N = -N;
    float fres = 1.0 - max(dot(N, viewDir), 0.0);
    fres = pow(fres, uFresnelPower);

    float scan = 1.0;
  #ifndef SIMPLIFY
    float sc = mix(uScanCount, uScanCount * 4.0, uDissolve);
    scan = sin(vWorldPos.y * sc - time * uScanSpeed) * 0.5 + 0.5;
    scan = smoothstep(0.25, 0.75, scan);
  #endif

    vec3 finalColor = baseColor * (0.55 + 0.45 * scan);
    finalColor += baseColor * fres * uGlow;

    // Last Stand: golden override.
    if (uLastStand > 0.5) {
      vec3 gold = vec3(1.0, 0.84, 0.0);
      finalColor = mix(finalColor, gold, 0.55);
      finalColor += gold * fres * 0.9;
    }

    // Dead ghost: desaturate + dim.
    if (uDead > 0.5) {
      float g = dot(finalColor, vec3(0.299, 0.587, 0.114));
      finalColor = vec3(g) * 0.35;
    }

    finalColor *= uEnvTint;

    float flicker = 0.92 + 0.08 * sin(time * 7.0 + vWorldPos.x * 3.0);

    float alpha = uOpacity * flicker;
    // Edge-biased alpha: silhouette stays solid, interior reads through.
    alpha *= clamp(0.35 + fres * 0.9 + scan * 0.15, 0.0, 1.0);
    alpha *= (1.0 - uDissolve);
    if (uDead > 0.5) alpha = min(alpha, 0.32);

  #ifndef SIMPLIFY
    if (uDissolve > 0.0) {
      float h = hash13(floor(vWorldPos * 26.0));
      if (h < uDissolve) discard;     // fragment away during death
    }
  #endif

    if (alpha < 0.01) discard;
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

const ENV_DEFAULT = new THREE.Color(0.82, 0.86, 1.0); // faint cool cast

/**
 * Build a holographic ShaderMaterial tinted to `color`.
 * @param {THREE.ColorRepresentation} color  team tint
 * @param {{ simplify?: boolean, opacity?: number }} opts
 */
export function createHolographicMaterial(color, opts = {}) {
  const { simplify = false, opacity = 0.82 } = opts;
  return new THREE.ShaderMaterial({
    uniforms: {
      time:         { value: 0 },
      uColor:       { value: new THREE.Color(color) },
      uEnvTint:     { value: ENV_DEFAULT.clone() },
      uOpacity:     { value: opacity },
      uScanSpeed:   { value: 1.4 },
      uScanCount:   { value: 22.0 },
      uGlow:        { value: 0.6 },
      uFresnelPower:{ value: 2.2 },
      uLastStand:   { value: 0 },
      uDead:        { value: 0 },
      uDissolve:    { value: 0 },
    },
    vertexShader: HOLO_VERTEX,
    fragmentShader: (simplify ? "#define SIMPLIFY\n" : "") + HOLO_FRAGMENT,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export { ENV_DEFAULT };
