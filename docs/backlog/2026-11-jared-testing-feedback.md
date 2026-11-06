# Backlog — feedback from testing with Jared (2026-11-06)

Working notes while David feeds the list item by item. Each entry: what he
asked for, what the code does today, the recommendation, open questions.

## 1. Bulk upload — pick or drop many files, start them in one go

**Asked:** open a folder, multi-select files, start the whole transfer at
once, without pressing "add a file" again for each one.

**Today:** `artifacts/web/src/components/upload-manager.tsx` reads only
`files?.[0]` from the picker and from a drop, and one *What is it?* role
(Camera A / Camera B / Audio) applies to the single file. The server already
allows any number of files per role on a shoot, so this is a browser-only
change (the uploader is in the Ingest feature, prototype phase).

**Recommendation:**
- Picker and drop zone accept many files (`multiple`).
- The chosen files appear as a list. Each row shows a role that is guessed
  and can be changed: an audio file → Audio, a video → Camera A. Then one
  **Upload all** button.
- Files go up one at a time, in order. Bandwidth is the limit, so running
  them in parallel would not finish the batch sooner, and it would hide
  which file is in flight. Each row shows its own progress and status.
- A file that stops does not stop the batch. The next file starts, and
  choosing the stopped files again continues them, as now.
- Not now: picking a whole folder (`webkitdirectory`). It brings camera
  sidecar files (.XML, .THM) along, and in a normal multi-select Jared
  can already press Ctrl/⌘-A inside the folder.

**Open question for David/Jared:** can the file names tell Camera A from
Camera B (for example, different filename prefixes per camera)? If they
can, the role is guessed from the name; if not, every video starts as
Camera A and Jared changes the B files.
