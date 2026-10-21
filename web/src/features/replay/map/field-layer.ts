// MapLibre custom layer: the ERA5 field (colourised in the shader from 8-bit textures through an Akari
// colour LUT, time-interpolated between hourly frames, soft-faded at the storm window's edge) plus
// webgl-wind style particles advected by the interpolated u/v field.
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";

import { type TyfHeader, UV_SCALE } from "@/data";

import { attribute, bindTexture, buffer, type Program, program, texture, upload } from "./gl";
import { DRAW_FS, DRAW_VS, FIELD_FS, FIELD_VS, QUAD_VS, SCREEN_FS, UPDATE_FS } from "./shaders";

export interface FrameInput {
  index: number;
  raw: Uint8Array;
  uv: Uint8Array;
}

export interface FieldStyle {
  /** Index of the variable inside a raw frame. */
  varIndex: number;
  encoding: number; // 0 linear, 1 sqrt
  scale: number;
  offset: number;
  domain: [number, number];
  norm: number; // 0 linear, 1 sqrt, 2 reverse
  lut: Uint8Array;
  opacity: number;
  visible: boolean;
}

export interface ParticleStyle {
  enabled: boolean;
  /** Particle state texture side: count = res². */
  res: number;
  color: [number, number, number, number];
  fade: number;
}

const mercX = (lon: number) => (lon + 180) / 360;

/**
 * North-west cell longitudes of every frame, unwrapped so consecutive windows stay continuous across the
 * antimeridian (the published `nw_lon` is in (-180, 180], so a window east of 170°E can jump by 360°).
 * The first window's centre is put in (-180, 180], as the first track point is.
 */
export function unwrapWindowLons(nwLon: readonly number[], nx: number, res: number): number[] {
  const half = ((nx - 1) / 2) * res;
  const out: number[] = [];
  let prev: number | undefined;
  for (const w of nwLon) {
    let c = w + half;
    if (prev === undefined) {
      c = ((((c + 180) % 360) + 360) % 360) - 180;
      if (c === -180) c = 180;
    } else {
      while (c - prev > 180) c -= 360;
      while (prev - c > 180) c += 360;
    }
    out.push(c - half);
    prev = c;
  }
  return out;
}

/**
 * Longitude shift (a multiple of 360°) that puts a window centred at `centreLon` in the world copy nearest
 * the camera. A custom layer is drawn once, not per world copy as MapLibre draws the track, so without this
 * the field can sit 360° away from the track and the eye marker.
 */
export function worldShift(centreLon: number, cameraLon: number): number {
  return 360 * Math.round((cameraLon - centreLon) / 360) || 0;
}
const mercY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;

