import fs from "fs-extra";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

export interface AppState {
  lastProcessedMessageRowId: number;
}

const defaultState: AppState = {
  lastProcessedMessageRowId: 0
};

export async function readState(): Promise<AppState> {
  const exists = await fs.pathExists(appPaths.stateFile);
  if (!exists) {
    logger.info(
      {
        operation: "readState",
        stateFile: appPaths.stateFile,
        lastProcessedMessageRowId: 0,
      },
      "State file not found — starting from row ID 0 (first run or state was deleted)",
    );
    return defaultState;
  }

  const state = await fs.readJson(appPaths.stateFile);
  const lastProcessedMessageRowId =
    typeof state.lastProcessedMessageRowId === "number"
      ? state.lastProcessedMessageRowId
      : 0;

  if (lastProcessedMessageRowId === 0) {
    logger.warn(
      {
        operation: "readState",
        stateFile: appPaths.stateFile,
        lastProcessedMessageRowId,
      },
      "State file exists but lastProcessedMessageRowId is 0 — may reprocess all messages",
    );
  } else {
    logger.info(
      {
        operation: "readState",
        stateFile: appPaths.stateFile,
        lastProcessedMessageRowId,
      },
      "State loaded",
    );
  }

  return { lastProcessedMessageRowId };
}

export async function writeState(state: AppState): Promise<void> {
  await fs.ensureFile(appPaths.stateFile);
  await fs.writeJson(appPaths.stateFile, state, { spaces: 2 });
}

/**
 * Called once at startup.
 *
 * - If START_FROM_NOW=true → always reset to `currentMaxRowId`.
 * - If state file does not exist → initialize from `currentMaxRowId` (safe first run).
 * - Otherwise → return the persisted state as-is.
 *
 * `currentMaxRowId` must be read from the live DB before calling this function.
 */
export async function initializeStartupState(
  currentMaxRowId: number,
): Promise<AppState> {
  if (env.START_FROM_NOW) {
    const state: AppState = { lastProcessedMessageRowId: currentMaxRowId };
    await writeState(state);
    logger.info(
      { currentMaxRowId },
      "START_FROM_NOW enabled — resetting state to current max ROWID",
    );
    logger.info(
      { lastProcessedMessageRowId: currentMaxRowId },
      "Watching for new messages after ROWID " + String(currentMaxRowId),
    );
    return state;
  }

  const exists = await fs.pathExists(appPaths.stateFile);
  if (!exists) {
    const state: AppState = { lastProcessedMessageRowId: currentMaxRowId };
    await writeState(state);
    logger.info(
      { currentMaxRowId },
      "State file not found — initializing from current max ROWID",
    );
    logger.info(
      { lastProcessedMessageRowId: currentMaxRowId },
      "Watching for new messages after ROWID " + String(currentMaxRowId),
    );
    return state;
  }

  const saved = await readState();

  // Guard: a persisted 0 would reprocess ALL historical messages.
  // Treat it the same as a missing state file — reset to current max.
  if (saved.lastProcessedMessageRowId === 0) {
    const state: AppState = { lastProcessedMessageRowId: currentMaxRowId };
    await writeState(state);
    logger.warn(
      { savedRowId: 0, currentMaxRowId },
      "State file had lastProcessedMessageRowId=0 — resetting to current max ROWID to prevent historical reprocessing",
    );
    logger.info(
      { lastProcessedMessageRowId: currentMaxRowId },
      "Watching for new messages after ROWID " + String(currentMaxRowId),
    );
    return state;
  }

  logger.info(
    { lastProcessedMessageRowId: saved.lastProcessedMessageRowId },
    "Watching for new messages after ROWID " +
      String(saved.lastProcessedMessageRowId),
  );
  return saved;
}