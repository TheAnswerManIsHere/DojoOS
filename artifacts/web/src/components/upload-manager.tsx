import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShootsQueryKey, removeSource, useCompleteUpload, useSignPart, useStartUpload, type Source, type UploadInputRole } from '@workspace/api-client-react';

const CHUNK_SIZE = 8 * 1024 * 1024;
/** A dropped part is tried again on its own this many times, waiting longer each time, before the upload stops. */
const PART_RETRIES = [1000, 4000, 12000];
type Descriptor = {
  id: string;
  uploadId: string;
  shootId: string;
  role: UploadInputRole;
  fileName: string;
  size: number;
  lastModified: number;
  parts: { partNumber: number; etag: string }[];
};
const roles: Record<string, string> = { camera_a: 'Camera A', camera_b: 'Camera B', audio: 'Audio' };
const megabytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
const partsOf = (d: Descriptor) => Math.max(1, Math.ceil(d.size / CHUNK_SIZE));
const sameFile = (d: Descriptor, file: File) => d.fileName === file.name && d.size === file.size && d.lastModified === file.lastModified;

function load(key: string): Descriptor[] {
  try { const saved = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(saved) ? saved : []; }
  catch { return []; }
}

function putPart(url: string, blob: Blob, onProgress: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onerror = () => reject(new Error('the connection to storage dropped'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(`storage answered ${xhr.status}`)); return; }
      const etag = xhr.getResponseHeader('ETag');
      if (!etag) { reject(new Error('storage did not return the part’s tag (check ETag is exposed in the bucket’s CORS settings)')); return; }
      resolve(etag);
    };
    xhr.send(blob);
  });
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Adding a file to a shoot. One place to choose it: a file that matches an unfinished upload of this shoot (same name,
 * size and date) continues that upload from where it stopped; any other file starts a new one. A stopped upload says
 * how far it got and what to do, and can be discarded, which cancels it in storage. */
