import { stitchVertical } from "./image";

export interface ShareImages {
  jpeg: File;  // for Web Share and download
  png: Blob;   // for the clipboard (browsers only accept PNG there)
}

/**
 * Build the share payload ahead of time. Browsers require navigator.share()
 * to run right after the tap, so the image fetching and stitching must
 * already be done when the button is pressed.
 */
export async function prepareShareImages(urls: string[], name: string): Promise<ShareImages> {
  const blobs = await Promise.all(
    urls.map(async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`image_fetch_failed_${res.status}`);
      return res.blob();
    }),
  );
  const [jpeg, png] = await Promise.all([stitchVertical(blobs, "image/jpeg"), stitchVertical(blobs, "image/png")]);
  return { jpeg: new File([jpeg], `${name}.jpg`, { type: "image/jpeg" }), png };
}

export type ShareOutcome = "shared" | "copied" | "downloaded" | "cancelled";

/** Web Share with the file → copy image to clipboard → download. */
export async function shareImage(images: ShareImages, title: string): Promise<ShareOutcome> {
  const payload = { files: [images.jpeg], title };
  if (typeof navigator.share === "function" && navigator.canShare?.(payload)) {
    try {
      await navigator.share(payload);
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
      // Otherwise fall through to the clipboard.
    }
  }
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": images.png })]);
      return "copied";
    } catch {
      // Fall through to download.
    }
  }
  const url = URL.createObjectURL(images.jpeg);
  const a = document.createElement("a");
  a.href = url;
  a.download = images.jpeg.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
