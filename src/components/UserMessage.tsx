import type { Attachment } from "../types.js";
import { AttachmentChip } from "./AttachmentChip.js";

interface Props {
  text: string;
  attachments?: Attachment[];
}

export function UserMessage({ text, attachments }: Props) {
  return (
    <div className="message user">
      <div className="bubble">
        {attachments && attachments.length > 0 && (
          <div className="bubble-attachments">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} compact />
            ))}
          </div>
        )}
        {text}
      </div>
    </div>
  );
}
