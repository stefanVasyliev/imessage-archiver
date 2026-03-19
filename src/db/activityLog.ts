import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ActivityEventKind =
  | "attachment_processed"
  | "attachment_skipped"
  | "duplicate_detected"
  | "project_resolved"
  | "manual_review_routed"
  | "context_updated"
  | "poll_cycle";

export interface ActivityEvent {
  readonly ts: string;
  readonly kind: ActivityEventKind;
  readonly messageRowId?: number;
  readonly senderId?: string;
  readonly projectName?: string;
  readonly fileName?: string;
  readonly detail?: string;
}

export interface ActivityLog {
  write(event: ActivityEvent): Promise<void>;
}

export function createActivityLog(filePath: string): ActivityLog {
  return {
    async write(event: ActivityEvent): Promise<void> {
      const line = JSON.stringify(event) + "\n";
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, "utf8");
    },
  };
}
