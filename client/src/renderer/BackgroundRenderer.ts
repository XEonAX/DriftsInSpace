/**
 * BackgroundRenderer — 3-layer parallax background using procedural GLSL shaders.
 *
 * Layer order (back → front):
 *   Stars  — hash-based point stars, warm/cool colour variation, parallax 0.03
 *   Nebula — FBM value noise with domain warping, dark red + blue-purple, parallax 0.08
 *   Fog    — sparse FBM, near-black dark wisps, parallax 0.15 (same as old TilingSprite)
 *
 * All layers are fullscreen sprites in stage space (not worldContainer), so they
 * are unaffected by world scale/translation. The uOffset uniform scrolls the
 * procedural UV each frame based on the camera world position.
 *
 * Requires WebGL2 (app.init must include preference:'webgl'). WGSL/WebGPU
 * shaders are not provided; force WebGL in Application.init to avoid errors.
 */

import { Application, Container, Filter, GlProgram, Sprite, Texture, UniformGroup } from 'pixi.js'
import { PIXELS_PER_UNIT } from '../physics/ShipPhysics'

// ─── Background colour constants ───────────────────────────────────────────
// All values are linear RGB in [0, 1]. Edit here to retheme the background.

// Stars
const STAR_COLOR_WARM = [1.00, 0.82, 0.35] as const  // gold/amber stars — ANXRacers accent colour
const STAR_COLOR_COOL = [0.68, 0.45, 1.00] as const  // soft violet stars

// Nebula
const NEBULA_COLOR_RED  = [0.32, 0.05, 0.65] as const  // rich purple cloud region
const NEBULA_COLOR_BLUE = [0.10, 0.02, 0.42] as const  // deep violet cloud region

// Fog
const FOG_COLOR = [0.06, 0.01, 0.14] as const  // faint purple-black wisps

// ─── Background scale / density constants ─────────────────────────────────

// Stars
// Number of grid cells across one screen-width. Higher = more, smaller stars.
const STAR_GRID_DENSITY   = 80
// Fraction of cells that contain a star (0–1). 0.65 threshold → ~35 % fill.
const STAR_DENSITY_THRESH = 0.65
// Min and max star radius in cell-UV space.
const STAR_SIZE_MIN = 0.04
const STAR_SIZE_MAX = 0.09  // min + h1 * (max - min)

// Nebula
// Overall UV scale — lower = larger nebula features.
const NEBULA_UV_SCALE  = 0.55
// FBM frequency multiplier applied on top of UV scale.
const NEBULA_FBM_FREQ  = 2.5
// How aggressively to threshold + brighten nebula patches (contrast).
const NEBULA_CONTRAST  = 3.2

// Fog
// Overall UV scale — lower = larger fog patches.
const FOG_UV_SCALE   = 2
// FBM frequency on top of UV scale.
const FOG_FBM_FREQ   = 3.0
// Threshold below which fog is invisible (0–1). Higher = sparser wisps.
const FOG_THRESHOLD  = 0.4
// Alpha multiplier — controls how opaque the fog wisps are.
const FOG_OPACITY = 0.55
// Max Fog alpha is also clamped in shader to prevent excessively bright wisps when contrast is high.
const FOG_MAX_ALPHA = 0.65

/** Format a colour constant as a GLSL vec3 literal. */
function v3(c: readonly [number, number, number]): string {
  return `vec3(${c[0]}, ${c[1]}, ${c[2]})`
}
/** Format a number as a GLSL float literal (always includes a decimal point). */
function f(n: number): string {
  return n % 1 === 0 ? `${n}.0` : `${n}`
}

