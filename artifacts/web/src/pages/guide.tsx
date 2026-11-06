// The user guide for Jared, as a page of the app in the app's own look (David, 2026-11-01: "render it out … so it looks
// nice and pretty, has the same look and feel as the rest of the site"). It describes the keys in the three keymap files
// and the labels on screen; a change to either is a change here too.
import type { ReactNode } from 'react';

/** A row of keys: each entry one key cap, so "Shift + ←" reads as two caps joined. */
function Keys({ k }: { k: string }) {
  return <span className="guide-keys">{k.split(' ').map((part, i) =>
    part === '+' || part === '/' || part === 'or' ? <span key={i} className="subtle"> {part} </span> : <kbd key={i}>{part}</kbd>)}</span>;
}

function KeyTable({ rows, label }: { rows: Array<[string, ReactNode]>; label: string }) {
  return <div className="table-scroll"><table className="plain-table guide-table" aria-label={label}>
    <thead><tr><th>Key</th><th>What it does</th></tr></thead>
    <tbody>{rows.map(([k, what]) => <tr key={k}><td><Keys k={k} /></td><td>{what}</td></tr>)}</tbody>
  </table></div>;
}

const sections = [
  ['what', 'What DojoOS does'], ['library', 'Signing in and the library'], ['logging', 'Logging a file'],
  ['editor', 'Original and Edited'], ['lesson', 'The edit: joins and dissolves'], ['render', 'Rendering'],
  ['feedback', 'Giving feedback'], ['test', 'Your test session'], ['rough', 'Known rough edges'],
] as const;

function Section({ id, n, children }: { id: string; n: number; children: ReactNode }) {
  const title = sections.find(([s]) => s === id)?.[1];
  return <section className="card guide-section" id={id} aria-labelledby={`${id}-title`}>
    <p className="eyebrow">Part {n}</p>
    <h2 id={`${id}-title`}>{title}</h2>
    {children}
  </section>;
}

