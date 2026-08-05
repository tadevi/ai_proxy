import { describe, expect, it } from 'vitest';
import { formatTokens } from './format.js';

describe('formatTokens (dashboard rendering)', () => {
  it('renders null as —', () => {
    expect(formatTokens(null)).toBe('—');
  });

  it('renders undefined as —', () => {
    expect(formatTokens(undefined)).toBe('—');
  });

  it('renders explicit zero as "0" (not "—", not "0K")', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('renders small positive numbers as raw strings', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1)).toBe('1');
  });

  it('renders large numbers with suffixes', () => {
    expect(formatTokens(2_500)).toBe('2.5K');
    expect(formatTokens(1_000_000)).toBe('1M');
  });

  it('accepts string inputs', () => {
    expect(formatTokens('0')).toBe('0');
    expect(formatTokens('120')).toBe('120');
    expect(formatTokens('2500')).toBe('2.5K');
  });
});
