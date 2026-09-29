import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShootsQueryKey, useCreateShoot, useListShoots } from '@workspace/api-client-react';
import { UploadManager } from '@/components/upload-manager';

export function Library({ accountId }: { accountId: string }) {
  const shoots = useListShoots();
  const create = useCreateShoot();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [shotOn, setShotOn] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  return <section>
    <h1>Library</h1>
    <section className="plain-section">
      <h2>Create shoot</h2>
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
    </section>
    <section className="plain-section">
      <h2>Shoots</h2>
      {shoots.isLoading && <p role="status">Loading shoots…</p>}
      {shoots.isError && <p className="error" role="alert">Could not load shoots. <button type="button" onClick={() => shoots.refetch()} data-testid="button-retry-shoots">Retry</button></p>}
      {shoots.data?.length === 0 && <p>No shoots yet. Create one to add source files.</p>}
      {shoots.data?.map(shoot => <article className="plain-row" key={shoot.id} data-testid={`shoot-${shoot.id}`}>
        <h3>{shoot.name}</h3>
        {shoot.shotOn && <p>Shot on: {shoot.shotOn}</p>}
        {shoot.notes && <p>{shoot.notes}</p>}
        <p className="subtle">ID: {shoot.id}</p>
        <h3>Sources</h3>
        {shoot.sources.length === 0 ? <p>No sources yet.</p> :
          <div className="table-scroll"><table className="plain-table">
            <thead><tr><th>ID</th><th>Role</th><th>Ingest state</th><th>Duration</th><th>Width</th><th>Height</th><th>FPS</th></tr></thead>
            <tbody>{shoot.sources.map(source => <tr key={source.id} data-testid={`row-source-${source.id}`}>
              <td>{source.id}</td><td>{source.role}</td><td>{source.ingestState}</td><td>{source.durationMs == null ? '—' : `${source.durationMs} ms`}</td><td>{source.width ?? '—'}</td><td>{source.height ?? '—'}</td><td>{source.fps ?? '—'}</td>
            </tr>)}</tbody>
          </table></div>}
        <UploadManager shootId={shoot.id} accountId={accountId} />
      </article>)}
    </section>
  </section>;
}