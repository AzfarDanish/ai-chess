import {
  cameraBase,
  cameraErrorResponse,
  cameraSnapshotUrl,
  fetchFromCamera,
  notConfiguredMessage,
  unreachableMessage,
} from "@/lib/camera";

/**
 * Single frame from the phone (IP Webcam serves one at /shot.jpg).
 * Handy for checking the PHONE_CAMERA_URL works without opening the stream.
 */
export async function GET(request: Request) {
  const base = cameraBase();
  if (!base) return cameraErrorResponse(notConfiguredMessage(), 500);

  const target = cameraSnapshotUrl(base);

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
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "no-store",
    },
  });
}
