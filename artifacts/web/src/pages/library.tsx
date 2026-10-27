import { Link } from 'wouter';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShootsQueryKey, useCreateShoot, useListShoots, type Source } from '@workspace/api-client-react';
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

/** One file of a shoot, as a readable row: what it is, how long, its picture, where it stands, and what can be done. */
function SourceRow({ source }: { source: Source }) {
  const facts = [source.durationMs != null && length(source.durationMs), source.width && source.height && `${source.width}×${source.height}`,
    source.fps && `${Math.round(source.fps * 100) / 100} fps`].filter(Boolean).join(' · ');
  const playable = source.ingestState === 'ready' && source.hasProxy;
  return <div className="source-row" data-testid={`row-source-${source.id}`} title={`File ${source.id}`}>
    <div>
      <div className="source-title">{roles[source.role] ?? source.role} <SourceState source={source} /></div>
      {facts && <div className="source-facts">{facts}</div>}
    </div>
    <div className="source-actions">
      {playable && <Link href={`/sources/${source.id}/log`} className="button button-primary" data-testid={`link-log-${source.id}`}>Log</Link>}
    </div>
    <div className="source-extra">
      {playable && <div><ProxyPlayer sourceId={source.id} /></div>}
      <div className="source-actions" style={{ justifyContent: 'flex-start' }}><TranscriptView source={source} /></div>
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
        </div>
      </div>
      {shoot.sources.length === 0 ? <p className="subtle">No files yet.</p> :
        <div className="source-list">{shoot.sources.map(source => <SourceRow key={source.id} source={source} />)}</div>}
      <UploadManager shootId={shoot.id} accountId={accountId} />
    </article>)}
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
  </section>;
}
