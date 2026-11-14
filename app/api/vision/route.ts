import {
  DEFAULT_OPENROUTER_BASE,
  DEFAULT_VISION_MODEL,
  readingFromContent,
  VISION_SYSTEM_PROMPT,
} from "@/lib/vision-api";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reads a chess board out of a camera frame with a DeepSeek vision model.
 *
 * The browser POSTs a JPEG (raw bytes); the OpenRouter API key stays on the
 * server. Responds with { placement, note } where placement is a validated
 * FEN piece-placement field (or null when the board could not be read).
 */
export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      {
        error:
          "OPENROUTER_API_KEY is not set. Add it to .env.local and restart the dev server.",
      },
      { status: 500 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("image/jpeg")) {
    return Response.json({ error: "expected an image/jpeg body" }, { status: 415 });
  }

  const image = Buffer.from(await request.arrayBuffer());
  if (image.length === 0) {
    return Response.json({ error: "empty image" }, { status: 400 });
  }
  if (image.length > MAX_IMAGE_BYTES) {
    return Response.json({ error: "image too large" }, { status: 413 });
  }

  const base = (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE).replace(/\/+$/, "");
  const model = process.env.OPENROUTER_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "AI Chess Coach",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        // V4.1 Flash is a reasoning model. Left enabled, it can spend the
        // whole token budget on hidden reasoning and return no content at all
        // (finish_reason "length"), which looked like "no board detected".
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Digitize this chess position." },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` },
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      { error: timedOut ? "OpenRouter request timed out" : "Could not reach OpenRouter" },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 300).trim();
    return Response.json(
      { error: `OpenRouter error ${upstream.status}${detail ? `: ${detail}` : ""}` },
      { status: 502 },
    );
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    return Response.json({ error: "OpenRouter returned invalid JSON" }, { status: 502 });
  }

  const choice = (
    data as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    }
  )?.choices?.[0];
  const content = choice?.message?.content;
  const empty =
    content == null ||
    (typeof content === "string" && content.trim() === "") ||
    (Array.isArray(content) && content.length === 0);
  if (empty) {
    const reason =
      choice?.finish_reason === "length"
        ? "vision model hit the token limit before answering"
        : "vision model returned no output";
    return Response.json({ error: reason }, { status: 502 });
  }

  const reading = readingFromContent(content);
  if (!reading.placement && !reading.note) {
    return Response.json(
      { error: "vision model returned no usable board reading" },
      { status: 502 },
    );
  }
  return Response.json(reading, { headers: { "Cache-Control": "no-store" } });
}
