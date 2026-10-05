/**
 * Loads OpenCV.js lazily (self-hosted at public/opencv/opencv.js, only
 * fetched when the corner-adjust screen mounts) and wraps the handful of
 * calls that screen needs: detecting a page's 4 corners, and warping +
 * enhancing the flattened result. Cv.Mat objects are manually freed
 * (.delete()) throughout, since the WASM heap isn't garbage collected.
 */

interface CvMat {
  delete(): void;
  rows: number;
  data32S: Int32Array;
}
interface CvMatVector {
  size(): number;
  get(i: number): CvMat;
  delete(): void;
}

// OpenCV.js has no usable published types; this is the subset we call.
export interface Cv {
  Mat: new () => CvMat;
  MatVector: new () => CvMatVector;
  Size: new (w: number, h: number) => unknown;
  CV_32FC2: number;
  COLOR_RGBA2GRAY: number;
  COLOR_RGBA2RGB: number;
  COLOR_RGB2YCrCb: number;
  COLOR_YCrCb2RGB: number;
  RETR_LIST: number;
  CHAIN_APPROX_SIMPLE: number;
  matFromImageData(imageData: ImageData): CvMat;
  matFromArray(rows: number, cols: number, type: number, data: number[]): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, ksize: unknown, sigma: number): void;
  Canny(src: CvMat, dst: CvMat, t1: number, t2: number): void;
  findContours(src: CvMat, contours: CvMatVector, hierarchy: CvMat, mode: number, method: number): void;
  contourArea(contour: CvMat): number;
  arcLength(contour: CvMat, closed: boolean): number;
  approxPolyDP(curve: CvMat, approx: CvMat, epsilon: number, closed: boolean): void;
  isContourConvex(contour: CvMat): boolean;
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
  warpPerspective(src: CvMat, dst: CvMat, transform: CvMat, size: unknown): void;
  split(src: CvMat, channels: CvMatVector): void;
  merge(channels: CvMatVector, dst: CvMat): void;
  equalizeHist(src: CvMat, dst: CvMat): void;
  addWeighted(src1: CvMat, alpha: number, src2: CvMat, beta: number, gamma: number, dst: CvMat): void;
  imshow(canvas: HTMLCanvasElement, mat: CvMat): void;
}

declare global {
  interface Window {
    cv?: unknown;
  }
}

export interface Point {
  x: number;
  y: number;
}

let loading: Promise<Cv> | null = null;

export function loadOpenCv(): Promise<Cv> {
  loading ??= new Promise<Cv>((resolve, reject) => {
    const existing = window.cv;
    if (existing && !(existing instanceof Promise) && (existing as { Mat?: unknown }).Mat) {
      resolve(existing as Cv);
      return;
    }
    const script = document.createElement("script");
    script.src = "/opencv/opencv.js";
    script.async = true;
    script.onerror = () => reject(new Error("opencv_load_failed"));
    script.onload = () => {
      Promise.resolve(window.cv as Cv | Promise<Cv>).then(resolve, reject);
    };
    document.body.appendChild(script);
  });
  return loading;
}

function toImageData(bitmap: ImageBitmap, maxEdge: number): { imageData: ImageData; scale: number } {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { imageData: ctx.getImageData(0, 0, width, height), scale };
}

/** TL, TR, BR, BL — the standard document-scanner corner ordering. */
function orderCorners(points: Point[]): [Point, Point, Point, Point] {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  const tr = byDiff[0];
  const bl = byDiff[3];
  return [tl, tr, br, bl];
}

/** Detect the page's 4 corners, normalized 0-1 against the bitmap's own size. Null if nothing plausible is found. */
export async function detectCorners(bitmap: ImageBitmap): Promise<[Point, Point, Point, Point] | null> {
  const cv = await loadOpenCv();
  const SCAN_EDGE = 1000;
  const { imageData, scale } = toImageData(bitmap, SCAN_EDGE);

  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const approx = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = imageData.width * imageData.height;
    let best: Point[] | null = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area > bestArea && area > imageArea * 0.15) {
        const peri = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, 0.02 * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts: Point[] = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          best = pts;
          bestArea = area;
        }
      }
      contour.delete();
    }

    if (!best) return null;
    const ordered = orderCorners(best);
    return ordered.map((p) => ({ x: p.x / scale / bitmap.width, y: p.y / scale / bitmap.height })) as [Point, Point, Point, Point];
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
    approx.delete();
  }
}

/** Warp to the 4 corners (normalized 0-1), then a mild contrast/sharpen pass. Returns a JPEG blob. */
export async function flattenAndEnhance(bitmap: ImageBitmap, corners: [Point, Point, Point, Point]): Promise<Blob> {
  const cv = await loadOpenCv();
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  const src = cv.matFromImageData(imageData);
  const rgb = new cv.Mat();
  const [tl, tr, br, bl] = corners.map((p) => ({ x: p.x * bitmap.width, y: p.y * bitmap.height }));
  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const outWidth = Math.round(Math.max(widthTop, widthBottom));
  const outHeight = Math.round(Math.max(heightLeft, heightRight));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outWidth, 0, outWidth, outHeight, 0, outHeight]);
  const transform = cv.getPerspectiveTransform(srcTri, dstTri);
  const warped = new cv.Mat();
  const ycc = new cv.Mat();
  const channels = new cv.MatVector();
  const enhanced = new cv.Mat();
  const blurredForSharpen = new cv.Mat();
  const sharpened = new cv.Mat();

  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.warpPerspective(rgb, warped, transform, new cv.Size(outWidth, outHeight));

    cv.cvtColor(warped, ycc, cv.COLOR_RGB2YCrCb);
    cv.split(ycc, channels);
    cv.equalizeHist(channels.get(0), channels.get(0));
    cv.merge(channels, ycc);
    cv.cvtColor(ycc, enhanced, cv.COLOR_YCrCb2RGB);

    cv.GaussianBlur(enhanced, blurredForSharpen, new cv.Size(0, 0), 3);
    cv.addWeighted(enhanced, 1.5, blurredForSharpen, -0.5, 0, sharpened);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outWidth;
    outCanvas.height = outHeight;
    cv.imshow(outCanvas, sharpened);
    return await new Promise<Blob>((resolve, reject) =>
      outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode_failed"))), "image/jpeg", 0.9),
    );
  } finally {
    src.delete();
    rgb.delete();
    srcTri.delete();
    dstTri.delete();
    transform.delete();
    warped.delete();
    ycc.delete();
    channels.delete();
    enhanced.delete();
    blurredForSharpen.delete();
    sharpened.delete();
  }
}
