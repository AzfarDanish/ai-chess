"use client";

import { useEffect, useRef, useState } from "react";
import { consumeMjpeg } from "@/lib/mjpeg";
import {
  describeMove,
  findMatchingMoveByPlacement,
  legalMoves,
  makeMove,
  moveFromUci,
  placementOf,
  startPosition,
  uciOf,
  type Move,
  type Position,
} from "@/lib/chess";
import { Engine } from "./stockfish";

const STREAM = "/api/camera/stream";
const VISION_ENDPOINT = "/api/vision";
const RETRY_MS = 1500;
/** Frame-capture cadence for the vision model (one request in flight at a time). */
const VISION_INTERVAL_MS = 1500;
const CAPTURE_MAX_WIDTH = 768;
const LOG_LIMIT = 500;

type Phase = "setup" | "running";
type Rotation = 0 | 90 | 180 | 270;

interface VisionPayload {
  placement?: string | null;
  note?: string | null;
  error?: string;
}

/**
 * Automatic chess coach backed by an AI vision model.
 *
 * Pipeline: camera frame → /api/vision (DeepSeek via OpenRouter, server-side
 * key) → FEN placement → matched against exactly one legal move from the
 * tracked game → Stockfish best reply.
 *
 * Bottom log is two console-style columns: LEFT = best move for the player,
 * RIGHT = what the vision model sees (detected board states and moves).
 */
