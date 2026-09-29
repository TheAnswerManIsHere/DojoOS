import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListShootsQueryKey, useCompleteUpload, useSignPart, useStartUpload, type UploadInputRole } from '@workspace/api-client-react';

const CHUNK_SIZE = 8 * 1024 * 1024;
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

function load(key: string): Descriptor[] {
  try { const saved = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(saved) ? saved : []; }
  catch { return []; }
}

function putPart(url: string, blob: Blob, onProgress: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onerror = () => reject(new Error('Storage upload failed. Select the same file and retry.'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(`Storage returned ${xhr.status}. Select the same file and retry.`)); return; }
      const etag = xhr.getResponseHeader('ETag');
      if (!etag) { reject(new Error('Storage did not expose an ETag. Confirm ETag is exposed in storage CORS settings.')); return; }
      resolve(etag);
    };
    xhr.send(blob);
  });
}

export function UploadManager({ shootId, accountId }: { shootId: string; accountId: string }) {
  const key = `dojoos:uploads:${accountId}`;
  const [all, setAll] = useState<Descriptor[]>(() => load(key));
  const [role, setRole] = useState<UploadInputRole>('camera_a');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const start = useStartUpload();
  const sign = useSignPart();
  const complete = useCompleteUpload();
  const client = useQueryClient();
  const pending = all.filter(item => item.shootId === shootId);
  function save(next: Descriptor[]) { setAll(next); localStorage.setItem(key, JSON.stringify(next)); }

  async function transfer(initial: Descriptor, file?: File) {
    setBusyId(initial.id); setError(''); setNotice('');
    let current = initial;
    try {
      const total = Math.max(1, Math.ceil(initial.size / CHUNK_SIZE));
      if (current.parts.length < total && !file) throw new Error('Select the original file to resume this upload.');
      if (file && (file.name !== current.fileName || file.size !== current.size || file.lastModified !== current.lastModified)) {
        throw new Error('This is not the original file. Select the same file to resume.');
      }
      for (let partNumber = 1; partNumber <= total; partNumber++) {
        if (current.parts.some(part => part.partNumber === partNumber)) continue;
        const from = (partNumber - 1) * CHUNK_SIZE;
        const blob = file!.slice(from, Math.min(from + CHUNK_SIZE, file!.size));
        const signed = await sign.mutateAsync({ id: current.id, data: { uploadId: current.uploadId, partNumber } });
        const etag = await putPart(signed.url, blob, loaded => setProgress(previous => ({ ...previous, [current.id]: Math.min(100, Math.round(((from + loaded) / current.size) * 100)) })));
        current = { ...current, parts: [...current.parts, { partNumber, etag }] };
        save(load(key).filter(item => item.id !== current.id).concat(current));
      }
      await complete.mutateAsync({ id: current.id, data: { uploadId: current.uploadId, parts: current.parts.slice().sort((a, b) => a.partNumber - b.partNumber) } });
      save(load(key).filter(item => item.id !== current.id));
      setProgress(previous => { const next = { ...previous }; delete next[current.id]; return next; });
      setNotice(`${current.fileName} uploaded.`);
      await client.invalidateQueries({ queryKey: getListShootsQueryKey() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed. Select the same file and retry.');
    } finally { setBusyId(null); }
  }

  return <section className="plain-section">
    <h3>Upload source</h3>
    <form className="plain-form" onSubmit={async event => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem('source-file') as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      setError(''); setNotice('');
      try {
        const upload = await start.mutateAsync({ data: { shootId, role, fileName: file.name, contentType: file.type || 'application/octet-stream' } });
        const descriptor: Descriptor = { id: upload.id, uploadId: upload.uploadId, shootId, role, fileName: file.name, size: file.size, lastModified: file.lastModified, parts: [] };
        save(load(key).concat(descriptor));
        input.value = '';
        await transfer(descriptor, file);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start upload.'); }
    }}>
      <label htmlFor={`role-${shootId}`}>Role<select id={`role-${shootId}`} value={role} onChange={event => setRole(event.target.value as UploadInputRole)} data-testid={`select-role-${shootId}`}>
        <option value="camera_a">Camera A</option><option value="camera_b">Camera B</option><option value="audio">Audio</option>
      </select></label>
      <label htmlFor={`file-${shootId}`}>File<input id={`file-${shootId}`} name="source-file" type="file" accept="video/*,audio/*" required data-testid={`input-source-file-${shootId}`} /></label>
      <div><button type="submit" disabled={!!busyId || start.isPending} data-testid={`button-upload-source-${shootId}`}>Upload</button></div>
    </form>
    {pending.length > 0 && <div className="plain-section"><h3>Pending uploads</h3>{pending.map(item =>
      <div className="plain-row" key={item.id} data-testid={`row-pending-upload-${item.id}`}>
        <p>{item.fileName} · {item.role} · {item.parts.length}/{Math.max(1, Math.ceil(item.size / CHUNK_SIZE))} parts</p>
        {busyId === item.id && <><progress className="upload-progress" max={100} value={progress[item.id] ?? Math.round((item.parts.length * CHUNK_SIZE / Math.max(1, item.size)) * 100)} data-testid={`progress-upload-${item.id}`} /><span> {progress[item.id] ?? Math.round((item.parts.length * CHUNK_SIZE / Math.max(1, item.size)) * 100)}%</span></>}
        <label htmlFor={`resume-${item.id}`}>Select original file to resume<input id={`resume-${item.id}`} type="file" accept="video/*,audio/*" disabled={!!busyId} onChange={event => { const file = event.target.files?.[0]; if (file) void transfer(item, file); event.target.value = ''; }} data-testid={`input-resume-upload-${item.id}`} /></label>
        {item.parts.length === Math.max(1, Math.ceil(item.size / CHUNK_SIZE)) && <button type="button" disabled={!!busyId} onClick={() => void transfer(item)} data-testid={`button-complete-upload-${item.id}`}>Complete upload</button>}
      </div>)}</div>}
    {error && <p className="error" role="alert" data-testid={`status-upload-error-${shootId}`}>{error}</p>}
    {notice && <p role="status" data-testid={`status-upload-success-${shootId}`}>{notice}</p>}
  </section>;
}