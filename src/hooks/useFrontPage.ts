import { useMemo } from "react";
import type { ChatTurn } from "./useAgent.js";
import type { ContentBlock } from "../types.js";
import { foldPage, pageEntries, type FrontPage } from "../lib/frontPage.js";

/**
 * The chat's front page, folded from its page-tool calls (see frontPage.ts).
 * Only the user's own messages count as answers; subagent and system messages
 * don't clear the offered options.
 */
export function useFrontPage(turns: ChatTurn[]): FrontPage {
  return useMemo(
    () =>
      foldPage(
        pageEntries(
          turns.flatMap((t): Array<{ user: true } | { blocks: ContentBlock[] }> =>
            t.kind === "user"
              ? (t.origin ?? "user") === "user"
                ? [{ user: true as const }]
                : []
              : t.kind === "assistant" || t.kind === "tool_results"
                ? [{ blocks: t.content }]
                : [],
          ),
        ),
      ),
    [turns],
  );
}
