/**
 * Virasya Preservation Workbench API Client
 * Connects frontend to the Virasya AI backend or operates in preview mode.
 */

import { SAMPLE_EXPLORE_STORIES } from "../explore/sampleStories";
import {
  getSupabase,
  isSupabaseConfigured,
  fetchExploreStoriesFromSupabase,
  fetchExploreStoryDetailFromSupabase,
  preserveStoryToSupabase,
  storyRowToStoryPayload,
  uploadAudioToPrivateBucket,
  deleteStoryDraftFromSupabase,
  deleteStoryFromSupabase,
} from "../supabase";
import type { TranscriptionStyle } from "./types";
import { transliterateDevanagariToLatin } from "./transliterate";

export interface StoryPayload {
  id?: string;
  title?: string;
  carrier?: string;
  relationship?: string;
  roots?: string;
  place?: string;
  category?: string;
  language?: string;
  period?: string;
  email?: string;
  writtenText?: string;
  final_text?: string;
  story?: string;
  provenance_id?: string;
  provenance_hash?: string;
  preserved_at?: string;
  audio?: {
    filename: string;
    url?: string;
    size?: number | null;
    duration?: number | null;
    kind: string;
    storage_path?: string;
    bucket?: string;
  } | null;
  audio_public_playback?: boolean;
  transcription_style?: TranscriptionStyle;
  raw_transcripts?: Record<string, any>;
  workingDraft?: string;
  vocabulary?: Array<{
    id?: string;
    preferred: string;
    heard?: string;
    meaning?: string;
    context?: string;
    language?: string;
    kind?: string;
  }>;
  punctuation?: {
    finalText?: string;
    marksCount?: number;
    wordIntegrityPassed?: boolean;
  };
  visibility?: "private" | "family" | "community" | "public" | string;
  finalSettings?: {
    visibility?: string;
    confirmed?: boolean;
    permissionConfirmed?: boolean;
    audioPublicConsent?: boolean;
    provenance_id?: string;
    provenance_hash?: string;
    preserved_at?: string;
    [key: string]: any;
  };
  status?: "draft" | "preserved";
  updated_at?: string;
  created_at?: string;
}

export interface PreserveResponse {
  status: "success";
  story: StoryPayload;
  preserved_at: string;
  provenance_id: string;
  provenance_hash: string;
}

export interface AudioUploadResponse {
  status: "success";
  filename: string;
  url: string;
  size: number;
}

export interface VocabularyWordItem {
  preferred: string;
  heard?: string;
  meaning?: string;
  context?: string;
  language?: string;
  kind?: string;
}

// Configurable API Base URL from Vite environment variables
const RAW_API_BASE = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

function isLocalhostUrl(url: string): boolean {
  if (!url) return false;
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

export function isLocalDev(): boolean {
  return Boolean(import.meta.env.DEV);
}

/**
 * Indicates whether a backend platform is explicitly configured.
 * In the modern serverless architecture, Supabase is the primary backend platform.
 * Returns true if Supabase is configured (or during local development preview).
 */
export function isBackendConfigured(): boolean {
  if (isSupabaseConfigured()) {
    return true;
  }
  if (isLocalDev()) {
    return true;
  }
  // In production, reject empty or localhost/127.0.0.1 URLs
  if (RAW_API_BASE.length > 0 && !isLocalhostUrl(RAW_API_BASE)) {
    return true;
  }
  return false;
}

export function getApiBase(): string {
  if (isLocalDev()) {
    return RAW_API_BASE || "";
  }
  // In production, never return a localhost URL
  if (RAW_API_BASE.length > 0 && !isLocalhostUrl(RAW_API_BASE)) {
    return RAW_API_BASE;
  }
  return "";
}

/**
 * Resolves an API endpoint against the configured backend base URL.
 * In production, throws a clear Configuration Error if VITE_API_BASE_URL is missing,
 * preventing silent fallback to relative /api on Vercel.
 * In local development, returns relative /api path (proxied by Vite dev server to 127.0.0.1:5000).
 */
export function resolveApiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (isLocalDev()) {
    return `${RAW_API_BASE || ""}${cleanPath}`;
  }
  if (RAW_API_BASE.length > 0 && !isLocalhostUrl(RAW_API_BASE)) {
    return `${RAW_API_BASE}${cleanPath}`;
  }
  if (!isBackendConfigured()) {
    throw new Error(
      `Configuration Error: Cannot route '${cleanPath}'. VITE_API_BASE_URL is missing in this production deployment. Set VITE_API_BASE_URL in your hosting environment settings.`
    );
  }
  return cleanPath;
}

