/** Load any photo the browser can decode, honouring EXIF rotation. */
async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    // Older Safari: fall back to an <img>, which also applies EXIF rotation.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } catch {
      throw new Error("unsupported_image");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode_failed"))), type, quality),
  );
}

/**
 * Prepare a camera/gallery photo for storage: upright, JPEG, long edge at
 * most `maxEdge`. This also turns iPhone HEIC into JPEG, which sharp can't read.
 */
export async function prepareJpeg(file: Blob, maxEdge = 3000, quality = 0.9): Promise<Blob> {
  const img = await decode(file);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
  img.close();
  return canvasToBlob(canvas, "image/jpeg", quality);
}

/** Stack several image parts vertically on white into one image. */
export async function stitchVertical(blobs: Blob[], type: "image/jpeg" | "image/png"): Promise<Blob> {
  const imgs = await Promise.all(blobs.map(decode));
  const width = Math.max(...imgs.map((i) => i.width));
  const gap = imgs.length > 1 ? 12 : 0;
  const height = imgs.reduce((h, i) => h + i.height, 0) + gap * (imgs.length - 1);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const i of imgs) {
    ctx.drawImage(i.source, 0, y);
    y += i.height + gap;
    i.close();
  }
  return canvasToBlob(canvas, type, 0.92);
}
