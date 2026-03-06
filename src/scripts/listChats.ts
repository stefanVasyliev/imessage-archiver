import { openChatDb } from "../db/chatDb.js";

interface ChatRow {
  chatRowId: number;
  chatIdentifier: string | null;
  displayName: string | null;
  serviceName: string | null;
  lastMessageDate: number | null;
  messageCount: number;
}

function main(): void {
  const db = openChatDb();

  const rows = db
    .prepare(
      `
      SELECT
        c.ROWID AS chatRowId,
        c.chat_identifier AS chatIdentifier,
        c.display_name AS displayName,
        c.service_name AS serviceName,
        MAX(m.date) AS lastMessageDate,
        COUNT(m.ROWID) AS messageCount
      FROM chat AS c
      LEFT JOIN chat_message_join AS cmj
        ON cmj.chat_id = c.ROWID
      LEFT JOIN message AS m
        ON m.ROWID = cmj.message_id
      GROUP BY c.ROWID
      ORDER BY lastMessageDate DESC
      LIMIT 100
    `,
    )
    .all() as ChatRow[];

  console.table(rows);

  db.close();
}

main();
