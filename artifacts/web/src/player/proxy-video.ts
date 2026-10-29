// PROTOTYPE — a player that recovers by itself (David, 2026-10-29: the video went black and Space stopped working after
// switching away from Safari and back). The proxy plays from a signed link that lasts five minutes; when the iPad
// unloads or freezes the page, the player's next fetch can be refused, and Safari does not always say so. So the player
// checks itself whenever the page is shown again and whenever play is refused, fetches a fresh link, and puts itself
// back at the same position, speed and play state. A failure it cannot recover from is said, never swallowed.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { getPlayback } from '@workspace/api-client-react';
import { noteKey } from './key-log';

/** A signed link this old is refreshed when the page is shown again, before Safari finds out the hard way. */
const staleAfterMs = 4 * 60 * 1000;
/** Recoveries allowed in a minute: past this a fresh link is not what the video needs, and the page says so. */
const recoveriesPerMinute = 3;

export function useProxyVideo(video: RefObject<HTMLVideoElement | null>, sourceId: string, say: (message: string) => void) {
  const [url, setUrl] = useState<string>();
  const issuedAt = useRef(0);
  const restore = useRef<{ time: number; rate: number; play: boolean } | null>(null);
  const recovering = useRef<Promise<boolean> | null>(null);
  const recent = useRef<number[]>([]);
  /** Where the player last was while it worked: a failed load can reset the element to 0 before the error arrives. */
  const lastGood = useRef<{ time: number; rate: number; play: boolean }>({ time: 0, rate: 1, play: false });

  const fetchLink = useCallback(async () => {
    const { url: fresh } = await getPlayback(sourceId);
    issuedAt.current = Date.now();
    setUrl(fresh);
    return fresh;
  }, [sourceId]);

  useEffect(() => { fetchLink().catch(() => say('The video could not be loaded. Tap the video to try again.')); }, [fetchLink]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fetches a fresh link and reloads at the same place; one recovery at a time. */
  const recover = useCallback((why: string, thenPlay?: boolean): Promise<boolean> => {
    if (recovering.current) return recovering.current;
    const now = Date.now();
    recent.current = recent.current.filter((t) => now - t < 60_000);
    if (recent.current.length >= recoveriesPerMinute) {
      noteKey({ code: 'recover', outcome: `gave up (${why})` });
      say('The video keeps failing to play, even with a fresh link. Reload the page; if it happens again, tap “Report a key problem”.');
      return Promise.resolve(false);
    }
    recent.current.push(now);
    const v = video.current;
    const last = lastGood.current;
    restore.current = v ? { time: last.time, rate: last.rate, play: thenPlay ?? last.play } : null;
    noteKey({ code: 'recover', outcome: why });
    recovering.current = fetchLink().then((fresh) => {
      // The element is reloaded even when the link reads the same, since React would not touch an unchanged src.
      const el = video.current;
      if (el && (el.error || el.src !== fresh || el.readyState < 1)) { el.src = fresh; el.load(); }
      return true;
    }, () => { say('The video could not be loaded. Tap the video to try again.'); return false; })
      .finally(() => { recovering.current = null; });
    return recovering.current;
  }, [fetchLink, video, say]);

  // Back at the same place once the fresh link has loaded.
  const onLoadedMetadata = useCallback(() => {
    const v = video.current, r = restore.current;
    if (!v || !r) return;
    restore.current = null;
    v.currentTime = r.time;
    v.playbackRate = r.rate;
    if (r.play) void v.play().catch(() => say('The video is loaded but would not start. Press Space or tap the video.'));
  }, [video, say]);

  const healthy = () => {
    const v = video.current;
    return !!v && !v.error && v.readyState >= 1 && Date.now() - issuedAt.current < staleAfterMs;
  };

  // Shown again after the iPad froze or unloaded the page: check, and recover if needed.
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible' && issuedAt.current && !healthy()) void recover('page shown again'); };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('focus', check);
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('pageshow', check); window.removeEventListener('focus', check); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /** Space's play: if the browser refuses, recover once and try again; if that fails too, say why. A second later,
   * still not playing is said as well, so a press that does nothing is never silent. */
  const play = useCallback(async () => {
    const v = video.current;
    if (!v) { say('The video is still loading.'); return; }
    try {
      await v.play();
      noteKey({ code: 'play', outcome: 'playing' });
    } catch (cause) {
      const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      noteKey({ code: 'play', outcome: `refused (${reason})` });
      if ((cause as Error)?.name === 'NotAllowedError') { say('Safari would not start playback without a tap. Tap the video once, then Space works.'); return; }
      if (!(await recover('play refused', true))) return;
    }
    setTimeout(() => {
      const now = video.current;
      if (now && now.paused && !restore.current) say(now.readyState < 3 ? 'The video is still loading…' : 'The video did not start. Press Space again, or tap the video.');
    }, 1200);
  }, [video, recover, say]);

  const onTimeUpdate = useCallback(() => {
    const v = video.current;
    if (v && !v.error && v.readyState >= 1 && !restore.current) lastGood.current = { time: v.currentTime, rate: v.playbackRate, play: !v.paused };
  }, [video]);

  return { url, recover, play, onLoadedMetadata, onTimeUpdate, onSeeked: onTimeUpdate, onPause: onTimeUpdate, onPlaying: onTimeUpdate, onError: () => void recover('video error'), onStalled: () => { if (!healthy()) void recover('stalled'); } };
}
