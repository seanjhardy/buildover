import {
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

// Callback type: the tool handler calls this and awaits the returned promise,
// which only resolves when a real attention_ack WebSocket message arrives from
// the client. This means the tool blocks regardless of whether Claude Code's
// dangerouslySkipPermissions flag is set — bypass only affects the permission
// gate, not the tool execution itself.
export type RequestAttentionAck = (args: {
  attentionId: string;
  message: string;
  summary?: string;
}) => Promise<{ feedback?: string; interrupt?: boolean }>;

// Creates the custom MCP tool server, closing over the requestAttentionAck
// callback so the RequestUserAttention handler can block on real user input.
export function createCustomToolsServer(requestAttentionAck: RequestAttentionAck) {
  // RequestUserAttention: pauses the agent turn and surfaces a UI prompt.
  // Unlike the old implementation that returned immediately (making it
  // bypassable via the permission system), the handler here awaits a Promise
  // that only resolves when the client sends an explicit attention_ack message.
  // "Stop" resolves with interrupt=true, causing the SDK to abort the turn.
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
    async (args) => {
      const attentionId = `attn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await requestAttentionAck({
        attentionId,
        message: args.message,
        summary: args.summary,
      });

      if (result.interrupt) {
        // Returning an error content block causes the SDK to surface the
        // denial to the model, which will then stop its turn naturally.
        return {
          content: [{ type: "text" as const, text: "User stopped the agent." }],
          isError: true,
        };
      }

      const responseText = result.feedback?.trim()
        ? `User responded: ${result.feedback}`
        : "User acknowledged. You may continue.";

      return {
        content: [{ type: "text" as const, text: responseText }],
      };
    },
  );

  // RenderSVG: lets the agent embed an inline SVG graphic directly into the
  // chat history. The tool itself does no work server-side — its `input`
  // payload (the SVG markup) is what the client picks up and renders as a
  // real <svg> element via the SvgBlock component. The client sanitizer
  // strips <script>, <foreignObject>, on* handlers, and javascript: URLs
  // before mounting.
  const renderSvgTool = tool(
  "RenderSVG",
  "Render an inline SVG graphic directly in the chat. Use this whenever a " +
    "visual would communicate the answer better than text — diagrams, " +
    "flowcharts, charts, geometry, simple illustrations, icons, or logos. " +
    "The `svg` argument must be a complete, valid <svg>...</svg> document " +
    "(include a viewBox so it scales). Prefer concise, readable markup; " +
    "you do NOT need to inline raster images or huge path data. Do not " +
    "include <script>, <foreignObject>, on* event handlers, or " +
    "javascript: URLs — they will be stripped. Pair the SVG with a short " +
    "title and, if helpful, a one-line caption explaining what the viewer " +
    "is looking at.",
  {
    svg: z
      .string()
      .describe(
        "The full SVG markup, starting with <svg ...> and ending with " +
          "</svg>. Always include a viewBox attribute so it scales " +
          "responsively (e.g. viewBox=\"0 0 200 100\"). Keep dimensions " +
          "reasonable — the chat column is roughly 720px wide.",
      ),
    title: z
      .string()
      .optional()
      .describe(
        "Short label shown above the graphic (e.g. \"Architecture\", " +
          "\"sin(x) from 0 to 2π\"). Keep under ~60 chars.",
      ),
    caption: z
      .string()
      .optional()
      .describe(
        "Optional one-line caption rendered under the graphic to explain " +
          "what it shows. Plain text, no markdown.",
      ),
  },
  async (args) => {
    // The handler is a no-op confirmation. The SVG markup lives in the
    // tool_use input, which is what the client renders.
    const title = args.title ? ` "${args.title}"` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Rendered SVG${title} in the chat.`,
        },
      ],
    };
  },
);

  return createSdkMcpServer({
    name: "buildover-custom-tools",
    version: "1.0.0",
    tools: [requestUserAttentionTool, renderSvgTool],
  });
}
