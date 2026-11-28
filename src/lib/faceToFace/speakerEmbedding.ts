/** Browser-worker-backed local CAM++ embeddings for face-to-face transcripts. */

export type SpeakerIssueCode = 'model-download' | 'model-integrity' | 'runtime-init' | 'worker' | 'audio-too-short' | 'inference';

export interface SpeakerIssue {
  code: SpeakerIssueCode;
  message: string;
  fatal: boolean;
}

export interface SpeakerEmbedderOptions {
  onIssue?: (issue: SpeakerIssue) => void;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'issue'; code: string; message: string; fatal: boolean }
  | { type: 'result'; id: number; embedding?: Float32Array; error?: string };

interface PendingEmbed {
  resolve: (embedding: Float32Array) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Downloads and verifies the pinned CAM++ model into the shared local model
 * IndexedDB cache, then runs FBank and ONNX inference in a dedicated worker.
 */
export class SpeakerEmbedder {
  private readonly readyPromise: Promise<void>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingEmbed>();
  private nextId = 1;
  private disposed = false;
  private rejectReady: ((error: Error) => void) | undefined;
  private resolveReady: (() => void) | undefined;
  private readySettled = false;

  constructor(private readonly options: SpeakerEmbedderOptions = {}) {
    try {
      this.worker = new Worker(new URL('./speakerEmbedding.worker.ts', import.meta.url), { type: 'module' });
    } catch (cause) {
      this.reportIssue({ code: 'worker', message: cause instanceof Error ? cause.message : String(cause), fatal: true });
      throw cause;
    }
    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = () => {
        if (this.readySettled) return;
        this.readySettled = true;
        resolve();
      };
      this.rejectReady = error => {
        if (this.readySettled) return;
        this.readySettled = true;
        reject(error);
      };
      const handleMessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === 'ready') {
          this.worker.removeEventListener('message', handleMessage);
          this.resolveReady?.();
        } else if (message.type === 'issue') {
          if (message.fatal) {
            this.worker.removeEventListener('message', handleMessage);
            this.rejectReady?.(new Error(message.message));
          }
        }
      };
      this.worker.addEventListener('message', handleMessage);
      this.worker.addEventListener('error', event => {
        const error = new Error(event.message || 'CAM++ worker failed');
        this.reportIssue({ code: 'worker', message: error.message, fatal: true });
        this.rejectReady?.(error);
        this.rejectPending(error);
        this.worker.terminate();
      }, { once: true });
    });
    const startupTimeout = setTimeout(() => {
      const error = new Error('CAM++ model startup timed out after 10 minutes');
      this.reportIssue({ code: 'worker', message: error.message, fatal: true });
      this.rejectReady?.(error);
      this.worker.terminate();
      this.rejectPending(error);
    }, 10 * 60_000);
    void this.readyPromise.finally(() => clearTimeout(startupTimeout)).catch(() => undefined);
    const wasmBaseUrl = new URL(`${import.meta.env.BASE_URL}wasm/ort/`, document.baseURI).href;
    try {
      this.worker.postMessage({ type: 'init', wasmBaseUrl });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.reportIssue({ code: 'worker', message: error.message, fatal: true });
      this.rejectReady?.(error);
      this.worker.terminate();
    }
    // Prevent an early background startup failure from becoming an unhandled
    // rejection before the consumer awaits ready(). The original promise still rejects.
    void this.readyPromise.catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async embed(samples: Float32Array, sampleRate: number): Promise<Float32Array> {
    if (this.disposed) throw new Error('SpeakerEmbedder is disposed');
    if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 1) {
      throw new TypeError('embed expects Float32Array PCM and a positive sample rate');
    }
    if (samples.length < sampleRate * 0.25) {
      const message = 'speaker audio must contain at least 250 ms of PCM';
      this.reportIssue({ code: 'audio-too-short', message, fatal: false });
      throw new RangeError(message);
    }
    await this.readyPromise;
    const id = this.nextId++;
    const copy = samples.slice();
    return new Promise<Float32Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('CAM++ inference timed out after 30 seconds');
        this.reportIssue({ code: 'inference', message: error.message, fatal: false });
        reject(error);
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.worker.postMessage({ type: 'embed', id, samples: copy, sampleRate }, [copy.buffer]);
      } catch (cause) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
    const error = new Error('SpeakerEmbedder was disposed');
    if (!this.readySettled) this.rejectReady?.(error);
    this.rejectPending(error);
  }

  private handleWorkerMessage = (event: MessageEvent<WorkerMessage>): void => {
    const message = event.data;
    if (message.type === 'issue') {
      this.reportIssue(message);
    } else if (message.type === 'result') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error || !message.embedding) pending.reject(new Error(message.error || 'CAM++ returned no embedding'));
      else pending.resolve(message.embedding);
    }
  };

  private reportIssue(value: { code: string; message: string; fatal: boolean }): void {
    const allowed: SpeakerIssueCode[] = ['model-download', 'model-integrity', 'runtime-init', 'worker', 'audio-too-short', 'inference'];
    const code = allowed.includes(value.code as SpeakerIssueCode) ? value.code as SpeakerIssueCode : 'worker';
    try {
      this.options.onIssue?.({ code, message: value.message, fatal: value.fatal });
    } catch {
      // Diagnostics must not take down the embedding worker lifecycle.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