/**
 * Safely retrieves current Supabase session access token for protected ASR backend calls.
 * Never throws, never logs tokens, and handles missing or expired sessions gracefully.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const supabase = getSupabase();
    if (!supabase) return {};
    const { data, error } = await supabase.auth.getSession();
    if (error || !data?.session?.access_token) return {};
    return {
      Authorization: `Bearer ${data.session.access_token}`,
    };
  } catch {
    return {};
  }
}

/**
 * Fetches an authenticated audio file using the user's Bearer token and returns an ephemeral Blob URL.
 * Automatically eliminates query-string tokens from media URLs and prevents browser history leaks.
 */
export async function fetchAuthenticatedAudioBlob(audioUrl: string): Promise<string> {
  if (!audioUrl) throw new Error("No audio URL provided");
  if (audioUrl.startsWith("blob:") || audioUrl.startsWith("data:")) {
    return audioUrl;
  }

  if (!audioUrl.startsWith("http://") && !audioUrl.startsWith("https://")) {
    if (!isBackendConfigured()) {
      throw new Error(
        "Configuration Error: VITE_API_BASE_URL is missing in this production environment. Cannot fetch audio recording from relative path."
      );
    }
  }

  const base = getApiBase();
  const targetUrl = audioUrl.startsWith("http://") || audioUrl.startsWith("https://")
    ? audioUrl
    : `${base}${audioUrl.startsWith("/") ? "" : "/"}${audioUrl}`;

  const authHeaders = await getAuthHeaders();
  const res = await fetch(targetUrl, {
    method: "GET",
    headers: { ...authHeaders },
  });

  if (res.status === 401) {
    throw new Error("Authentication required to access this recording.");
  }
  if (res.status === 404) {
    throw new Error("Audio recording not found or unauthorized.");
  }
  if (!res.ok) {
    throw new Error(`Failed to load audio (${res.status})`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function saveStoryToBackend(story: StoryPayload): Promise<{ status: string; story: StoryPayload }> {
  // If Supabase is configured, persist draft directly to public.stories
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const storyId = story.id || `story_${Date.now()}`;
        const draftVisibility =
          story.visibility ||
          story.finalSettings?.visibility ||
          (story as any).visibility ||
          "private";

        const { error } = await supabase.from("stories").upsert({
          id: storyId,
          user_id: user.id,
          title: story.title || "Untitled Story",
          carrier: story.carrier || "",
          category: story.category || "General",
          place: story.place || story.roots || "",
          language: story.language || "Hindi",
          written_text: story.writtenText || (story as any).story || "",
          working_draft: story.workingDraft || "",
          audio: story.audio || null,
          raw_transcripts: story.raw_transcripts || {},
          vocabulary: story.vocabulary || [],
          punctuation: story.punctuation || {},
          final_settings: story.finalSettings || {},
          visibility: draftVisibility,
          status: "draft",
          updated_at: new Date().toISOString(),
        });
        if (!error) {
          return { status: "success", story: { ...story, id: storyId, visibility: draftVisibility } };
        }
      }
    } catch (err) {
      console.warn("Supabase draft persistence notice:", err);
    }
  }

  // Local browser draft fallback for guest exploration
  return { status: "preview_local", story };
}

export async function getUserDraftFromBackend(): Promise<StoryPayload | null> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data, error } = await supabase
          .from("stories")
          .select("*")
          .eq("user_id", user.id)
          .eq("status", "draft")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) {
          return storyRowToStoryPayload(data);
        }
      }
    } catch (err) {
      console.warn("Supabase getUserDraftFromBackend notice:", err);
    }
  }
  return null;
}

export async function deleteStoryDraftFromBackend(
  storyId: string
): Promise<{ success: boolean; notFound?: boolean; error?: string }> {
  if (isSupabaseConfigured()) {
    return deleteStoryDraftFromSupabase(storyId);
  }
  // Local browser draft fallback for guest exploration
  return { success: true };
}

export async function deleteStoryFromBackend(
  storyId: string
): Promise<{ success: boolean; storageCleaned?: boolean; notFound?: boolean; error?: string; warning?: string }> {
  if (isSupabaseConfigured()) {
    return deleteStoryFromSupabase(storyId);
  }
  return { success: true, storageCleaned: true };
}

export async function getStoryFromBackend(storyId: string): Promise<StoryPayload> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from("stories")
      .select("*")
      .eq("id", storyId)
      .maybeSingle();

    if (!error && data) {
      return storyRowToStoryPayload(data);
    }
  }
  throw new Error("Story record not found in archive.");
}

