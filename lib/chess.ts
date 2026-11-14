/**
 * Minimal but complete chess move logic for the coach.
 *
 * Squares are indexed 0..63 with index = rank*8 + file, so a1 = 0, h1 = 7,
 * a8 = 56, h8 = 63. White moves up the board (increasing rank).
 *
 * The coach tracks the game from the start position. The vision model reports
 * the board's piece placement, and findMatchingMoveByPlacement() accepts a move
 * only when the detected placement equals the result of exactly one legal move.
 */

export type Color = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface Piece {
  type: PieceType;
  color: Color;
}

export type Board = (Piece | null)[]; // 64 entries

export interface Position {
  board: Board;
  turn: Color;
  /** Remaining castling rights in FEN order, e.g. "KQkq" or "-". */
  castling: string;
  /** En-passant target square index, or null. */
  ep: number | null;
}

export interface Move {
  from: number;
  to: number;
  piece: PieceType;
  color: Color;
  /** Captures a piece (including en passant). */
  capture: boolean;
  ep: boolean;
  castle: "k" | "q" | null;
  promotion: PieceType | null;
}

export const KING_DIRS: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const BISHOP_DIRS: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
export const ROOK_DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const KNIGHT_DELTAS: [number, number][] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

const FILES = "abcdefgh";
const PROMOTIONS: PieceType[] = ["q", "r", "b", "n"];

export function squareName(sq: number): string {
  return FILES[sq & 7] + String(1 + (sq >> 3));
}

