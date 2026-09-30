# Changelog

Release notes for each version are on the repository's GitHub releases page,
generated from the conventional commits since the previous release.

## Unreleased

### Chat

- Messages take the panel's full width; the avatars are small marks beside the time, and a
  narrow panel opens the conversations list over the chat.
- Each crew answer shows how long the crew took, next to its time. Conversations saved
  before this show the time alone.
- Under each message, buttons for Copy, Ask again, and Edit and resend (your questions), or
  Copy and Ask the question again (crew answers), shown on hover or keyboard focus.
- Rename and Delete in a chat's header, beside Copy and Save. A conversation keeps its
  first question as its name until renamed; Delete asks first, removes the saved file, and
  closes the panel.
- Failures stay visible. An agent's card says what it found in plain words and turns red
  when the agent failed or could not run; when the turn ends, what went wrong (a failed or
  unfinished agent, a gateway error, a timeout, a stop) is kept under the answer or notice,
  saved with the conversation, and included in the Markdown export. The export also gives
  each answer's duration, and its last section is now "Agent activity".
- An agent's card says when the agent is starting up or ready.
- Ask Crew about Selection, in the editor's context menu: pick a crew, and its chat opens
  with the selected text in the input, fenced with its file name and language.
