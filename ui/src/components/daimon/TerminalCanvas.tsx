import { useEffect, useRef, useCallback, useState } from "react";
import initWasm, { Terminal } from "@/lib/terminal-wasm/terminal_wasm";
import { wasmBytes } from "@/lib/terminal-wasm/wasm-bytes";

// Match daimon's main terminal font (src/terminalview: Monaco, Menlo, …).
const FONT_SIZE = 13;
const FONT_FAMILY = 'Monaco, Menlo, "Ubuntu Mono", monospace';
const CELL_H = 18; // px per line
const BG_DEFAULT = 0x0d1117;
const FG_DEFAULT = 0xe6edf3;
const DPR = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);

// The Rust engine's default cell colors (see lib.rs Cell::default).
const WASM_FG_DEFAULT = 0xffffff;
const WASM_BG_DEFAULT = 0x000000;

// ---- WASM singleton --------------------------------------------------------
let wasmReady: Promise<{ memory: WebAssembly.Memory }> | null = null;
function ensureWasm() {
  if (!wasmReady) {
    // Hand the raw bytes to WebAssembly.instantiate — no fetch. Electrobun's `views://`
    // scheme can't be fetched (init 404s / rejects), which left the canvas empty and the
    // engine unfed. Embedding the bytes removes the network dependency entirely.
    wasmReady = initWasm({ module_or_path: wasmBytes })
      .then((out) => ({ memory: out.memory }))
      .catch((e) => { console.error("[TerminalCanvas] WASM init failed:", e); throw e; });
  }
  return wasmReady;
}

// ---- Glyph atlas (alpha coverage mask) -------------------------------------
// Rasterize each unique glyph once as white-on-black into a Canvas2D atlas,
// upload as a single-channel texture. Colors are applied per-instance in the
// shader (Alacritty model) — the atlas holds only coverage.
type GlyphInfo = { u0: number; v0: number; u1: number; v1: number };

class Atlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  next = 0;
  map = new Map<string, GlyphInfo>();
  dirty = true;

  constructor(cellW: number, cellH: number) {
    this.cellW = Math.ceil(cellW);
    this.cellH = Math.ceil(cellH);
    this.cols = 32;
    this.rows = 32; // 1024 glyph slots — grows if needed by re-creating
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.cols * this.cellW;
    this.canvas.height = this.rows * this.cellH;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false })!;
    this.ctx.textBaseline = "top";
    this.ctx.fillStyle = "#fff";
  }

  key(ch: string, bold: boolean, italic: boolean) {
    return ch + (bold ? "b" : "") + (italic ? "i" : "");
  }

  get(ch: string, bold: boolean, italic: boolean): GlyphInfo {
    const k = this.key(ch, bold, italic);
    const hit = this.map.get(k);
    if (hit) return hit;

    const slot = this.next++;
    const cx = (slot % this.cols) * this.cellW;
    const cy = Math.floor(slot / this.cols) * this.cellH;
    this.ctx.font =
      (bold ? "bold " : "") + (italic ? "italic " : "") + `${FONT_SIZE * DPR}px ${FONT_FAMILY}`;
    this.ctx.fillStyle = "#fff";
    this.ctx.textBaseline = "top";
    this.ctx.fillText(ch, cx, cy + 1 * DPR);

    const info: GlyphInfo = {
      u0: cx / this.canvas.width,
      v0: cy / this.canvas.height,
      u1: (cx + this.cellW) / this.canvas.width,
      v1: (cy + this.cellH) / this.canvas.height,
    };
    this.map.set(k, info);
    this.dirty = true;
    return info;
  }
}