export default function Coach() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bestLogRef = useRef<HTMLDivElement | null>(null);
  const visionLogRef = useRef<HTMLDivElement | null>(null);

  const [phase, setPhase] = useState<Phase>("setup");
  const [myColor, setMyColor] = useState<"w" | "b">("w");
  const [rotation, setRotation] = useState<Rotation>(0);
  const [bestLines, setBestLines] = useState<string[]>([]);
  const [visionLines, setVisionLines] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);

  // Game + loop state lives in refs so the analysis loop never goes stale.
  const posRef = useRef<Position>(startPosition());
  const movesRef = useRef<string[]>([]);
  const genRef = useRef(0);
  const myColorRef = useRef(myColor);
  const engineRef = useRef<Engine | null>(null);
  const lastPlacementRef = useRef<string | null>(null);
  const lastNoteRef = useRef<string | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const pendingMoveRef = useRef<string | null>(null);
  const nullStreakRef = useRef(0);
  const rotationRef = useRef<Rotation>(0);
  const repaintRef = useRef<(() => void) | null>(null);
  const hasFrameRef = useRef(false);

  useEffect(() => {
    myColorRef.current = myColor;
  }, [myColor]);

  useEffect(() => {
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  // ── Live stream: fetch → decode → rotate → paint; auto-reconnect ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rawCanvas = document.createElement("canvas");
    const rawCtx = rawCanvas.getContext("2d");
    const ctrl = new AbortController();
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let seenFrame = false;
    let autoRotated = false;

    const paint = () => {
      if (!active || !ctx || rawCanvas.width === 0 || rawCanvas.height === 0) return;
      const angle = rotationRef.current;
      const width = angle === 90 || angle === 270 ? rawCanvas.height : rawCanvas.width;
      const height = angle === 90 || angle === 270 ? rawCanvas.width : rawCanvas.height;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.drawImage(rawCanvas, -rawCanvas.width / 2, -rawCanvas.height / 2);
      ctx.restore();
    };
    repaintRef.current = paint;

    const drawFrame = (bitmap: ImageBitmap) => {
      if (rawCanvas.width !== bitmap.width) rawCanvas.width = bitmap.width;
      if (rawCanvas.height !== bitmap.height) rawCanvas.height = bitmap.height;
      rawCtx?.drawImage(bitmap, 0, 0);

      // Phone streams usually arrive landscape even when the phone is mounted
      // upright. Show (and analyse) a portrait feed by default.
      if (!autoRotated) {
        autoRotated = true;
        if (bitmap.width > bitmap.height && rotationRef.current === 0) {
          rotationRef.current = 90;
          setRotation(90);
        }
      }

      paint();
      hasFrameRef.current = true;
      if (!seenFrame) {
        seenFrame = true;
        setOffline(false);
      }
    };

    const run = async () => {
      while (active && !ctrl.signal.aborted) {
        try {
          const res = await fetch(`${STREAM}?c=${Date.now()}`, { signal: ctrl.signal, cache: "no-store" });
          if (!res.ok) {
            setOffline(true);
          } else {
            await consumeMjpeg(res, drawFrame, ctrl.signal);
            if (active && !ctrl.signal.aborted) setOffline(true);
          }
        } catch {
          if (!active || ctrl.signal.aborted) return;
          setOffline(true);
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
      repaintRef.current = null;
    };
  }, []);

  // Repaint the current frame when the user rotates the camera view.
  useEffect(() => {
    rotationRef.current = rotation;
    repaintRef.current?.();
  }, [rotation]);

  // ── Vision → move tracking → Stockfish loop ──
  useEffect(() => {
    if (phase !== "running") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const offscreen = document.createElement("canvas");

    const pushBest = (text: string) => {
      setBestLines((prev) => [...prev.slice(-(LOG_LIMIT - 1)), text]);
    };
    const pushVision = (text: string) => {
      setVisionLines((prev) => [...prev.slice(-(LOG_LIMIT - 1)), text]);
    };
    const getEngine = (): Engine => {
      if (!engineRef.current) engineRef.current = new Engine();
      return engineRef.current;
    };

    const acceptMove = (move: Move, uci: string) => {
      posRef.current = makeMove(posRef.current, move);
      movesRef.current.push(uci);
      const gen = ++genRef.current;
      pushVision(`Move: ${describeMove(move)}`);

      if (move.color === myColorRef.current) return; // my move — wait for the opponent
      if (legalMoves(posRef.current).length === 0) return; // game over — nothing to suggest
      const snapshot = [...movesRef.current];
      void getEngine()
        .bestMove(snapshot)
        .then((best) => {
          if (gen !== genRef.current || !best) return; // superseded or game over
          const reply = moveFromUci(posRef.current, best);
          if (reply) pushBest(describeMove(reply));
        })
        .catch((error) => console.warn("coach: engine error", error));
    };

    const handleReading = (payload: VisionPayload | null, ok: boolean) => {
      if (cancelled) return;
      if (!ok || !payload) {
        const message = payload?.error ?? "vision request failed";
        if (message !== lastErrorRef.current) {
          lastErrorRef.current = message;
          pushVision(`Vision error: ${message}`);
        }
        return;
      }
      lastErrorRef.current = null;

      const placement = typeof payload.placement === "string" ? payload.placement : null;
      if (!placement) {
        // Require two consecutive unreadable frames before logging: a single
        // miss is usually a hand passing over the board or a transient blur.
        nullStreakRef.current += 1;
        const note = payload.note?.trim() || "no board detected";
        if (nullStreakRef.current >= 2 && note !== lastNoteRef.current) {
          lastNoteRef.current = note;
          pushVision(`Vision: ${note}`);
        }
        pendingMoveRef.current = null;
        return;
      }
      nullStreakRef.current = 0;
      lastNoteRef.current = null;

      if (placement !== lastPlacementRef.current) {
        lastPlacementRef.current = placement;
        pushVision(`Board: ${placement}`);
      }

      // A move needs two consecutive matching readings before it is accepted.
      if (placement === placementOf(posRef.current)) {
        pendingMoveRef.current = null;
        return;
      }
      const move = findMatchingMoveByPlacement(posRef.current, placement);
      if (!move) {
        pendingMoveRef.current = null;
        return;
      }
      const uci = uciOf(move);
      if (pendingMoveRef.current !== uci) {
        pendingMoveRef.current = uci;
        return;
      }
      pendingMoveRef.current = null;
      acceptMove(move, uci);
    };

    const capture = (canvas: HTMLCanvasElement): Promise<Blob | null> => {
      if (canvas.width === 0 || canvas.height === 0) return Promise.resolve(null);
      const scale = Math.min(1, CAPTURE_MAX_WIDTH / canvas.width);
      const width = Math.max(1, Math.round(canvas.width * scale));
      const height = Math.max(1, Math.round(canvas.height * scale));
      if (offscreen.width !== width) offscreen.width = width;
      if (offscreen.height !== height) offscreen.height = height;
      const ctx = offscreen.getContext("2d");
      if (!ctx) return Promise.resolve(null);
      ctx.drawImage(canvas, 0, 0, width, height);
      return new Promise<Blob | null>((resolve) =>
        offscreen.toBlob((blob) => resolve(blob), "image/jpeg", 0.85),
      );
    };

    const loop = async () => {
      while (!cancelled) {
        const startedAt = Date.now();
        const canvas = canvasRef.current;
        if (canvas && hasFrameRef.current && canvas.width > 0) {
          try {
            const blob = await capture(canvas);
            if (blob) {
              const res = await fetch(VISION_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "image/jpeg" },
                body: blob,
                cache: "no-store",
                signal: ctrl.signal,
              });
              const payload = (await res.json().catch(() => null)) as VisionPayload | null;
              handleReading(payload, res.ok);
            }
          } catch {
            if (ctrl.signal.aborted || cancelled) return;
            handleReading(null, false);
          }
        }
        if (cancelled) return;
        // Keep the cadence tight: the wait accounts for the request time.
        const wait = Math.max(0, VISION_INTERVAL_MS - (Date.now() - startedAt));
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait);
        });
      }
    };
    void loop();
    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [phase]);

  useEffect(() => {
    const el = bestLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bestLines]);

  useEffect(() => {
    const el = visionLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visionLines]);

  const handleStart = () => {
    setPhase("running");
  };

  const handleRotate = () => {
    const next = ((rotationRef.current + 90) % 360) as Rotation;
    rotationRef.current = next;
    setRotation(next);
    repaintRef.current?.();
  };

  const handleNewGame = () => {
    posRef.current = startPosition();
    movesRef.current = [];
    genRef.current++;
    lastPlacementRef.current = null;
    lastNoteRef.current = null;
    lastErrorRef.current = null;
    pendingMoveRef.current = null;
    nullStreakRef.current = 0;
    setBestLines([]);
    setVisionLines([]);
  };

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-black">
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          aria-label="Chess board camera"
          className="absolute inset-0 h-full w-full object-contain"
        />
        {offline && (
          <p className="absolute inset-x-0 bottom-3 text-center text-xs font-medium text-zinc-400">
            Offline — retrying…
          </p>
        )}
        <button
          type="button"
          onClick={handleRotate}
          aria-label="Rotate camera 90 degrees"
          title="Rotate camera 90°"
          className="absolute top-3 right-3 rounded-md bg-black/60 px-2.5 py-1.5 text-xs font-medium text-white ring-1 ring-white/20 backdrop-blur-sm hover:bg-black/80"
        >
          Rotate
        </button>
      </div>

      {phase === "setup" ? (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-zinc-950 px-3 py-3">
          <div className="flex overflow-hidden rounded-lg ring-1 ring-white/15">
            {(["w", "b"] as const).map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setMyColor(color)}
                className={`px-3 py-1.5 text-xs font-medium ${myColor === color ? "bg-sky-500 text-white" : "bg-zinc-900 text-zinc-300"}`}
              >
                You play {color === "w" ? "White" : "Black"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleStart}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Start coaching
          </button>
        </div>
      ) : (
        <section className="flex h-[42dvh] min-h-0 flex-col border-t border-white/10 bg-zinc-950">
          <div className="flex items-center justify-end gap-2 border-b border-white/5 px-3 py-1.5">
            <button
              type="button"
              onClick={handleNewGame}
              className="rounded-md px-2 py-1 text-xs text-zinc-300 ring-1 ring-white/10 hover:bg-white/5"
            >
              New game
            </button>
            <button
              type="button"
              onClick={() => setPhase("setup")}
              className="rounded-md px-2 py-1 text-xs text-zinc-300 ring-1 ring-white/10 hover:bg-white/5"
            >
              Stop
            </button>
          </div>
          <div className="flex min-h-0 flex-1 divide-x divide-white/10">
            <div className="flex min-w-0 flex-[2] flex-col">
              <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                Best move
              </p>
              <div
                ref={bestLogRef}
                data-testid="best-log"
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto font-mono text-sm leading-6 text-emerald-300"
              >
                {bestLines.map((line, index) => (
                  <div key={index} className="whitespace-pre-wrap break-words px-3">
                    {line}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex min-w-0 flex-[3] flex-col">
              <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                Vision
              </p>
              <div
                ref={visionLogRef}
                data-testid="vision-log"
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto font-mono text-sm leading-6 text-sky-200"
              >
                {visionLines.map((line, index) => (
                  <div key={index} className="whitespace-pre-wrap break-words px-3">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
