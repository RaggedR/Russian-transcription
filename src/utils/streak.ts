/**
 * Pure streak computation — no side effects, no IO.
 * All dates are "YYYY-MM-DD" strings in the user's local timezone.
 */

/** Returns today's date as "YYYY-MM-DD" in local timezone. */
export function getLocalDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Subtract one day from a "YYYY-MM-DD" string. Uses noon anchor to dodge DST. */
export function previousDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12); // noon anchor
  date.setDate(date.getDate() - 1);
  return getLocalDateString(date);
}

/** Find the Monday (ISO week start) for a given "YYYY-MM-DD". */
export function getMondayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  const day = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  date.setDate(date.getDate() - diff);
  return getLocalDateString(date);
}

export interface StreakState {
  currentStreak: number;
  longestStreak: number;
  completedToday: boolean;
  freezesUsedThisWeek: number;
  freezeWeekStart: string;
}

/**
 * Compute the current streak state from completion history.
 *
 * Walks backward from yesterday through completionDates:
 * - Each completed day: increment streak
 * - Each gap within the current Mon-Sun week with freezes < 2: consume a freeze, continue
 * - Each gap outside current week or freezes exhausted: stop
 * - If today is completed: add 1 to streak
 */
export function computeStreakState(
  completionDates: string[],
  storedLongestStreak: number,
  today: string = getLocalDateString(),
): StreakState {
  const dateSet = new Set(completionDates);
  const completedToday = dateSet.has(today);
  const currentWeekMonday = getMondayOfWeek(today);

  let streak = 0;
  let freezesUsed = 0;
  let cursor = previousDay(today);

  // Only walk backward if there are completion dates to find
  // (avoids consuming freezes when there's no streak to preserve)
  // Max 400 iterations (~13 months) as a safety bound against corrupted data
  let steps = 0;
  while (dateSet.size > 0 && steps++ < 400) {
    if (dateSet.has(cursor)) {
      streak++;
      dateSet.delete(cursor); // shrink set so loop terminates
      cursor = previousDay(cursor);
      continue;
    }

    // Gap day — can we use a freeze?
    const cursorWeekMonday = getMondayOfWeek(cursor);
    if (cursorWeekMonday === currentWeekMonday && freezesUsed < 2) {
      freezesUsed++;
      cursor = previousDay(cursor);
      continue;
    }

    // Gap with no freeze available — streak ends
    break;
  }

  // If today is completed, it extends the streak
  if (completedToday) {
    streak++;
  }

  const longestStreak = Math.max(storedLongestStreak, streak);

  return {
    currentStreak: streak,
    longestStreak,
    completedToday,
    freezesUsedThisWeek: freezesUsed,
    freezeWeekStart: currentWeekMonday,
  };
}
