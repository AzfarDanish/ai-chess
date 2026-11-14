export type MjpegFrameHandler = (frame: ImageBitmap) => void;

/** Bail out when no boundary separator shows up — the body is not MJPEG. */
const MAX_BUFFER = 16 * 1024 * 1024;

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
 * Consumes an MJPEG response, calling onFrame with every decoded JPEG part.
 * The bitmap is closed after the handler returns — draw it inside the handler.
 * Raw body pass-through decoding: frames are emitted as they arrive, never buffered.
 */
export async function consumeMjpeg(
  res: Response,
  onFrame: MjpegFrameHandler,
  signal?: AbortSignal,
): Promise<void> {
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
    if (done || signal?.aborted) return;
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
      if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8) {
        const bitmap = await createImageBitmap(new Blob([body], { type: "image/jpeg" }));
        onFrame(bitmap);
        bitmap.close();
      }
      buf = buf.subarray(next);
    }

    if (buf.length > MAX_BUFFER && indexOf(buf, delim) === -1) {
      throw new Error("stream is not multipart");
    }
  }
}
