import { useRef, useState } from 'react';
import { getPlayback } from '@workspace/api-client-react';

/** Plays a source's proxy through its short-lived signed URL (architecture.md §4). The URL lives five minutes, so a
 * playback error fetches a fresh one and resumes where it stopped, once per error, rather than leaving a dead player. */
export function ProxyPlayer({ sourceId }: { sourceId: string }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef(0);
  const retried = useRef(false);
  const load = async () => {
    setLoading(true); setError('');
    try { setUrl((await getPlayback(sourceId)).url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the proxy.'); }
    finally { setLoading(false); }
  };
  return <>
    {url ? <video ref={video} src={url} controls preload="metadata" width={320} data-testid={`video-source-${sourceId}`}
      onLoadedMetadata={() => { if (resumeAt.current && video.current) { video.current.currentTime = resumeAt.current; resumeAt.current = 0; } }}
      onPlaying={() => { retried.current = false; }}
      onError={() => {
        if (retried.current) { setError('The proxy could not be played.'); return; }
        retried.current = true;
        resumeAt.current = video.current?.currentTime ?? 0;
        void load();
      }} />
      : <button type="button" onClick={load} disabled={loading} data-testid={`button-play-${sourceId}`}>{loading ? 'Loading…' : 'Play proxy'}</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}
