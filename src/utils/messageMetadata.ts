import type { ProjectTrade } from "./projectFolders.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MessageMetadata {
  readonly projectName: string | null;
  readonly trade: ProjectTrade;
  readonly description: string;
  /** 0–1. Combination of project-match + trade-match + description quality. */
  readonly confidence: number;
}

export interface ExtractMetadataParams {
  readonly message: string;
  readonly knownProjects: readonly string[];
  /** Optional: extra signal beyond message text (e.g. attachment filename). */
  readonly filename?: string | null;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Splits any text into lowercase alphabetic tokens. Digits and punctuation
 * are treated as whitespace so "pool-house" and "pool house" both yield
 * ["pool", "house"].
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Joins tokens into a single run-on string so multi-word project names can
 * be detected by substring search.
 *
 * ["pool", "house", "painting", "wall"] → "poolhousepaintingwall"
 */
function joinTokens(tokens: string[]): string {
  return tokens.join("");
}

// ---------------------------------------------------------------------------
// Stop words — filtered from description output
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "it", "its", "my", "your",
  "our", "their", "this", "that", "these", "those", "and", "or", "but",
  "not", "very", "really", "some", "any", "all", "up", "out", "with",
  "for", "from", "of", "in", "on", "at", "to", "by", "as", "so", "if",
  "just", "also", "new", "got", "get", "need", "needs", "about", "more",
  "other", "now", "there", "here", "we", "they", "he", "she", "i", "me",
  "us", "them", "into", "onto", "over", "under", "then", "too",
]);

// ---------------------------------------------------------------------------
// Verb normalization
// Simple imperative / base-form → canonical past-participle / gerund.
// These appear at the END of the description tokens.
// ---------------------------------------------------------------------------

const VERB_NORMALIZATIONS: ReadonlyMap<string, string> = new Map([
  ["fix",       "Repair"],
  ["fixing",    "Repair"],
  ["fixed",     "Repair"],
  ["repair",    "Repair"],
  ["repairing", "Repair"],
  ["repaired",  "Repair"],
  ["install",   "Install"],
  ["installing","Install"],
  ["installed", "Install"],
  ["replace",   "Replace"],
  ["replacing", "Replace"],
  ["replaced",  "Replace"],
  ["remove",    "Remove"],
  ["removing",  "Remove"],
  ["removed",   "Remove"],
  ["demo",      "Demo"],
  ["demolish",  "Demo"],
  ["demolishing","Demo"],
  ["patch",     "Patch"],
  ["patching",  "Patch"],
  ["patched",   "Patch"],
  ["prime",     "Prime"],
  ["priming",   "Prime"],
  ["primed",    "Prime"],
  ["touch",     "TouchUp"],   // "touch up" → "TouchUp" (the "up" is a stop word)
  ["clean",     "Clean"],
  ["cleaning",  "Clean"],
  ["cleaned",   "Clean"],
  ["check",     "Check"],
  ["checking",  "Check"],
  ["layout",    "Layout"],
  ["frame",     "Framing"],
  ["framing",   "Framing"],
  ["rough",     "RoughIn"],
  ["roughin",   "RoughIn"],
  ["add",       "Install"],
  ["adding",    "Install"],
]);

/** Words that are canonical verbs (not nouns in a description context). */
function isNormalizedVerb(word: string): boolean {
  return VERB_NORMALIZATIONS.has(word);
}

// ---------------------------------------------------------------------------
// Trade detection
// ---------------------------------------------------------------------------

interface TradeRule {
  readonly trade: ProjectTrade;
  /** Single-word tokens, lowercase. */
  readonly keywords: readonly string[];
  /**
   * Phrase patterns: each inner array is an ordered sequence of tokens that
   * must ALL appear anywhere in the token stream (order does not matter).
   * A phrase match scores as 2 keyword hits.
   */
  readonly phrases?: readonly (readonly string[])[];
}

