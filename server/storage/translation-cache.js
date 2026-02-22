/**
 * Translation LRU cache.
 * Bounded to prevent unbounded memory growth.
 */
import { LRUCache } from 'lru-cache';

// Translation cache — LRU-bounded to prevent unbounded growth
export const translationCache = new LRUCache({ max: 10000 });
