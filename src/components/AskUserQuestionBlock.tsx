import { useState } from "react";
import { MessageCircleQuestion, ChevronRight, ChevronDown } from "lucide-react";

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

interface Props {
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}

export function AskUserQuestionBlock({ input, result }: Props) {
  const [collapsed, setCollapsed] = useState(true);

  const questions = (input.questions ?? []) as Question[];
  const answers = (input.answers ?? {}) as Record<string, string | string[]>;

  if (collapsed) {
    return (
      <div
        className="tool-visual ask-question-visual collapsed"
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <MessageCircleQuestion size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">
          Asked {questions.length} question{questions.length !== 1 ? "s" : ""}
        </span>
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className="tool-visual ask-question-visual">
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <MessageCircleQuestion size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">Questions & Answers</span>
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        {questions.map((q, i) => {
          const answer = answers[q.question];
          const answerList = Array.isArray(answer) ? answer : [answer].filter(Boolean);

          return (
            <div key={i} className="ask-qa-pair">
              <div className="ask-question">{q.question}</div>
              {answerList.length > 0 && (
                <div className="ask-answer">
                  {answerList.map((ans, j) => (
                    <span key={j} className="ask-answer-chip">
                      {ans}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
