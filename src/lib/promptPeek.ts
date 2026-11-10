// Which of the user's messages the reader has lost sight of: the newest one
// that starts above the top of the chat's viewport. PromptPeek shows it when
// the pointer rests on the upper part of a chat, so a long reply can be read
// with the message it answers in view.

/** A rendered user message and the viewport y of its top edge. */
export interface MountedPrompt {
  id: string;
  top: number;
}

/**
 * Index into `ids` (every user message in the transcript, oldest first) of the
 * message that the content at viewport y `cutoff` answers, or -1 if none does.
 * `mounted` lists the rendered user messages in document order; older ones can
 * sit outside the loaded history window.
 */
export function indexOfPromptAbove(
  ids: readonly string[],
  mounted: readonly MountedPrompt[],
  cutoff: number,
): number {
  // Nothing rendered is a user message, so the whole loaded window answers
  // the newest one.
  if (mounted.length === 0) return ids.length - 1;
  let owner: string | undefined;
  for (const prompt of mounted) {
    if (prompt.top >= cutoff) break;
    owner = prompt.id;
  }
  if (owner !== undefined) return ids.indexOf(owner);
  // Every rendered message still starts below the cutoff, so the content above
  // them answers the one just before the loaded window, if there is one.
  const first = ids.indexOf(mounted[0].id);
  return first > 0 ? first - 1 : -1;
}