export function UploadManager({ shootId, accountId, sources }: { shootId: string; accountId: string; sources: Source[] }) {
  const key = `dojoos:uploads:${accountId}`;
  const [all, setAll] = useState<Descriptor[]>(() => load(key));
  const [role, setRole] = useState<UploadInputRole>('camera_a');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const start = useStartUpload();
  const sign = useSignPart();
  const complete = useCompleteUpload();
  const client = useQueryClient();
  function save(next: Descriptor[]) { setAll(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* the upload still runs */ } }

  // An unfinished upload this browser remembers but the library no longer shows as uploading (finished, or removed) is
  // forgotten, so the page never shows a stale "in progress".
  const uploading = new Set(sources.filter(s => s.ingestState === 'uploading').map(s => s.id));
  const pending = all.filter(item => item.shootId === shootId && uploading.has(item.id));
  useEffect(() => {
    const stale = load(key).filter(item => item.shootId === shootId && !uploading.has(item.id) && item.id !== busyId);
    if (stale.length) save(load(key).filter(item => !stale.some(s => s.id === item.id)));
  }, [sources.map(s => `${s.id}:${s.ingestState}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function transfer(initial: Descriptor, file: File) {
    setBusyId(initial.id); setError(''); setNotice('');
    let current = initial;
    try {
      const total = partsOf(initial);
      for (let partNumber = 1; partNumber <= total; partNumber++) {
        if (current.parts.some(part => part.partNumber === partNumber)) continue;
        const from = (partNumber - 1) * CHUNK_SIZE;
        const blob = file.slice(from, Math.min(from + CHUNK_SIZE, file.size));
        let etag = '';
        for (let attempt = 0; ; attempt++) {
          try {
            // A fresh signature each attempt: a signed address lasts fifteen minutes.
            const signed = await sign.mutateAsync({ id: current.id, data: { uploadId: current.uploadId, partNumber } });
            etag = await putPart(signed.url, blob, loaded => setProgress(previous => ({ ...previous, [current.id]: Math.min(100, Math.round(((from + loaded) / current.size) * 100)) })));
            break;
          } catch (cause) {
            if (attempt >= PART_RETRIES.length) throw cause;
            setNotice(`Part ${partNumber} of ${total} didn’t go through; trying again…`);
            await wait(PART_RETRIES[attempt]);
            setNotice('');
          }
        }
        current = { ...current, parts: [...current.parts, { partNumber, etag }] };
        save(load(key).filter(item => item.id !== current.id).concat(current));
      }
      await complete.mutateAsync({ id: current.id, data: { uploadId: current.uploadId, parts: current.parts.slice().sort((a, b) => a.partNumber - b.partNumber) } });
      save(load(key).filter(item => item.id !== current.id));
      setProgress(previous => { const next = { ...previous }; delete next[current.id]; return next; });
      setNotice(`${current.fileName} is uploaded. Processing has started — follow it in the file’s steps above.`);
      await client.invalidateQueries({ queryKey: getListShootsQueryKey() });
    } catch (cause) {
      const done = current.parts.length, total = partsOf(current);
      setError(`The upload of ${current.fileName} stopped at part ${done} of ${total} (${cause instanceof Error ? cause.message : 'the connection dropped'}). ` +
        'Choose the same file again and it will continue from there.');
    } finally { setBusyId(null); }
  }

  /** One file chosen or dropped: continue its unfinished upload if there is one, else start a new upload. */
  async function choose(file: File) {
    setError(''); setNotice('');
    const resume = pending.find(item => sameFile(item, file));
    if (resume) { await transfer(resume, file); return; }
    try {
      const upload = await start.mutateAsync({ data: { shootId, role, fileName: file.name, contentType: file.type || 'application/octet-stream' } });
      const descriptor: Descriptor = { id: upload.id, uploadId: upload.uploadId, shootId, role, fileName: file.name, size: file.size, lastModified: file.lastModified, parts: [] };
      save(load(key).concat(descriptor));
      await client.invalidateQueries({ queryKey: getListShootsQueryKey() });
      await transfer(descriptor, file);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start the upload.'); }
  }

  async function discard(item: Descriptor) {
    if (!window.confirm(`Discard the unfinished upload of ${item.fileName}? What has been sent so far is thrown away.`)) return;
    setError('');
    try {
      await removeSource(item.id);
      save(load(key).filter(d => d.id !== item.id));
      await client.invalidateQueries({ queryKey: getListShootsQueryKey() });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not discard the upload.'); }
  }

  const busy = !!busyId || start.isPending;
  return <section className="uploader">
    {pending.map(item => {
      const done = item.parts.length, total = partsOf(item);
      const pct = progress[item.id] ?? Math.round((done / total) * 100);
      const running = busyId === item.id;
      return <div className="upload-row" key={item.id} data-testid={`row-pending-upload-${item.id}`}>
        <div className="upload-row-head"><strong>{item.fileName}</strong><span className="subtle">{roles[item.role] ?? item.role} · {megabytes(item.size)}</span></div>
        <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} data-testid={`progress-upload-${item.id}`}>
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        {running ? <p className="subtle">Uploading · {pct}% · part {Math.min(done + 1, total)} of {total}</p>
          : <p className="upload-stopped">Stopped at part {done} of {total}. <strong>Choose the same file below to continue from there</strong> — nothing already sent is lost.</p>}
        {!running && <div><button type="button" onClick={() => void discard(item)} data-testid={`button-discard-upload-${item.id}`}>Discard this upload</button></div>}
      </div>;
    })}
    <details className="fold" open={pending.length > 0 || undefined}>
      <summary>{pending.length ? 'Choose a file' : 'Add a file to this shoot'}</summary>
      <div className="plain-form">
        <label htmlFor={`role-${shootId}`}>What is it?<select id={`role-${shootId}`} value={role} onChange={event => setRole(event.target.value as UploadInputRole)} disabled={busy} data-testid={`select-role-${shootId}`}>
          <option value="camera_a">Camera A</option><option value="camera_b">Camera B</option><option value="audio">Audio</option>
        </select></label>
        <label className={`drop-zone${dragging ? ' dragging' : ''}${busy ? ' disabled' : ''}`}
          onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file && !busy) void choose(file); }}>
          <input ref={input} type="file" accept="video/*,audio/*" className="sr-only" disabled={busy} data-testid={`input-source-file-${shootId}`}
            onChange={event => { const file = event.target.files?.[0]; if (file) void choose(file); event.target.value = ''; }} />
          <span className="drop-zone-title">{busy ? 'Uploading…' : 'Choose a video or audio file'}</span>
          <span className="subtle">{busy ? 'Keep this page open until it finishes.' : pending.length ? 'Choosing the file of a stopped upload continues it; any other file starts a new upload.' : 'Tap to pick from your files, or drop one here.'}</span>
        </label>
      </div>
    </details>
    {error && <p className="status-line error" role="alert" data-testid={`status-upload-error-${shootId}`}>{error}</p>}
    {notice && <p className="status-line" role="status" data-testid={`status-upload-success-${shootId}`}>{notice}</p>}
  </section>;
}