const TRADE_RULES: readonly TradeRule[] = [
  {
    trade: "Electrical",
    keywords: [
      "wire", "wires", "wiring", "outlet", "outlets", "switch", "switches",
      "panel", "breaker", "breakers", "conduit", "junction", "electrical",
      "electric", "receptacle", "disconnect", "subpanel", "gfci", "arc",
      "romex", "voltage",
    ],
  },
  {
    trade: "Plumbing",
    keywords: [
      "pipe", "pipes", "piping", "plumbing", "drain", "drains", "draining",
      "valve", "valves", "faucet", "faucets", "toilet", "toilets", "water",
      "supply", "manifold", "shutoff", "sewer", "vent", "trap", "p-trap",
      "leak", "leaking", "flush",
    ],
    phrases: [["rough", "plumbing"], ["water", "line"]],
  },
  {
    trade: "HVAC",
    keywords: [
      "hvac", "duct", "ducts", "ducting", "ductwork", "vent", "vents",
      "venting", "furnace", "ac", "heat", "heating", "cooling", "air",
      "mechanical", "thermostat", "damper", "register", "diffuser",
    ],
    phrases: [["air", "conditioning"], ["air", "handler"]],
  },
  {
    trade: "Tile",
    keywords: [
      "tile", "tiles", "tiling", "grout", "grouting", "grouted",
      "backsplash", "mosaic", "porcelain", "ceramic", "stone", "marble",
      "slate", "travertine", "backer", "durock", "hardiebacker", "thinset",
      "mortar", "waterproof", "waterproofing",
    ],
    phrases: [["cement", "board"], ["shower", "tile"]],
  },
  {
    trade: "Finish",
    keywords: [
      "paint", "painting", "painted", "primer", "priming", "stain",
      "staining", "finish", "finishing", "trim", "baseboard", "baseboards",
      "molding", "moulding", "cabinet", "cabinets", "door", "doors",
      "caulk", "caulking", "drywall", "sheetrock", "plaster",
      "texture", "ceiling",
    ],
    phrases: [["touch", "up"], ["wall", "paint"]],
  },
  {
    trade: "Structural",
    keywords: [
      "frame", "framing", "beam", "beams", "stud", "studs", "joist",
      "joists", "rafter", "rafters", "footing", "footings", "foundation",
      "concrete", "block", "masonry", "sheathing", "subfloor",
      "structure", "structural", "demo", "demolition", "tear",
      "header", "lintel", "post", "column", "wall",
    ],
    phrases: [["rough", "framing"], ["rough", "in"]],
  },
];

interface TradeScore {
  readonly trade: ProjectTrade;
  readonly score: number;
}

/**
 * Scores each trade by counting how many of its keywords appear in `tokens`.
 * Phrase matches count as 2 hits.
 * Returns the winning trade and its normalized confidence (0–1).
 */
function detectTrade(tokens: string[]): { trade: ProjectTrade; score: number } {
  const tokenSet = new Set(tokens);

  const scores: TradeScore[] = TRADE_RULES.map((rule) => {
    let score = 0;

    for (const kw of rule.keywords) {
      if (tokenSet.has(kw)) score += 1;
    }

    for (const phrase of rule.phrases ?? []) {
      if (phrase.every((w) => tokenSet.has(w))) score += 2;
    }

    return { trade: rule.trade, score };
  });

  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));

  return best.score > 0 ? best : { trade: "General", score: 0 };
}

// ---------------------------------------------------------------------------
// Project matching
// ---------------------------------------------------------------------------

/**
 * Breaks a PascalCase or underscore-separated project name into lowercase
 * word tokens of ≥ 3 characters.
 *
 * "Poolhouse"            → ["poolhouse"]
 * "ContentStudio"        → ["content", "studio"]
 * "Office_OrangeCounty"  → ["office", "orange", "county"]
 */
function projectWordTokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter((w) => w.length >= 3);
}

/**
 * Tries to find a project name within `tokens` using two strategies:
 *
 * 1. Substring: join all tokens (no spaces) and check whether the normalized
 *    project name appears as a continuous substring.
 *    "pool house" → "poolhouse" ⊂ "poolhousepaintingwall" ✓
 *
 * 2. Word-overlap: ≥ 2 of the project's significant word-tokens appear in the
 *    message token set.
 *
 * Longest-name project wins when multiple candidates qualify.
 */
function matchProject(
  tokens: string[],
  knownProjects: readonly string[],
): string | null {
  const messageRun = joinTokens(tokens);
  const tokenSet = new Set(tokens);

  // Sort longest first so a more specific name wins over a short prefix.
  const sorted = [...knownProjects].sort((a, b) => b.length - a.length);

  for (const project of sorted) {
    const norm = project.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (messageRun.includes(norm)) return project;
  }

  // Word-overlap tier — requires ≥ 2 significant words present.
  let best: string | null = null;
  let bestOverlap = 0;

  for (const project of sorted) {
    const words = projectWordTokens(project);
    const overlap = words.filter((w) => tokenSet.has(w)).length;
    if (overlap >= 2 && overlap > bestOverlap) {
      best = project;
      bestOverlap = overlap;
    }
  }

  return best;
}

