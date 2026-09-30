/**
 * Text selected in an editor, ready for the chat input: the file it came from, then the
 * text in a Markdown code fence tagged with its language, then a blank line for the
 * question. The fence is longer than any run of backticks in the text, so the text cannot
 * close it early.
 */
export function selectionPrompt(fileName: string, languageId: string, text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  const language = languageId === 'plaintext' ? '' : languageId;
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return `From ${fileName}:\n\n${fence}${language}\n${body}${fence}\n\n`;
}

/** The length of the longest run of backticks in `text`, in one pass. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === '`' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
