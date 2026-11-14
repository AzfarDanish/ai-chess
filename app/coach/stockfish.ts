/**
 * Stockfish 19 (lite, single-threaded WASM) wrapped in a Web Worker.
 *
 * The build lives in /stockfish/ and needs no SharedArrayBuffer or special
 * headers. Queries are serialized so overlapping `go` commands can never
 * interleave, and every query carries the full move list — the engine is
 * stateless between queries.
 */

const WORKER_URL = "/stockfish/stockfish-19-lite-single.js";

interface Pending {
  resolve: (uci: string | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Engine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private destroyed = false;

  private ensureWorker(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER_URL);
      this.worker = worker;
      const fail = (message: string) => {
        const pending = this.pending;
        this.pending = null;
        pending?.reject(new Error(message));
        reject(new Error(message));
      };
      worker.onerror = (event) => fail(event.message || "Stockfish worker failed to load");
      worker.onmessage = (event) => {
        const data = event.data;
        const line = typeof data === "string" ? data : String(data?.data ?? "");
        if (line.startsWith("uciok")) {
          worker.postMessage("setoption name MultiPV value 1");
          worker.postMessage("isready");
        } else if (line === "readyok") {
          resolve();
        } else if (line.startsWith("bestmove")) {
          const pending = this.pending;
          this.pending = null;
          if (pending) {
            clearTimeout(pending.timer);
            const uci = line.split(/\s+/)[1];
            pending.resolve(uci && uci !== "(none)" ? uci : null);
          }
        }
      };
      worker.postMessage("uci");
    });
    return this.readyPromise;
  }

  /**
   * Best move for the position reached after `moves` (UCI list from startpos),
   * or null when the game is over. Results arrive in call order.
   */
  bestMove(moves: string[], movetimeMs = 1200): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      if (this.destroyed) throw new Error("engine destroyed");
      await this.ensureWorker();
      return new Promise<string | null>((resolve, reject) => {
        if (this.destroyed) {
          reject(new Error("engine destroyed"));
          return;
        }
        const timer = setTimeout(() => {
          const pending = this.pending;
          this.pending = null;
          pending?.reject(new Error("engine timed out"));
        }, movetimeMs + 8000);
        this.pending = { resolve, reject, timer };
        const worker = this.worker!;
        worker.postMessage(`position startpos moves ${moves.join(" ")}`.trim());
        worker.postMessage(`go movetime ${movetimeMs}`);
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined); // keep the chain alive on errors
    return result;
  }

  destroy(): void {
    this.destroyed = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("engine destroyed"));
    }
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
  }
}
