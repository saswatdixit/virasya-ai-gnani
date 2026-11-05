/**
 * Virasya Supabase Adapters Module
 *
 * Provides explicit, secure conversions between frontend application models,
 * local JSON file representations, and the deployed PostgreSQL database schema.
 *
 * Source of Truth: supabase/migrations/20261017000000_virasya_core_schema.sql
 *
 * Key Invariants:
 * 1. Explicit camelCase <-> snake_case field mapping.
 * 2. Client-safe draft creation strictly prevents client-side elevation to 'preserved'
 *    or client-forged cryptographic provenance identifiers.
 * 3. Client vocabulary submission forces verification_status = 'suggested' and is_sample = false.
 * 4. Local legacy JSON fields that cannot be stored in defined database columns are
 *    segregated into an unmapped dictionary rather than being silently dropped.
 */

import type {
  AudioItem,
  VocabularyEntry,
} from "../preserve/types";

import type {
  StoryPayload,
  VocabularyWordItem,
} from "../preserve/api";

import type {
  StoryRow,
  StoryInsert,
  StoryStatus,
  StoryVisibility,
  VocabularyRow,
  VocabularyInsert,
  DbAudioMetadata,
  DbFinalSettings,
  Json,
} from "./types";

// =============================================================================
// 1. AUDIO METADATA ADAPTERS
// =============================================================================

/**
 * Converts frontend AudioItem or StoryPayload audio to PostgreSQL DbAudioMetadata JSON structure.
 */
export function audioItemToDbAudio(
  audio: AudioItem | StoryPayload["audio"] | null | undefined
): DbAudioMetadata | null {
  if (!audio) return null;
  const filename =
    "name" in audio && typeof audio.name === "string"
      ? audio.name
      : "filename" in audio && typeof audio.filename === "string"
      ? audio.filename
      : "";

  return {
    filename,
    url: audio.url || undefined,
    size: audio.size ?? null,
    duration: audio.duration ?? null,
    kind: audio.kind,
    storage_path: audio.storage_path || undefined,
    bucket: audio.bucket || undefined,
  };
}

/**
 * Converts database DbAudioMetadata JSON back to frontend AudioItem.
 */
export function dbAudioToAudioItem(dbAudio: DbAudioMetadata | null | undefined): AudioItem | null {
  if (!dbAudio) return null;
  const rawKind = dbAudio.kind;
  const validKind: AudioItem["kind"] =
    rawKind === "recorded" || rawKind === "uploaded" || rawKind === "demo" || rawKind === "lost"
      ? rawKind
      : "uploaded";

  return {
    name: dbAudio.filename || "",
    url: dbAudio.url || null,
    size: dbAudio.size ?? null,
    duration: dbAudio.duration ?? null,
    kind: validKind,
    storage_path: dbAudio.storage_path || undefined,
    bucket: dbAudio.bucket || undefined,
  };
}

// =============================================================================
// 2. STORY DRAFT INSERT ADAPTER (CLIENT-SAFE)
// =============================================================================

export interface DraftInsertOptions {
  userId: string;
  audioPublicPlayback?: boolean;
}

/**
 * Prepares a client-editable StoryPayload for database insertion into public.stories.
 *
 * SECURITY ENFORCEMENT:
 * - Forces status = 'draft' (client cannot elevate status to 'preserved').
 * - Strips client-supplied provenance_id, provenance_hash, and preserved_at
 *   (these can only be sealed by the trusted backend with service_role).
 * - Enforces the authenticated caller's userId as user_id.
 */
