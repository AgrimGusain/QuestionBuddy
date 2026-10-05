import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { computeProjection, fillColumnGaps, findColumnGutter, findNearestGap, findWhitespaceGap, snapBoxes } from "./snap";

describe("computeProjection", () => {
  it("sums ink per row and per column", () => {
    // 3x2 grid (width=3, height=2): row0 = [1,1,0], row1 = [0,1,1]
    const ink = new Uint8Array([1, 1, 0, 0, 1, 1]);
    expect(computeProjection(ink, 3, 2, "row")).toEqual([2, 2]);
    expect(computeProjection(ink, 3, 2, "col")).toEqual([1, 2, 1]);
  });

  it("restricts the row profile to an x range", () => {
    const ink = new Uint8Array([1, 1, 0, 0, 1, 1]);
    expect(computeProjection(ink, 3, 2, "row", [0, 2])).toEqual([2, 1]);
  });
});

describe("findWhitespaceGap", () => {
  it("returns the center of the widest near-empty run", () => {
    expect(findWhitespaceGap([5, 5, 0, 0, 0, 5, 5], 0, 7)).toBe(3);
  });

  it("returns null when nothing in the window is empty enough", () => {
    expect(findWhitespaceGap([5, 5, 5, 5], 0, 4)).toBeNull();
  });
});

describe("findColumnGutter", () => {
  it("finds a near-empty run in the middle third", () => {
    const profile = [9, 9, 9, 0, 0, 0, 9, 9, 9];
    expect(findColumnGutter(profile, 9)).toBe(4);
  });
});

// Build a white page with black rectangles ("text") via raw pixel composition.
function makePage(width: number, height: number, rects: [number, number, number, number][]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3, 255);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 3;
        buf[i] = buf[i + 1] = buf[i + 2] = 0;
      }
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("snapBoxes", () => {
  it("snaps an edge into a nearby whitespace gap", async () => {
    // Two text bands (100-200, 250-350) in a 300x600 single-column page.
    const image = await makePage(300, 600, [
      [20, 100, 280, 200],
      [20, 250, 280, 350],
    ]);
    const snapped = await snapBoxes(image, [{ bbox: [0.05, 0.17, 0.95, 0.4], column: 1 }], 1);
    const [, , , y1] = snapped[0];
    // The gap between the bands is rows 200-250 (fractions ~0.333-0.417).
    expect(y1).toBeGreaterThan(0.32);
    expect(y1).toBeLessThan(0.43);
  });

  it("keeps the model's edge when no gap is in the window", async () => {
    // One solid band from 0 to 600: no whitespace anywhere near y=300.
    const image = await makePage(300, 600, [[20, 0, 280, 600]]);
    const snapped = await snapBoxes(image, [{ bbox: [0.05, 0.1, 0.95, 0.5], column: 1 }], 1);
    const [, , , y1] = snapped[0];
    expect(y1).toBeCloseTo(0.51, 1); // original 0.5 plus ~1% padding, not snapped elsewhere
  });

  it("snaps x edges to a detected column gutter", async () => {
    // Two columns of text with a wide empty gutter between x=140 and x=160.
    const image = await makePage(300, 600, [
      [10, 50, 135, 550],
      [165, 50, 290, 550],
    ]);
    const snapped = await snapBoxes(
      image,
      [
        { bbox: [0.03, 0.1, 0.49, 0.9], column: 1 },
        { bbox: [0.51, 0.1, 0.97, 0.9], column: 2 },
      ],
      2,
    );
    expect(snapped[0][2]).toBeGreaterThan(0.46);
    expect(snapped[0][2]).toBeLessThan(0.54);
    // They land either side of the same gutter center, separated by ~2x the display padding.
    expect(Math.abs(snapped[1][0] - snapped[0][2])).toBeLessThan(0.03);
  });

  it("splits an overlap between neighbors in the same column at the gap between them", async () => {
    const image = await makePage(300, 600, [
      [20, 100, 280, 200],
      [20, 250, 280, 350],
    ]);
    const snapped = await snapBoxes(
      image,
      [
        { bbox: [0.05, 0.15, 0.95, 0.45], column: 1 }, // y1 overlaps the next box's y0
        { bbox: [0.05, 0.4, 0.95, 0.6], column: 1 },
      ],
      1,
    );
    expect(snapped[0][3]).toBeLessThanOrEqual(snapped[1][1]);
  });

  it("clamps padding at the page edge", async () => {
    const image = await makePage(300, 600, [[20, 0, 280, 100]]);
    const snapped = await snapBoxes(image, [{ bbox: [0.05, 0, 0.95, 0.16], column: 1 }], 1);
    expect(snapped[0][1]).toBe(0);
  });
});

describe("fillColumnGaps", () => {
  it("extends each box down to the next box in its column, leaving other columns alone", () => {
    const boxes: [number, number, number, number][] = [
      [0, 0.1, 0.5, 0.3],
      [0, 0.4, 0.5, 0.6],
      [0.5, 0.35, 1, 0.5],
    ];
    fillColumnGaps(boxes, [
      { bbox: [0, 0, 0, 0], column: 1 },
      { bbox: [0, 0, 0, 0], column: 1 },
      { bbox: [0, 0, 0, 0], column: 2 },
    ]);
    expect(boxes).toEqual([
      [0, 0.1, 0.5, 0.4],
      [0, 0.4, 0.5, 0.6],
      [0.5, 0.35, 1, 0.5],
    ]);
  });
});

describe("findNearestGap", () => {
  //               0  1  2  3  4  5  6  7  8  9 10 11
  const profile = [0, 0, 0, 0, 5, 5, 5, 0, 5, 5, 5, 5];

  it("keeps an edge that already sits in whitespace inside its own run", () => {
    expect(findNearestGap(profile, 7, 0, 12)).toBe(7);
  });

  it("moves an edge cutting through ink to the closer gap, not the wider one", () => {
    // Index 6 is on ink: the 1-row gap at 7 is closer than the 4-row gap at 0-3.
    expect(findNearestGap(profile, 6, 0, 12)).toBe(7);
  });

  it("returns the middle of the run it lands in", () => {
    expect(findNearestGap(profile, 4, 0, 12)).toBe(1);
  });

  it("returns null when no gap is inside the window", () => {
    expect(findNearestGap(profile, 9, 8, 12)).toBeNull();
  });
});
