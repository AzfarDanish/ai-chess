"use client";

import { useEffect, useRef, useState } from "react";

const STREAM = "/api/camera/stream";
const RETRY_MS = 2000;
const MAX_BUFFER = 16 * 1024 * 1024;

type Status = "connecting" | "live" | "error";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Live phone-camera preview.
 *
 * The MJPEG stream is fetched and decoded frame-by-frame onto a <canvas>.
 * This is deliberate: the browser's native multipart-in-<img> rendering is
 * unreliable (it freezes after the first frame in Safari and headless
 * Chromium), while explicit decoding animates identically everywhere.
 * /api/camera/stream proxies the phone's /video endpoint unbuffered.
 */
export default function CameraStream() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");

    const ctrl = new AbortController();
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let seenFrame = false;

    const showError = (message: string) => {
      if (!active) return;
      setStatus("error");
      setDetail(message);
    };
    const onFrame = () => {
      if (!active || seenFrame) return;
      seenFrame = true;
      setStatus("live");
      setDetail(null);
    };
    const sleep = (ms: number) => new Promise<void>((r) => (retryTimer = setTimeout(r, ms)));

    const drawPart = async (bytes: Uint8Array<ArrayBuffer>): Promise<boolean> => {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (!ctx) return false;
        if (canvasEl.width !== bitmap.width) canvasEl.width = bitmap.width;
        if (canvasEl.height !== bitmap.height) canvasEl.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
        return true;
      } catch {
        return false; // undecodable part — skip it
      } finally {
        bitmap?.close();
      }
    };

    /** Reads the multipart stream, painting every complete JPEG part as it arrives. */
    const consume = async (res: Response): Promise<void> => {
      const contentType = res.headers.get("content-type") ?? "";
      const match = /boundary=(?:"([^"]*)"|([^;]+))/i.exec(contentType);
      const value = (match?.[1] ?? match?.[2] ?? "").trim();
      // Some cameras include the leading dashes inside the boundary value.
      const boundary = value.startsWith("--") ? value : `--${value}`;
      if (!value) throw new Error("stream is not multipart");

      const delim = new TextEncoder().encode(boundary);
      const separator = new Uint8Array([13, 10, 13, 10]); // \r\n\r\n ends part headers
      const reader = res.body!.getReader();
      let buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);

      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done || ctrl.signal.aborted) return;
        buf = concat(buf, chunk);

        for (;;) {
          const start = indexOf(buf, delim);
          if (start === -1) break;
          const headEnd = indexOf(buf, separator, start);
          if (headEnd === -1) break;
          const bodyStart = headEnd + separator.length;
          const next = indexOf(buf, delim, bodyStart);
          if (next === -1) break;

          let body = buf.subarray(bodyStart, next);
          if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
            body = body.subarray(0, body.length - 2); // trailing \r\n before next boundary
          }
          if (await drawPart(body)) onFrame();
          buf = buf.subarray(next);
        }

        if (buf.length > MAX_BUFFER && indexOf(buf, delim) === -1) {
          throw new Error("stream is not multipart");
        }
      }
    };

    const run = async () => {
      while (active && !ctrl.signal.aborted) {
        try {
          setStatus("connecting");
          // cache: "no-store" + cache-buster so no stale frames can be reused.
          const res = await fetch(`${STREAM}?c=${Date.now()}`, {
            signal: ctrl.signal,
            cache: "no-store",
          });
          if (!res.ok) {
            showError((await res.text()).trim() || `Stream failed (HTTP ${res.status}).`);
          } else {
            await consume(res);
            if (active && !ctrl.signal.aborted) {
              showError("The camera stream ended. Reconnecting…");
            }
          }
        } catch {
          if (ctrl.signal.aborted || !active) return;
          showError("The camera stream is unavailable. Retrying…");
        }
        if (!active || ctrl.signal.aborted) return;
        await sleep(RETRY_MS);
      }
    };

    void run();

    return () => {
      active = false;
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  return (
    <main className="relative flex min-h-dvh w-full flex-1 items-center justify-center overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        aria-label="Phone camera preview"
        className="absolute inset-0 h-full w-full object-contain"
      />

      <div className="absolute top-4 left-4 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
        <span
          className={`h-2 w-2 rounded-full ${
            status === "live"
              ? "bg-emerald-400"
              : status === "error"
                ? "bg-red-500"
                : "animate-pulse bg-amber-400"
          }`}
        />
        {status === "live" ? "Live" : status === "error" ? "Offline — retrying" : "Connecting"}
      </div>

      {status === "error" && detail && (
        <div className="absolute inset-x-4 bottom-6 mx-auto max-w-xl rounded-xl bg-zinc-900/95 p-5 text-sm leading-6 whitespace-pre-line text-zinc-100 shadow-xl ring-1 ring-white/10">
          {detail}
        </div>
      )}
    </main>
  );
}