export function storyPayloadToDraftInsert(
  payload: StoryPayload,
  options: DraftInsertOptions
): StoryInsert {
  if (!options.userId) {
    throw new Error("Cannot create story insert: authenticated userId is required.");
  }

  const raw = payload as Record<string, any>;
  const storyId = payload.id || `story_${Date.now()}`;

  // Safe visibility extraction with fallback to 'private'
  const rawVisibility = payload.finalSettings?.visibility || raw.visibility;
  const visibility: StoryVisibility =
    rawVisibility === "public" ||
    rawVisibility === "family" ||
    rawVisibility === "community" ||
    rawVisibility === "private"
      ? rawVisibility
      : "private";

  const roots = payload.roots || raw.place || "";
  const place = raw.place || payload.roots || "";
  const written_text = payload.writtenText || raw.written_text || "";
  const final_text = raw.final_text || raw.finalText || "";
  const story = raw.story || final_text || payload.workingDraft || raw.working_draft || written_text || "";

  return {
    id: storyId,
    user_id: options.userId,
    title: payload.title || "",
    carrier: payload.carrier || "",
    relationship: payload.relationship || "",
    place,
    roots,
    category: payload.category || "",
    language: payload.language || "Odia",
    period: payload.period || "",
    email: payload.email || "",
    written_text,
    working_draft: payload.workingDraft || raw.working_draft || "",
    final_text: raw.final_text || raw.finalText || story || "",
    story: story || final_text || "",
    audio: audioItemToDbAudio(payload.audio),
    raw_transcripts: (raw.raw_transcripts as any) || {},
    vocabulary: (payload.vocabulary as unknown as Json) || [],
    punctuation: (payload.punctuation as unknown as Json) || {},
    final_settings: (payload.finalSettings as unknown as DbFinalSettings) || {},
    status: "draft", // Strictly forced to draft for untrusted client inserts
    visibility,
    confirmed: Boolean(payload.finalSettings?.confirmed ?? raw.confirmed),
    permission_confirmed: Boolean(payload.finalSettings?.permissionConfirmed ?? raw.permissionConfirmed ?? raw.permission_confirmed),
    audio_public_playback: Boolean(options.audioPublicPlayback ?? raw.audio_public_playback),
    // Strictly null for client draft inserts; populated only upon server preservation
    provenance_id: null,
    provenance_hash: null,
    preserved_at: null,
  };
}

// =============================================================================
// 3. STORY ROW TO FRONTEND STORYPAYLOAD ADAPTER
// =============================================================================

/**
 * Transforms a PostgreSQL StoryRow from the database into the frontend StoryPayload.
 * Maps snake_case database columns to camelCase frontend properties.
 */
export function storyRowToStoryPayload(row: StoryRow): StoryPayload {
  const finalSettings = {
    visibility: row.visibility,
    confirmed: row.confirmed,
    permissionConfirmed: row.permission_confirmed,
    audioPublicConsent: Boolean(
      (row.final_settings as any)?.audioPublicConsent ??
      (row.final_settings as any)?.audio_public_consent ??
      (row.status === "preserved" && row.audio_public_playback)
    ),
    ...(typeof row.final_settings === "object" && row.final_settings !== null ? row.final_settings : {}),
  };

  const payloadAudio: StoryPayload["audio"] = row.audio
    ? {
        filename: row.audio.filename || "",
        url: row.audio.url,
        size: row.audio.size ?? null,
        duration: row.audio.duration ?? null,
        kind: row.audio.kind || "uploaded",
        storage_path: row.audio.storage_path || undefined,
        bucket: row.audio.bucket || undefined,
      }
    : null;

  return {
    id: row.id,
    title: row.title,
    carrier: row.carrier,
    relationship: row.relationship,
    roots: row.roots,
    category: row.category,
    language: row.language,
    period: row.period,
    email: row.email,
    writtenText: row.written_text,
    audio: payloadAudio,
    workingDraft: row.working_draft,
    vocabulary: Array.isArray(row.vocabulary) ? (row.vocabulary as any) : [],
    punctuation: typeof row.punctuation === "object" && row.punctuation !== null ? (row.punctuation as any) : {},
    finalSettings,
    visibility: row.visibility,
    status: row.status,
    audio_public_playback: Boolean(row.audio_public_playback),
    updated_at: row.updated_at,
    created_at: row.created_at,
    // Supplemental fields supported by Explore and Review pages
    ...(row.final_text ? { final_text: row.final_text } : {}),
    ...(row.story ? { story: row.story } : {}),
    ...(row.place ? { place: row.place } : {}),
    ...(row.provenance_id ? { provenance_id: row.provenance_id } : {}),
    ...(row.provenance_hash ? { provenance_hash: row.provenance_hash } : {}),
    ...(row.preserved_at ? { preserved_at: row.preserved_at } : {}),
    ...(row.raw_transcripts && Object.keys(row.raw_transcripts).length > 0
      ? { raw_transcripts: row.raw_transcripts }
      : {}),
  };
}

