// Small WebGL2 helpers (programs, textures, framebuffers).

export interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  a: Record<string, number>;
}

function shader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
  return s;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program link failed");
  const u: Program["u"] = {};
  const a: Program["a"] = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const info = gl.getActiveUniform(p, i)!;
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) {
    const info = gl.getActiveAttrib(p, i)!;
    a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { program: p, u, a };
}

export type TexFormat = "R8" | "RG8" | "RGBA8";

const FORMATS: Record<TexFormat, (gl: WebGL2RenderingContext) => [number, number, number]> = {
  R8: (gl) => [gl.R8, gl.RED, 1],
  RG8: (gl) => [gl.RG8, gl.RG, 2],
  RGBA8: (gl) => [gl.RGBA8, gl.RGBA, 4],
};

export function texture(gl: WebGL2RenderingContext, fmt: TexFormat, width: number, height: number, data: Uint8Array | null, filter: number = gl.NEAREST): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  upload(gl, t, fmt, width, height, data);
  return t;
}

export function upload(gl: WebGL2RenderingContext, t: WebGLTexture, fmt: TexFormat, width: number, height: number, data: Uint8Array | null) {
  const [internal, format, channels] = FORMATS[fmt](gl);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, channels === 4 ? 4 : 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.UNSIGNED_BYTE, data);
}

export function bindTexture(gl: WebGL2RenderingContext, t: WebGLTexture, unit: number) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
}

export function buffer(gl: WebGL2RenderingContext, data: Float32Array, usage: number = gl.STATIC_DRAW): WebGLBuffer {
  const b = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  return b;
}

export function attribute(gl: WebGL2RenderingContext, buf: WebGLBuffer, loc: number | undefined, size: number) {
  if (loc === undefined || loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

export function framebuffer(gl: WebGL2RenderingContext, t: WebGLTexture): WebGLFramebuffer {
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  return fb;
}
