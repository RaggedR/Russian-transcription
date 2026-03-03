import type { LibraryItem } from '../services/api';

interface LibraryProps {
  items: LibraryItem[];
  isLoading: boolean;
  isItemLoading: boolean;
  onOpenItem: (item: LibraryItem) => void;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export function Library({ items, isLoading, isItemLoading, onOpenItem }: LibraryProps) {
  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto mt-8">
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Content Library</h3>
        <div className="flex justify-center py-6">
          <div className="inline-block animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent"></div>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="max-w-2xl mx-auto mt-8">
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Content Library</h3>
        <p className="text-center text-sm text-gray-400 py-6">No content yet. Analyze a video or text to build the library.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto mt-8">
      <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Content Library</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <button
            key={item.sessionId}
            onClick={() => onOpenItem(item)}
            disabled={isItemLoading}
            className="text-left p-4 rounded-lg border border-gray-200 bg-white hover:border-blue-300 hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-wait"
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-sm font-medium text-gray-900 line-clamp-1">{item.title}</span>
              <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium ${
                item.contentType === 'video'
                  ? 'bg-purple-100 text-purple-700'
                  : 'bg-emerald-100 text-emerald-700'
              }`}>
                {item.contentType === 'video' ? 'Video' : 'Text'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>{item.chunkCount} {item.contentType === 'text' ? 'sections' : 'parts'}</span>
              {item.contentType === 'video' && item.totalDuration > 0 && (
                <>
                  <span className="text-gray-300">&middot;</span>
                  <span>{formatDuration(item.totalDuration)}</span>
                </>
              )}
              {item.hasMoreChunks && (
                <>
                  <span className="text-gray-300">&middot;</span>
                  <span className="text-blue-600">More available</span>
                </>
              )}
              <span className="ml-auto">{formatRelativeDate(item.createdAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
