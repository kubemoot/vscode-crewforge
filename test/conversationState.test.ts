import { describe, expect, it } from 'vitest';
import { canControl, controlsFor, conversationState } from '../src/discussion/conversationState';

describe('conversationState', () => {
  it('is paused once paused, running while a turn streams, and finished otherwise', () => {
    expect(conversationState(true, false)).toBe('running');
    expect(conversationState(true, true)).toBe('paused');
    expect(conversationState(false, true)).toBe('paused');
    expect(conversationState(false, false)).toBe('finished');
  });

  it('offers Stop and Pause when running, Resume and Stop when paused, and none when finished', () => {
    expect(controlsFor('running')).toEqual(['stop', 'pause']);
    expect(controlsFor('paused')).toEqual(['resume', 'stop']);
    expect(controlsFor('finished')).toEqual([]);
  });

  it('always allows deleting from the crew, and nothing else out of state', () => {
    expect(canControl('finished', 'erase')).toBe(true);
    expect(canControl('finished', 'stop')).toBe(false);
    expect(canControl('running', 'resume')).toBe(false);
    expect(canControl('paused', 'pause')).toBe(false);
    expect(canControl('paused', 'resume')).toBe(true);
  });
});
