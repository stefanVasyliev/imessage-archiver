import fs from "fs-extra";
import { appPaths } from "../utils/filePaths.js";

export interface AppState {
  lastProcessedMessageRowId: number;
}

const defaultState: AppState = {
  lastProcessedMessageRowId: 0
};

export async function readState(): Promise<AppState> {
  const exists = await fs.pathExists(appPaths.stateFile);
  if (!exists) {
    return defaultState;
  }

  const state = await fs.readJson(appPaths.stateFile);
  return {
    lastProcessedMessageRowId:
      typeof state.lastProcessedMessageRowId === "number"
        ? state.lastProcessedMessageRowId
        : 0
  };
}

export async function writeState(state: AppState): Promise<void> {
  await fs.ensureFile(appPaths.stateFile);
  await fs.writeJson(appPaths.stateFile, state, { spaces: 2 });
}