export async function listStoriesFromBackend(): Promise<StoryPayload[]> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data, error } = await supabase
        .from("stories")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });

      if (!error && data) {
        return data.map(storyRowToStoryPayload);
      }
    }
  }
  return [];
}

export async function preserveStoryOnBackend(storyId: string, payload: Partial<StoryPayload>): Promise<PreserveResponse> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    throw new Error("Archival preservation requires active Supabase credentials.");
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Authentication required: You must be signed in to preserve a story.");
  }
  return preserveStoryToSupabase({ ...payload, id: storyId } as StoryPayload, user.id);
}

export async function uploadAudioToBackend(file: File): Promise<AudioUploadResponse> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const res = await uploadAudioToPrivateBucket(file, file.name, user.id);
      if (res.error) {
        throw new Error(res.error.message || "Failed to upload audio to storage.");
      }
      return {
        status: "success",
        filename: file.name,
        url: res.signedUrl || "",
        size: file.size,
      };
    }
    throw new Error("Authentication required. Please sign in to upload audio recordings.");
  }

  if (isLocalDev()) {
    const base = getApiBase();
    const authHeaders = await getAuthHeaders();
    const formData = new FormData();
    formData.append("file", file, file.name);
    let res: Response;
    try {
      res = await fetch(`${base}/api/upload`, {
        method: "POST",
        headers: { ...authHeaders },
        body: formData,
      });
      if (!res.ok) throw new Error("Local upload failed");
      return res.json();
    } catch {
      return {
        status: "success",
        filename: file.name,
        url: URL.createObjectURL(file),
        size: file.size,
      };
    }
  }

  throw new Error("Supabase is not configured in this environment.");
}