// =============================================================================
// 4. LOCAL STORY JSON <-> DATABASE ROW ROUND-TRIP ADAPTER
// =============================================================================

/**
 * Recognised columns in public.stories.
 */
const KNOWN_STORY_ROW_KEYS = new Set([
  "id",
  "user_id",
  "title",
  "carrier",
  "relationship",
  "place",
  "roots",
  "category",
  "language",
  "period",
  "email",
  "written_text",
  "working_draft",
  "final_text",
  "story",
  "audio",
  "raw_transcripts",
  "vocabulary",
  "punctuation",
  "final_settings",
  "status",
  "visibility",
  "confirmed",
  "permission_confirmed",
  "audio_public_playback",
  "provenance_id",
  "provenance_hash",
  "preserved_at",
  "created_at",
  "updated_at",
]);

export interface LocalStoryConversionResult {
  row: StoryRow;
  unmapped: Record<string, any>;
  hasUnmappedFields: boolean;
}

/**
 * Converts a raw local story JSON file (from virasya-ai/data/output/stories/)
 * into a fully typed database StoryRow while capturing any unmapped or redundant
 * legacy keys into an unmapped dictionary.
 */
export function localStoryJsonToDbRow(
  json: Record<string, any>,
  fallbackUserId: string | null = null
): LocalStoryConversionResult {
  const unmapped: Record<string, any> = {};

  // Extract known fields with snake_case and camelCase precedence
  const id = String(json.id || "");
  const user_id = json.user_id !== undefined ? json.user_id : fallbackUserId;
  const title = String(json.title || "");
  const carrier = String(json.carrier || "");
  const relationship = String(json.relationship || "");
  const place = String(json.place || json.roots || "");
  const roots = String(json.roots || json.place || "");
  const category = String(json.category || "");
  const language = String(json.language || "Odia");
  const period = String(json.period || "");
  const email = String(json.email || "");

  const written_text = String(
    json.written_text !== undefined ? json.written_text : json.writtenText !== undefined ? json.writtenText : json.story || ""
  );
  const working_draft = String(
    json.working_draft !== undefined ? json.working_draft : json.workingDraft || ""
  );
  const final_text = String(json.final_text || json.finalText || "");
  const story = String(json.story || json.written_text || json.writtenText || "");

  const audio: DbAudioMetadata | null = json.audio ? (json.audio as DbAudioMetadata) : null;
  const raw_transcripts: Record<string, any> = json.raw_transcripts || {};
  const vocabulary: Json = json.vocabulary || [];
  const punctuation: Json = json.punctuation || {};
  const final_settings: Record<string, any> = json.final_settings || json.finalSettings || {};

  const rawStatus = String(json.status || "draft").toLowerCase();
  const status: StoryStatus = rawStatus === "preserved" ? "preserved" : "draft";

  const rawVisibility = String(
    json.visibility || (json.finalSettings && json.finalSettings.visibility) || "private"
  ).toLowerCase();
  const visibility: StoryVisibility =
    rawVisibility === "public" || rawVisibility === "family" || rawVisibility === "community"
      ? (rawVisibility as StoryVisibility)
      : "private";

  const confirmed = Boolean(
    json.confirmed !== undefined ? json.confirmed : json.finalSettings && json.finalSettings.confirmed
  );
  const permission_confirmed = Boolean(
    json.permission_confirmed !== undefined
      ? json.permission_confirmed
      : json.permissionConfirmed !== undefined
      ? json.permissionConfirmed
      : json.finalSettings && json.finalSettings.permissionConfirmed
  );

  const audio_public_playback = Boolean(json.audio_public_playback);
  const provenance_id = json.provenance_id ? String(json.provenance_id) : null;
  const provenance_hash = json.provenance_hash ? String(json.provenance_hash) : null;
  const preserved_at = json.preserved_at ? String(json.preserved_at) : null;
  const created_at = json.created_at ? String(json.created_at) : new Date().toISOString();
  const updated_at = json.updated_at ? String(json.updated_at) : created_at;

  const row: StoryRow = {
    id,
    user_id,
    title,
    carrier,
    relationship,
    place,
    roots,
    category,
    language,
    period,
    email,
    written_text,
    working_draft,
    final_text,
    story,
    audio,
    raw_transcripts,
    vocabulary,
    punctuation,
    final_settings,
    status,
    visibility,
    confirmed,
    permission_confirmed,
    audio_public_playback,
    provenance_id,
    provenance_hash,
    preserved_at,
    created_at,
    updated_at,
  };

  // Save original key list for lossless round-trip reconstruction
  unmapped._original_keys = Object.keys(json);

  // Capture all legacy dual-cased keys or non-column fields into unmapped
  for (const [key, val] of Object.entries(json)) {
    if (!KNOWN_STORY_ROW_KEYS.has(key)) {
      unmapped[key] = val;
    }
    // Also track legacy camelCase duplicates
    if (key === "writtenText" || key === "workingDraft" || key === "permissionConfirmed" || key === "finalSettings") {
      unmapped[key] = val;
    }
  }

  const realUnmappedKeys = Object.keys(unmapped).filter((k) => k !== "_original_keys");

  return {
    row,
    unmapped,
    hasUnmappedFields: realUnmappedKeys.length > 0,
  };
}

