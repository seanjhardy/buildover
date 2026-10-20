import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { activityLabel } from "../lib/condenseTranscript.js";
import type { CondensedRow } from "../lib/condenseTranscript.js";
import { AssistantMessage } from "./AssistantMessage.js";

type ActivityRow = Extract<CondensedRow, { kind: "activity" }>;

interface Props {
  row: ActivityRow;
  expanded: boolean;
  /** True while this stretch is the work currently in flight. */
  live: boolean;
  onToggle: (key: string) => void;
  toolResults: Record<string, { content: string; isError: boolean }>;
  cwd?: string;
}

/**
 * One stretch of collapsed work in a high-level transcript: a single
 * "used n tools" line standing in for the tool calls, thinking and
 * intermediate chatter it holds. Collapsed on every render by default —
 * clicking opens the full blow-by-blow, rendered exactly as a verbose
 * transcript would render it.
 */
function ActivityGroupInner({ row, expanded, live, onToggle, toolResults, cwd }: Props) {
  return (
    <div
      className={`activity-group${expanded ? " activity-group--open" : ""}`}
      data-activity-key={row.key}
    >
      <button
        type="button"
        className="activity-group-line"
        aria-expanded={expanded}
        title={expanded ? "Hide the details" : "Show the details"}
        onClick={() => onToggle(row.key)}
      >
        <ChevronRight size={13} className="activity-group-chevron" />
        <span className="activity-group-label">{activityLabel(row.toolCount)}</span>
        {live && <span className="activity-group-live" aria-label="working" />}
      </button>
      {expanded && (
        <div className="activity-group-detail">
          {row.parts.map((part, i) => (
            <AssistantMessage
              key={`${part.id}-${i}`}
              content={part.content}
              toolResults={toolResults}
              cwd={cwd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const ActivityGroup = memo(ActivityGroupInner);
