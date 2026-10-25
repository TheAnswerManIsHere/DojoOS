import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListFeedbackQueryKey, getListQuestionsQueryKey, useListQuestions, useSubmitFeedback } from '@workspace/api-client-react';

export function QuestionRail({ feature, page }: { feature: string; page: string }) {
  const client = useQueryClient();
  const questions = useListQuestions({ feature }, { query: { queryKey: getListQuestionsQueryKey({ feature }) } });
  const submit = useSubmitFeedback();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  return <aside className="question-rail" aria-label="Tester questions">
    <h2>Questions</h2>
    {questions.isLoading && <p role="status">Loading questions…</p>}
    {questions.isError && <p className="error" role="alert">Could not load questions. <button type="button" onClick={() => questions.refetch()} data-testid="button-retry-questions">Retry</button></p>}
    {questions.data?.length === 0 && <p className="subtle">No questions for this page.</p>}
    {questions.data?.slice().sort((a, b) => a.position - b.position).map(question =>
      <form key={question.id} className="plain-section" onSubmit={async event => {
        event.preventDefault();
        setErrors(previous => ({ ...previous, [question.key]: '' }));
        try {
          await submit.mutateAsync({ data: { questionKey: question.key, answer: answers[question.key]?.trim() || '', page, state: { feature } } });
          setSent(previous => ({ ...previous, [question.key]: true }));
          client.invalidateQueries({ queryKey: getListFeedbackQueryKey() });
        } catch (cause) {
          // Said beside this question, where it was asked, and the typed answer stays in its box to send again.
          setErrors(previous => ({ ...previous, [question.key]: `Not sent: ${cause instanceof Error ? cause.message : 'could not submit answer.'} Your text is still here; press Submit again.` }));
        }
      }}>
        <label htmlFor={`answer-${question.id}`}>{question.prompt}</label>
        <textarea id={`answer-${question.id}`} rows={3} required value={answers[question.key] || ''} onChange={event => { setAnswers(previous => ({ ...previous, [question.key]: event.target.value })); setSent(previous => ({ ...previous, [question.key]: false })); }} data-testid={`input-answer-${question.id}`} />
        <button type="submit" disabled={submit.isPending || !answers[question.key]?.trim()} data-testid={`button-submit-answer-${question.id}`}>Submit answer</button>
        {sent[question.key] && <p role="status" data-testid={`status-answer-${question.id}`}>Answer submitted.</p>}
        {errors[question.key] && <p className="error" role="alert" data-testid={`error-answer-${question.id}`}>{errors[question.key]}</p>}
      </form>
    )}
  </aside>;
}