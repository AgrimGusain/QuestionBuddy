"use client";

import { Copy, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText, prepareShareImages, shareImage, type ShareImages } from "@/lib/share";

const MESSAGES = {
  shared: "Shared.",
  copied: "Image copied. Paste it into any chat.",
  downloaded: "Image downloaded.",
  cancelled: "",
};

/** "Share image" and "Copy text" for a question. */
export function ShareButtons({
  urls,
  number,
  text,
}: {
  urls: string[]; // signed URLs of the parts, in order
  number: string;
  text: string;
}) {
  const [images, setImages] = useState<ShareImages | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const key = urls.join("|");

  // Prepare before the tap: share() must run right after the user's gesture.
  useEffect(() => {
    if (!key) return;
    let live = true;
    setImages(null);
    setFailed(false);
    prepareShareImages(key.split("|"), `question-${number}`)
      .then((i) => live && setImages(i))
      .catch((e) => {
        console.error("share_prepare_failed", e);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [key, number]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={!images}
          onClick={async () => {
            if (!images) return;
            setNote(MESSAGES[await shareImage(images, `Question ${number}`)]);
          }}
        >
          <Share2 size={18} aria-hidden />
          {failed ? "Image unavailable" : images ? "Share image" : "Preparing…"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            if (!text.trim()) {
              setNote("No question text saved yet. Type it in below to enable copying.");
              return;
            }
            setNote((await copyText(text)) ? "Text copied." : "Couldn't access the clipboard.");
          }}
        >
          <Copy size={18} aria-hidden />
          Copy text
        </button>
      </div>
      {note && (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      )}
    </div>
  );
}
