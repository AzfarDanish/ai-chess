import {
  cameraBase,
  cameraErrorResponse,
  cameraStreamUrl,
  fetchFromCamera,
  notConfiguredMessage,
  unreachableMessage,
} from "@/lib/camera";

/**
 * Streams the phone's MJPEG feed to the browser, same-origin.
 * IP Webcam serves the feed at /video as multipart/x-mixed-replace.
 *
 * Node runtime (the default — a `runtime` segment config is not allowed with
 * cacheComponents), no-store, raw body pass-through — never buffered
 * (no .text()/.arrayBuffer()); the browser client draws frames as they arrive.
 */
export async function GET(request: Request) {
  const base = cameraBase();
  if (!base) return cameraErrorResponse(notConfiguredMessage(), 500);

  const target = cameraStreamUrl(base);

  let upstream: Response;
  try {
    upstream = await fetchFromCamera(target, request.signal);
  } catch {
    return cameraErrorResponse(unreachableMessage(target));
  }

  if (!upstream.ok || !upstream.body) {
    return cameraErrorResponse(
      `The phone camera at ${target} responded with HTTP ${upstream.status}.`,
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ??
        "multipart/x-mixed-replace; boundary=BoundaryString",
      "Cache-Control": "no-store, no-transform",
    },
  });
}
