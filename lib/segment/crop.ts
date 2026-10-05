import sharp from "sharp";

const READ_MAX_EDGE = 1600;

/** JPEG of one question's region (normalized [x0, y0, x1, y1]) from the full-resolution page, for the reading model. */
export async function cropForReading(page: Buffer, box: [number, number, number, number]): Promise<Buffer> {
  const { width = 1, height = 1 } = await sharp(page).metadata();
  const left = Math.max(0, Math.floor(box[0] * width));
  const top = Math.max(0, Math.floor(box[1] * height));
  const right = Math.min(width, Math.ceil(box[2] * width));
  const bottom = Math.min(height, Math.ceil(box[3] * height));
  return sharp(page)
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .resize({ width: READ_MAX_EDGE, height: READ_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}
