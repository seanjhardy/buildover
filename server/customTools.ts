import {
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

// RequestUserAttention: pauses the agent turn and surfaces a custom UI
// prompt in the client. The tool goes through `canUseTool` → `requestPermission`
// which emits a `permission_request` event and sets the chat status to
// `awaiting_input` until the user responds.
//
// Use this ONLY when a genuine response or decision is needed from the user —
// e.g. a question you cannot answer yourself, or explicit sign-off before a
// risky action. Do NOT use it to report that a step is complete.
//
// If the user clicks "Continue" the tool returns a simple confirmation
// and the agent continues. If the user types feedback and clicks
// "Send feedback", the agent receives a `deny` result containing the feedback
// message and can incorporate it. "Stop" aborts the turn.
const requestUserAttentionTool = tool(
  "RequestUserAttention",
  "Pause and wait for the user to respond or make a decision before continuing. " +
    "Use this ONLY when you genuinely need input from the user — a question they must answer, " +
    "a direction they must choose, or explicit sign-off before a significant action. " +
    "Do NOT use it simply to announce that you have completed a step or finished reading files. " +
    "If you have produced output but have no blocking question, just continue. " +
    "Reserve it strictly for situations where you cannot proceed without the user's response.",
  {
    message: z
      .string()
      .describe(
        "A plain-text sentence stating what you need from the user.",
      ),
    summary: z
      .string()
      .optional()
      .describe(
        "Optional markdown-formatted context to help the user respond (findings, options, decisions, etc.).",
      ),
  },
  async (_args) => {
    // This handler only runs after the user clicks "Continue".
    // The meaningful interaction (feedback, stop) is handled via the
    // `deny` path in the permission system before this is ever called.
    return {
      content: [
        {
          type: "text" as const,
          text: "User acknowledged. You may continue.",
        },
      ],
    };
  },
);

export const customToolsServer = createSdkMcpServer({
  name: "buildover-custom-tools",
  version: "1.0.0",
  tools: [requestUserAttentionTool],
});