// ─── PixiJS v8 default filter vertex shader ────────────────────────────────
// Source: node_modules/pixi.js/lib/filters/defaults/defaultFilter.vert.mjs
const FILTER_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`

// ─── Shared hash function (avoids sin() precision issues on GPU) ────────────
const HASH_FN = `
float hash(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}
`

// ─── Shared value noise + FBM ───────────────────────────────────────────────
const NOISE_FN = HASH_FN + `
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i),                  hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}
`

// ─── Stars fragment shader ──────────────────────────────────────────────────
// Grid of cells, each cell may contain a single star at a random sub-cell
// position. 35 % density; warm (yellowish) ↔ cool (bluish) colour variation.
const STARS_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform vec2 uOffset;

${HASH_FN}

void main(void) {
    vec2 uv      = vTextureCoord + uOffset;
    vec2 scaled  = uv * ${f(STAR_GRID_DENSITY)};
    vec2 cell    = floor(scaled);
    vec2 cellFrc = fract(scaled);

    float brightness = 0.0;
    float warmth     = 0.5;

    // Check 3×3 neighbourhood so stars near cell boundaries render correctly.
    for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
            vec2  nc   = cell + vec2(float(i), float(j));
            float h1   = hash(nc);
            float h2   = hash(nc + vec2(33.7, 17.1));
            float h3   = hash(nc + vec2(71.2, 43.8));

            if (h1 > ${f(STAR_DENSITY_THRESH)}) {
                vec2  starPos   = vec2(h2, h3);
                vec2  d         = cellFrc - starPos - vec2(float(i), float(j));
                float dist      = length(d);
                float size      = ${f(STAR_SIZE_MIN)} + h1 * ${f(STAR_SIZE_MAX - STAR_SIZE_MIN)};
                float intensity = (h1 - ${f(STAR_DENSITY_THRESH)}) / ${f(1.0 - STAR_DENSITY_THRESH)};
                float star      = intensity * smoothstep(size, 0.0, dist);
                if (star > brightness) {
                    brightness = star;
                    warmth = h3;
                }
            }
        }
    }

    // Warm (yellowish) ↔ cool (bluish) star tint.
    vec3 col = mix(${v3(STAR_COLOR_WARM)}, ${v3(STAR_COLOR_COOL)}, warmth) * brightness;
    finalColor = vec4(col, brightness);
}
`

// ─── Nebula fragment shader ─────────────────────────────────────────────────
// FBM value noise with domain warping. Dark red and dark blue-purple regions.
// Features span ~2 screen-widths for that vast cosmic look.
const NEBULA_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform vec2 uOffset;

${NOISE_FN}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
        v += a * noise(p);
        p  = p * 2.3 + vec2(1.7, 9.2);
        a *= 0.5;
    }
    return v;
}

void main(void) {
    vec2 uv = (vTextureCoord + uOffset) * ${f(NEBULA_UV_SCALE)};

    float n1 = fbm(uv * ${f(NEBULA_FBM_FREQ)});
    // Domain-warped second pass → organic, cloud-like shapes.
    float n2 = fbm(uv * ${f(NEBULA_FBM_FREQ)} + vec2(5.2, 1.3) + n1 * 0.4);

    // Dark red region.
    vec3 red  = ${v3(NEBULA_COLOR_RED)}  * pow(max(n1 - 0.30, 0.0), 1.5) * ${f(NEBULA_CONTRAST)};
    // Dark blue-purple region.
    vec3 blue = ${v3(NEBULA_COLOR_BLUE)} * pow(max(n2 - 0.30, 0.0), 1.5) * ${f(NEBULA_CONTRAST)};

    vec3  col   = red + blue;
    float alpha = clamp(length(col) * 2.0, 0.0, 0.80);

    finalColor = vec4(col, alpha);
}
`

// ─── Fog fragment shader ────────────────────────────────────────────────────
// Sparse FBM, near-black dark wisps. Fastest parallax — appears closest to
// the camera, subtly obscuring parts of the star field and nebula beneath.
const FOG_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform vec2 uOffset;

${NOISE_FN}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p  = p * 2.1 + vec2(3.1, 7.3);
        a *= 0.5;
    }
    return v;
}

void main(void) {
    vec2 uv = (vTextureCoord + uOffset) * ${f(FOG_UV_SCALE)};

    float n = fbm(uv * ${f(FOG_FBM_FREQ)});
    // Hard threshold: only the densest patches become visible wisps.
    n = pow(max(n - ${f(FOG_THRESHOLD)}, 0.0), 1.8) * 4.0;

    // Very dark blue-black colour (just barely visible against black BG).
    vec3  col   = ${v3(FOG_COLOR)} * n;
    float alpha = clamp(n * ${f(FOG_OPACITY)}, 0.0, ${f(FOG_MAX_ALPHA)});

    finalColor = vec4(col, alpha);
}
`

