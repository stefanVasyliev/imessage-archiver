import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface MessageEvent {
  readonly ts: string;
  readonly messageRowId: number;
  readonly senderId: string;
  readonly isFromMe: boolean;
  readonly text: string | null;
  readonly projectName?: string;
  readonly projectSource?: string;
}

export interface MessageLog {
  write(event: MessageEvent): Promise<void>;
}

export function createMessageLog(filePath: string): MessageLog {
  return {
    async write(event: MessageEvent): Promise<void> {
      const line = JSON.stringify(event) + "\n";
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, "utf8");
    },
  };
}