export function parseSquare(name: string): number {
  const file = FILES.indexOf(name[0]);
  const rank = Number(name[1]) - 1;
  if (file < 0 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

export function pieceName(type: PieceType): string {
  switch (type) {
    case "p":
      return "Pawn";
    case "n":
      return "Knight";
    case "b":
      return "Bishop";
    case "r":
      return "Rook";
    case "q":
      return "Queen";
    case "k":
      return "King";
  }
}

const START_BACK_RANK: PieceType[] = ["r", "n", "b", "q", "k", "b", "n", "r"];

function startBoard(): Board {
  const board: Board = new Array(64).fill(null);
  for (let f = 0; f < 8; f++) {
    board[f] = { type: START_BACK_RANK[f], color: "w" };
    board[8 + f] = { type: "p", color: "w" };
    board[48 + f] = { type: "p", color: "b" };
    board[56 + f] = { type: START_BACK_RANK[f], color: "b" };
  }
  return board;
}

export function startPosition(): Position {
  return { board: startBoard(), turn: "w", castling: "KQkq", ep: null };
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

/** Is `sq` attacked by any piece of color `by`? */
export function isAttacked(board: Board, sq: number, by: Color): boolean {
  const file = sq & 7;
  const rank = sq >> 3;

  // Pawns attack diagonally forward; a square is attacked by a white pawn
  // sitting one rank below it, by a black pawn one rank above it.
  const pawnRank = by === "w" ? rank - 1 : rank + 1;
  for (const df of [-1, 1]) {
    if (onBoard(file + df, pawnRank)) {
      const p = board[pawnRank * 8 + file + df];
      if (p && p.color === by && p.type === "p") return true;
    }
  }

  for (const [df, dr] of KNIGHT_DELTAS) {
    if (!onBoard(file + df, rank + dr)) continue;
    const p = board[(rank + dr) * 8 + file + df];
    if (p && p.color === by && p.type === "n") return true;
  }

  for (const [df, dr] of KING_DIRS) {
    if (!onBoard(file + df, rank + dr)) continue;
    const p = board[(rank + dr) * 8 + file + df];
    if (p && p.color === by && p.type === "k") return true;
  }

  for (const [dirs, types] of [
    [BISHOP_DIRS, "bq"],
    [ROOK_DIRS, "rq"],
  ] as const) {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const p = board[r * 8 + f];
        if (p) {
          if (p.color === by && types.includes(p.type)) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
  }
  return false;
}

export function kingSquare(board: Board, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.type === "k" && p.color === color) return i;
  }
  return -1;
}

export function inCheck(pos: Position, color: Color): boolean {
  const ks = kingSquare(pos.board, color);
  if (ks < 0) return false;
  return isAttacked(pos.board, ks, color === "w" ? "b" : "w");
}

interface PushExtra {
  ep?: boolean;
  castle?: "k" | "q";
  promotion?: PieceType;
}

/** All fully-legal moves for the side to move (castling, en passant, promotions). */
export function legalMoves(pos: Position): Move[] {
  const moves: Move[] = [];
  const { board, turn } = pos;
  const enemy: Color = turn === "w" ? "b" : "w";

  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece || piece.color !== turn) continue;
    const file = sq & 7;
    const rank = sq >> 3;

    const push = (to: number, extra: PushExtra = {}) => {
      moves.push({
        from: sq,
        to,
        piece: piece.type,
        color: turn,
        capture: board[to] !== null || extra.ep === true,
        ep: extra.ep ?? false,
        castle: extra.castle ?? null,
        promotion: extra.promotion ?? null,
      });
    };

    if (piece.type === "p") {
      const dir = turn === "w" ? 1 : -1;
      const startRank = turn === "w" ? 1 : 6;
      const lastRank = turn === "w" ? 7 : 0;
      const one = sq + dir * 8;
      if (onBoard(file, rank + dir) && board[one] === null) {
        if (rank + dir === lastRank) {
          for (const promo of PROMOTIONS) push(one, { promotion: promo });
        } else {
          push(one);
          const two = sq + dir * 16;
          if (rank === startRank && board[two] === null) push(two);
        }
      }
      for (const df of [-1, 1]) {
        if (!onBoard(file + df, rank + dir)) continue;
        const to = (rank + dir) * 8 + file + df;
        const target = board[to];
        if (target && target.color === enemy) {
          if (rank + dir === lastRank) {
            for (const promo of PROMOTIONS) push(to, { promotion: promo });
          } else {
            push(to);
          }
        } else if (target === null && pos.ep === to) {
          push(to, { ep: true });
        }
      }
    } else if (piece.type === "n" || piece.type === "k") {
      const deltas = piece.type === "n" ? KNIGHT_DELTAS : KING_DIRS;
      for (const [df, dr] of deltas) {
        if (!onBoard(file + df, rank + dr)) continue;
        const to = (rank + dr) * 8 + file + df;
        const target = board[to];
        if (!target || target.color === enemy) push(to);
      }
      if (piece.type === "k") {
        // Castling: rights present, path empty, king not castling out of,
        // through, or into check. Rights imply king/rook placement, but both
        // are verified so a corrupted position can never castle.
        const home = turn === "w" ? 4 : 60;
        const king = board[home];
        if (king && king.type === "k" && king.color === turn && sq === home) {
          const rookSq = turn === "w" ? 7 : 63;
          const rook = board[rookSq];
          if (
            pos.castling.includes(turn === "w" ? "K" : "k") &&
            rook &&
            rook.type === "r" &&
            rook.color === turn &&
            board[home + 1] === null &&
            board[home + 2] === null &&
            !isAttacked(board, home, enemy) &&
            !isAttacked(board, home + 1, enemy) &&
            !isAttacked(board, home + 2, enemy)
          ) {
            push(home + 2, { castle: "k" });
          }
          const qRookSq = turn === "w" ? 0 : 56;
          const qRook = board[qRookSq];
          if (
            pos.castling.includes(turn === "w" ? "Q" : "q") &&
            qRook &&
            qRook.type === "r" &&
            qRook.color === turn &&
            board[home - 1] === null &&
            board[home - 2] === null &&
            board[home - 3] === null &&
            !isAttacked(board, home, enemy) &&
            !isAttacked(board, home - 1, enemy) &&
            !isAttacked(board, home - 2, enemy)
          ) {
            push(home - 2, { castle: "q" });
          }
        }
      }
    } else {
      const dirs = piece.type === "b" ? BISHOP_DIRS : piece.type === "r" ? ROOK_DIRS : KING_DIRS;
      for (const [df, dr] of dirs) {
        let f = file + df;
        let r = rank + dr;
        while (onBoard(f, r)) {
          const to = r * 8 + f;
          const target = board[to];
          if (!target) {
            push(to);
          } else {
            if (target.color === enemy) push(to);
            break;
          }
          f += df;
          r += dr;
        }
      }
    }
  }

  // A move may not leave the mover's own king in check.
  return moves.filter((m) => !inCheck(makeMove(pos, m), turn));
}