// ─── Parallax rates (fraction of camera movement transferred to each layer) ─
const PARALLAX_RATES = [
  0.03,  // stars  — vast distance, almost stationary
  0.08,  // nebula — mid range
  0.4,  // fog    — closest; matches the old TilingSprite rate
] as const

const LAYER_NAMES  = ['bg-stars', 'bg-nebula', 'bg-fog'] as const
const LAYER_FRAGS  = [STARS_FRAG, NEBULA_FRAG, FOG_FRAG]

interface BgLayer {
  sprite:       Sprite
  uniforms:     UniformGroup
  parallaxRate: number
}

export class BackgroundRenderer {
  private layers: BgLayer[] = []

  /**
   * Create the three background sprite layers and insert them into `stage`
   * at indices 0, 1, 2 — behind whatever was already there (worldContainer).
   * Must be called after `worldContainer` has been added to stage so that
   * the addChildAt calls push it to the correct position.
   */
  init(app: Application, stage: Container): void {
    const W = app.screen.width
    const H = app.screen.height

    for (let i = 0; i < 3; i++) {
      const uniforms = new UniformGroup({
        uOffset: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
      })

      const filter = new Filter({
        glProgram: GlProgram.from({
          vertex:   FILTER_VERT,
          fragment: LAYER_FRAGS[i]!,
          name:     LAYER_NAMES[i]!,
        }),
        resources: { bgUniforms: uniforms },
      })

      const sprite = new Sprite(Texture.WHITE)
      sprite.width   = W
      sprite.height  = H
      sprite.filters = [filter]

      // Insert before worldContainer (which shifts up by 1 each iteration).
      stage.addChildAt(sprite, i)

      this.layers.push({ sprite, uniforms, parallaxRate: PARALLAX_RATES[i]! })
    }
  }

  /**
   * Call every frame with the camera world position to scroll each layer.
   * The UV offset is computed so scrolling speed is resolution-independent.
   */
  update(cameraX: number, cameraY: number, screenW: number, screenH: number): void {
    for (const layer of this.layers) {
      const r = layer.parallaxRate
      // Match original TilingSprite direction:
      //   camera moves right (+X) → texture shifts left  (negative U offset)
      //   camera moves up   (+Y) → texture shifts up     (positive V, because
      //       vTextureCoord V=0 is top, so positive offset scrolls upward)
      // UV offset direction:
      //   ship moves right (+cameraX) → world objects slide LEFT → bg must also slide LEFT
      //     → sample further right in texture (positive U) → +X
      //   ship moves up (+cameraY, Y-up world) → world objects slide DOWN (Y-down screen)
      //     → bg must also slide DOWN → sample further up in texture (negative V) → -Y
      const u = layer.uniforms.uniforms as Record<string, unknown>
      ;(u['uOffset'] as Float32Array | number[])[0] =  (cameraX * PIXELS_PER_UNIT * r) / screenW
      ;(u['uOffset'] as Float32Array | number[])[1] = -(cameraY * PIXELS_PER_UNIT * r) / screenH
    }
  }

  /** Call on window resize to keep the sprites filling the viewport. */
  resize(w: number, h: number): void {
    for (const layer of this.layers) {
      layer.sprite.width  = w
      layer.sprite.height = h
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      layer.sprite.filters = []
      layer.sprite.destroy()
    }
    this.layers = []
  }
}
