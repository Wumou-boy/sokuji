import { InferenceSession, Tensor, env as ortEnv } from '../local-inference/workers/_shared/onnxruntime-all';
import { computeCampPlusFeatures } from './speakerEmbeddingFeatures';
import { SPEAKER_MODEL, ModelIntegrityError, verifiedSpeakerModel } from './speakerModel';

interface InitMessage { type: 'init'; wasmBaseUrl: string; }
interface EmbedMessage { type: 'embed'; id: number; samples: Float32Array; sampleRate: number; }
type RequestMessage = InitMessage | EmbedMessage | { type: 'dispose' };

const scope = self as DedicatedWorkerGlobalScope;
const CACHE_KEY = `${SPEAKER_MODEL.id}/${SPEAKER_MODEL.filename}`;
let session: InferenceSession | undefined;
let inputName = '';
let outputName = '';
let ready = false;
let inferenceQueue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  if (message.type === 'init') {
    void initialize(message).catch(error => {
      const code = error instanceof ModelIntegrityError ? 'model-integrity'
        : error instanceof RuntimeInitError ? 'runtime-init' : 'model-download';
      report(code, error, true);
    });
  } else if (message.type === 'embed') {
    inferenceQueue = inferenceQueue.then(() => embed(message)).catch(error => {
      scope.postMessage({ type: 'result', id: message.id, error: describe(error) });
      report('inference', error, false);
    });
  } else {
    session?.release();
    session = undefined;
    ready = false;
    scope.close();
  }
};

async function initialize(message: InitMessage): Promise<void> {
  try {
    ortEnv.wasm.wasmPaths = message.wasmBaseUrl;
    ortEnv.wasm.numThreads = 1;
    ortEnv.wasm.proxy = false;
    const model = await loadVerifiedModel();
    try {
      session = await InferenceSession.create(model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (error) {
      throw new RuntimeInitError(describe(error));
    }
    if (session.inputNames.length !== 1 || session.outputNames.length < 1) {
      throw new RuntimeInitError(`unexpected CAM++ ONNX I/O: ${session.inputNames.length} inputs, ${session.outputNames.length} outputs`);
    }
    inputName = session.inputNames[0];
    outputName = session.outputNames[0];
    ready = true;
    scope.postMessage({ type: 'ready' });
  } catch (error) {
    throw error;
  }
}

async function loadVerifiedModel(): Promise<Uint8Array> {
  let blob = await getCachedModel();
  if (blob) {
    try {
      return await verifiedSpeakerModel(blob);
    } catch (error) {
      // A stale or partially written cache entry is removed before a clean fetch.
      report('model-integrity', error, false);
      await removeCachedModel();
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  let response: Response;
  let downloaded: Blob;
  try {
    response = await fetch(SPEAKER_MODEL.url, { cache: 'no-cache', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`CAM++ model download failed (${response.status})`);
    downloaded = await response.blob();
  } finally {
    clearTimeout(timeout);
  }
  const bytes = await verifiedSpeakerModel(downloaded);
  await cacheModel(downloaded);
  return bytes;
}

/**
 * Speaker inference runs in a Worker, so keep this tiny IndexedDB adapter free
 * of the renderer's Zustand diagnostics dependency. It uses the same
 * `sokuji-models/files` key as modelStorage.ts.
 */
async function openModelDb(): Promise<IDBDatabase> {
  const open = (version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? indexedDB.open('sokuji-models') : indexedDB.open('sokuji-models', version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata');
      if (!db.objectStoreNames.contains('voice_styles')) {
        const store = db.createObjectStore('voice_styles', { keyPath: 'id', autoIncrement: true });
        store.createIndex('engine', 'engine', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('model cache database open failed'));
  });
  try {
    return await open(2);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'VersionError') throw error;
    const db = await open();
    if (!db.objectStoreNames.contains('files')) {
      db.close();
      throw new Error('newer model cache schema is missing its files store');
    }
    return db;
  }
}

async function getCachedModel(): Promise<Blob | undefined> {
  const db = await openModelDb();
  try {
    return await idbRequest<Blob | undefined>(db, 'readonly', store => store.get(CACHE_KEY));
  } finally {
    db.close();
  }
}

async function cacheModel(blob: Blob): Promise<void> {
  const db = await openModelDb();
  try {
    await idbRequest<IDBValidKey>(db, 'readwrite', store => store.put(blob, CACHE_KEY));
  } finally {
    db.close();
  }
}

async function removeCachedModel(): Promise<void> {
  const db = await openModelDb();
  try {
    await idbRequest<undefined>(db, 'readwrite', store => store.delete(CACHE_KEY));
  } finally {
    db.close();
  }
}

function idbRequest<T>(db: IDBDatabase, mode: IDBTransactionMode, execute: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const request = execute(tx.objectStore('files'));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error('model cache transaction failed'));
    tx.oncomplete = () => resolve(result!);
    tx.onerror = () => reject(tx.error ?? new Error('model cache transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('model cache transaction aborted'));
  });
}


async function embed(message: EmbedMessage): Promise<void> {
  if (!ready || !session) throw new Error('CAM++ worker is not initialized');
  if (!(message.samples instanceof Float32Array) || !Number.isFinite(message.sampleRate) || message.sampleRate < 1) {
    throw new Error('invalid audio input');
  }
  const pcm16k = resampleLinear(message.samples, message.sampleRate, SPEAKER_MODEL.sampleRate);
  const features = computeCampPlusFeatures(pcm16k, SPEAKER_MODEL.sampleRate);
  const input = new Tensor('float32', features.data, [1, features.frames, 80]);
  const result = await session.run({ [inputName]: input });
  const tensor = result[outputName];
  if (!(tensor?.data instanceof Float32Array) || tensor.data.length !== SPEAKER_MODEL.embeddingDimensions) {
    throw new Error(`unexpected CAM++ embedding output length: ${tensor?.data?.length ?? 'missing'}`);
  }
  const normalized = normalizeVector(tensor.data);
  scope.postMessage({ type: 'result', id: message.id, embedding: normalized }, [normalized.buffer]);
}

/** sherpa-onnx's LinearResample-compatible endpoint-preserving interpolation. */
function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input.slice();
  const outputLength = Math.floor((input.length - 1) * outputRate / inputRate) + 1;
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const left = Math.min(Math.floor(position), input.length - 1);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

function normalizeVector(input: Float32Array): Float32Array {
  let normSq = 0;
  for (const value of input) {
    if (!Number.isFinite(value)) throw new Error('CAM++ returned a non-finite embedding');
    normSq += value * value;
  }
  if (!(normSq > 1e-12)) throw new Error('CAM++ returned a zero embedding');
  const scale = 1 / Math.sqrt(normSq);
  return Float32Array.from(input, value => value * scale);
}

function report(code: string, error: unknown, fatal: boolean): void {
  scope.postMessage({ type: 'issue', code, message: describe(error), fatal });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RuntimeInitError extends Error {}
