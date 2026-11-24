import { describe, expect, it } from 'vitest';
import { canControl, controlsFor, conversationState } from '../src/discussion/conversationState';

describe('conversationState', () => {
  it('goes by what the crew says when it says', () => {
    expect(conversationState('paused', false)).toBe('paused');
    expect(conversationState('paused', true)).toBe('paused');
    expect(conversationState('queued', false)).toBe('queued');
    expect(conversationState('running', false)).toBe('running');
  });

  it('is finished for a conversation the crew says stopped or finished, unless a turn streams in this panel', () => {
    expect(conversationState('finished', false)).toBe('finished');
    expect(conversationState('stopped', false)).toBe('finished');
    expect(conversationState('finished', true)).toBe('running');
    expect(conversationState('stopped', true)).toBe('running');
  });

  it('goes by the turn in this panel when the crew could not say', () => {
    expect(conversationState(undefined, true)).toBe('running');
    expect(conversationState(undefined, false)).toBe('finished');
  });

  it('offers Stop and Pause when running, Resume and Stop when paused, Cancel alone when queued, and none when finished', () => {
    expect(controlsFor('running')).toEqual(['stop', 'pause']);
    expect(controlsFor('paused')).toEqual(['resume', 'stop']);
    expect(controlsFor('queued')).toEqual(['stop']);
    expect(controlsFor('finished')).toEqual([]);
  });

  it('always allows deleting from the crew, and nothing else out of state', () => {
    expect(canControl('finished', 'erase')).toBe(true);
    expect(canControl('finished', 'stop')).toBe(false);
    expect(canControl('running', 'resume')).toBe(false);
    expect(canControl('paused', 'pause')).toBe(false);
    expect(canControl('paused', 'resume')).toBe(true);
    expect(canControl('queued', 'pause')).toBe(false);
    expect(canControl('queued', 'stop')).toBe(true);
  });
});