export class FieldLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map?: MlMap;
  private fieldProg?: Program;
  private updateProg?: Program;
  private drawProg?: Program;
  private screenProg?: Program;
  private vao?: WebGLVertexArrayObject;
  private quad?: WebGLBuffer;
  private fieldQuad?: WebGLBuffer;
  private indexBuf?: WebGLBuffer;
  private texA?: WebGLTexture;
  private texB?: WebGLTexture;
  private uvA?: WebGLTexture;
  private uvB?: WebGLTexture;
  private lutTex?: WebGLTexture;
  private state0?: WebGLTexture;
  private state1?: WebGLTexture;
  private stateFb?: WebGLFramebuffer;
  private screen0?: WebGLTexture;
  private screen1?: WebGLTexture;
  private screenFb?: WebGLFramebuffer;
  private screenSize = [0, 0];
  private stateRes = 0;

  private header?: TyfHeader;
  /** nw_lon of every frame, unwrapped (see unwrapWindowLons). */
  private nwLon: number[] = [];
  private a?: FrameInput;
  private b?: FrameInput;
  private mixT = 0;
  private uploaded = { a: -1, b: -1, var: -1, lut: undefined as Uint8Array | undefined };
  private style?: FieldStyle;
  private particles: ParticleStyle = { enabled: false, res: 96, color: [1, 1, 1, 0.8], fade: 0.9 };
  private domain: [number, number, number, number] = [0, 0, 1, 1];
  private clearTrails = true;
  private onMove = () => {
    this.clearTrails = true;
  };
  /** Set when GL setup failed (e.g. a driver without a needed feature); the field is simply not drawn. */
  failed?: string;

  constructor(id = "era5-field") {
    this.id = id;
  }

  setHeader(h: TyfHeader) {
    this.header = h;
    this.nwLon = unwrapWindowLons(h.nw_lon.slice(0, h.frames), h.nx, h.res_deg);
    // Particle domain: every window of the storm, so particles never need re-basing between frames.
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (let i = 0; i < h.frames; i++) {
      const west = this.nwLon[i]! - h.res_deg / 2;
      const north = h.nw_lat[i]! + h.res_deg / 2;
      w = Math.min(w, west);
      e = Math.max(e, west + h.nx * h.res_deg);
      n = Math.max(n, north);
      s = Math.min(s, north - h.ny * h.res_deg);
    }
    this.domain = [w, s, e, n];
    this.uploaded = { ...this.uploaded, a: -1, b: -1 };
  }

  setFrames(a: FrameInput | undefined, b: FrameInput | undefined, mix: number) {
    this.a = a;
    this.b = b ?? a;
    this.mixT = b ? mix : 0;
    this.map?.triggerRepaint();
  }

  setStyle(style: FieldStyle) {
    if (this.style && style.varIndex !== this.style.varIndex) this.uploaded = { ...this.uploaded, a: -1, b: -1 };
    this.style = style;
    this.map?.triggerRepaint();
  }

  setParticles(p: Partial<ParticleStyle>) {
    const was = this.particles.enabled;
    this.particles = { ...this.particles, ...p };
    if (!was && this.particles.enabled) this.clearTrails = true;
    this.map?.triggerRepaint();
  }

  get animating() {
    return this.particles.enabled && !!this.a;
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    try {
      this.fieldProg = program(gl, FIELD_VS, FIELD_FS);
      this.updateProg = program(gl, QUAD_VS, UPDATE_FS);
      this.drawProg = program(gl, DRAW_VS, DRAW_FS);
      this.screenProg = program(gl, QUAD_VS, SCREEN_FS);
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
      console.error("field layer:", this.failed);
      return;
    }
    this.vao = gl.createVertexArray()!;
    this.quad = buffer(gl, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));
    this.fieldQuad = buffer(gl, new Float32Array(12), gl.DYNAMIC_DRAW);
    this.texA = texture(gl, "R8", 1, 1, new Uint8Array(1));
    this.texB = texture(gl, "R8", 1, 1, new Uint8Array(1));
    this.uvA = texture(gl, "RG8", 1, 1, new Uint8Array(2));
    this.uvB = texture(gl, "RG8", 1, 1, new Uint8Array(2));
    this.lutTex = texture(gl, "RGBA8", 256, 1, new Uint8Array(1024));
    this.stateFb = gl.createFramebuffer()!;
    this.screenFb = gl.createFramebuffer()!;
    map.on("move", this.onMove);
    map.on("resize", this.onMove);
  }

  onRemove(map: MlMap, gl: WebGL2RenderingContext) {
    map.off("move", this.onMove);
    map.off("resize", this.onMove);
    for (const t of [this.texA, this.texB, this.uvA, this.uvB, this.lutTex, this.state0, this.state1, this.screen0, this.screen1]) if (t) gl.deleteTexture(t);
    for (const b of [this.quad, this.fieldQuad, this.indexBuf]) if (b) gl.deleteBuffer(b);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.stateFb) gl.deleteFramebuffer(this.stateFb);
    if (this.screenFb) gl.deleteFramebuffer(this.screenFb);
    for (const p of [this.fieldProg, this.updateProg, this.drawProg, this.screenProg]) if (p) gl.deleteProgram(p.program);
  }

  private syncTextures(gl: WebGL2RenderingContext) {
    const h = this.header, st = this.style;
    if (!h || !st || !this.a || !this.b) return false;
    const n = h.nx * h.ny;
    const vi = st.varIndex;
    if (this.uploaded.var !== vi) this.uploaded = { ...this.uploaded, a: -1, b: -1, var: vi };
    if (this.uploaded.a !== this.a.index) {
      upload(gl, this.texA!, "R8", h.nx, h.ny, this.a.raw.subarray(vi * n, (vi + 1) * n));
      upload(gl, this.uvA!, "RG8", h.nx, h.ny, this.a.uv);
      this.uploaded.a = this.a.index;
    }
    if (this.uploaded.b !== this.b.index) {
      upload(gl, this.texB!, "R8", h.nx, h.ny, this.b.raw.subarray(vi * n, (vi + 1) * n));
      upload(gl, this.uvB!, "RG8", h.nx, h.ny, this.b.uv);
      this.uploaded.b = this.b.index;
    }
    if (this.uploaded.lut !== st.lut) {
      upload(gl, this.lutTex!, "RGBA8", 256, 1, st.lut);
      this.uploaded.lut = st.lut;
    }
    return true;
  }

  private geo(i: number): [number, number, number, number] {
    const h = this.header!;
    return [this.nwLon[i]!, h.nw_lat[i]!, h.res_deg, 0];
  }

  private windowsBounds() {
    const h = this.header!;
    const ga = this.geo(this.a!.index), gb = this.geo(this.b!.index);
    const west = Math.min(ga[0], gb[0]) - h.res_deg / 2;
    const north = Math.max(ga[1], gb[1]) + h.res_deg / 2;
    const east = Math.max(ga[0], gb[0]) + (h.nx - 0.5) * h.res_deg;
    const south = Math.min(ga[1], gb[1]) - (h.ny - 0.5) * h.res_deg;
    return { west, north, east, south, ga, gb };
  }

  /** World-copy shift (degrees) for the current frame, from the camera centre. */
  private shift() {
    const h = this.header!;
    const g = this.geo(this.mixT < 0.5 ? this.a!.index : this.b!.index);
    return worldShift(g[0] + ((h.nx - 1) / 2) * h.res_deg, this.map?.getCenter().lng ?? 0);
  }

  private ensureParticleState(gl: WebGL2RenderingContext) {
    const res = this.particles.res;
    if (this.stateRes === res && this.state0) return;
    const init = new Uint8Array(res * res * 4);
    for (let i = 0; i < init.length; i++) init[i] = Math.floor(Math.random() * 256);
    if (this.state0) gl.deleteTexture(this.state0);
    if (this.state1) gl.deleteTexture(this.state1);
    this.state0 = texture(gl, "RGBA8", res, res, init);
    this.state1 = texture(gl, "RGBA8", res, res, init);
    const idx = new Float32Array(res * res);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    if (this.indexBuf) gl.deleteBuffer(this.indexBuf);
    this.indexBuf = buffer(gl, idx);
    this.stateRes = res;
  }

  private ensureScreen(gl: WebGL2RenderingContext) {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (this.screen0 && this.screenSize[0] === w && this.screenSize[1] === h) return;
    if (this.screen0) gl.deleteTexture(this.screen0);
    if (this.screen1) gl.deleteTexture(this.screen1);
    this.screen0 = texture(gl, "RGBA8", w, h, new Uint8Array(w * h * 4), gl.LINEAR);
    this.screen1 = texture(gl, "RGBA8", w, h, new Uint8Array(w * h * 4), gl.LINEAR);
    this.screenSize = [w, h];
    this.clearTrails = true;
  }

  prerender(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (this.failed || !this.particles.enabled || !this.syncTextures(gl)) return;
    const h = this.header!;
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    this.ensureParticleState(gl);
    this.ensureScreen(gl);
    gl.bindVertexArray(this.vao!);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    const { ga, gb } = this.windowsBounds();
    const res = this.stateRes;

    // 1. Advect particles: state0 -> state1.
    const up = this.updateProg!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFb!);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.state1!, 0);
    gl.viewport(0, 0, res, res);
    gl.disable(gl.BLEND);
    gl.useProgram(up.program);
    attribute(gl, this.quad!, up.a.a_pos, 2);
    bindTexture(gl, this.state0!, 0);
    bindTexture(gl, this.uvA!, 1);
    bindTexture(gl, this.uvB!, 2);
    gl.uniform1i(up.u.u_particles!, 0);
    gl.uniform1i(up.u.u_uvA!, 1);
    gl.uniform1i(up.u.u_uvB!, 2);
    gl.uniform2i(up.u.u_size!, h.nx, h.ny);
    gl.uniform1f(up.u.u_mix!, this.mixT);
    gl.uniform4fv(up.u.u_geoA!, ga);
    gl.uniform4fv(up.u.u_geoB!, gb);
    gl.uniform4fv(up.u.u_domain!, this.domain);
    const cur = this.mixT < 0.5 ? ga : gb;
    gl.uniform4f(up.u.u_spawn!, cur[0], cur[1] - (h.ny - 1) * h.res_deg, cur[0] + (h.nx - 1) * h.res_deg, cur[1]);
    gl.uniform1f(up.u.u_uvScale!, UV_SCALE);
    // Degrees per (m/s) per update, scaled with zoom so trails keep a similar on-screen length.
    const zoom = this.map?.getZoom() ?? 5;
    gl.uniform1f(up.u.u_speed!, 0.0016 * Math.pow(2, 5 - zoom));
    gl.uniform1f(up.u.u_seed!, Math.random() + 0.5);
    gl.uniform1f(up.u.u_drop!, 0.004);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    [this.state0, this.state1] = [this.state1, this.state0];

    // 2. Trails: fade the previous screen into screen1, then draw particles on top.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.screenFb!);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.screen1!, 0);
    gl.viewport(0, 0, this.screenSize[0]!, this.screenSize[1]!);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.clearTrails) {
      const sp = this.screenProg!;
      gl.useProgram(sp.program);
      attribute(gl, this.quad!, sp.a.a_pos, 2);
      bindTexture(gl, this.screen0!, 0);
      gl.uniform1i(sp.u.u_screen!, 0);
      gl.uniform1f(sp.u.u_opacity!, this.particles.fade);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    this.clearTrails = false;
    const dp = this.drawProg!;
    gl.useProgram(dp.program);
    attribute(gl, this.indexBuf!, dp.a.a_index, 1);
    bindTexture(gl, this.state0!, 0);
    gl.uniform1i(dp.u.u_particles!, 0);
    gl.uniform1f(dp.u.u_res!, res);
    gl.uniform4fv(dp.u.u_domain!, this.domain);
    gl.uniform4f(dp.u.u_window!, cur[0], cur[1] - (h.ny - 1) * h.res_deg, cur[0] + (h.nx - 1) * h.res_deg, cur[1]);
    gl.uniform1f(dp.u.u_lonShift!, this.shift());
    gl.uniformMatrix4fv(dp.u.u_matrix!, false, options.defaultProjectionData.mainMatrix as Float32Array);
    gl.uniform1f(dp.u.u_pointSize!, Math.max(1, window.devicePixelRatio));
    const [r, g, b, a] = this.particles.color;
    gl.uniform4f(dp.u.u_color!, r * a, g * a, b * a, a);
    gl.drawArrays(gl.POINTS, 0, res * res);
    [this.screen0, this.screen1] = [this.screen1, this.screen0];

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (this.failed || !this.style || !this.syncTextures(gl)) return;
    const h = this.header!;
    const st = this.style;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao!);

    if (st.visible) {
      const { west, north, east, south, ga, gb } = this.windowsBounds();
      // The shader maps each fragment back to lon/lat modulo 360°, so only the quad moves to the camera's copy.
      const k = this.shift();
      const x0 = mercX(west + k), x1 = mercX(east + k), y0 = mercY(north), y1 = mercY(south);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fieldQuad!);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]));
      const fp = this.fieldProg!;
      gl.useProgram(fp.program);
      attribute(gl, this.fieldQuad!, fp.a.a_merc, 2);
      bindTexture(gl, this.texA!, 0);
      bindTexture(gl, this.texB!, 1);
      bindTexture(gl, this.lutTex!, 2);
      gl.uniform1i(fp.u.u_texA!, 0);
      gl.uniform1i(fp.u.u_texB!, 1);
      gl.uniform1i(fp.u.u_lut!, 2);
      gl.uniformMatrix4fv(fp.u.u_matrix!, false, options.defaultProjectionData.mainMatrix as Float32Array);
      gl.uniform2i(fp.u.u_size!, h.nx, h.ny);
      gl.uniform1f(fp.u.u_mix!, this.mixT);
      gl.uniform4fv(fp.u.u_geoA!, ga);
      gl.uniform4fv(fp.u.u_geoB!, gb);
      gl.uniform4f(fp.u.u_dec!, st.encoding, st.scale, st.offset, h.nodata);
      gl.uniform3f(fp.u.u_ramp!, st.domain[0], st.domain[1], st.norm);
      gl.uniform1f(fp.u.u_edgeDeg!, 1.5);
      gl.uniform1f(fp.u.u_opacity!, st.opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    if (this.particles.enabled && this.screen0) {
      const sp = this.screenProg!;
      gl.useProgram(sp.program);
      attribute(gl, this.quad!, sp.a.a_pos, 2);
      bindTexture(gl, this.screen0, 0);
      gl.uniform1i(sp.u.u_screen!, 0);
      gl.uniform1f(sp.u.u_opacity!, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(null);
  }
}

