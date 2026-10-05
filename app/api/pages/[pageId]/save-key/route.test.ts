import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown as ReturnType<typeof makeDb> } }));
vi.mock("@/lib/supabase/server", () => ({ serverSupabase: async () => dbRef.current }));

import { POST } from "./route";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SECTION = "33333333-3333-4333-8333-333333333333";
const CHAPTER = "44444444-4444-4444-8444-444444444444";

function query(result: unknown) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return q;
}

function makeDb(opts: { page?: Record<string, unknown>; rpcError?: { message: string; code?: string }; image: Buffer }) {
  const uploads: { path: string; body: Buffer }[] = [];
  const removed: string[][] = [];
  const rpc = vi.fn().mockResolvedValue({ data: [], error: opts.rpcError ?? null });
  const page = opts.page ?? { id: PAGE_ID, kind: "answer_key", status: "needs_review", chapter_id: CHAPTER, original_path: "u/k.jpg", processed_path: "u/k.clean.jpg" };
  const downloads: string[] = [];
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
    from: (table: string) => (table === "pages" ? query({ data: page, error: null }) : query({ data: [{ id: SECTION }], error: null })),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          downloads.push(`${bucket}/${path}`);
          return { data: new Blob([new Uint8Array(opts.image)]), error: null };
        },
        upload: async (path: string, body: Buffer) => {
          uploads.push({ path, body });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
      }),
    },
    rpc,
    _uploads: uploads,
    _removed: removed,
    _downloads: downloads,
  };
}

const request = (body: unknown) => new Request("http://localhost/api/pages/x/save-key", { method: "POST", body: JSON.stringify(body) });
const ctx = () => ({ params: Promise.resolve({ pageId: PAGE_ID }) });
const id = () => crypto.randomUUID();

let image: Buffer;
beforeEach(async () => {
  image = await sharp({ create: { width: 400, height: 600, channels: 3, background: "white" } }).jpeg().toBuffer();
});

describe("POST /api/pages/[pageId]/save-key", () => {
  it("parses short answers on the server, crops and stitches worked solutions, and calls the RPC", async () => {
    const db = makeDb({ image });
    dbRef.current = db;
    const worked = id();
    const res = await POST(
      request({
        entries: [
          { id: id(), kind: "short", number: "31", sectionId: SECTION, raw: "(a; c)", bbox: [0.1, 0.5, 0.9, 0.7] },
          { id: id(), kind: "short", number: "2", sectionId: SECTION, raw: "4.4-4.6" },
          { id: id(), kind: "short", number: "5", sectionId: SECTION, raw: "Bonus" },
          {
            id: worked,
            kind: "worked",
            number: "3",
            sectionId: SECTION,
            raw: "int Myx …",
            boxes: [
              { x0: 0.05, y0: 0.1, x1: 0.5, y1: 0.4 },
              { x0: 0.5, y0: 0.05, x1: 0.95, y1: 0.2 },
            ],
          },
        ],
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: 4, chapterId: CHAPTER });

    // Cropped from the flattened copy, two parts stitched into one upload.
    expect(db._downloads).toEqual(["pages/u/k.clean.jpg"]);
    expect(db._uploads).toHaveLength(1);
    expect(db._uploads[0].path).toBe(`${USER_ID}/keys/${PAGE_ID}/${worked}.jpg`);
    const stitched = await sharp(db._uploads[0].body).metadata();
    expect(stitched.height).toBeGreaterThan(0.3 * 600); // both parts, stacked

    const [fn, args] = db.rpc.mock.calls[0];
    expect(fn).toBe("save_answer_key_page");
    const p = args.p_entries;
    expect(p[0]).toMatchObject({ kind: "short", correct_options: ["a", "c"], numeric_min: null, parse_flags: [], bbox: [0.1, 0.5, 0.9, 0.7] });
    expect(p[1]).toMatchObject({ numeric_min: 4.4, numeric_max: 4.6, correct_options: null });
    expect(p[2]).toMatchObject({ parse_flags: ["no_answer"] });
    expect(p[3]).toMatchObject({ kind: "worked", image_path: `${USER_ID}/keys/${PAGE_ID}/${worked}.jpg`, answer_text: "int Myx …", bbox: [0.05, 0.05, 0.95, 0.4] });
  });

  it("refuses entries without a section (unless ignored) before touching storage", async () => {
    const db = makeDb({ image });
    dbRef.current = db;
    const res = await POST(
      request({
        entries: [
          { id: id(), kind: "short", number: "1", sectionId: null, raw: "(a)" },
          { id: id(), kind: "short", number: "2", sectionId: null, raw: "(b)", ignored: true },
        ],
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "section_required", numbers: ["1"] });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db._uploads).toEqual([]);
  });

  it("refuses a section from another chapter", async () => {
    const db = makeDb({ image });
    dbRef.current = db;
    const res = await POST(request({ entries: [{ id: id(), kind: "short", number: "1", sectionId: id(), raw: "(a)" }] }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_section" });
  });

  it("removes uploaded crops when the RPC fails", async () => {
    const db = makeDb({ image, rpcError: { message: "boom" } });
    dbRef.current = db;
    const res = await POST(
      request({ entries: [{ id: id(), kind: "worked", number: "3", sectionId: SECTION, raw: "x", boxes: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3 }] }] }),
      ctx(),
    );
    expect(res.status).toBe(500);
    expect(db._removed).toEqual([[db._uploads[0].path]]);
  });

  it("answers 409 for a page that's already saved, whether seen up front or by the RPC (double tap)", async () => {
    let db = makeDb({ image, page: { id: PAGE_ID, kind: "answer_key", status: "saved", chapter_id: CHAPTER, original_path: "u/k.jpg", processed_path: null } });
    dbRef.current = db;
    expect((await POST(request({ entries: [{ id: id(), kind: "short", number: "1", sectionId: SECTION, raw: "(a)" }] }), ctx())).status).toBe(409);

    db = makeDb({ image, rpcError: { message: "page_already_saved" } });
    dbRef.current = db;
    const res = await POST(
      request({ entries: [{ id: id(), kind: "worked", number: "3", sectionId: SECTION, raw: "x", boxes: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3 }] }] }),
      ctx(),
    );
    expect(res.status).toBe(409);
    expect(db._removed).toHaveLength(1); // the losing attempt's crop is cleaned up
  });

  it("does not crop ignored worked solutions", async () => {
    const db = makeDb({ image });
    dbRef.current = db;
    await POST(
      request({ entries: [{ id: id(), kind: "worked", number: "3", sectionId: null, raw: "x", ignored: true, boxes: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3 }] }] }),
      ctx(),
    );
    expect(db._uploads).toEqual([]);
    expect(db.rpc.mock.calls[0][1].p_entries[0]).toMatchObject({ image_path: null, ignored: true });
  });

  it("refuses a question page", async () => {
    const db = makeDb({ image, page: { id: PAGE_ID, kind: "questions", status: "needs_review", chapter_id: CHAPTER, original_path: "u/k.jpg", processed_path: null } });
    dbRef.current = db;
    expect((await POST(request({ entries: [{ id: id(), kind: "short", number: "1", sectionId: SECTION, raw: "(a)" }] }), ctx())).status).toBe(400);
  });
});