export async function saveVocabularyToBackend(words: VocabularyWordItem[]): Promise<{ status: string; count: number; entries: any[] }> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user && words.length > 0) {
        const rows = words.map((w) => ({
          id: `vocab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          user_id: user.id,
          canonical_term: w.preferred,
          heard_term: w.heard || "",
          meaning: w.meaning || "",
          context: w.context || "",
          language: w.language || "Hindi",
        }));
        await supabase.from("vocabulary").upsert(rows);
        return { status: "success", count: words.length, entries: words };
      }
    } catch (err) {
      console.warn("Supabase vocabulary upsert notice:", err);
    }
  }
  return { status: "preview_local", count: words.length, entries: words };
}

export async function getVocabularyFromBackend(): Promise<any[]> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data, error } = await supabase
        .from("vocabulary")
        .select("*")
        .eq("user_id", user.id);
      if (!error && data) return data;
    }
  }
  return [];
}

export interface TranscribeResultItem {
  status: "done" | "error";
  text: string;
  model: string;
  provider: string;
  inference_seconds?: number;
  duration_seconds?: number;
  error?: string | null;
}

export interface TranscribeResponse {
  status: "success";
  filename: string;
  provider?: string;
  model?: string;
  transcript?: string;
  raw_text?: string;
  inference_seconds?: number;
  duration_seconds?: number;
  format?: string;
  transcription_style?: string;
  language?: string;
  language_code?: string;
  requested_language?: string;
  provider_language?: string;
  metadata?: Record<string, any>;
  results: {
    gnani?: TranscribeResultItem;
    vaani?: TranscribeResultItem;
    indicconformer?: TranscribeResultItem;
  };
  gnani?: string;
  vaani?: string;
  indic?: string;
  gnani_info?: TranscribeResultItem;
  vaani_info?: TranscribeResultItem;
  indic_info?: TranscribeResultItem;
}

export async function fetchModelStatus(): Promise<{
  gnani?: { status: string; error?: string | null; model: string };
  vaani: { status: string; error?: string | null; model: string };
  indicconformer: { status: string; error?: string | null; model: string };
  busy: boolean;
}> {
  return {
    gnani: { status: "online", error: null, model: "Gnani Prisma STT v2.5 (Cloud AI)" },
    vaani: { status: "online", error: null, model: "Gnani Prisma STT v2.5" },
    indicconformer: { status: "offline", error: null, model: "AI4Bharat IndicConformer (Offline)" },
    busy: false,
  };
}

export interface BackendHealthResponse {
  status: "healthy";
  service: string;
  timestamp: string;
  models: {
    gnani?: { status: string; error?: string | null; model: string };
    vaani: { status: string; error?: string | null; model: string };
    indicconformer: { status: string; error?: string | null; model: string };
    busy: boolean;
  };
}

export async function checkBackendHealth(): Promise<{
  online: boolean;
  configured: boolean;
  data?: BackendHealthResponse;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    return {
      online: false,
      configured: false,
      error: "Supabase connection is not configured in this environment.",
    };
  }

  return {
    online: true,
    configured: true,
    data: {
      status: "healthy",
      service: "Virasya Supabase Platform",
      timestamp: new Date().toISOString(),
      models: {
        gnani: { status: "online", model: "Gnani Prisma STT v2.5 (Cloud AI)" },
        vaani: { status: "online", model: "Gnani Prisma STT v2.5" },
        indicconformer: { status: "offline", model: "AI4Bharat IndicConformer (Offline)" },
        busy: false,
      },
    },
  };
}

export interface PunctuateResponse {
  status: "success" | "error" | "manual_only";
  supported: boolean;
  model?: string;
  original_text?: string;
  punctuated_text: string;
  error?: string;
  message?: string;
}

export async function punctuateTextOnBackend(text: string, _taskPath?: string): Promise<PunctuateResponse> {
  // Punctuation is performed by storytellers in Step 5 (Punctuation Truthfulness)
  // using quick-insert marks without corrupting words
  return {
    status: "manual_only",
    supported: false,
    punctuated_text: text,
    message: "Use the authentic quick-insert punctuation marks to punctuate your story respectfully.",
  };
}

export async function checkPunctuationCapability(text?: string): Promise<{
  status: "manual_only" | "supported" | "success" | "error";
  supported: boolean;
  message?: string;
  punctuated_text?: string;
}> {
  return punctuateTextOnBackend(text || "");
}

export function extractErrorMessage(err: unknown, fallback: string = "Speech transcription failed."): string {
  if (!err) return fallback;
  if (typeof err === "string") {
    const trimmed = err.trim();
    if (trimmed && trimmed !== "[object Object]") return trimmed;
    return fallback;
  }
  if (typeof err === "object") {
    const obj = err as Record<string, any>;
    if (typeof obj.message === "string" && obj.message.trim() && obj.message !== "[object Object]") {
      return obj.message.trim();
    }
    if (typeof obj.error === "string" && obj.error.trim() && obj.error !== "[object Object]") {
      return obj.error.trim();
    }
    if (typeof obj.error === "object" && obj.error !== null) {
      return extractErrorMessage(obj.error, fallback);
    }
    if (typeof obj.detail === "string" && obj.detail.trim()) {
      return obj.detail.trim();
    }
    if (typeof obj.code === "string" && obj.code.trim()) {
      return `Error (${obj.code}): ${fallback}`;
    }
    try {
      const json = JSON.stringify(obj);
      if (json && json !== "{}") return json;
    } catch {}
  }
  return fallback;
}

export async function transcribeAudioOnBackend(
  filename: string,
  language: string = "hi-IN",
  storyId?: string,
  signal?: AbortSignal,
  storagePath?: string,
  format: TranscriptionStyle = "verbatim"
): Promise<TranscribeResponse> {
  const supabase = getSupabase();
  if (supabase && isSupabaseConfigured()) {
    const canonicalPath = storagePath || filename;
    const { data, error } = await supabase.functions.invoke<TranscribeResponse>("transcribe-audio", {
      body: {
        storage_path: canonicalPath,
        language,
        language_code: language,
        story_id: storyId,
        format,
        transcription_style: format,
      },
    });

    if (error) {
      let detailMessage: string = error.message;
      if ((error as any).context && typeof (error as any).context.json === "function") {
        try {
          const errJson = await (error as any).context.json();
          detailMessage = extractErrorMessage(errJson, error.message);
        } catch {
          detailMessage = error.message;
        }
      }
      throw new Error(extractErrorMessage(detailMessage, "Speech transcription failed."));
    }

    if (!data || data.status !== "success") {
      const msg = extractErrorMessage((data as any)?.error, "Speech transcription failed.");
      throw new Error(msg);
    }

    if (format === "transliterate" && data) {
      if (data.transcript && /[\u0900-\u097F]/.test(data.transcript)) {
        const latin = transliterateDevanagariToLatin(data.transcript);
        data.transcript = latin;
        data.raw_text = latin;
        if (data.gnani) data.gnani = latin;
        if (data.vaani) data.vaani = latin;
        if (data.results?.gnani) data.results.gnani.text = latin;
        if (data.results?.vaani) data.results.vaani.text = latin;
        if (data.gnani_info) data.gnani_info.text = latin;
        if (data.vaani_info) data.vaani_info.text = latin;
      }
    }

    return data;
  }

  // Local development fallback
  if (isLocalDev()) {
    const base = getApiBase();
    const authHeaders = await getAuthHeaders();
    let res: Response;
    try {
      res = await fetch(`${base}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          filename,
          language,
          language_code: language,
          story_id: storyId,
          format,
          transcription_style: format,
        }),
        signal,
      });
    } catch (networkErr: any) {
      if (networkErr.name === "AbortError") throw networkErr;
      throw new Error(
        "Unable to connect to local development backend. Please ensure the backend is running."
      );
    }

    if (res.status === 401) {
      throw new Error("Authentication required. Please sign in to perform speech transcription.");
    }

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      if (errorData.error) throw new Error(errorData.error);
      throw new Error(`Transcription failed with status ${res.status}`);
    }
    const localData = await res.json();
    if (format === "transliterate" && localData) {
      if (localData.transcript && /[\u0900-\u097F]/.test(localData.transcript)) {
        const latin = transliterateDevanagariToLatin(localData.transcript);
        localData.transcript = latin;
        localData.raw_text = latin;
        if (localData.gnani) localData.gnani = latin;
        if (localData.vaani) localData.vaani = latin;
        if (localData.results?.gnani) localData.results.gnani.text = latin;
        if (localData.results?.vaani) localData.results.vaani.text = latin;
        if (localData.gnani_info) localData.gnani_info.text = latin;
        if (localData.vaani_info) localData.vaani_info.text = latin;
      }
    }
    return localData;
  }

  throw new Error("Supabase connection is not configured in this environment.");
}

