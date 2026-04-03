import fs from "fs-extra";
import * as path from "node:path";
import { appPaths } from "./filePaths.js";

export const PROJECT_PHASES = [
  "Demo",
  "Framing",
  "Electrical",
  "Plumbing",
  "HVAC",
  "TilePrep",
  "Finish",
  "Site",
  "General",
] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];

function cleanAlphaNumeric(value: string): string {
  return value.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
}

function toPascalCase(value: string): string {
  const cleaned = cleanAlphaNumeric(value);

  if (!cleaned) {
    return "Unknown";
  }

  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function normalizeProjectName(projectName: string): string {
  return toPascalCase(projectName);
}

export function normalizeDescriptionToken(description: string): string {
  return toPascalCase(description);
}

export async function ensureProjectStructure(
  projectName: string,
): Promise<string> {
  const normalizedProjectName = normalizeProjectName(projectName);
  const projectRoot = path.join(appPaths.root, normalizedProjectName);

  const directories = [
    ...PROJECT_PHASES.map((phase) => path.join(projectRoot, "Photos", phase)),
    ...PROJECT_PHASES.map((phase) => path.join(projectRoot, "Videos", phase)),
    path.join(projectRoot, "Renders"),
    path.join(projectRoot, "Final"),
  ];

  await Promise.all(directories.map((directory) => fs.ensureDir(directory)));

  return projectRoot;
}
