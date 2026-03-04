interface StreakBadgeProps {
  currentStreak: number;
  completedToday: boolean;
  freezesRemaining: number;
}

export function StreakBadge({ currentStreak, completedToday, freezesRemaining }: StreakBadgeProps) {
  const tooltipParts: string[] = [];
  if (currentStreak > 0) {
    tooltipParts.push(`${currentStreak} day streak`);
  }
  if (!completedToday) {
    tooltipParts.push(currentStreak > 0 ? 'Complete a chunk to extend!' : 'Complete a chunk to start a streak!');
  } else {
    tooltipParts.push("Today's goal complete!");
  }
  tooltipParts.push(`${freezesRemaining} freeze${freezesRemaining !== 1 ? 's' : ''} remaining`);
  const tooltip = tooltipParts.join(' — ');

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 rounded-md"
      title={tooltip}
      data-testid="streak-badge"
    >
      {/* Flame icon */}
      <svg
        className={`w-5 h-5 ${completedToday ? 'text-orange-500' : 'text-gray-400'}`}
        viewBox="0 0 24 24"
        fill="currentColor"
        data-testid="streak-flame"
      >
        <path d="M12 23c-3.6 0-7-2.4-7-7 0-3.1 2.1-5.7 3.2-6.8.4-.4 1-.2 1.2.3.6 1.7 1.8 3 2.8 3.7.2-.8.3-2.1-.2-3.7-.2-.5.1-1.1.6-1.2.5-.1 1 .1 1.2.5C15.6 12.1 19 14.5 19 16c0 4.6-3.4 7-7 7z" />
      </svg>
      {/* Streak count */}
      <span
        className={`text-sm font-semibold tabular-nums ${completedToday ? 'text-orange-600' : 'text-gray-500'}`}
        data-testid="streak-count"
      >
        {currentStreak}
      </span>
      {/* Freeze dots */}
      <div className="flex gap-0.5 ml-0.5" data-testid="freeze-dots">
        {[0, 1].map(i => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${
              i < freezesRemaining ? 'bg-blue-400' : 'bg-gray-300'
            }`}
            data-testid={`freeze-dot-${i}`}
          />
        ))}
      </div>
    </div>
  );
}
