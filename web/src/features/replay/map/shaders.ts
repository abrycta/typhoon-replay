// GLSL ES 3.00 shaders for the field + wind-particle layer (technique after mapbox/webgl-wind, ISC).
// All data textures are 8-bit (R8 scalar, RG8 u/v, RGBA8 particle state) with manual bilinear filtering,
// so nothing depends on float texture filtering (OES_texture_float_linear is missing on many phones).

const COMMON = /* glsl */ `
const float PI = 3.141592653589793;
uniform ivec2 u_size;      // nx, ny of a frame
uniform float u_mix;       // 0 = frame A, 1 = frame B

vec2 mercToLonLat(vec2 m) {
  return vec2(m.x * 360.0 - 180.0, degrees(atan(sinh(PI * (1.0 - 2.0 * m.y)))));
}

// Fractional cell position of lon/lat in a window whose NW cell centre/resolution is geo.xyz.
// Returns (fx, fy, distance to the window edge in degrees).
vec3 cellPos(vec4 geo, vec2 ll) {
  float dl = ll.x - geo.x;
  dl -= 360.0 * floor((dl + 180.0) / 360.0);
  float fx = dl / geo.z;
  float fy = (geo.y - ll.y) / geo.z;
  vec2 size = vec2(u_size);
  float edge = min(min(fx + 0.5, size.x - 0.5 - fx), min(fy + 0.5, size.y - 0.5 - fy)) * geo.z;
  return vec3(fx, fy, edge);
}

// Manual bilinear sample of channel(s) of an 8-bit texture at a fractional cell position (0..255 units).
vec4 bilinear(sampler2D tex, vec2 p) {
  vec2 size = vec2(u_size);
  p = clamp(p, vec2(0.0), size - 1.0);
  ivec2 i0 = ivec2(floor(p));
  ivec2 i1 = min(i0 + 1, u_size - 1);
  vec2 f = p - vec2(i0);
  vec4 a = texelFetch(tex, i0, 0);
  vec4 b = texelFetch(tex, ivec2(i1.x, i0.y), 0);
  vec4 c = texelFetch(tex, ivec2(i0.x, i1.y), 0);
  vec4 d = texelFetch(tex, i1, 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 255.0;
}

float maxOf4(sampler2D tex, vec2 p) {
  vec2 size = vec2(u_size);
  p = clamp(p, vec2(0.0), size - 1.0);
  ivec2 i0 = ivec2(floor(p));
  ivec2 i1 = min(i0 + 1, u_size - 1);
  return max(max(texelFetch(tex, i0, 0).r, texelFetch(tex, ivec2(i1.x, i0.y), 0).r),
             max(texelFetch(tex, ivec2(i0.x, i1.y), 0).r, texelFetch(tex, i1, 0).r)) * 255.0;
}
`;

export const FIELD_VS = /* glsl */ `#version 300 es
in vec2 a_merc;
uniform mat4 u_matrix;
out vec2 v_merc;
void main() {
  v_merc = a_merc;
  gl_Position = u_matrix * vec4(a_merc, 0.0, 1.0);
}`;

export const FIELD_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform sampler2D u_lut;
uniform vec4 u_geoA;
uniform vec4 u_geoB;
uniform vec4 u_dec;    // encoding (0 linear, 1 sqrt), scale, offset, nodata
uniform vec3 u_ramp;   // domain min, domain max, norm (0 linear, 1 sqrt, 2 reverse)
uniform float u_edgeDeg;
uniform float u_opacity;
in vec2 v_merc;
out vec4 outColor;

// (q, weight): weight fades to 0 over u_edgeDeg at the window edge and is 0 on nodata.
vec2 fieldAt(sampler2D tex, vec4 geo, vec2 ll) {
  vec3 c = cellPos(geo, ll);
  if (c.z <= 0.0) return vec2(0.0);
  if (maxOf4(tex, c.xy) > u_dec.w - 0.5) return vec2(0.0);
  return vec2(bilinear(tex, c.xy).r, smoothstep(0.0, u_edgeDeg, c.z));
}

