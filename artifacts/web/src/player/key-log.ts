// PROTOTYPE — the last few key presses and what became of each (David, 2026-10-29: Space sometimes seemed not to work,
// and could not be made to happen on demand). "Report a key problem" sends this record with the feedback, so the next
// time it happens it can be read rather than guessed.
import { submitFeedback } from '@workspace/api-client-react';

type Entry = { at: string; code: string; target?: string; outcome: string };
const entries: Entry[] = [];

export function noteKey(entry: { code: string; target?: string; outcome: string }) {
  entries.push({ at: new Date().toISOString().slice(11, 23), ...entry });
  if (entries.length > 40) entries.shift();
}

/** Where a key went: a text box takes it, so the page's keys do not. */
export const describeTarget = (el: Element | null) => !el ? 'none' : `${el.tagName.toLowerCase()}${(el as HTMLElement).dataset?.testid ? `[${(el as HTMLElement).dataset.testid}]` : ''}`;

export async function reportKeyProblem(page: string, video: HTMLVideoElement | null) {
  const v = video;
  await submitFeedback({ questionKey: 'logging-viewer.keys', page, answer: 'Key problem report (sent from the page): a key did not do what was expected.',
    state: { keyLog: [...entries], video: v ? { paused: v.paused, readyState: v.readyState, networkState: v.networkState, error: v.error?.code ?? null,
      currentTime: v.currentTime, playbackRate: v.playbackRate } : null, focus: describeTarget(document.activeElement), visibility: document.visibilityState,
      userAgent: navigator.userAgent } });
}
