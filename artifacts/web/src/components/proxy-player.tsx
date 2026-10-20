import { useRef, useState } from 'react';
import { getPlayback } from '@workspace/api-client-react';

/** Plays a source's proxy through its short-lived signed URL (architecture.md §4). The URL lives five minutes, so a
 * playback error fetches a fresh one once and resumes where it stopped. Whenever playback cannot continue — the fresh
 * URL also fails, or fetching it fails — the player returns to its Play button, which tries again from the same place;
 * automatic retries stay at one per user attempt, so an unplayable file cannot loop. */
export function ProxyPlayer({ sourceId }: { sourceId: string }) {
  const [url, setUrl] = useState<string>();
  // Each fetched URL gets a fresh video element: a refresh signed in the same second as the failed URL is identical
  // to it, and React would otherwise leave the failed element in place with nothing to load.
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef(0);
  const retried = useRef(false);
  const load = async (byUser: boolean) => {
    if (byUser) retried.current = false;
    setLoading(true); setError('');
    try { setUrl((await getPlayback(sourceId)).url); setAttempt(n => n + 1); }
    catch (cause) { setUrl(undefined); setError(cause instanceof Error ? cause.message : 'Could not load the proxy.'); }
    finally { setLoading(false); }
  };
  return <>
    {url ? <video key={attempt} ref={video} src={url} controls preload="metadata" width={320} data-testid={`video-source-${sourceId}`}
      onLoadedMetadata={() => { if (resumeAt.current && video.current) { video.current.currentTime = resumeAt.current; resumeAt.current = 0; } }}
      onPlaying={() => { retried.current = false; }}
      onError={() => {
        resumeAt.current = video.current?.currentTime || resumeAt.current;
        if (retried.current) { setUrl(undefined); setError('The proxy could not be played. Press Play to try again.'); return; }
        retried.current = true;
        void load(false);
      }} />
      : <button type="button" onClick={() => void load(true)} disabled={loading} data-testid={`button-play-${sourceId}`}>{loading ? 'Loading…' : 'Play proxy'}</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}
