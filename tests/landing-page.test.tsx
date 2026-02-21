import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LandingPage } from '../src/components/LandingPage';

describe('LandingPage', () => {
  it('renders app title', () => {
    render(<LandingPage onSignIn={vi.fn()} />);
    expect(screen.getByText('Russian Video & Text')).toBeInTheDocument();
  });

  it('renders feature sections', () => {
    render(<LandingPage onSignIn={vi.fn()} />);
    expect(screen.getByText('Synced Transcripts')).toBeInTheDocument();
    expect(screen.getByText('Text Reading with TTS')).toBeInTheDocument();
    expect(screen.getByText('Click-to-Translate')).toBeInTheDocument();
    expect(screen.getByText('SRS Flashcards')).toBeInTheDocument();
  });

  it('renders pricing info', () => {
    render(<LandingPage onSignIn={vi.fn()} />);
    expect(screen.getByText(/\$5/)).toBeInTheDocument();
    expect(screen.getByText(/30-day free trial/i)).toBeInTheDocument();
  });

  it('renders "Get Started" button with data-testid', () => {
    render(<LandingPage onSignIn={vi.fn()} />);
    const btn = screen.getByTestId('get-started-btn');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('Get Started');
  });

  it('calls onSignIn when "Get Started" is clicked', () => {
    const onSignIn = vi.fn();
    render(<LandingPage onSignIn={onSignIn} />);

    fireEvent.click(screen.getByTestId('get-started-btn'));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('does not show error when error prop is not provided', () => {
    const { container } = render(<LandingPage onSignIn={vi.fn()} />);
    expect(container.querySelector('.text-red-600')).toBeNull();
  });

  it('does not show error when error prop is null', () => {
    const { container } = render(<LandingPage onSignIn={vi.fn()} error={null} />);
    expect(container.querySelector('.text-red-600')).toBeNull();
  });

  it('shows error message when error prop is set', () => {
    render(<LandingPage onSignIn={vi.fn()} error="Sign-in failed. Please try again." />);
    expect(screen.getByText('Sign-in failed. Please try again.')).toBeInTheDocument();
  });

  it('renders Google logo SVG', () => {
    const { container } = render(<LandingPage onSignIn={vi.fn()} />);
    // Google logo has a distinctive path fill color
    const googlePath = container.querySelector('path[fill="#4285F4"]');
    expect(googlePath).not.toBeNull();
  });

  it('renders legal agreement with expandable ToS', () => {
    render(<LandingPage onSignIn={vi.fn()} />);

    const agreement = screen.getByTestId('legal-agreement');
    expect(agreement).toBeInTheDocument();

    // ToS content should be hidden initially
    expect(screen.queryByTestId('login-tos-content')).toBeNull();

    // Click ToS link to expand
    fireEvent.click(screen.getByTestId('login-tos-link'));
    expect(screen.getByTestId('login-tos-content')).toBeInTheDocument();
    expect(screen.getByTestId('login-tos-content')).toHaveTextContent('Acceptance of Terms');

    // Click again to collapse
    fireEvent.click(screen.getByTestId('login-tos-link'));
    expect(screen.queryByTestId('login-tos-content')).toBeNull();
  });

  it('renders expandable Privacy Policy', () => {
    render(<LandingPage onSignIn={vi.fn()} />);

    // Privacy content should be hidden initially
    expect(screen.queryByTestId('login-privacy-content')).toBeNull();

    // Click Privacy link to expand
    fireEvent.click(screen.getByTestId('login-privacy-link'));
    expect(screen.getByTestId('login-privacy-content')).toBeInTheDocument();
    expect(screen.getByTestId('login-privacy-content')).toHaveTextContent('Information We Collect');

    // Clicking ToS should switch to ToS and hide Privacy
    fireEvent.click(screen.getByTestId('login-tos-link'));
    expect(screen.getByTestId('login-tos-content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-privacy-content')).toBeNull();
  });

  it('has a second CTA in the pricing section', () => {
    render(<LandingPage onSignIn={vi.fn()} />);
    // There should be at least two buttons that trigger onSignIn
    const buttons = screen.getAllByText('Get Started');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });
});
