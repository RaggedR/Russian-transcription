/**
 * Shared Russian language utilities.
 *
 * Consolidates normalization and speech synthesis logic previously
 * duplicated across sm2.ts, TranscriptPanel.tsx, WordPopup.tsx, and ReviewPanel.tsx.
 */

/**
 * Strip punctuation, lowercase, and normalize ё→е.
 * Used for card deduplication, frequency lookup, and word matching.
 */
export function normalizeRussianWord(word: string): string {
  return word.toLowerCase().replace(/[^а-яё]/g, '').replace(/ё/g, 'е');
}

/**
 * Clean a word for display/storage: trim whitespace and strip leading/trailing
 * punctuation while preserving the original case and interior characters.
 *
 * Whisper transcripts often produce words with leading spaces (" неожиданно")
 * or trailing punctuation (" мозга\",", " ответа."). This function strips
 * those artifacts so card words are clean for display and API matching.
 */
export function cleanWord(word: string): string {
  return word.trim().replace(/^[\s.,;:!?"'«»„""—–\-()[\]{}]+|[\s.,;:!?"'«»„""—–\-()[\]{}]+$/g, '');
}

/**
 * Speak text using the Web Speech API.
 * Maps short language codes (ru, fr, th) to BCP 47 locale tags.
 */
export function speak(text: string, language: string): void {
  if (!('speechSynthesis' in window)) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const langMap: Record<string, string> = {
    th: 'th-TH',
    fr: 'fr-FR',
    ru: 'ru-RU',
  };
  utterance.lang = langMap[language] || 'en-US';
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}
