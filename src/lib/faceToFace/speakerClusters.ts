/** Session-only, conservative online clustering for speaker embeddings. */

export interface SpeakerClustersOptions {
  /** Similarity at or above which an embedding joins the nearest existing speaker. */
  matchThreshold?: number;
  /** Similarity below which an embedding may seed a distinct speaker. */
  newSpeakerThreshold?: number;
  /** Keep ids bounded for short meetings and resist embedding outliers. */
  maxSpeakers?: number;
}

interface Cluster {
  centroid: Float32Array;
  count: number;
}

const DEFAULT_MATCH_THRESHOLD = 0.62;
const DEFAULT_NEW_SPEAKER_THRESHOLD = 0.34;
const DEFAULT_MAX_SPEAKERS = 12;

/**
 * Adds one normalized CAM++ embedding at a time and returns a stable, zero-based
 * speaker id. Scores in the uncertain band return undefined instead of forcing
 * an assignment. State is deliberately in memory only and reset() starts a new
 * session.
 */
export class SpeakerClusters {
  private readonly clusters: Cluster[] = [];
  private readonly matchThreshold: number;
  private readonly newSpeakerThreshold: number;
  private readonly maxSpeakers: number;

  constructor(options: SpeakerClustersOptions = {}) {
    this.matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
    this.newSpeakerThreshold = options.newSpeakerThreshold ?? DEFAULT_NEW_SPEAKER_THRESHOLD;
    this.maxSpeakers = options.maxSpeakers ?? DEFAULT_MAX_SPEAKERS;
    if (!(this.newSpeakerThreshold >= -1 && this.newSpeakerThreshold < this.matchThreshold
      && this.matchThreshold <= 1)) {
      throw new RangeError('speaker thresholds must satisfy -1 <= newSpeakerThreshold < matchThreshold <= 1');
    }
    if (!Number.isInteger(this.maxSpeakers) || this.maxSpeakers < 1) {
      throw new RangeError('maxSpeakers must be a positive integer');
    }
  }

  /**
   * Returns a speaker id for a confident match/new speaker, or undefined if the
   * embedding is invalid or falls between the conservative similarity gates.
   */
  assign(embedding: Float32Array): number | undefined {
    const normalized = normalizeEmbedding(embedding);
    if (!normalized) return undefined;
    if (this.clusters.length === 0) {
      this.clusters.push({ centroid: normalized, count: 1 });
      return 0;
    }

    let bestId = -1;
    let bestSimilarity = -Infinity;
    for (let id = 0; id < this.clusters.length; id++) {
      const similarity = cosine(normalized, this.clusters[id].centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestId = id;
      }
    }

    if (bestSimilarity >= this.matchThreshold) {
      this.updateCentroid(this.clusters[bestId], normalized);
      return bestId;
    }
    if (bestSimilarity > this.newSpeakerThreshold || this.clusters.length >= this.maxSpeakers) {
      return undefined;
    }

    const id = this.clusters.length;
    this.clusters.push({ centroid: normalized, count: 1 });
    return id;
  }

  /** Starts a clean session and resets speaker IDs to zero. */
  reset(): void {
    this.clusters.length = 0;
  }

  get speakerCount(): number {
    return this.clusters.length;
  }

  private updateCentroid(cluster: Cluster, next: Float32Array): void {
    const weight = cluster.count / (cluster.count + 1);
    for (let i = 0; i < cluster.centroid.length; i++) {
      cluster.centroid[i] = cluster.centroid[i] * weight + next[i] / (cluster.count + 1);
    }
    const renormalized = normalizeEmbedding(cluster.centroid);
    if (renormalized) cluster.centroid = renormalized;
    cluster.count++;
  }
}

function normalizeEmbedding(vector: Float32Array): Float32Array | undefined {
  if (!(vector instanceof Float32Array) || vector.length === 0) return undefined;
  let normSq = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return undefined;
    normSq += value * value;
  }
  if (!(normSq > 1e-12)) return undefined;
  const scale = 1 / Math.sqrt(normSq);
  return Float32Array.from(vector, value => value * scale);
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
