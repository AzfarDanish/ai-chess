/**
 * OpenRouter vision integration helpers (server-only usage).
 *
 * The camera frame is sent to a DeepSeek vision model which returns the
 * board's piece placement as a FEN field. This module holds the prompt and
 * the tolerant parsing of the model's response; the API route handles HTTP.
 */
import { parsePlacement, serializePlacement } from "./chess";

export const DEFAULT_VISION_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const VISION_SYSTEM_PROMPT = [
  "You are a chess board digitizer. The image comes from a phone camera pointed at a physical chess board.",
  "Return the board's piece placement as the first field of a FEN string.",
  "Rules:",
  "- Ranks are written from rank 8 (top, black's home rank in the standard orientation) to rank 1 (bottom), separated by '/'.",
  "- Uppercase letters are White pieces (KQRBNP), lowercase are Black pieces (kqrbnp).",
  "- Digits 1-8 are runs of empty squares.",
  "- Use the STANDARD chess orientation: White pieces belong on ranks 1-2, Black on ranks 7-8, regardless of the camera angle.",
  "- The image may be rotated 90° or 180°. Normalize it to the standard orientation described above.",
  "- Each rank must sum to exactly 8 squares.",
  "- Do not include castling rights, side to move, or any other FEN fields.",
  'If the image is not a chess board, the board is not fully visible, a hand or object hides pieces, or the orientation is unclear, return {"fen": null, "note": "<short reason>"}.',
  'Otherwise return {"fen": "<placement>", "note": "<one short sentence about the position>"}.',
  "Give your best reading of every square. If you are unsure about a piece, give your best guess and say so in the note.",
  "Always include the note field, even when fen is null.",
  "Respond with ONLY the JSON object, no markdown fences.",
].join("\n");

export interface VisionReading {
  /** Normalized FEN placement field, or null when no valid board was read. */
  placement: string | null;
  /** Short human-readable note from the model (reason when placement is null). */
  note: string | null;
}

/** Pulls a JSON object out of a model reply, tolerating fences and extra prose. */
export function extractJsonObject(content: string): unknown {
  if (!content) return null;
  const trimmed = content.trim();
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Normalizes an OpenRouter message content into a validated reading. */
export function readingFromContent(content: unknown): VisionReading {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }

  const parsed = extractJsonObject(text) as { fen?: unknown; note?: unknown } | null;
  const rawFen = typeof parsed?.fen === "string" ? parsed.fen.trim() : null;
  let placement: string | null = null;
  if (rawFen) {
    const board = parsePlacement(rawFen);
    if (board) placement = serializePlacement(board);
  }
  const note = typeof parsed?.note === "string" && parsed.note.trim() ? parsed.note.trim() : null;
  return { placement, note };
}
