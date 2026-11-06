// PROTOTYPE — AI Rename (David, 2026-11-06: "an 'AI Rename' button that will rename the file based on its content"). A
// short descriptive name for a file, written by a small, cheap model from the file's transcript and its shoot's name. The
// words are what a clip is about, and reading text costs a fraction of a cent a file; the picture is not sent. The key is
// the Repl's ANTHROPIC_API_KEY secret; without it the page says so and nothing is called.
const model = process.env.AI_RENAME_MODEL || "claude-haiku-5-5";
/** About the first ten minutes of talk is plenty to say what a clip is. */
const maxChars = 12_000;

export async function suggestName(input: { shootName: string; fileName: string | null; text: string }): Promise<{ name: string } | { error: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "AI Rename is not set up yet: the AI service's key has not been added to the app." };
  const prompt = [
    `A physical-therapy continuing-education video shoot called "${input.shootName}" has a file${input.fileName ? ` named "${input.fileName}"` : ""}.`,
    "Below is the transcript of what is said in it. Give the file a short descriptive name, 3 to 8 words, that says what it",
    "shows — the technique, the body region, the position — in plain words a clinician would use, for example",
    "\"Psoas release, side-lying demo\". Answer with the name only: no quotes, no file extension, no full stop.",
    "", "Transcript:", input.text.slice(0, maxChars),
  ].join("\n");
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 40, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { error: `The AI service answered ${response.status}; try again in a moment.` };
    const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const name = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim()
      .replace(/^["'“”]+|["'“”.]+$/g, "").replace(/\s+/g, " ").slice(0, 120);
    return name ? { name } : { error: "The AI service gave no name; try again." };
  } catch {
    return { error: "Could not reach the AI service; try again in a moment." };
  }
}
