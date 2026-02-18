/**
 * SSE progress broadcasting and terminal rendering.
 * Extracted from index.js for separation of concerns.
 */

// SSE clients for progress updates
const progressClients = new Map();

/**
 * Terminal progress bar rendering
 */
const TERM_COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgMagenta: '\x1b[45m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  white: '\x1b[37m',
};

const TYPE_STYLES = {
  audio:         { color: TERM_COLORS.blue,    label: 'AUDIO' },
  transcription: { color: TERM_COLORS.green,   label: 'TRANSCRIBE' },
  punctuation:   { color: TERM_COLORS.yellow,  label: 'PUNCTUATE' },
  lemmatization: { color: TERM_COLORS.yellow,  label: 'LEMMATIZE' },
  tts:           { color: TERM_COLORS.cyan,    label: 'TTS' },
  video:         { color: TERM_COLORS.magenta,  label: 'VIDEO' },
  complete:      { color: TERM_COLORS.green,   label: 'DONE' },
  error:         { color: TERM_COLORS.red,     label: 'ERROR' },
  connected:     { color: TERM_COLORS.cyan,    label: 'SSE' },
};

function renderProgressBar(percent, width = 30) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function printProgress(sessionId, type, progress, status, message) {
  const style = TYPE_STYLES[type] || { color: TERM_COLORS.white, label: type.toUpperCase() };
  const { color, label } = style;
  const { reset, bold, dim } = TERM_COLORS;

  if (type === 'connected') {
    console.log(`${dim}[${sessionId.slice(-6)}]${reset} ${color}${label}${reset} Client connected`);
    return;
  }

  if (type === 'error') {
    console.log(`${dim}[${sessionId.slice(-6)}]${reset} ${color}${bold}${label}${reset} ${message}`);
    return;
  }

  if (type === 'complete') {
    console.log(`${dim}[${sessionId.slice(-6)}]${reset} ${color}${bold}✓ ${label}${reset} ${message}`);
    return;
  }

  const bar = renderProgressBar(progress);
  const pct = `${String(progress).padStart(3)}%`;
  // Use \r to overwrite line for same-type updates
  process.stdout.write(`\r${dim}[${sessionId.slice(-6)}]${reset} ${color}${bold}${label.padEnd(10)}${reset} ${color}${bar}${reset} ${pct} ${dim}${message}${reset}\x1b[K`);

  // Print newline when a phase completes (100%) so next output starts fresh
  if (progress >= 100 || status === 'complete') {
    process.stdout.write('\n');
  }
}

/**
 * Rewrite known API error messages into user-friendly versions with actionable links.
 */
export function friendlyErrorMessage(message) {
  if (message && message.includes('exceeded your current quota')) {
    return 'OpenAI API quota exceeded. Add credits at https://platform.openai.com/settings/organization/billing';
  }
  return message;
}

/**
 * Send progress update to all connected SSE clients for a session
 */
export function sendProgress(sessionId, type, progress, status, message, extra = {}) {
  if (status === 'error') message = friendlyErrorMessage(message);
  // Print to terminal
  printProgress(sessionId, type, progress, status, message);

  const clients = progressClients.get(sessionId);
  if (clients && clients.length > 0) {
    const data = JSON.stringify({ type, progress, status, message, ...extra });
    clients.forEach(client => {
      client.write(`data: ${data}\n\n`);
    });
  }
}

/**
 * Create progress callback for a session
 */
export function createProgressCallback(sessionId) {
  return (type, percent, status, message) => {
    sendProgress(sessionId, type, percent, status, message);
  };
}

export { progressClients };
