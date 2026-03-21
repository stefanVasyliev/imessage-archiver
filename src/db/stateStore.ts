import fs from "fs-extra";
import { appPaths } from "../utils/filePaths.js";
import { logger } from "../utils/logger.js";

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