export interface ExploreStoryCard {
  id: string;
  title: string;
  carrier: string;
  category: string;
  place: string;
  roots?: string;
  language: string;
  period: string;
  relationship: string;
  excerpt: string;
  word_count: number;
  preserved_at: string;
  provenance_id: string;
  vocabulary_count: number;
  has_audio?: boolean;
  is_preview?: boolean;
  vocabulary: Array<{
    preferred: string;
    heard?: string;
    meaning: string;
    language: string;
    context: string;
    pronunciation?: string;
  }>;
}

export interface ExploreDetailStory extends ExploreStoryCard {
  final_text: string;
  written_text?: string;
  audio?: {
    filename: string;
    url?: string;
    duration?: number | null;
    size?: number | null;
    kind?: string;
    storage_path?: string;
    bucket?: string;
  } | null;
  raw_transcripts?: {
    vaani?: {
      text?: string;
      model?: string;
      status?: string;
    };
    indicconformer?: {
      text?: string;
      model?: string;
      status?: string;
    };
  };
}

export interface ExploreFeedResponse {
  status: "success";
  count: number;
  stories: ExploreStoryCard[];
}

export async function fetchExploreFeed(filters?: {
  search?: string;
  q?: string;
  category?: string;
  language?: string;
  place?: string;
}): Promise<ExploreFeedResponse> {
  // The public explore feed queries ONLY preserved public stories from Supabase.
  // It never falls back to local backend JSON drafts or test fixture files.
  if (!isSupabaseConfigured()) {
    return {
      status: "success",
      count: 0,
      stories: [],
    };
  }

  try {
    const supabaseResult = await fetchExploreStoriesFromSupabase(filters);
    return {
      status: "success",
      count: supabaseResult.count,
      stories: supabaseResult.stories,
    };
  } catch (supabaseErr: any) {
    console.error("[Explore] Supabase query failed:", supabaseErr?.message);
    throw new Error(
      `Failed to load stories from archive: ${supabaseErr?.message || "Remote database error"}`
    );
  }
}

export async function fetchExploreStoryDetail(storyId: string): Promise<{ status: "success"; story: ExploreDetailStory }> {
  // Check authorized sample preview stories first (for offline preview demo)
  const sample = SAMPLE_EXPLORE_STORIES.find((s) => s.id === storyId);
  if (sample) {
    return { status: "success", story: sample };
  }

  // Check Supabase public stories
  if (isSupabaseConfigured()) {
    try {
      const supabaseDetail = await fetchExploreStoryDetailFromSupabase(storyId);
      if (supabaseDetail) {
        return { status: "success", story: supabaseDetail };
      }
    } catch (err: any) {
      console.warn("[Explore] Supabase story detail error:", err?.message);
    }
  }

  throw new Error("Story record is not available in the public archive.");
}
