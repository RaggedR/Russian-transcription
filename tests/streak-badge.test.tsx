import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreakBadge } from '../src/components/StreakBadge';

describe('StreakBadge', () => {
  it('renders streak count', () => {
    render(<StreakBadge currentStreak={5} completedToday={false} freezesRemaining={2} />);
    expect(screen.getByTestId('streak-count').textContent).toBe('5');
  });

  it('shows orange flame when completed today', () => {
    render(<StreakBadge currentStreak={3} completedToday={true} freezesRemaining={2} />);
    const flame = screen.getByTestId('streak-flame');
    expect(flame.classList.contains('text-orange-500')).toBe(true);
  });

  it('shows gray flame when not completed today', () => {
    render(<StreakBadge currentStreak={3} completedToday={false} freezesRemaining={2} />);
    const flame = screen.getByTestId('streak-flame');
    expect(flame.classList.contains('text-gray-400')).toBe(true);
  });

  it('shows correct freeze dots — 2 remaining', () => {
    render(<StreakBadge currentStreak={1} completedToday={true} freezesRemaining={2} />);
    const dot0 = screen.getByTestId('freeze-dot-0');
    const dot1 = screen.getByTestId('freeze-dot-1');
    expect(dot0.classList.contains('bg-blue-400')).toBe(true);
    expect(dot1.classList.contains('bg-blue-400')).toBe(true);
  });

  it('shows correct freeze dots — 1 remaining', () => {
    render(<StreakBadge currentStreak={1} completedToday={true} freezesRemaining={1} />);
    const dot0 = screen.getByTestId('freeze-dot-0');
    const dot1 = screen.getByTestId('freeze-dot-1');
    expect(dot0.classList.contains('bg-blue-400')).toBe(true);
    expect(dot1.classList.contains('bg-gray-300')).toBe(true);
  });

  it('shows correct freeze dots — 0 remaining', () => {
    render(<StreakBadge currentStreak={1} completedToday={true} freezesRemaining={0} />);
    const dot0 = screen.getByTestId('freeze-dot-0');
    const dot1 = screen.getByTestId('freeze-dot-1');
    expect(dot0.classList.contains('bg-gray-300')).toBe(true);
    expect(dot1.classList.contains('bg-gray-300')).toBe(true);
  });

  it('has correct tooltip with streak', () => {
    render(<StreakBadge currentStreak={5} completedToday={false} freezesRemaining={1} />);
    const badge = screen.getByTestId('streak-badge');
    expect(badge.title).toContain('5 day streak');
    expect(badge.title).toContain('Complete a chunk to extend!');
    expect(badge.title).toContain('1 freeze remaining');
  });

  it('has correct tooltip when completed today', () => {
    render(<StreakBadge currentStreak={5} completedToday={true} freezesRemaining={2} />);
    const badge = screen.getByTestId('streak-badge');
    expect(badge.title).toContain("Today's goal complete!");
  });

  it('renders zero streak', () => {
    render(<StreakBadge currentStreak={0} completedToday={false} freezesRemaining={2} />);
    expect(screen.getByTestId('streak-count').textContent).toBe('0');
  });
});
