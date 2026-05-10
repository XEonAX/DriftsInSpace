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
    // 80 grid cells across one screen-width; each cell may contain one star.
    vec2 uv      = vTextureCoord + uOffset;
    vec2 scaled  = uv * 80.0;
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

            // ~35 % of cells contain a star.
            if (h1 > 0.65) {
                vec2  starPos   = vec2(h2, h3);
                vec2  d         = cellFrc - starPos - vec2(float(i), float(j));
                float dist      = length(d);
                float size      = 0.04 + h1 * 0.05;       // radius in cell-UV space
                float intensity = (h1 - 0.65) / 0.35;     // brighter for higher h1
                float star      = intensity * smoothstep(size, 0.0, dist);
                if (star > brightness) {
                    brightness = star;
                    warmth = h3;
                }
            }
        }
    }

    // Warm (yellowish) ↔ cool (bluish) star tint.
    vec3 col = mix(vec3(1.0, 0.88, 0.70), vec3(0.70, 0.88, 1.0), warmth) * brightness;
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
    // Scale: nebula features span roughly 2 screen-widths.
    vec2 uv = (vTextureCoord + uOffset) * 0.55;

    float n1 = fbm(uv * 2.5);
    // Domain-warped second pass → organic, cloud-like shapes.
    float n2 = fbm(uv * 2.5 + vec2(5.2, 1.3) + n1 * 0.4);

    // Dark red region.
    vec3 red  = vec3(0.55, 0.05, 0.08) * pow(max(n1 - 0.30, 0.0), 1.5) * 2.2;
    // Dark blue-purple region.
    vec3 blue = vec3(0.04, 0.08, 0.38) * pow(max(n2 - 0.30, 0.0), 1.5) * 2.2;

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
    vec2 uv = (vTextureCoord + uOffset) * 0.85;

    float n = fbm(uv * 3.0);
    // Hard threshold: only the densest patches become visible wisps.
    n = pow(max(n - 0.42, 0.0), 1.8) * 4.0;

    // Very dark blue-black colour (just barely visible against black BG).
    vec3  col   = vec3(0.02, 0.03, 0.07) * n;
    float alpha = clamp(n * 0.40, 0.0, 0.45);

    finalColor = vec4(col, alpha);
}
`

// ─── Parallax rates (fraction of camera movement transferred to each layer) ─
const PARALLAX_RATES = [
  0.03,  // stars  — vast distance, almost stationary
  0.08,  // nebula — mid range
  0.15,  // fog    — closest; matches the old TilingSprite rate
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
