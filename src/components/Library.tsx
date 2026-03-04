import type { LibraryItem } from '../services/api';

interface LibraryProps {
  items: LibraryItem[];
  isLoading: boolean;
  loadingItemId: string | null;
  onOpenItem: (item: LibraryItem) => void;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

/** Truncate title to fit in a button, preserving whole words. */
function truncateTitle(title: string, maxLen = 40): string {
  if (title.length <= maxLen) return title;
  const truncated = title.slice(0, maxLen).replace(/\s+\S*$/, '');
  return (truncated || title.slice(0, maxLen)) + '...';
}

export function Library({ items, isLoading, loadingItemId, onOpenItem }: LibraryProps) {
  // Find most recent video and most recent text (items are sorted by createdAt desc)
  const latestVideo = items.find(i => i.contentType === 'video') ?? null;
  const latestText = items.find(i => i.contentType === 'text') ?? null;

  if (isLoading) {
    return null; // Don't show anything while loading — avoids layout shift
  }

  if (!latestVideo && !latestText) {
    return null; // Nothing to show
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-4 my-6">
        <div className="flex-1 border-t border-gray-300"></div>
        <span className="text-sm text-gray-500">or continue where you left off</span>
        <div className="flex-1 border-t border-gray-300"></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {latestVideo && (
          <button
            data-testid="cached-video-btn"
            onClick={() => onOpenItem(latestVideo)}
            disabled={loadingItemId !== null}
            className="px-4 py-3 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-purple-400 transition-colors text-sm text-gray-700 disabled:opacity-50 disabled:cursor-wait text-left"
          >
            {loadingItemId === latestVideo.sessionId ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-purple-500 border-t-transparent"></span>
                Loading...
              </span>
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">Video</span>
                  {latestVideo.totalDuration > 0 && (
                    <span className="text-xs text-gray-400">{formatDuration(latestVideo.totalDuration)}</span>
                  )}
                </div>
                <span className="font-medium text-gray-900 line-clamp-1">{truncateTitle(latestVideo.title)}</span>
              </div>
            )}
          </button>
        )}
        {latestText && (
          <button
            data-testid="cached-text-btn"
            onClick={() => onOpenItem(latestText)}
            disabled={loadingItemId !== null}
            className="px-4 py-3 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-emerald-400 transition-colors text-sm text-gray-700 disabled:opacity-50 disabled:cursor-wait text-left"
          >
            {loadingItemId === latestText.sessionId ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-emerald-500 border-t-transparent"></span>
                Loading...
              </span>
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700">Text</span>
                  <span className="text-xs text-gray-400">{latestText.chunkCount} sections</span>
                </div>
                <span className="font-medium text-gray-900 line-clamp-1">{truncateTitle(latestText.title)}</span>
              </div>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