/** Applies a legal move, returning the new position (input is not mutated). */
export function makeMove(pos: Position, move: Move): Position {
  const board = pos.board.slice();
  const piece = board[move.from];
  if (!piece) return { ...pos, board, ep: null };

  board[move.from] = null;
  if (move.ep) {
    const captured = move.color === "w" ? move.to - 8 : move.to + 8;
    board[captured] = null;
  }
  board[move.to] = move.promotion ? { type: move.promotion, color: move.color } : piece;

  let castling = pos.castling;
  const drop = (flag: string) => {
    castling = castling.replace(flag, "");
  };
  if (piece.type === "k") {
    if (move.color === "w") {
      drop("K");
      drop("Q");
    } else {
      drop("k");
      drop("q");
    }
    if (move.castle) {
      const [rookFrom, rookTo] =
        move.castle === "k"
          ? move.color === "w"
            ? [7, 5]
            : [63, 61]
          : move.color === "w"
            ? [0, 3]
            : [56, 59];
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    }
  }
  if (move.from === 0 || move.to === 0) drop("Q");
  if (move.from === 7 || move.to === 7) drop("K");
  if (move.from === 56 || move.to === 56) drop("q");
  if (move.from === 63 || move.to === 63) drop("k");

  let ep: number | null = null;
  if (piece.type === "p" && Math.abs((move.to >> 3) - (move.from >> 3)) === 2) {
    ep = move.color === "w" ? move.from + 8 : move.from - 8;
  }

  return {
    board,
    turn: pos.turn === "w" ? "b" : "w",
    castling: castling === "" ? "-" : castling,
    ep,
  };
}

/** FEN piece-placement field for a board, e.g. "rnbqkbnr/pppppppp/8/8/...". */
export function serializePlacement(board: Board): string {
  let out = "";
  for (let rank = 7; rank >= 0; rank--) {
    let run = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      if (!piece) {
        run++;
        continue;
      }
      if (run > 0) {
        out += run;
        run = 0;
      }
      out += piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }
    if (run > 0) out += run;
    if (rank > 0) out += "/";
  }
  return out;
}

export function placementOf(pos: Position): string {
  return serializePlacement(pos.board);
}

/** Parses a FEN piece-placement field into a board, or null if malformed. */
export function parsePlacement(text: string): Board | null {
  const field = text.trim().split(/\s+/)[0];
  if (!field) return null;
  const ranks = field.split("/");
  if (ranks.length !== 8) return null;
  const board: Board = new Array(64).fill(null);
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase();
      if (!"pnbrqk".includes(lower) || file > 7) return null;
      board[(7 - r) * 8 + file] = { type: lower as PieceType, color: ch === lower ? "b" : "w" };
      file++;
    }
    if (file !== 8) return null;
  }
  return board;
}

/**
 * Match an AI-detected board placement against the legal moves of `pos`.
 * Returns the unique legal move whose resulting placement equals the
 * detection, or null when nothing matches or the match is ambiguous.
 */
export function findMatchingMoveByPlacement(pos: Position, placement: string): Move | null {
  const target = placement.trim().split(/\s+/)[0];
  if (!target) return null;
  const matches = legalMoves(pos).filter((move) => serializePlacement(makeMove(pos, move).board) === target);
  return matches.length === 1 ? matches[0] : null;
}

/** Reconstructs a move from a UCI string for an arbitrary position. */
export function moveFromUci(pos: Position, uci: string): Move | null {
  for (const move of legalMoves(pos)) {
    if (uciOf(move) === uci) return move;
  }
  return null;
}

export function uciOf(move: Move): string {
  return squareName(move.from) + squareName(move.to) + (move.promotion ?? "");
}

/** The coach's exact output format, e.g. "Knight g1 to f3". */
export function describeMove(move: Move): string {
  return `${pieceName(move.piece)} ${squareName(move.from)} to ${squareName(move.to)}`;
}
