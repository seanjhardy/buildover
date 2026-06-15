import {
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { writeRunConfig } from "./runConfig.js";

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

// Callback type: signals to the session that the agent wants to compact the
// conversation history. The session schedules a /compact turn after the current
// turn ends (same mechanism as auto-compact, but triggered by the agent itself).
export type RequestCompact = (reason?: string) => void;

// Callback type: returns the current todos from the conversation history by
// scanning for the latest TodoWrite call (same logic as the useTodos hook).
export type GetCurrentTodos = () => Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}>;

// Creates the custom MCP tool server, closing over the requestAttentionAck
// callback so the RequestUserAttention handler can block on real user input.
export function createCustomToolsServer(
  requestAttentionAck: RequestAttentionAck,
  requestCompact: RequestCompact,
  repoPath?: string,
  getCurrentTodos?: GetCurrentTodos,
) {
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

  // RenderTable: lets the agent embed a formatted data table directly into
  // the chat history. Like RenderSVG, the handler is a no-op confirmation —
  // the actual data (headers + rows) lives in the tool_use input, which the
  // client picks up and renders via the TableBlock component.
  const renderTableTool = tool(
    "RenderTable",
    "Render a formatted data table directly in the chat. Use this whenever " +
      "structured data would be clearer as a table than as prose or a code " +
      "block — comparisons, metrics, schedules, lists with multiple attributes. " +
      "Provide column headers and rows as arrays of strings. Numeric values " +
      "should be pre-formatted (e.g. '1,234' or '98.6%') since all cells are " +
      "treated as plain text. Pair the table with a short title and, if " +
      "helpful, a one-line caption explaining what the data shows.",
    {
      headers: z
        .array(z.string())
        .describe("Column header labels, left to right."),
      rows: z
        .array(z.array(z.string()))
        .describe(
          "Row data. Each element is one row; each row is an array of cell " +
            "values in the same order as headers. All cells are plain text.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Short label shown above the table (e.g. \"Monthly Costs\"). " +
            "Keep under ~60 chars.",
        ),
      caption: z
        .string()
        .optional()
        .describe(
          "Optional one-line caption rendered under the table. Plain text.",
        ),
    },
    async (args) => {
      const title = args.title ? ` "${args.title}"` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Rendered table${title} in the chat.`,
          },
        ],
      };
    },
  );

  // RenderChart: lets the agent embed a bar, line, or pie chart directly into
  // the chat. The handler is a no-op confirmation; the chart data lives in the
  // tool_use input and is rendered client-side via the ChartBlock component
  // using pure SVG — no external chart library required.
  const renderChartTool = tool(
    "RenderChart",
    "Render a bar, line, or pie chart directly in the chat. Use this " +
      "whenever a visual would show trends, comparisons, or proportions more " +
      "clearly than prose or a table. Choose the type based on the data: " +
      "'bar' for comparing discrete categories, 'line' for trends over time " +
      "or a continuous axis, 'pie' for part-to-whole proportions (one series " +
      "only). Provide human-readable labels and pre-scaled numeric values. " +
      "Multiple datasets are supported for bar and line charts (they appear " +
      "as grouped bars or overlapping lines with a legend). Pie charts use " +
      "only the first dataset.",
    {
      type: z
        .enum(["bar", "line", "pie"])
        .describe("Chart type: 'bar', 'line', or 'pie'."),
      labels: z
        .array(z.string())
        .describe(
          "Labels for each data point or pie slice, in order. " +
            "Keep each label short (under ~14 chars) so they fit on the axis.",
        ),
      datasets: z
        .array(
          z.object({
            label: z
              .string()
              .describe(
                "Series name shown in the legend. Keep under ~12 chars.",
              ),
            values: z
              .array(z.number())
              .describe(
                "Numeric values, one per label entry, in the same order.",
              ),
            color: z
              .string()
              .optional()
              .describe(
                "Optional CSS colour for this series (e.g. '#4e9af1'). " +
                  "If omitted, a built-in palette is used.",
              ),
          }),
        )
        .describe(
          "One or more data series. Bar and line charts support multiple " +
            "series (grouped/overlapping). Pie charts use only the first series.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Short label shown above the chart (e.g. \"Weekly Active Users\"). " +
            "Keep under ~60 chars.",
        ),
      caption: z
        .string()
        .optional()
        .describe(
          "Optional one-line caption rendered under the chart. Plain text.",
        ),
    },
    async (args) => {
      const title = args.title ? ` "${args.title}"` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Rendered ${args.type} chart${title} in the chat.`,
          },
        ],
      };
    },
  );

  // ClearContext: lets the agent proactively compact the conversation history
  // to free up context window space. Calling it schedules a silent /compact
  // turn immediately after the current turn ends — the same mechanism used by
  // auto-compact, but triggered by the agent rather than a usage threshold.
  // Use this after accumulating large tool results or file reads that are no
  // longer needed for the current task.
  const clearContextTool = tool(
    "ClearContext",
    "Summarize and compact the conversation history to free up context window space. " +
      "Call this proactively whenever you have accumulated tool results, file reads, " +
      "or other content in the history that is no longer relevant to what you are " +
      "currently working on. Prefer calling it early and often rather than waiting " +
      "until the context window is nearly full — clearing irrelevant history makes " +
      "the remaining context cheaper and faster. After this turn ends the history " +
      "will be summarized automatically; you do not need to do anything else.",
    {
      reason: z
        .string()
        .optional()
        .describe(
          "Brief description of what is being cleared and why " +
            "(e.g. 'Clearing file reads from initial exploration — moving to implementation'). " +
            "Helps with debugging; not shown to the user.",
        ),
    },
    async (args) => {
      requestCompact(args.reason);
      return {
        content: [
          {
            type: "text" as const,
            text: args.reason
              ? `Context compaction scheduled: ${args.reason}`
              : "Context compaction scheduled. History will be summarized after this turn completes.",
          },
        ],
      };
    },
  );

  // WriteRunConfig: lets the agent persist a custom HTML run panel + metadata
  // for the current repo. The panel HTML is stored at
  // ~/.buildover/repos/{name}/run-panel.html and rendered in a sandboxed
  // iframe at the bottom of the chat sidebar. Buttons inside the HTML fire
  // window.parent.postMessage({ type: 'run-command', command: '...' }, '*')
  // which buildover intercepts and routes to a new terminal tab.
  const writeRunConfigTool = tool(
    "WriteRunConfig",
    "Persist a custom Run panel for a project. Call this after discovering the " +
      "project's runnable commands. The panelHtml must be a fully self-contained " +
      "HTML snippet (inline CSS + JS, no external resources). Each button should " +
      "call: window.parent.postMessage({ type: 'run-command', command: 'CMD' }, '*') " +
      "on click. Style to match buildover's dark theme: background #1a1a1a, text #cccccc, " +
      "primary buttons #c6613f. Keep it compact — the panel lives in a 260px-wide sidebar.",
    {
      repoPath: z
        .string()
        .describe(
          "Absolute path of the project this run panel belongs to. " +
            "This may differ from the current working directory when the setup " +
            "chat was opened in a different repo (e.g. buildover itself). " +
            "Example: '/Users/alice/projects/my-app'",
        ),
      panelHtml: z
        .string()
        .describe(
          "Complete self-contained HTML for the run panel. Must include a <style> block " +
            "and inline onclick handlers. No external stylesheets or scripts.",
        ),
      previewUrl: z
        .string()
        .optional()
        .describe(
          "Full URL where the dev server will be accessible once started, " +
            "e.g. 'http://localhost:5173'. Used to open the embedded preview pane.",
        ),
      devPort: z
        .number()
        .optional()
        .describe(
          "Numeric port the dev server listens on, e.g. 5173. Used to detect " +
            "whether the server is running and to offer a Kill button.",
        ),
    },
    async (args) => {
      // Prefer the explicitly-supplied repoPath argument; fall back to the
      // session's cwd for backwards-compat with same-repo invocations.
      const targetPath = args.repoPath || repoPath;
      if (!targetPath) {
        return {
          content: [{ type: "text" as const, text: "Error: repoPath argument is required." }],
          isError: true,
        };
      }
      try {
        await writeRunConfig(targetPath, args.panelHtml, args.previewUrl, args.devPort);
        return {
          content: [
            {
              type: "text" as const,
              text: `Run panel saved for ${targetPath}. The panel will appear at the bottom of the chat sidebar immediately.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to save run config: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // TodoRead: lets the agent query the current task list from the conversation
  // history. Scans for the latest TodoWrite call and returns its contents.
  const todoReadTool = tool(
    "TodoRead",
    "Read the current task list from the sidebar. Returns the todos from your " +
      "most recent TodoWrite call. Use this when you need to check the current " +
      "state before updating the list, or when resuming work after a long conversation. " +
      "If no todos exist yet, returns an empty list.",
    {},
    async () => {
      if (!getCurrentTodos) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No current todos. Use TodoWrite to create a task list.",
            },
          ],
        };
      }

      const todos = getCurrentTodos();

      if (todos.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No current todos. Use TodoWrite to create a task list.",
            },
          ],
        };
      }

      const lines = todos.map((t, i) => {
        const status =
          t.status === "pending" ? "☐ Pending" :
          t.status === "in_progress" ? "★ In Progress" :
          "☑ Completed";
        return `${i + 1}. [${status}] ${t.content}`;
      });

      const summary = [
        todos.filter(t => t.status === "in_progress").length + " in progress",
        todos.filter(t => t.status === "pending").length + " pending",
        todos.filter(t => t.status === "completed").length + " completed",
      ]
        .filter(s => !s.startsWith("0"))
        .join(", ");

      return {
        content: [
          {
            type: "text" as const,
            text: `Current task list (${summary}):\n\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );

  // TodoWrite: lets the agent update the task list shown in the right sidebar.
  // Each call replaces the full list. The client picks up the tool_use input
  // (the todos array) from the chat history and renders it via TodoPanel.
  const todoWriteTool = tool(
    "TodoWrite",
    "Update the task list shown in the right sidebar. Use this to communicate " +
      "your plan and progress when working on multi-step requests. Each call " +
      "replaces the full list, so include all current tasks. Update it as you " +
      "work: mark tasks in_progress when starting them, completed when done. " +
      "Keep task descriptions short (under ~60 chars) so they fit in the sidebar. " +
      "The list disappears once all tasks are completed, so only call this when " +
      "you have pending or in-progress work to show.",
    {
      todos: z
        .array(
          z.object({
            content: z
              .string()
              .describe(
                "Short task description shown in the sidebar. Keep under ~60 chars.",
              ),
            status: z
              .enum(["pending", "in_progress", "completed"])
              .describe(
                "Task status: 'pending' (not started), 'in_progress' (currently working on), 'completed' (done).",
              ),
            activeForm: z
              .string()
              .describe(
                "Present progressive form of the task (e.g. 'Reading schema', 'Writing tests'). " +
                  "Shown in the sidebar when status is 'in_progress'. Should match the content but be phrased as an ongoing action.",
              ),
          }),
        )
        .describe(
          "Complete list of tasks for the current request. Replaces any previous list.",
        ),
    },
    async (args) => {
      // The handler is a no-op confirmation. The todos array lives in the
      // tool_use input, which is what the client renders.
      const pending = args.todos.filter((t) => t.status === "pending").length;
      const inProgress = args.todos.filter((t) => t.status === "in_progress").length;
      const completed = args.todos.filter((t) => t.status === "completed").length;
      const summary = [
        inProgress > 0 && `${inProgress} in progress`,
        pending > 0 && `${pending} pending`,
        completed > 0 && `${completed} completed`,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated task list: ${summary}.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "buildover-custom-tools",
    version: "1.0.0",
    tools: [
      requestUserAttentionTool,
      renderSvgTool,
      renderTableTool,
      renderChartTool,
      clearContextTool,
      writeRunConfigTool,
      todoReadTool,
      todoWriteTool,
    ],
  });
}