void main() {
  vec2 ll = mercToLonLat(v_merc);
  vec2 a = fieldAt(u_texA, u_geoA, ll);
  vec2 b = fieldAt(u_texB, u_geoB, ll);
  float wa = a.y * (1.0 - u_mix);
  float wb = b.y * u_mix;
  float w = wa + wb;
  if (w <= 0.001) discard;
  float q = (a.x * wa + b.x * wb) / w;
  float v = u_dec.x < 0.5 ? u_dec.z + q * u_dec.y : pow(q * u_dec.y, 2.0);
  float t = clamp((v - u_ramp.x) / (u_ramp.y - u_ramp.x), 0.0, 1.0);
  if (u_ramp.z > 1.5) t = 1.0 - t; else if (u_ramp.z > 0.5) t = sqrt(t);
  vec4 col = texture(u_lut, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
  float alpha = col.a * w * u_opacity;
  outColor = vec4(col.rgb * alpha, alpha);
}`;

export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_tex;
void main() {
  v_tex = a_pos;
  gl_Position = vec4(2.0 * a_pos - 1.0, 0.0, 1.0);
}`;

export const UPDATE_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D u_particles;
uniform sampler2D u_uvA;
uniform sampler2D u_uvB;
uniform vec4 u_geoA;
uniform vec4 u_geoB;
uniform vec4 u_domain;   // west, south, east, north of the particle domain
uniform vec4 u_spawn;    // west, south, east, north where dropped particles respawn
uniform float u_uvScale; // m/s per uv step
uniform float u_speed;   // degrees per (m/s) per update
uniform float u_seed;
uniform float u_drop;
in vec2 v_tex;
out vec4 outColor;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 windAt(sampler2D tex, vec4 geo, vec2 ll) {
  vec3 c = cellPos(geo, ll);
  if (c.z <= 0.0) return vec3(0.0);
  vec2 uv = (bilinear(tex, c.xy).rg - 128.0) * u_uvScale;
  return vec3(uv, smoothstep(0.0, 1.0, c.z));
}

void main() {
  vec4 s = texture(u_particles, v_tex);
  vec2 pos = vec2(s.r / 255.0 + s.b, s.g / 255.0 + s.a);
  vec2 ll = mix(u_domain.xy, u_domain.zw, pos);
  vec3 a = windAt(u_uvA, u_geoA, ll);
  vec3 b = windAt(u_uvB, u_geoB, ll);
  vec2 uv = mix(a.xy, b.xy, u_mix);
  float w = mix(a.z, b.z, u_mix);
  ll += vec2(uv.x / max(cos(radians(ll.y)), 0.2), uv.y) * u_speed;
  vec2 seed = (pos + v_tex) * u_seed;
  float drop = step(1.0 - u_drop - length(uv) * 0.0004, rand(seed));
  if (w < 0.2) drop = 1.0;
  vec2 fresh = mix(u_spawn.xy, u_spawn.zw, vec2(rand(seed + 1.3), rand(seed + 2.1)));
  ll = mix(ll, fresh, drop);
  pos = clamp((ll - u_domain.xy) / (u_domain.zw - u_domain.xy), 0.0, 0.9999);
  outColor = vec4(fract(pos * 255.0), floor(pos * 255.0) / 255.0);
}`;

export const DRAW_VS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform sampler2D u_ink;  // particle ink by ramp position (Akari map ink with the higher contrast on that field colour)
uniform vec4 u_geoA;
uniform vec4 u_geoB;
uniform vec4 u_dec;
uniform vec3 u_ramp;
in float a_index;
uniform sampler2D u_particles;
uniform float u_res;
uniform vec4 u_domain;
uniform mat4 u_matrix;
uniform float u_pointSize;
uniform vec4 u_window;   // west, south, east, north of the current field window
uniform float u_lonShift; // world copy the field is drawn in (multiple of 360 degrees)
out float v_alpha;
out vec3 v_ink;

// Ramp position of the field under the particle, as FIELD_FS computes it (0 where there is no field).
float rampAt(vec2 ll) {
  float q = 0.0, w = 0.0;
  vec3 ca = cellPos(u_geoA, ll), cb = cellPos(u_geoB, ll);
  float wa = ca.z > 0.0 && maxOf4(u_texA, ca.xy) < u_dec.w - 0.5 ? (1.0 - u_mix) : 0.0;
  float wb = cb.z > 0.0 && maxOf4(u_texB, cb.xy) < u_dec.w - 0.5 ? u_mix : 0.0;
  if (wa + wb <= 0.001) return 0.0;
  q = (bilinear(u_texA, ca.xy).r * wa + bilinear(u_texB, cb.xy).r * wb) / (wa + wb);
  float v = u_dec.x < 0.5 ? u_dec.z + q * u_dec.y : pow(q * u_dec.y, 2.0);
  float t = clamp((v - u_ramp.x) / (u_ramp.y - u_ramp.x), 0.0, 1.0);
  if (u_ramp.z > 1.5) t = 1.0 - t; else if (u_ramp.z > 0.5) t = sqrt(t);
  return t;
}

void main() {
  vec2 t = vec2((mod(a_index, u_res) + 0.5) / u_res, (floor(a_index / u_res) + 0.5) / u_res);
  vec4 s = texture(u_particles, t);
  vec2 pos = vec2(s.r / 255.0 + s.b, s.g / 255.0 + s.a);
  vec2 ll = mix(u_domain.xy, u_domain.zw, pos);
  vec2 merc = vec2((ll.x + u_lonShift + 180.0) / 360.0, (1.0 - log(tan(PI / 4.0 + radians(ll.y) / 2.0)) / PI) / 2.0);
  float edge = min(min(ll.x - u_window.x, u_window.z - ll.x), min(ll.y - u_window.y, u_window.w - ll.y));
  v_alpha = smoothstep(0.0, 2.5, edge);
  v_ink = texture(u_ink, vec2((rampAt(ll) * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  gl_PointSize = u_pointSize;
  gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
}`;

export const DRAW_FS = /* glsl */ `#version 300 es
precision mediump float;
uniform float u_alpha;
in float v_alpha;
in vec3 v_ink;
out vec4 outColor;
void main() {
  float a = u_alpha * v_alpha;
  outColor = vec4(v_ink * a, a);
}`;

export const SCREEN_FS = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_screen;
uniform float u_opacity;
in vec2 v_tex;
out vec4 outColor;
void main() {
  vec4 c = texture(u_screen, v_tex);
  // Fade the trail; floor() makes faint trails reach exactly zero instead of lingering at 1/255.
  outColor = floor(255.0 * c * u_opacity) / 255.0;
}`;
