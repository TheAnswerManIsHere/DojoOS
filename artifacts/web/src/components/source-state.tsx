import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShootsQueryKey, retryIngest, type Source } from '@workspace/api-client-react';

/** The ingest state as the library shows it: the state, the error a failed ingest left, and the operator's retry
 * (architecture.md §2: "failed with the error text … the operator retries from the page"). */
export function SourceState({ source }: { source: Source }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <>
    <span data-testid={`text-ingest-state-${source.id}`}>{source.ingestState}</span>
    {source.lastError && <p className="error" data-testid={`text-ingest-error-${source.id}`}>{source.lastError}</p>}
    {source.retryable && <div><button type="button" disabled={busy} data-testid={`button-retry-ingest-${source.id}`} onClick={async () => {
      setBusy(true); setError('');
      try { await retryIngest(source.id); await client.invalidateQueries({ queryKey: getListShootsQueryKey() }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not queue the source again.'); }
      finally { setBusy(false); }
    }}>{busy ? 'Queuing…' : 'Process again'}</button></div>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}