/**
 * Returns the set of tokens that contributed to the project match so they
 * can be excluded from the description.
 */
function projectTokenSet(projectName: string): Set<string> {
  const norm = projectName.toLowerCase().replace(/[^a-z]/g, "");
  const words = projectWordTokens(projectName);
  return new Set([norm, ...words]);
}

// ---------------------------------------------------------------------------
// Description generation
// ---------------------------------------------------------------------------

/**
 * Capitalizes the first letter of a word.
 * "painting" → "Painting"
 */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const FALLBACK_DESCRIPTION = "Progress_Photo";
const MAX_DESCRIPTION_TOKENS = 3;

/**
 * Builds a 1–3 word description from the meaningful words remaining after
 * project and stop-word tokens are removed.
 *
 * Rules:
 * - Imperative verbs (fix, install…) are normalized and moved to the end.
 * - Everything else is kept in original order.
 * - Fallback: "Progress_Photo".
 */
function buildDescription(
  tokens: string[],
  usedProjectTokens: Set<string>,
): string {
  // 1. Remove stop words and project-identifying words.
  const remaining = tokens.filter(
    (t) => !STOP_WORDS.has(t) && !usedProjectTokens.has(t),
  );

  if (remaining.length === 0) return FALLBACK_DESCRIPTION;

  // 2. Separate verbs from descriptive words.
  const descriptiveWords: string[] = [];
  const normalizedVerbs: string[] = [];

  for (const token of remaining) {
    const verbForm = VERB_NORMALIZATIONS.get(token);
    if (verbForm !== undefined) {
      // Avoid duplicate normalized verbs (e.g. "fix" and "fixing" both → Repair).
      if (!normalizedVerbs.includes(verbForm)) normalizedVerbs.push(verbForm);
    } else {
      descriptiveWords.push(capitalize(token));
    }
  }

  // 3. Descriptive nouns/gerunds first, normalized verbs at end.
  const ordered: string[] = [...descriptiveWords, ...normalizedVerbs];

  if (ordered.length === 0) return FALLBACK_DESCRIPTION;

  // 4. Limit to MAX_DESCRIPTION_TOKENS and join.
  return ordered.slice(0, MAX_DESCRIPTION_TOKENS).join("_");
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/**
 * Combines three independent signals into a single 0–1 confidence score.
 *
 * | Signal               | Points |
 * |----------------------|--------|
 * | Project matched      |   0.40 |
 * | Trade ≠ General      |   0.35 |
 * | Description not generic |  0.25 |
 */
function computeConfidence(params: {
  projectMatched: boolean;
  tradeScore: number;
  descriptionGeneric: boolean;
}): number {
  let score = 0;
  if (params.projectMatched) score += 0.40;
  if (params.tradeScore > 0) score += Math.min(0.35, params.tradeScore * 0.12);
  if (!params.descriptionGeneric) score += 0.25;
  return Math.min(1, Math.round(score * 100) / 100);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure TypeScript metadata extractor — no AI, fully deterministic.
 *
 * Combines message text (and optionally filename) to produce:
 * - The matched project name
 * - The dominant construction trade
 * - A clean 1–3 word description for file naming
 * - A confidence score
 *
 * @example
 * extractFileMetadata({
 *   message: "pool house painting wall",
 *   knownProjects: ["Poolhouse", "ContentStudio"],
 * });
 * // → { projectName: "Poolhouse", trade: "Finish",
 * //      description: "Painting_Wall", confidence: 1 }
 */
export function extractFileMetadata(
  params: ExtractMetadataParams,
): MessageMetadata {
  // Combine message and optional filename into a single token stream.
  const combined = [params.message, params.filename ?? ""].join(" ");
  const tokens = tokenize(combined);

  // --- Project ---
  const projectName = matchProject(tokens, params.knownProjects);
  const usedProjectTokens =
    projectName !== null ? projectTokenSet(projectName) : new Set<string>();

  // --- Trade ---
  const { trade, score: tradeScore } = detectTrade(tokens);

  // --- Description ---
  const description = buildDescription(tokens, usedProjectTokens);
  const descriptionGeneric = description === FALLBACK_DESCRIPTION;

  // --- Confidence ---
  const confidence = computeConfidence({
    projectMatched: projectName !== null,
    tradeScore,
    descriptionGeneric,
  });

  return { projectName, trade, description, confidence };
}
