import { useListFeedback } from '@workspace/api-client-react';

export function FeedbackPage() {
  const feedback = useListFeedback();
  return <section>
    <h1>Feedback</h1>
    {feedback.isLoading && <p role="status">Loading feedback…</p>}
    {feedback.isError && <p className="error" role="alert">Could not load feedback. <button type="button" onClick={() => feedback.refetch()} data-testid="button-retry-feedback">Retry</button></p>}
    {feedback.data?.length === 0 && <p>No feedback yet.</p>}
    {!!feedback.data?.length && <div className="table-scroll"><table className="plain-table">
      <thead><tr><th>Date</th><th>User</th><th>Question</th><th>Answer</th><th>Page</th><th>Build</th><th>State</th></tr></thead>
      <tbody>{feedback.data.map(item => <tr key={item.id} data-testid={`row-feedback-${item.id}`}>
        <td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.userId}</td><td>{item.questionKey}</td><td>{item.answer}</td><td>{item.page}</td><td>{item.buildVersion}</td><td><pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(item.state, null, 2)}</pre></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}