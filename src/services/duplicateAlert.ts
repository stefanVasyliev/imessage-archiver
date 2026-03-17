import { Resend } from "resend";

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
        return; // Currently, we only alert on exact duplicates
      }
      

      await resend.emails.send({
        from: "Archiver <updates@yourdomain.com>",
        to: ["you@example.com"],
        subject: `Duplicate detected — ${input.projectName}`,
        html: `
          <h2>Duplicate detected</h2>
          <p><b>Project:</b> ${input.projectName}</p>
          <p><b>File:</b> ${input.fileName}</p>
          <p><b>Type:</b> ${input.duplicateType}</p>
          <p><b>Matched:</b> ${input.matchedPath ?? "-"}</p>
        `,
      });
    },
  };
}
