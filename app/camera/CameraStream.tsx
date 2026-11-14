"use client";

import { useEffect, useRef, useState } from "react";
import { consumeMjpeg } from "@/lib/mjpeg";

const STREAM = "/api/camera/stream";
const RETRY_MS = 2000;

type Status = "connecting" | "live" | "error";

/**
 * Live phone-camera preview.
 *
 * The MJPEG stream is fetched and decoded frame-by-frame onto a <canvas>
 * (shared lib/mjpeg consumer). This is deliberate: the browser's native
 * multipart-in-<img> rendering is unreliable (it freezes after the first
 * frame in Safari and headless Chromium), while explicit decoding animates
 * identically everywhere. /api/camera/stream proxies the phone's /video
 * endpoint unbuffered.
 */
export default function CameraStream() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const ctrl = new AbortController();
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let seenFrame = false;

    const showError = (message: string) => {
      if (!active) return;
      setStatus("error");
      setDetail(message);
    };
    const drawFrame = (bitmap: ImageBitmap) => {
      if (!active) return;
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      ctx?.drawImage(bitmap, 0, 0);
      if (!seenFrame) {
        seenFrame = true;
        setStatus("live");
        setDetail(null);
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
            await consumeMjpeg(res, drawFrame, ctrl.signal);
            if (active && !ctrl.signal.aborted) {
              showError("The camera stream ended. Reconnecting…");
            }
          }
        } catch {
          if (ctrl.signal.aborted || !active) return;
          showError("The camera stream is unavailable. Retrying…");
        }
        if (!active || ctrl.signal.aborted) return;
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(resolve, RETRY_MS);
        });
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
