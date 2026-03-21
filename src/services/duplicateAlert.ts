import { Resend } from "resend";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface DuplicateAlertInput {
  readonly projectName: string;
  readonly fileName: string;
  readonly duplicateType: "exact" | "perceptual";
  readonly matchedPath?: string;
}

export function createDuplicateAlert(apiKey: string) {
  const resend = new Resend(apiKey);

  return {
    async send(input: DuplicateAlertInput): Promise<void> {
      if (input.duplicateType !== "exact") {
        return;
      }

      const from = env.REPORT_EMAIL_FROM;
      const to = env.REPORT_EMAIL_TO;

      if (!from || !to) {
        logger.warn(
          { projectName: input.projectName, fileName: input.fileName },
          "Email not configured — skipping duplicate alert",
        );
        return;
      }

      await resend.emails.send({
        from,
        to: [to],
        subject: `Duplicate detected — ${input.projectName}`,
        html: `<h2>Duplicate file detected</h2>
<p><b>Project:</b> ${input.projectName}</p>
<p><b>File:</b> ${input.fileName}</p>
<p><b>Type:</b> ${input.duplicateType}</p>
<p><b>Matched file:</b> ${input.matchedPath ?? "—"}</p>`,
      });
    },
  };
}
