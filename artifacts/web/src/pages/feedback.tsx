import { useListFeedback, useListQuestions, getListQuestionsQueryKey } from '@workspace/api-client-react';

const pageName = (page: string) => page === '/library' ? 'Library' : page.endsWith('/log') ? 'Logging' : page.endsWith('/lesson') ? 'Lesson' : page;

/** Every answer from the rail, newest first, with its question in words where the question is still asked. */
export function FeedbackPage() {
  const feedback = useListFeedback();
  const prompts = new Map<string, string>();
  for (const feature of ['logging-viewer', 'lesson-timeline', 'library']) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed list, called in the same order every render
    const q = useListQuestions({ feature }, { query: { queryKey: getListQuestionsQueryKey({ feature }) } });
    for (const item of q.data ?? []) prompts.set(item.key, item.prompt);
  }
  return <section>
    <div className="page-head">
      <p className="eyebrow">What you've told us</p>
      <h1>Feedback</h1>
    </div>
    {feedback.isLoading && <p role="status">Loading feedback…</p>}
    {feedback.isError && <p className="error" role="alert">Could not load feedback. <button type="button" onClick={() => feedback.refetch()} data-testid="button-retry-feedback">Retry</button></p>}
    {feedback.data?.length === 0 && <div className="card"><p>No feedback yet.</p></div>}
    {feedback.data?.map(item => <article className="card" key={item.id} data-testid={`row-feedback-${item.id}`}>
      <p className="eyebrow">{pageName(item.page)} · {new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
      <h3>{prompts.get(item.questionKey) ?? item.questionKey}</h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{item.answer}</p>
      <details className="subtle"><summary>Details</summary><p>Build {item.buildVersion} · question {item.questionKey} · page {item.page} · by {item.userId}</p>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(item.state, null, 2)}</pre></details>
    </article>)}
  </section>;
}
