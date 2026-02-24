/**
 * Example sentence LRU cache.
 * Keyed by lowercase word, values are { russian, english } sentence pairs.
 * Bounded to prevent unbounded memory growth.
 */
import { LRUCache } from 'lru-cache';

export const exampleCache = new LRUCache({ max: 10000 });