// ---- WebGL2 renderer -------------------------------------------------------
const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;      // unit quad corner 0..1
layout(location=1) in vec2 aCell;        // cell col,row
layout(location=2) in vec4 aUV;          // glyph atlas rect u0,v0,u1,v1 (unused for bg)
layout(location=3) in vec3 aColor;       // rgb 0..1
uniform vec2 uCellPx;                     // cell size in px
uniform vec2 uViewport;                   // canvas px
out vec2 vUV;
out vec3 vColor;
void main() {
  vec2 px = (aCell + aCorner) * uCellPx;
  vec2 clip = vec2(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = mix(aUV.xy, aUV.zw, aCorner);
  vColor = aColor;
}`;

const FS_BG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

const FS_GLYPH = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vColor;
uniform sampler2D uAtlas;
out vec4 outColor;
void main() {
  float a = texture(uAtlas, vUV).r;
  outColor = vec4(vColor, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program: " + gl.getProgramInfoLog(p));
  }
  return p;
}

export type TerminalHandle = {
  feed: (bytes: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  /** True when the app enabled DECCKM (application cursor keys). */
  appCursorKeys: () => boolean;
  /** True when the terminal switched to the alternate screen (fullscreen TUI). */
  onAlt: () => boolean;
};

type Props = {
  cols: number;
  rows: number;
  onReady: (handle: TerminalHandle) => void;
  /** Called whenever the alt-screen state flips (fullscreen TUI enter/exit). */
  onAltChange?: (alt: boolean) => void;
};

export function TerminalCanvas({ cols, rows, onReady, onAltChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const wasAltRef = useRef(false);

  // Track live cols/rows — updated via handle.resize() without remounting.
  const colsRef = useRef(cols);
  const rowsRef = useRef(rows);

  // CSS px size for the canvas element — set explicitly to avoid 100%/100% resolving
  // against a collapsed ancestor (position:fixed inside an auto-height article).
  const [cssSize, setCssSize] = useState<{ w: number; h: number } | null>(null);

  // GL + WASM handles kept across renders
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const memRef = useRef<WebAssembly.Memory | null>(null);
  const atlasRef = useRef<Atlas | null>(null);
  const cellWRef = useRef(7.8);
  const glState = useRef<{
    bgProg: WebGLProgram; glyphProg: WebGLProgram;
    vao: WebGLVertexArrayObject; instBuf: WebGLBuffer;
    atlasTex: WebGLTexture;
    uBgViewport: WebGLUniformLocation; uBgCell: WebGLUniformLocation;
    uGViewport: WebGLUniformLocation; uGCell: WebGLUniformLocation;
  } | null>(null);

  const render = useCallback(() => {
    const term = termRef.current;
    const gl = glRef.current;
    const st = glState.current;
    const mem = memRef.current;
    const atlas = atlasRef.current;
    if (!term || !gl || !st || !mem || !atlas) return;

    term.sync();
    const cw = cellWRef.current;
    const c = term.cols();
    const r = term.rows();

    // Re-read pointer each frame — wasm memory may have grown on resize.
    const ptr = term.cells_ptr();
    const len = term.cells_len();
    const grid = new Uint32Array(mem.buffer, ptr, len);

    // Build instance data: bg pass (col,row,color) and glyph pass (col,row,uv,color).
    // Layout per instance: [col, row, u0, v0, u1, v1, rf, gf, bf] = 9 floats.
    const bg: number[] = [];
    const fgInst: number[] = [];
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const o = (row * c + col) * 4;
        const code = grid[o]!;
        let fgc = grid[o + 1]!;
        let bgc = grid[o + 2]!;
        const flags = grid[o + 3]!;
        const bold = (flags & 1) !== 0;
        const italic = (flags & 2) !== 0;
        // Map engine defaults to our theme colors.
        if (fgc === WASM_FG_DEFAULT) fgc = FG_DEFAULT;
        if (bgc === WASM_BG_DEFAULT) bgc = BG_DEFAULT;

        if (bgc !== BG_DEFAULT) {
          bg.push(col, row, 0, 0, 0, 0, ((bgc >> 16) & 255) / 255, ((bgc >> 8) & 255) / 255, (bgc & 255) / 255);
        }
        const ch = code === 0 ? " " : String.fromCodePoint(code);
        if (ch !== " ") {
          const g = atlas.get(ch, bold, italic);
          fgInst.push(col, row, g.u0, g.v0, g.u1, g.v1, ((fgc >> 16) & 255) / 255, ((fgc >> 8) & 255) / 255, (fgc & 255) / 255);
        }
      }
    }

    // Cursor as an inverse block on the primary screen (alt screen draws its own).
    if (!term.on_alt() && term.cursor_visible()) {
      const cx = term.cursor_col();
      const cy = term.cursor_row();
      bg.push(cx, cy, 0, 0, 0, 0, ((FG_DEFAULT >> 16) & 255) / 255, ((FG_DEFAULT >> 8) & 255) / 255, (FG_DEFAULT & 255) / 255);
    }

    const vw = c * cw * DPR;
    const vh = r * CELL_H * DPR;
    gl.viewport(0, 0, vw, vh);
    gl.clearColor(((BG_DEFAULT >> 16) & 255) / 255, ((BG_DEFAULT >> 8) & 255) / 255, (BG_DEFAULT & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Upload atlas if it grew this frame.
    if (atlas.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, st.atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, atlas.canvas);
      atlas.dirty = false;
    }

    gl.bindVertexArray(st.vao);

    // ---- Background pass ----
    if (bg.length) {
      gl.useProgram(st.bgProg);
      gl.uniform2f(st.uBgViewport, vw, vh);
      gl.uniform2f(st.uBgCell, cw * DPR, CELL_H * DPR);
      gl.bindBuffer(gl.ARRAY_BUFFER, st.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(bg), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bg.length / 9);
    }

    // ---- Glyph pass ----
    if (fgInst.length) {
      gl.useProgram(st.glyphProg);
      gl.uniform2f(st.uGViewport, vw, vh);
      gl.uniform2f(st.uGCell, cw * DPR, CELL_H * DPR);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, st.atlasTex);
      gl.bindBuffer(gl.ARRAY_BUFFER, st.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fgInst), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fgInst.length / 9);
    }

    // Notify alt-screen flips for the fullscreen overlay.
    const alt = term.on_alt();
    if (alt !== wasAltRef.current) {
      wasAltRef.current = alt;
      onAltChange?.(alt);
    }
  }, [onAltChange]);

  const scheduleRender = useCallback(() => {
    dirtyRef.current = true;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (dirtyRef.current) { dirtyRef.current = false; render(); }
    });
  }, [render]);

  useEffect(() => {
    let disposed = false;
    const canvas = canvasRef.current!;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false })!;
    glRef.current = gl;

    // Measure real monospace advance for the cell width.
    const meas = document.createElement("canvas").getContext("2d")!;
    meas.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    const cellW = meas.measureText("M").width || 7.8;
    cellWRef.current = cellW;

    // ---- static GL setup ----
    const bgProg = program(gl, VS, FS_BG);
    const glyphProg = program(gl, VS, FS_GLYPH);

    // unit-quad corners as a triangle strip
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    // location 0: corner (per-vertex)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // instance buffer: [col,row, u0,v0,u1,v1, r,g,b] stride 9 floats
    const instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const S = 9 * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, 8);  gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 24); gl.vertexAttribDivisor(3, 1);

    const atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    glState.current = {
      bgProg, glyphProg, vao, instBuf, atlasTex,
      uBgViewport: gl.getUniformLocation(bgProg, "uViewport")!,
      uBgCell: gl.getUniformLocation(bgProg, "uCellPx")!,
      uGViewport: gl.getUniformLocation(glyphProg, "uViewport")!,
      uGCell: gl.getUniformLocation(glyphProg, "uCellPx")!,
    };
    atlasRef.current = new Atlas(cellW * DPR, CELL_H * DPR);
    // Bind atlas sampler to unit 0.
    gl.useProgram(glyphProg);
    gl.uniform1i(gl.getUniformLocation(glyphProg, "uAtlas"), 0);

    ensureWasm().then(({ memory }) => {
      if (disposed) return;
      // Defer until after layout so canvas.parentElement has real dimensions.
      requestAnimationFrame(() => {
        if (disposed) return;
        // Use window dimensions directly — reliable regardless of DOM layout timing.
        const cw = cellWRef.current;
        const cssW = window.innerWidth;
        const cssH = window.innerHeight;
        const initCols = Math.max(20, Math.floor(cssW / cw));
        const initRows = Math.max(5, Math.floor(cssH / CELL_H));
        colsRef.current = initCols;
        rowsRef.current = initRows;
        canvas.width = Math.round(cssW * DPR);
        canvas.height = Math.round(cssH * DPR);
        setCssSize({ w: cssW, h: cssH });

        memRef.current = memory;
        const term = new Terminal(initCols, initRows);
        termRef.current = term;

        const handle: TerminalHandle = {
          feed(bytes) {
            term.feed(bytes);
            scheduleRender();
          },
          resize(cc, rr) {
            colsRef.current = cc;
            rowsRef.current = rr;
            term.resize(cc, rr);
            const w = Math.round(cc * cellWRef.current * DPR);
            const h = Math.round(rr * CELL_H * DPR);
            canvas.width = w; canvas.height = h;
            setCssSize({ w: cc * cellWRef.current, h: rr * CELL_H });
            scheduleRender();
          },
          appCursorKeys() { return term.app_cursor_keys(); },
          onAlt() { return term.on_alt(); },
        };
        onReady(handle);
        scheduleRender();
      });
    });

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      termRef.current?.free();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: "block",
        width: cssSize ? cssSize.w : "100%",
        height: cssSize ? cssSize.h : "100%",
      }}
    />
  );
}
