/**
 * Connection details for the phone camera. The address lives in
 * PHONE_CAMERA_URL (see .env.example) — never hardcode it here.
 *
 * Accepts the address shown by the IP Webcam app ("http://192.168.1.50:8080")
 * or a full stream/snapshot URL ending in /video or /shot.jpg.
 */
export function cameraBase(): string | null {
  const raw = process.env.PHONE_CAMERA_URL?.trim();
  if (!raw) return null;

  const base = raw.replace(/\/+$/, "").replace(/\/(video|shot\.jpg)$/i, "");
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return base;
  } catch {
    return null;
  }
}

export function cameraStreamUrl(base: string): string {
  return `${base}/video`;
}

export function cameraSnapshotUrl(base: string): string {
  return `${base}/shot.jpg`;
}

/** Plain-text error response the preview page displays when the phone is unreachable. */
export function cameraErrorResponse(message: string, status = 502): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function notConfiguredMessage(): string {
  return [
    "PHONE_CAMERA_URL is not set.",
    "",
    "Add it to .env.local, e.g.",
    "  PHONE_CAMERA_URL=http://192.168.1.50:8080",
    "then restart the dev server.",
  ].join("\n");
}

export function unreachableMessage(target: string): string {
  return [
    `Could not connect to the phone at ${target}.`,
    "",
    "Check that:",
    "• the IP Webcam app is running on the phone (its feed is visible)",
    "• the phone and laptop are on the same Wi-Fi network",
    "• PHONE_CAMERA_URL in .env.local matches the address shown in the app",
    "",
    "Restart the dev server after changing .env.local.",
  ].join("\n");
}

/**
 * Fetch from the phone with a connect timeout that does NOT limit the streamed
 * body, and abort the upstream request when the browser client disconnects.
 */
export async function fetchFromCamera(
  url: string,
  clientSignal: AbortSignal,
  connectTimeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  if (clientSignal.aborted) {
    controller.abort();
  } else {
    clientSignal.addEventListener("abort", () => controller.abort());
  }
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    // Once the response headers have arrived, stop the connect timeout so the
    // long-lived MJPEG stream is not cut off; client disconnects still abort
    // via the listener above.
    clearTimeout(timer);
  }
}