export function GuidePage() {
  return <article className="guide">
    <div className="page-head">
      <p className="eyebrow">User guide</p>
      <h1>DojoOS: a guide for Jared</h1>
      <p className="subtle">You log a shoot once, and DojoOS builds the lesson from your marks. This is an early test version: today is about how it feels to use, not about a finished lesson.</p>
    </div>

    <nav className="card guide-contents" aria-label="Contents">
      <h2>Contents</h2>
      <ol>{sections.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>
    </nav>

    <Section id="what" n={1}>
      <p>There is no editing timeline to learn. You mark the parts worth keeping, put them in order, and press Render.</p>
      <div className="table-scroll"><table className="plain-table guide-table" aria-label="Words used on screen">
        <thead><tr><th>Word</th><th>What it means</th></tr></thead>
        <tbody>
          <tr><td><strong>Shoot</strong></td><td>One filming session, for example one technique demo. It holds the files from that day.</td></tr>
          <tr><td><strong>File</strong></td><td>One recording in a shoot: Camera A, Camera B, or a separate audio recorder.</td></tr>
          <tr><td><strong>Brick</strong></td><td>A stretch of a file you want to keep, from an in point to an out point. Each brick has a number that never changes.</td></tr>
          <tr><td><strong>Action</strong></td><td>What a brick does in the lesson. <em>Keep</em> plays it as filmed. <em>Punch in</em> zooms in on the lower third, centre or upper third of the frame.</td></tr>
          <tr><td><strong>Edit</strong></td><td>Your bricks in order with the gaps between them cut out, and a cut or a dissolve at each join. It is what renders as the lesson.</td></tr>
          <tr><td><strong>Render</strong></td><td>The finished video file DojoOS makes from the lesson, to play or download.</td></tr>
        </tbody>
      </table></div>
      <p className="subtle">Times are shown as minutes:seconds:frames. For example, 1:23:12 means 1 minute, 23 seconds and 12 frames.</p>
    </Section>

    <Section id="library" n={2}>
      <p>Sign in with the username and password David gives you. You land on the <strong>Library</strong>, which lists your shoots. It works in Safari on the iPad and on a computer.</p>
      <p><strong>Create a shoot.</strong> Under <strong>New shoot</strong>, type a name, pick the <strong>Shot on</strong> date and press <strong>Create shoot</strong>.</p>
      <p><strong>Add the files.</strong> Under <strong>Add a file to this shoot</strong>, pick the file's role (Camera A, Camera B or Audio). Then tap <strong>Choose a video or audio file</strong>, or drop the file on that area. Keep the page open until the upload finishes. If it stops, choose the same file again and it carries on from where it stopped.</p>
      <p><strong>Wait for processing.</strong> DojoOS works through five steps on its own and shows each one:</p>
      <ol className="guide-steps">
        <li>Upload</li><li>Check the file</li><li>Make the low-resolution proxy (the light copy you play and log from)</li>
        <li>Thumbnails and waveform</li><li>Transcribe</li>
      </ol>
      <p>The <strong>Log</strong> button appears once a file is transcribed, because your marks snap to the edges of spoken words. It then reads <strong>Continue logging</strong>, and <strong>Open log</strong> once the file is done. Each file shows its status: Not started, In progress or Done.</p>
      <p><strong>Tidy up.</strong> <strong>Archive</strong> moves a shoot out of the way, and <strong>Bring back</strong> under <strong>Archived shoots</strong> restores it. <strong>Remove</strong> deletes one file from a shoot.</p>
    </Section>

    <Section id="logging" n={3}>
      <p>Logging and editing happen in one window. Open a file with <strong>Log</strong> in the library and watch it, marking each part worth keeping as a brick. Press <kbd>I</kbd> where a part starts and <kbd>O</kbd> where it ends. The mark snaps to the nearest word edge; hold <kbd>Shift</kbd> to mark the exact frame instead.</p>
      <ul className="guide-points">
        <li><strong>Fixing as you go.</strong> Press <kbd>I</kbd> again while a brick is still open, and its start moves to the playhead. Press <kbd>O</kbd> again, and its end moves. After <kbd>O</kbd>, the next <kbd>I</kbd> starts a new brick.</li>
        <li><strong>Fixing an older brick.</strong> Tap it on the strip, or press <kbd>Tab</kbd>, to pick it. Then <kbd>I</kbd> and <kbd>O</kbd> move its edges to the playhead, <kbd>[</kbd> <kbd>]</kbd> and <kbd>,</kbd> <kbd>.</kbd> step them a word at a time (with Shift: a frame), and you can drag its two handles on the strip. <kbd>B</kbd> and <kbd>E</kbd> jump to its first and last frame. Tap an empty part of the strip to let go of it.</li>
        <li><strong>The strip.</strong> It shows the waveform and your bricks. Bricks that overlap stack in separate rows. Colour shows the label: blue for lesson, orange for short, purple for highlight, grey for none. Tap or drag on the strip to move around.</li>
        <li><strong>Zooming.</strong> <kbd>=</kbd> and <kbd>-</kbd> zoom in and out around the playhead, and <kbd>\</kbd> shows the whole file. You can also use the <strong>+</strong>, <strong>−</strong> and <strong>Fit</strong> buttons, Ctrl or ⌘ with the scroll wheel, or a pinch. Zoomed in, a scroll bar appears under the strip; drag its ends to zoom.</li>
        <li><strong>The transcript.</strong> It shows 3 lines, or 5, or the full transcript. The lines hold still while the highlighted word moves, then the next lines come up. Tap a word to jump to it.</li>
        <li><strong>Describing a brick.</strong> <kbd>N</kbd> writes a note. Turn on <strong>Automatic note creation</strong> and the note box opens by itself each time <kbd>O</kbd> closes a brick; the video waits while you type, and Enter carries on. <kbd>A</kbd> steps through the actions: keep, then punch in at the lower third, the centre and the upper third. The <strong>Lesson</strong>, <strong>Short</strong> and <strong>Highlight</strong> chips in the table label a brick.</li>
        <li><strong>Seeing the actions.</strong> <kbd>S</kbd> shows a punch-in zoomed, the way the render will frame it.</li>
        <li><strong>Finishing.</strong> Press <strong>I'm done logging</strong>. Done never locks anything: <strong>Mark as in progress</strong> reopens the file.</li>
      </ul>
      <KeyTable label="Editing keys" rows={[
        ['Space', 'Play or pause'],
        ['← →', 'Previous or next word. With no word within 5 seconds, jump 1 second.'],
        ['Shift + ← →', 'Jump 5 seconds'],
        ['Option + ← →', 'Step one frame'],
        ['J / K / L', 'Slower, normal speed, faster (0.25× to 2×)'],
        ['I / O', 'Start or end a brick at a word edge; again, to move that edge (with Shift: the exact frame)'],
        ['Tab', 'Pick the next brick (with Shift: the previous one)'],
        ['B / E', "Go to the brick's first or last frame"],
        ['[ / ]', 'Move the in point one word earlier or later (with Shift: one frame)'],
        [', / .', 'Move the out point one word earlier or later (with Shift: one frame)'],
        ['= / -', 'Zoom the strip in or out'],
        ['\\', 'Show the whole file'],
        ['N', 'Write a note on the brick'],
        ['A', "Change the brick's action"],
        ['S', 'Show actions on or off'],
        ['V', 'Switch between Original and Edited'],
        ['Delete', 'Remove the brick (it asks first)'],
        ['Esc', 'Undo (with Shift: redo)'],
      ]} />
      <p className="subtle">If the keys stop working after you type a note, tap <strong>Use the keys here</strong>.</p>
    </Section>

    <Section id="editor" n={4}>
      <p>The <strong>Original</strong> and <strong>Edited</strong> switch at the top of the page, or <kbd>V</kbd>, flips between the file as filmed and the edit. The edit is every brick of the shoot in order, file by file, with everything between bricks cut out. Where bricks overlap, that stretch plays once. The switch keeps your place: you land on the same moment, or on the next brick if you were in a part the edit leaves out.</p>
      <p>To change what is in the edit, change the bricks in the Original view. The edit follows them.</p>
    </Section>

    <Section id="lesson" n={5}>
      <p>In the Edited view, <kbd>Space</kbd> plays the edit. Cuts, dissolves and punch-ins play live, with no render needed. The strip zooms the same way as in the Original view.</p>
      <ul className="guide-points">
        <li><strong>Joins.</strong> Every join between two bricks starts as a cut. Pick a brick with <kbd>Tab</kbd>, or tap a join on the strip, and press <kbd>D</kbd> or tap <strong>Dissolve</strong> to dissolve into the next brick.</li>
        <li><strong>Dissolve length.</strong> A new dissolve lasts 1 second. Type another length in seconds under the strip, or drag either end of the dissolve's band. If a length is too long for the bricks either side, the page says the longest that fits.</li>
        <li><strong>Actions.</strong> Show actions is on here. <kbd>S</kbd> switches to the footage as filmed.</li>
        <li><strong>Back to a file.</strong> <kbd>V</kbd> or <strong>Original</strong> opens the file that is playing, at the same moment.</li>
      </ul>
      <KeyTable label="Edited view keys" rows={[
        ['Space', 'Play or pause from the playhead'],
        ['← → J K L', 'Move and change speed, as on every player'],
        ['Tab', 'Pick the next brick (with Shift: the previous one)'],
        ['D', 'Cut or dissolve after the picked brick'],
        ['= / - / \\', 'Zoom in, out, whole edit'],
        ['S', 'Show actions on or off'],
        ['Esc', 'Undo'],
        ['R', 'Render'],
        ['V', 'Back to the Original view'],
      ]} />
      <p className="status-line">If a dissolve plays slowly on the iPad, the page says how many frames a second it managed. Please write that number down for David.</p>
    </Section>

    <Section id="render" n={6}>
      <p>A render makes the finished, full-quality file from your original footage. In the Edited view, press <kbd>R</kbd>, or <strong>Render (R)</strong> under <strong>Renders</strong>.</p>
      <p>Each render is numbered and shows its state as it goes. You can keep working meanwhile. When it is ready, <strong>Play</strong> shows it on the page and <strong>Download</strong> saves the file. A new render never replaces an old one, so you can compare versions.</p>
    </Section>

    <Section id="feedback" n={7}>
      <p>Your answers decide what gets built next, so short and honest beats long and polite.</p>
      <ul className="guide-points">
        <li><strong>The questions on each page.</strong> The editing page asks a few questions, in a column beside the page or behind the <strong>Questions</strong> button on the iPad. Type an answer and press <strong>Submit answer</strong>. Everything you send is on the <strong>Feedback</strong> page.</li>
        <li><strong>Report a key problem.</strong> On the logging page, if a key did nothing or the wrong thing, tap it straight away. Your last few key presses go with it.</li>
        <li><strong>Anything else.</strong> Tell David what confused you, what you expected, and what you would change. A screenshot or a screen recording helps a lot.</li>
      </ul>
    </Section>

    <Section id="test" n={8}>
      <p>Run one real shoot from upload to rendered file, the way you would on a normal day. Plan on about an hour.</p>
      <ol className="guide-checklist">
        <li>Create a shoot for a short real demo (5 to 10 minutes of footage is plenty).</li>
        <li>Upload Camera A, plus Camera B or Audio if you have them. Watch the five steps finish.</li>
        <li>Open the log for Camera A, and note the time you start.</li>
        <li>Mark the bricks you would keep with <kbd>I</kbd> and <kbd>O</kbd>, leaving out flubs and dead air.</li>
        <li>Give two bricks a note, and set one to a punch-in with <kbd>A</kbd>.</li>
        <li>Press <kbd>S</kbd> to check the punch-in frames the right part of the picture.</li>
        <li>Pick one brick, zoom in with <kbd>=</kbd>, and drag one of its edges to the exact frame.</li>
        <li>Press <strong>I'm done logging</strong>, and note the time you finish.</li>
        <li>Press <kbd>V</kbd> for the Edited view and watch the edit with the gaps gone.</li>
        <li>Set one dissolve with <kbd>D</kbd>, change its length, and play through it. Write down any slow-dissolve message.</li>
        <li>Press <kbd>R</kbd>. When the render is ready, play it and download it.</li>
        <li>Check the render against the preview: same order, same cuts, punch-in framed the same.</li>
        <li>Answer the questions on the editing page, and tell David anything that confused you.</li>
      </ol>
    </Section>

    <Section id="rough" n={9}>
      <ul className="guide-points">
        <li><strong>The video may go blank</strong> after the iPad has been idle or Safari has been in the background. It should come back on its own in a few seconds; if not, reload the page. Your bricks are saved as you go.</li>
        <li><strong>Dissolves may play slowly on the iPad.</strong> The rendered file is not affected.</li>
        <li><strong>A file cannot be logged until it is transcribed,</strong> and a long file takes a while.</li>
        <li><strong>Your footage is private.</strong> It is kept in a private store, and its links expire after a few minutes. Nothing is published anywhere.</li>
      </ul>
    </Section>
  </article>;
}
