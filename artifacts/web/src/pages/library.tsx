import { Link } from 'wouter';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { archiveShoot, getListArchivedShootsQueryKey, getListShootsQueryKey, removeSource, restoreShoot, useCreateShoot, useListArchivedShoots, useListShoots, type Source } from '@workspace/api-client-react';
import { UploadManager } from '@/components/upload-manager';
import { ProxyPlayer } from '@/components/proxy-player';
import { SourceState } from '@/components/source-state';
import { TranscriptView } from '@/components/transcript-view';

/** States the worker moves a source through on its own; while any source is in one, or has a transcription queued or
 * running, the library refreshes itself.
 * `uploading` is not among them: it ends only when the browser finishes, and an abandoned upload must not poll forever. */
const inFlight = new Set(['uploaded', 'probing', 'proxying', 'transcribing']);
const refreshMs = 5000;
const roles: Record<string, string> = { camera_a: 'Camera A', camera_b: 'Camera B', audio: 'Audio', render: 'Render', deck: 'Deck' };
const length = (ms: number) => { const s = Math.round(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`; };
const shotOnLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

const clockOf = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
type Step = { title: string; detail?: string; state: 'done' | 'active' | 'waiting' | 'failed'; fraction?: number | null };

/** The steps between an upload and logging, as this file stands in them (David, 2026-10-27: "a multi-step progress
 * indicator … that visually shows what the steps are that need to happen before logging can start"). Logging waits
 * for the transcript, since word snapping depends on it (David, 2026-10-28). */
function stepsOf(source: Source, now: number): Step[] {
  const state = source.ingestState, stage = source.ingestProgress?.stage, fraction = source.ingestProgress?.fraction ?? null;
  const order = ['upload', 'check', 'proxy', 'derivatives', 'transcribe'] as const;
  const at = state === 'uploading' ? 'upload' : state === 'uploaded' ? 'check' : state === 'probing' ? 'check'
    : state === 'proxying' ? (stage === 'derivatives' ? 'derivatives' : stage === 'download' ? 'check' : 'proxy')
    : state === 'failed' ? 'check' : 'transcribe';
  const idx = order.indexOf(at);
  const mark = (i: number): Step['state'] => i < idx ? 'done' : i > idx ? 'waiting' : state === 'failed' ? 'failed' : 'active';
  const transcribing = source.transcriptionState === 'queued' || source.transcriptionState === 'claimed';
  const transcribed = source.transcriptWords != null;
  const started = source.transcriptionStartedAt ? now - Date.parse(source.transcriptionStartedAt) : null;
  return [
    { title: 'Upload', state: mark(0), detail: mark(0) === 'active' ? 'Sending the original from this device' : undefined },
    { title: 'Check the file', state: mark(1), fraction: at === 'check' && stage === 'download' ? fraction : undefined,
      detail: state === 'failed' ? source.lastError ?? 'Processing failed' : state === 'uploaded' ? 'Waiting to start' : mark(1) === 'active' ? 'Fetching the original and reading its format' : undefined },
    { title: 'Make the low-resolution proxy', state: mark(2), fraction: at === 'proxy' ? fraction : undefined,
      detail: mark(2) === 'active' ? 'The copy you play and log from' : undefined },
    { title: 'Thumbnails and waveform', state: mark(3) },
    { title: 'Transcribe', fraction: undefined,
      state: idx < 4 ? 'waiting' : transcribed && !transcribing ? 'done' : source.transcriptionState === 'failed' && !transcribing ? 'failed' : 'active',
      detail: transcribed && !transcribing ? `${source.transcriptWords} words` : source.transcriptionState === 'failed' ? source.transcriptionError ?? 'Transcription failed'
        : transcribing && started !== null ? `Running · ${clockOf(started)} so far — usually a few minutes` : transcribing ? 'Queued' : idx >= 4 ? 'Not started' : undefined },
  ];
}

function Tracker({ source }: { source: Source }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const steps = stepsOf(source, now);
  return <ol className="tracker" aria-label="Processing steps" data-testid={`tracker-${source.id}`}>
    {steps.map((step, i) => <li key={step.title} className={`tracker-step ${step.state}`} data-testid={`step-${i + 1}-${source.id}`}>
      <span className="tracker-dot" aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : i + 1}</span>
      <div className="tracker-body">
        <div className="tracker-title">{step.title}{typeof step.fraction === 'number' && <span className="subtle"> · {Math.round(step.fraction * 100)}%</span>}</div>
        {typeof step.fraction === 'number' && <div className="progress-track small"><div className="progress-fill" style={{ width: `${Math.round(step.fraction * 100)}%` }} /></div>}
        {step.detail && <div className="tracker-detail">{step.detail}</div>}
      </div>
    </li>)}
  </ol>;
}

/** One file of a shoot: once it is transcribed, a readable row with Log; until then, its steps. */
function SourceRow({ source, onChanged }: { source: Source; onChanged: () => void }) {
  const facts = [source.durationMs != null && length(source.durationMs), source.width && source.height && `${source.width}×${source.height}`,
    source.fps && `${Math.round(source.fps * 100) / 100} fps`].filter(Boolean).join(' · ');
  const playable = source.ingestState === 'ready' && source.hasProxy;
  const transcribed = source.transcriptWords != null;
  const transcribing = source.transcriptionState === 'queued' || source.transcriptionState === 'claimed';
  const loggable = playable && transcribed;
  const [unsnapped, setUnsnapped] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (!window.confirm('Remove this file from the shoot? Its bricks leave the lesson too.')) return;
    try { await removeSource(source.id); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove the file.'); }
  };
  return <div className="source-row" data-testid={`row-source-${source.id}`} title={`File ${source.id}`}>
    <div>
      <div className="source-title">{roles[source.role] ?? source.role} <SourceState source={source} /></div>
      {facts && <div className="source-facts">{facts}</div>}
    </div>
    <div className="source-actions">
      {(loggable || unsnapped) && playable && <Link href={`/sources/${source.id}/log`} className="button button-primary" data-testid={`link-log-${source.id}`}>{loggable ? 'Log' : 'Log without word snapping'}</Link>}
      {!transcribing && source.ingestState !== 'probing' && source.ingestState !== 'proxying' &&
        <button type="button" onClick={() => void remove()} className="button-quiet" data-testid={`button-remove-source-${source.id}`}>Remove</button>}
    </div>
    <div className="source-extra">
      {!loggable && <Tracker source={source} />}
      {loggable && <div className="tracker-done" data-testid={`text-ready-${source.id}`}>✓ Ready to log · {source.transcriptWords} words transcribed</div>}
      {playable && <div><ProxyPlayer sourceId={source.id} /></div>}
      {playable && <div className="source-actions" style={{ justifyContent: 'flex-start' }}><TranscriptView source={source} />
        {source.transcriptionState === 'failed' && !transcribed && !unsnapped &&
          <button type="button" className="button-quiet" onClick={() => setUnsnapped(true)} data-testid={`button-log-unsnapped-${source.id}`}>Log without word snapping…</button>}</div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </div>;
}

export function Library({ accountId }: { accountId: string }) {
  const shoots = useListShoots({ query: { queryKey: getListShootsQueryKey(),
    refetchInterval: query => query.state.data?.some(shoot => shoot.lessonRender || shoot.sources.some(source => inFlight.has(source.ingestState) ||
      source.transcriptionState === 'queued' || source.transcriptionState === 'claimed')) ? refreshMs : false } });
  const create = useCreateShoot();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [shotOn, setShotOn] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const archived = useListArchivedShoots({ query: { queryKey: getListArchivedShootsQueryKey(), enabled: showArchived } });
  const refresh = () => { void client.invalidateQueries({ queryKey: getListShootsQueryKey() }); void client.invalidateQueries({ queryKey: getListArchivedShootsQueryKey() }); };
  return <section>
    <div className="page-head">
      <p className="eyebrow">Production studio</p>
      <h1>Library</h1>
      <p className="subtle">Every shoot and its files. Log a file to mark its bricks, then open the shoot's lesson to put them together.</p>
    </div>
    {shoots.isLoading && <p role="status">Loading shoots…</p>}
    {shoots.isError && <p className="error" role="alert">Could not load shoots. <button type="button" onClick={() => shoots.refetch()} data-testid="button-retry-shoots">Retry</button></p>}
    {shoots.data?.length === 0 && <div className="card"><p>No shoots yet. Create one below to add its files.</p></div>}
    {shoots.data?.map(shoot => <article className="card" key={shoot.id} data-testid={`shoot-${shoot.id}`} title={`Shoot ${shoot.id}`}>
      <div className="card-head">
        <div>
          <h2>{shoot.name}</h2>
          <p className="shoot-meta">{[shoot.shotOn && `Shot ${shotOnLabel(shoot.shotOn)}`, `${shoot.sources.length} file${shoot.sources.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</p>
          {shoot.notes && <p>{shoot.notes}</p>}
        </div>
        <div className="source-actions">
          {shoot.lessonRender && <span className="pill busy" role="status" data-testid={`text-lesson-render-${shoot.id}`}>Render {shoot.lessonRender.number} · {shoot.lessonRender.state === 'claimed' ? 'rendering…' : 'queued…'}</span>}
          <Link href={`/shoots/${shoot.id}/lesson`} className="button button-primary" data-testid={`link-lesson-${shoot.id}`}>Open lesson</Link>
          <button type="button" className="button-quiet" data-testid={`button-archive-${shoot.id}`} onClick={async () => {
            if (!window.confirm(`Archive “${shoot.name}”? It leaves the library; you can bring it back from Archived shoots. Nothing is erased.`)) return;
            try { await archiveShoot(shoot.id); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not archive the shoot.'); }
          }}>Archive</button>
        </div>
      </div>
      {shoot.sources.length === 0 ? <p className="subtle">No files yet.</p> :
        <div className="source-list">{shoot.sources.map(source => <SourceRow key={source.id} source={source} onChanged={refresh} />)}</div>}
      <UploadManager shootId={shoot.id} accountId={accountId} sources={shoot.sources} />
    </article>)}
    {error && <p className="status-line error" role="alert">{error}</p>}
    <div className="card" style={{ marginTop: 18 }}>
      <details className="fold">
        <summary>New shoot</summary>
        <form className="plain-form" onSubmit={async event => {
          event.preventDefault();
          setError('');
          try {
            await create.mutateAsync({ data: { name: name.trim(), ...(shotOn && { shotOn }), ...(notes.trim() && { notes: notes.trim() }) } });
            setName(''); setShotOn(''); setNotes('');
            await client.invalidateQueries({ queryKey: getListShootsQueryKey() });
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create shoot.'); }
        }}>
          <label htmlFor="shoot-name">Name<input id="shoot-name" required value={name} onChange={event => setName(event.target.value)} data-testid="input-shoot-name" /></label>
          <label htmlFor="shot-on">Shot on<input id="shot-on" type="date" value={shotOn} onChange={event => setShotOn(event.target.value)} data-testid="input-shot-on" /></label>
          <label htmlFor="shoot-notes">Notes<textarea id="shoot-notes" rows={2} value={notes} onChange={event => setNotes(event.target.value)} data-testid="input-shoot-notes" /></label>
          <div><button type="submit" disabled={create.isPending || !name.trim()} data-testid="button-create-shoot">{create.isPending ? 'Creating…' : 'Create shoot'}</button></div>
          {error && <p role="alert" className="error">{error}</p>}
        </form>
      </details>
    </div>
    <div className="card" style={{ marginTop: 18 }}>
      <details className="fold" onToggle={event => setShowArchived((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>Archived shoots</summary>
        {archived.isLoading && <p role="status">Loading…</p>}
        {archived.data?.length === 0 && <p className="subtle">Nothing archived.</p>}
        {archived.data?.map(shoot => <div className="source-row" key={shoot.id} data-testid={`archived-${shoot.id}`}>
          <div><div className="source-title">{shoot.name}</div><div className="source-facts">{shoot.sources.length} file{shoot.sources.length === 1 ? '' : 's'}</div></div>
          <div className="source-actions"><button type="button" data-testid={`button-restore-${shoot.id}`} onClick={async () => {
            try { await restoreShoot(shoot.id); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore the shoot.'); }
          }}>Bring back</button></div>
        </div>)}
      </details>
    </div>
  </section>;
}
