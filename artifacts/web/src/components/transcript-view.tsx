import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShootsQueryKey, getTranscript, transcribeSource, type Source, type Transcript } from '@workspace/api-client-react';

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A source's newest transcript, read on demand: the library lists only the word count, and the words load when asked
 * for. Each word carries its time on hover, and a time mark opens each paragraph-sized run, so a wrong word can be
 * found in the proxy. */
export function TranscriptView({ source }: { source: Source }) {
  const sourceId = source.id, words = source.transcriptWords ?? null;
  const [transcript, setTranscript] = useState<Transcript>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (transcript) return;
    setLoading(true); setError('');
    try { setTranscript(await getTranscript(sourceId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the transcript.'); }
    finally { setLoading(false); }
  };
  const runs: Transcript['words'][] = [];
  for (const [i, word] of (transcript?.words ?? []).entries()) {
    if (i % 60 === 0) runs.push([]);
    runs[runs.length - 1].push(word);
  }
  return <>
    <TranscriptionState source={source} onQueued={() => { setTranscript(undefined); setOpen(false); }} />
    {words != null && <button type="button" onClick={() => void toggle()} data-testid={`button-transcript-${sourceId}`}>
      {open ? 'Hide' : 'Show'} transcript ({words} words)
    </button>}
    {open && loading && <p role="status">Loading transcript…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {open && transcript && <div className="transcript" data-testid={`transcript-${sourceId}`}>
      <p className="subtle">{transcript.provider} · {transcript.version}</p>
      {runs.map((run, i) => <p key={i}><span className="subtle">[{clock(run[0].start_ms)}]</span>{' '}
        {run.map((w, j) => <span key={j} title={`${clock(w.start_ms)}–${clock(w.end_ms)}`}>{w.text} </span>)}</p>)}
    </div>}
  </>;
}

/** Whether a transcription is under way or failed, and the operator's Transcribe (again): a changed vocabulary list or a
 * failed run is redone from here rather than by restarting the worker. */
function TranscriptionState({ source, onQueued }: { source: Source; onQueued: () => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = source.transcriptionState === 'queued' || source.transcriptionState === 'claimed';
  if (!source.hasProxy || source.ingestState !== 'ready') return <>—</>;
  return <>
    {running && <p role="status" data-testid={`text-transcribing-${source.id}`}>Transcribing…</p>}
    {source.transcriptionError && <p className="error" data-testid={`text-transcription-error-${source.id}`}>{source.transcriptionError}</p>}
    {!running && <div><button type="button" disabled={busy} data-testid={`button-transcribe-${source.id}`} onClick={async () => {
      setBusy(true); setError('');
      try { await transcribeSource(source.id); onQueued(); await client.invalidateQueries({ queryKey: getListShootsQueryKey() }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not queue the transcription.'); }
      finally { setBusy(false); }
    }}>{busy ? 'Queuing…' : source.transcriptWords == null ? 'Transcribe' : 'Transcribe again'}</button></div>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}
