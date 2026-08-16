import { Colors } from './types';

export function getColors(isDark: boolean): Colors {
  if (isDark) {
    return {
      bg: '#1a1a1f',
      bgSecondary: '#1e1e24',
      bgTertiary: 'transparent',
      primaryFrame: '#2a2a30',
      textPrimary: '#c1c1c6',
      textSystem: '#9f9fa9',
      textSecondary: '#9f9fa9',
      toolName: '#d4d4d8',
      harness: '#6366f1',
      border: '#9ca3af',
      borderFocus: '#6366f1',
      placeholder: '#5c5c64',
      timelineLine: '#52525b',
      timelineStatusNormal: '#c1c1c6',
      timelineStatusSuccess: '#22c55e',
      timelineStatusRunning: '#eab308',
      timelineStatusFail: '#ef4444',
      success: '#22c55e',
      error: '#ef4444',
    };
  }

  return {
    bg: '#f4f4f5',
    bgSecondary: '#e4e4e7',
    bgTertiary: 'transparent',
    primaryFrame: '#fafafa',
    textPrimary: '#18181b',
    textSystem: '#71717a',
    textSecondary: '#71717a',
    toolName: '#27272a',
    harness: '#6366f1',
    border: '#9ca3af',
    borderFocus: '#6366f1',
    placeholder: '#b2b2b7',
    timelineLine: '#d4d4d8',
    timelineStatusNormal: '#d4d4d8',
    timelineStatusSuccess: '#22c55e',
    timelineStatusRunning: '#eab308',
    timelineStatusFail: '#ef4444',
    success: '#22c55e',
    error: '#ef4444',
  };
}
