// Eye tracking via MediaPipe FaceMesh iris landmarks (GPU/WebGL accelerated).
// All processing is local — no data leaves the machine.

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export type GazePoint = { x: number; y: number }; // screen pixels

// 9-point calibration: maps normalized iris coords to screen coords via affine transform
type CalibPoint = { iris: { x: number; y: number }; screen: { x: number; y: number } };

const CALIB_KEY = "daimon-gaze-calib-v1";

function saveCalib(pts: CalibPoint[]) {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(pts)); } catch { /**/ }
}

function loadCalib(): CalibPoint[] | null {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CalibPoint[];
  } catch { return null; }
}

// Least-squares affine fit: iris (nx, ny) → screen (px, py)
// px = a*nx + b*ny + c
// py = d*nx + e*ny + f
type AffineCoeffs = { a: number; b: number; c: number; d: number; e: number; f: number };

function fitAffine(pts: CalibPoint[]): AffineCoeffs | null {
  if (pts.length < 4) return null;
  // Build normal equations for 6 coefficients
  let s1=0, sx=0, sy=0, sxx=0, sxy=0, syy=0;
  let spx=0, spy=0, sxpx=0, sypx=0, sxpy=0, sypy=0;
  for (const p of pts) {
    const { x, y } = p.iris;
    const { x: px, y: py } = p.screen;
    s1++; sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; syy+=y*y;
    spx+=px; spy+=py; sxpx+=x*px; sypx+=y*px; sxpy+=x*py; sypy+=y*py;
  }
  // Simple pseudo-inverse via 3x3 system [1, x, y] for each output
  // A = [[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]]
  const A = [[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const bx = [spx, sxpx, sypx];
  const by = [spy, sxpy, sypy];
  const cx = solve3(A, bx);
  const cy = solve3(A, by);
  if (!cx || !cy) return null;
  return { a: cx[1]!, b: cx[2]!, c: cx[0]!, d: cy[1]!, e: cy[2]!, f: cy[0]! };
}

function solve3(A: number[][], b: number[]): number[] | null {
  // Gaussian elimination
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col+1; row < 3; row++) if (Math.abs(M[row]![col]!) > Math.abs(M[maxRow]![col]!)) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow]!, M[col]!];
    if (Math.abs(M[col]![col]!) < 1e-10) return null;
    for (let row = col+1; row < 3; row++) {
      const f = M[row]![col]! / M[col]![col]!;
      for (let k = col; k <= 3; k++) M[row]![k]! -= f * M[col]![k]!;
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    x[i] = M[i]![3]!;
    for (let j = i+1; j < 3; j++) x[i] -= M[i]![j]! * x[j]!;
    x[i] /= M[i]![i]!;
  }
  return x;
}

function applyAffine(c: AffineCoeffs, iris: { x: number; y: number }): GazePoint {
  return {
    x: c.a * iris.x + c.b * iris.y + c.c,
    y: c.d * iris.x + c.e * iris.y + c.f,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export type GazeListener = (pt: GazePoint | null) => void;

let landmarker: FaceLandmarker | null = null;
let video: HTMLVideoElement | null = null;
let animFrame: number | null = null;
let coeffs: AffineCoeffs | null = null;
const listeners = new Set<GazeListener>();
let running = false;

export function hasCalibration(): boolean {
  return loadCalib() !== null;
}

export function clearCalibration() {
  try { localStorage.removeItem(CALIB_KEY); } catch { /**/ }
  coeffs = null;
}

async function initLandmarker() {
  if (landmarker) return;
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );
  landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
      delegate: "GPU",
    },
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
    runningMode: "VIDEO",
    numFaces: 1,
  });
}

// Iris landmark indices in FaceMesh 478-point model
// Left iris center: 468, right iris center: 473
function getIrisNormalized(landmarks: { x: number; y: number; z: number }[]): { x: number; y: number } | null {
  const l = landmarks[468];
  const r = landmarks[473];
  if (!l || !r) return null;
  // Average both irises — more stable than one
  return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
}

function tick() {
  if (!landmarker || !video || video.readyState < 2) {
    animFrame = requestAnimationFrame(tick);
    return;
  }
  const result = landmarker.detectForVideo(video, performance.now());
  if (result.faceLandmarks.length > 0) {
    const iris = getIrisNormalized(result.faceLandmarks[0]!);
    if (iris && coeffs) {
      const pt = applyAffine(coeffs, iris);
      listeners.forEach((fn) => fn(pt));
    } else {
      listeners.forEach((fn) => fn(null));
    }
  } else {
    listeners.forEach((fn) => fn(null));
  }
  animFrame = requestAnimationFrame(tick);
}

export async function startGaze(): Promise<void> {
  if (running) return;

  // WKWebView (Electrobun/macOS app shell) does not expose camera without native
  // permission delegate wiring. Detect and surface a clear error.
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera not available in app shell.\nOpen http://localhost:7881 in Chrome or Safari to use eye tracking."
    );
  }

  running = true;

  await initLandmarker();

  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } });
  video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  await new Promise<void>((res) => { video!.onloadeddata = () => res(); });

  const calib = loadCalib();
  if (calib) coeffs = fitAffine(calib);

  animFrame = requestAnimationFrame(tick);
}

export function stopGaze() {
  running = false;
  if (animFrame !== null) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (video) {
    (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    video = null;
  }
  listeners.forEach((fn) => fn(null));
}

export function onGaze(fn: GazeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Called during calibration: record a calibration point from current iris position
export function sampleCalibPoint(screenX: number, screenY: number): boolean {
  if (!landmarker || !video || video.readyState < 2) return false;
  const result = landmarker.detectForVideo(video, performance.now());
  if (result.faceLandmarks.length === 0) return false;
  const iris = getIrisNormalized(result.faceLandmarks[0]!);
  if (!iris) return false;
  const stored = loadCalib() ?? [];
  stored.push({ iris, screen: { x: screenX, y: screenY } });
  saveCalib(stored);
  // Refit if enough points
  if (stored.length >= 4) coeffs = fitAffine(stored);
  return true;
}

export function resetCalibration() {
  clearCalibration();
}