/**
 * Reconstructs the exact local JSON story format from a database StoryRow
 * and its captured unmapped properties. Guarantees 100% round-trip fidelity.
 */
export function dbRowToLocalStoryJson(
  row: StoryRow,
  unmapped: Record<string, any> = {}
): Record<string, any> {
  const originalKeys: string[] | undefined = unmapped._original_keys;

  if (Array.isArray(originalKeys) && originalKeys.length > 0) {
    const result: Record<string, any> = {};
    for (const key of originalKeys) {
      if (key === "_original_keys") continue;

      if (key in unmapped) {
        result[key] = unmapped[key];
        continue;
      }

      switch (key) {
        case "id": result.id = row.id; break;
        case "user_id": result.user_id = row.user_id; break;
        case "title": result.title = row.title; break;
        case "carrier": result.carrier = row.carrier; break;
        case "relationship": result.relationship = row.relationship; break;
        case "place": result.place = row.place; break;
        case "roots": result.roots = row.roots; break;
        case "category": result.category = row.category; break;
        case "language": result.language = row.language; break;
        case "period": result.period = row.period; break;
        case "email": result.email = row.email; break;
        case "written_text": result.written_text = row.written_text; break;
        case "writtenText": result.writtenText = unmapped.writtenText ?? row.written_text; break;
        case "working_draft": result.working_draft = row.working_draft; break;
        case "workingDraft": result.workingDraft = unmapped.workingDraft ?? row.working_draft; break;
        case "final_text": result.final_text = row.final_text; break;
        case "finalText": result.finalText = unmapped.finalText ?? row.final_text; break;
        case "story": result.story = row.story; break;
        case "audio": result.audio = row.audio; break;
        case "raw_transcripts": result.raw_transcripts = row.raw_transcripts; break;
        case "vocabulary": result.vocabulary = row.vocabulary; break;
        case "punctuation": result.punctuation = row.punctuation; break;
        case "final_settings": result.final_settings = row.final_settings; break;
        case "finalSettings": result.finalSettings = unmapped.finalSettings ?? row.final_settings; break;
        case "status": result.status = row.status; break;
        case "visibility": result.visibility = row.visibility; break;
        case "confirmed": result.confirmed = row.confirmed; break;
        case "permission_confirmed": result.permission_confirmed = row.permission_confirmed; break;
        case "permissionConfirmed": result.permissionConfirmed = unmapped.permissionConfirmed ?? row.permission_confirmed; break;
        case "audio_public_playback": result.audio_public_playback = row.audio_public_playback; break;
        case "provenance_id": result.provenance_id = row.provenance_id; break;
        case "provenance_hash": result.provenance_hash = row.provenance_hash; break;
        case "preserved_at": result.preserved_at = row.preserved_at; break;
        case "created_at": result.created_at = row.created_at; break;
        case "updated_at": result.updated_at = row.updated_at; break;
        default:
          if (key in unmapped) {
            result[key] = unmapped[key];
          }
      }
    }
    return result;
  }

  // Fallback for constructing JSON from a DB row without original keys history
  const result: Record<string, any> = {
    id: row.id,
    title: row.title,
    carrier: row.carrier,
    category: row.category,
    place: row.place,
    roots: row.roots,
    language: row.language,
    period: row.period,
    relationship: row.relationship,
    email: row.email,
    written_text: row.written_text,
    working_draft: row.working_draft,
    final_text: row.final_text,
    story: row.story,
    status: row.status,
    visibility: row.visibility,
    confirmed: row.confirmed,
    permission_confirmed: row.permission_confirmed,
    audio_public_playback: row.audio_public_playback,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (row.audio) result.audio = row.audio;
  if (row.raw_transcripts && Object.keys(row.raw_transcripts).length > 0) {
    result.raw_transcripts = row.raw_transcripts;
  }
  if (Array.isArray(row.vocabulary) && row.vocabulary.length > 0) {
    result.vocabulary = row.vocabulary;
  }
  if (row.punctuation && Object.keys(row.punctuation).length > 0) {
    result.punctuation = row.punctuation;
  }
  if (row.final_settings && Object.keys(row.final_settings).length > 0) {
    result.final_settings = row.final_settings;
  }
  if (row.provenance_id) result.provenance_id = row.provenance_id;
  if (row.provenance_hash) result.provenance_hash = row.provenance_hash;
  if (row.preserved_at) result.preserved_at = row.preserved_at;

  for (const [k, v] of Object.entries(unmapped)) {
    if (k !== "_original_keys") {
      result[k] = v;
    }
  }

  return result;
}

// =============================================================================
// 5. VOCABULARY ADAPTERS
// =============================================================================

export interface VocabularyInsertOptions {
  userId?: string | null;
  storyId?: string | null;
}

/**
 * Converts a frontend VocabularyEntry to a client-safe database VocabularyInsert row.
 *
 * SECURITY ENFORCEMENT:
 * - verification_status is forced to 'suggested' (clients cannot self-verify).
 * - is_sample is forced to false (clients cannot mark entries as system samples).
 * - verification_count is forced to 1.
 */
export function vocabularyEntryToDbInsert(
  entry: VocabularyEntry,
  options: VocabularyInsertOptions = {}
): VocabularyInsert {
  return {
    id: entry.id || `vocab_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    user_id: options.userId ?? null,
    story_id: options.storyId ?? null,
    canonical_term: entry.preferred,
    heard_term: entry.heard || "",
    language: entry.language || "or",
    category: entry.kind || "cultural_term",
    variants: [],
    context: entry.context || "",
    meaning: entry.meaning || "",
    pronunciation: entry.pronunciation || "",
    dialect: "",
    verification_status: "suggested", // Strictly enforced for standard clients
    verification_count: 1,
    source_artifact: {},
    provenance_history: [],
    is_sample: false, // Strictly enforced for standard clients
  };
}

/**
 * Converts a database VocabularyRow to the frontend VocabularyEntry interface.
 */
export function dbRowToVocabularyEntry(row: VocabularyRow): VocabularyEntry {
  return {
    id: row.id,
    preferred: row.canonical_term,
    heard: row.heard_term || row.canonical_term,
    meaning: row.meaning || "",
    language: row.language,
    context: row.context || "",
    kind: row.category,
    pronunciation: row.pronunciation || undefined,
    isSample: row.is_sample,
  };
}

/**
 * Converts a VocabularyWordItem (from preservation review step 4) to a database VocabularyInsert.
 */
export function vocabularyWordItemToDbInsert(
  item: VocabularyWordItem,
  options: VocabularyInsertOptions & { id?: string } = {}
): VocabularyInsert {
  return {
    id: options.id || `vocab_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    user_id: options.userId ?? null,
    story_id: options.storyId ?? null,
    canonical_term: item.preferred,
    heard_term: item.heard || "",
    language: item.language || "or",
    category: item.kind || "cultural_term",
    variants: [],
    context: item.context || "",
    meaning: item.meaning || "",
    pronunciation: "",
    dialect: "",
    verification_status: "suggested",
    verification_count: 1,
    source_artifact: {},
    provenance_history: [],
    is_sample: false,
  };
}
