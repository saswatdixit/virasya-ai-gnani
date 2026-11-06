/**
 * Virasya Supabase Story Persistence Module
 *
 * Implements real, client-safe persistence of cultural stories to the
 * Supabase `public.stories` table on the staging environment.
 *
 * Adheres strictly to:
 * - Row Level Security (RLS) policies on staging Supabase
 * - Integrity trigger `trigger_protect_story_integrity`
 * - Cryptographic provenance generation (VIR-{sha256[:12]})
 */

import { getSupabase, isSupabaseConfigured } from "./client";
import { storyRowToStoryPayload } from "./adapters";
import {
  attemptAudioCleanupWithRetry,
  queuePendingAudioCleanup,
} from "./storage";
import type { StoryPayload, PreserveResponse, ExploreStoryCard, ExploreDetailStory } from "../preserve/api";

/**
 * Computes deterministic cryptographic provenance identifier VIR-{sha256[:12]}
 * matching the Virasya archival design specification.
 */
export async function computeProvenanceId(params: {
  storyId: string;
  timestamp: string;
  title: string;
  carrier: string;
  text: string;
}): Promise<{ provenanceId: string; provenanceHash: string }> {
  const seed = `${params.storyId}:${params.timestamp}:${params.title}:${params.carrier}:${params.text.slice(0, 40)}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(seed);

  // Use standard Web Crypto API (available in modern browsers and modern Node)
  const subtle = typeof window !== "undefined" && window.crypto?.subtle
    ? window.crypto.subtle
    : (globalThis as any).crypto?.subtle;

  if (subtle) {
    const hashBuffer = await subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    const provenanceHash = hex.slice(0, 12).toUpperCase();
    return {
      provenanceId: `VIR-${provenanceHash}`,
      provenanceHash,
    };
  }

  // Pure JS fallback if SubtleCrypto is unavailable in certain environments
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const fallbackHex = Math.abs(hash).toString(16).padStart(12, "0").slice(0, 12).toUpperCase();
  return {
    provenanceId: `VIR-${fallbackHex}`,
    provenanceHash: fallbackHex,
  };
}

/**
 * Persists an authenticated user's story to Supabase public.stories table.
 *
 * If the user is unauthenticated or the database request fails, this function
 * strictly throws an error rather than fabricating a demo receipt.
 */
export async function preserveStoryToSupabase(
  story: StoryPayload,
  userId: string
): Promise<PreserveResponse> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    throw new Error(
      "Supabase connection is not configured in this environment. Permanent persistence requires active Supabase credentials."
    );
  }

  if (!userId) {
    throw new Error(
      "Authentication required: You must be signed in to permanently preserve a story to the Virasya archive."
    );
  }

  const storyId = story.id || `story_${Date.now()}`;
  const now = new Date().toISOString();
  const title = story.title || "Untitled Story";
  const carrier = story.carrier || "";
  const workingText =
    story.final_text ||
    (story as any).story ||
    story.workingDraft ||
    story.writtenText ||
    "";

  // Compute sovereign provenance ID
  const { provenanceId, provenanceHash } = await computeProvenanceId({
    storyId,
    timestamp: now,
    title,
    carrier,
    text: workingText,
  });

  // Forward explicit storyteller consent unchanged without defaulting missing consent to true (VIR-SEC-002)
  const audioPublicPlayback = Boolean(story.audio_public_playback);

  // Prepare payload with provenance stored safely in finalSettings JSONB
  const payloadWithProvenance: StoryPayload = {
    ...story,
    id: storyId,
    visibility: story.finalSettings?.visibility || (story as any).visibility || "public",
    audio_public_playback: audioPublicPlayback,
    finalSettings: {
      ...(story.finalSettings || {}),
      visibility: story.finalSettings?.visibility || (story as any).visibility || "public",
      confirmed: true,
      permissionConfirmed: true,
      audioPublicConsent: audioPublicPlayback,
      provenance_id: provenanceId,
      provenance_hash: provenanceHash,
      preserved_at: now,
    },
  };

  // Invoke trusted server-side Edge Function
  // The Edge Function verifies the user's JWT, enforces ownership, validates narrative integrity,
  // computes the cryptographic provenance hash, and seals the record using server-side service_role.
  const { data, error } = await supabase.functions.invoke<PreserveResponse>("preserve-story", {
    body: payloadWithProvenance,
  });

  if (error) {
    let detailMessage = error.message;
    // Check if error body has more specific JSON error
    if ((error as any).context && typeof (error as any).context.json === "function") {
      try {
        const errJson = await (error as any).context.json();
        if (errJson?.error) detailMessage = errJson.error;
      } catch {}
    }
    console.error("Trusted server-side preservation failed:", detailMessage);
    throw new Error(`Archival preservation failed: ${detailMessage}`);
  }

  if (!data || data.status !== "success") {
    const errorMsg = (data as any)?.error || "Server preservation did not return success.";
    throw new Error(`Archival preservation failed: ${errorMsg}`);
  }

  const savedPayload = data.story ? storyRowToStoryPayload(data.story as any) : (payloadWithProvenance as any);

  return {
    status: "success",
    story: {
      ...savedPayload,
      provenance_id: data.provenance_id,
      provenance_hash: data.provenance_hash,
      preserved_at: data.preserved_at,
    },
    preserved_at: data.preserved_at,
    provenance_id: data.provenance_id,
    provenance_hash: data.provenance_hash,
  };
}

// Explicit public-safe column projections (omits personal email and private storage paths)
const EXPLORE_PUBLIC_COLUMNS =
  "id, title, carrier, place, roots, category, language, period, final_text, audio_public_playback, provenance_id, preserved_at, created_at, audio, vocabulary";

const EXPLORE_DETAIL_COLUMNS =
  "id, title, carrier, place, roots, category, language, period, written_text, final_text, audio_public_playback, provenance_id, preserved_at, created_at, audio, vocabulary";

/**
 * Queries Supabase public.stories for preserved public stories.
 */
export async function fetchExploreStoriesFromSupabase(filters?: {
  search?: string;
  q?: string;
  category?: string;
  language?: string;
  place?: string;
}): Promise<{ count: number; stories: ExploreStoryCard[] }> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    return { count: 0, stories: [] };
  }

  try {
    // Query public.explore_stories view which enforces least-privilege projection,
    // redacts storyteller email addresses, and scrubs private audio storage paths (VIR-SEC-003)
    let query = (supabase as any)
      .from("explore_stories")
      .select(EXPLORE_PUBLIC_COLUMNS)
      .order("preserved_at", { ascending: false, nullsFirst: false });

    if (filters?.category && filters.category !== "All") {
      query = query.ilike("category", filters.category);
    }
    if (filters?.language && filters.language !== "All") {
      query = query.ilike("language", filters.language);
    }
    if (filters?.place) {
      query = query.ilike("place", `%${filters.place}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.warn("Could not query stories from Supabase:", error.message);
      throw new Error(error.message);
    }

    if (!data) {
      return { count: 0, stories: [] };
    }

    let rows: any[] = data;
    const searchTerm = (filters?.search || filters?.q || "").trim().toLowerCase();
    if (searchTerm) {
      rows = rows.filter((r: any) => {
        return (
          (r.title && r.title.toLowerCase().includes(searchTerm)) ||
          (r.carrier && r.carrier.toLowerCase().includes(searchTerm)) ||
          (r.place && r.place.toLowerCase().includes(searchTerm)) ||
          (r.final_text && r.final_text.toLowerCase().includes(searchTerm))
        );
      });
    }

    const cards: ExploreStoryCard[] = rows.map((row: any) => {
      const excerpt = (row.final_text || "").slice(0, 150);
      const settingsProvId = (row.final_settings as any)?.provenance_id;
      return {
        id: row.id,
        title: row.title || "Untitled Story",
        carrier: (row.carrier || "").trim() || "Community contributor",
        category: row.category || "General",
        place: row.place || row.roots || "India",
        roots: row.roots,
        language: row.language || "Hindi",
        period: row.period || "Traditional",
        relationship: (row.relationship || "").trim(),
        excerpt: excerpt ? (excerpt.length >= 150 ? `${excerpt}…` : excerpt) : "Oral heritage record",
        word_count: (row.final_text || "").split(/\s+/).filter(Boolean).length,
        preserved_at: row.preserved_at || row.created_at,
        provenance_id: row.provenance_id || settingsProvId || `VIR-${row.id.slice(-6).toUpperCase()}`,
        vocabulary_count: Array.isArray(row.vocabulary) ? row.vocabulary.length : 0,
        has_audio: Boolean(row.audio),
        vocabulary: Array.isArray(row.vocabulary) ? (row.vocabulary as any) : [],
      };
    });

    return {
      count: cards.length,
      stories: cards,
    };
  } catch (err: any) {
    console.warn("Supabase explore query error:", err.message);
    throw err;
  }
}

/**
 * Retrieves a single preserved story record by ID from Supabase.
 */
export async function fetchExploreStoryDetailFromSupabase(
  storyId: string
): Promise<ExploreDetailStory | null> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    return null;
  }

  try {
    // Query public.explore_stories view for detail to enforce strict field projection (VIR-SEC-003)
    const { data, error } = await (supabase as any)
      .from("explore_stories")
      .select(EXPLORE_DETAIL_COLUMNS)
      .eq("id", storyId)
      .single();

    if (error || !data) {
      return null;
    }

    const payload = storyRowToStoryPayload(data as any);
    const excerpt = (data.final_text || "").slice(0, 150);
    const settingsProvId = (data as any)?.final_settings?.provenance_id;

    // Sanitize audio metadata: do NOT leak private storage path if public playback is disabled
    const safeAudio = data.audio_public_playback
      ? payload.audio
      : undefined;

    return {
      id: data.id,
      title: data.title || "Untitled Story",
      carrier: (data.carrier || "").trim() || "Community contributor",
      category: data.category || "General",
      place: data.place || data.roots || "Odisha",
      roots: data.roots,
      language: data.language || "Odia",
      period: data.period || "Traditional",
      relationship: (data.relationship || "").trim(),
      excerpt: excerpt ? `${excerpt}…` : "Oral heritage record",
      word_count: (data.final_text || "").split(/\s+/).filter(Boolean).length,
      preserved_at: data.preserved_at || data.created_at,
      provenance_id: data.provenance_id || settingsProvId || `VIR-${data.id.slice(-6).toUpperCase()}`,
      vocabulary_count: Array.isArray(data.vocabulary) ? data.vocabulary.length : 0,
      has_audio: Boolean(data.audio && data.audio_public_playback),
      vocabulary: Array.isArray(data.vocabulary) ? (data.vocabulary as any) : [],
      written_text: (data as any)?.written_text || payload.writtenText || "",
      final_text: data.final_text || "",
      audio: safeAudio,
      raw_transcripts: undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Permanently discards a specific story draft from Supabase public.stories.
 *
 * Strict Security Rules:
 * - Requires authenticated session
 * - Restricted to rows where user_id = auth.uid() (matching RLS policy stories_delete_owner)
 * - Restricted strictly to rows with status = 'draft' (cannot delete preserved stories)
 * - Targets exact story ID only
 */
export async function deleteStoryDraftFromSupabase(
  storyId: string
): Promise<{ success: boolean; notFound?: boolean; error?: string }> {
  if (!storyId) {
    return { success: false, error: "Missing story draft identifier." };
  }

  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    return { success: false, error: "Archival database is not configured in this environment." };
  }

  try {
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return { success: false, error: "Authentication required to discard cloud draft." };
    }

    const { data, error, count } = await (supabase as any)
      .from("stories")
      .delete({ count: "exact" })
      .eq("id", storyId.trim())
      .eq("user_id", user.id)
      .eq("status", "draft")
      .select("id");

    if (error) {
      console.error("[Supabase] Failed to delete cloud draft:", error);
      return {
        success: false,
        error: error.message || "Failed to delete cloud draft from database.",
      };
    }

    const deletedCount = count ?? (Array.isArray(data) ? data.length : 0);
    if (deletedCount === 0) {
      console.warn("[Supabase] Delete story draft matched 0 rows for user:", user.id, "storyId:", storyId);
      return {
        success: false,
        notFound: true,
        error: "Story draft could not be deleted or does not exist in your archive.",
      };
    }

    return { success: true };
  } catch (err: any) {
    console.error("[Supabase] Exception discarding cloud draft:", err);
    return {
      success: false,
      error: err.message || "Network error while discarding cloud draft.",
    };
  }
}

export interface StoryDeletionResult {
  success: boolean;
  storageCleaned?: boolean;
  warning?: string;
  error?: string;
  notFound?: boolean;
}

/**
 * Permanently deletes a saved story (public or private) from Supabase public.stories
 * with failure-safe audio storage cleanup.
 *
 * Failure-Safe Invariants:
 * 1. Independent Server-Side Authentication & Ownership Verification:
 *    Fetches record matching id and user_id = auth.uid(). Fails if not found or unauthorized.
 * 2. Strict Path Sanitization:
 *    Extracts storage_path strictly from the verified database record (never from caller parameters).
 *    Asserts path starts with `${user.id}/` without directory traversal.
 * 3. Database-First Atomic Deletion:
 *    Deletes database row FIRST. If database deletion fails (trigger rejection, timeout, network error),
 *    the audio file is NEVER touched, keeping the story and its recording 100% intact and uncorrupted.
 * 4. Idempotent Storage Cleanup with Retry & Browser-Local Queue:
 *    Once database deletion succeeds, attempts audio cleanup with exponential backoff retries.
 *    If storage cleanup fails after retries, saves the path into browser localStorage for
 *    subsequent retry on the same device and returns an honest warning rather than claiming false storage cleanup.
 */
export async function deleteStoryFromSupabase(
  storyId: string
): Promise<StoryDeletionResult> {
  if (!storyId || typeof storyId !== "string" || !storyId.trim()) {
    return { success: false, error: "Missing story identifier." };
  }

  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    return { success: false, error: "Archival database is not configured in this environment." };
  }

  try {
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return { success: false, error: "Authentication required to permanently delete a story." };
    }

    // 1. Fetch story record to verify ownership and extract audio storage path
    const { data: storyRow, error: fetchErr } = await (supabase as any)
      .from("stories")
      .select("id, user_id, audio, status, visibility")
      .eq("id", storyId.trim())
      .eq("user_id", user.id)
      .maybeSingle();

    if (fetchErr) {
      console.error("[Supabase] Failed to verify story ownership before delete:", fetchErr);
      return { success: false, error: fetchErr.message || "Failed to locate story in database." };
    }

    if (!storyRow) {
      return {
        success: false,
        notFound: true,
        error: "Story record could not be found or you do not have permission to delete it.",
      };
    }

    // Invariant: Preserved stories are permanent cultural assets and cannot be deleted by standard clients
    if (storyRow.status === "preserved") {
      return {
        success: false,
        error: "Preserved stories are archived cultural assets and cannot be deleted by standard clients. Contact preservation administrators.",
      };
    }

    // 2. Extract and validate audio storage path ONLY from the verified database row
    let validatedStoragePath: string | null = null;
    if (storyRow.audio && typeof storyRow.audio === "object") {
      const rawPath = (storyRow.audio as any).storage_path;
      if (typeof rawPath === "string" && rawPath.trim()) {
        const cleanPath = rawPath.trim();
        // Strict invariant: audio must be strictly namespaced to this user
        if (
          cleanPath.startsWith(`${user.id}/`) &&
          !cleanPath.includes("..") &&
          !cleanPath.includes("\\")
        ) {
          validatedStoragePath = cleanPath;
        } else {
          console.warn("[Supabase] Audio storage path failed namespace validation:", cleanPath);
        }
      }
    }

    // 3. Delete database record FIRST to maintain consistency if database deletion fails
    const { data, error: deleteErr, count } = await (supabase as any)
      .from("stories")
      .delete({ count: "exact" })
      .eq("id", storyId.trim())
      .eq("user_id", user.id)
      .select("id");

    if (deleteErr) {
      console.error("[Supabase] Failed to delete story record from database:", deleteErr);
      // Consistent state: audio has not been touched, story remains preserved in database
      return {
        success: false,
        error: deleteErr.message || "Failed to delete story from database.",
      };
    }

    const deletedCount = count ?? (Array.isArray(data) ? data.length : 0);
    if (deletedCount === 0) {
      return {
        success: false,
        notFound: true,
        error: "Story could not be deleted or does not exist in your archive.",
      };
    }

    // 4. Now that database deletion is confirmed, clean up audio storage
    if (!validatedStoragePath) {
      // Story had no audio recording attached; deletion is complete
      return { success: true, storageCleaned: true };
    }

    // Attempt audio cleanup with retry
    const storageCleaned = await attemptAudioCleanupWithRetry(validatedStoragePath, 3);

    if (storageCleaned) {
      return { success: true, storageCleaned: true };
    }

    // If storage deletion failed after retries, enqueue into persistent cleanup queue
    queuePendingAudioCleanup(user.id, validatedStoragePath);

    return {
      success: true,
      storageCleaned: false,
      warning:
        "Story deleted, but audio cleanup could not be confirmed. A retry is saved in this browser and may run when you reopen the app on this device.",
    };
  } catch (err: any) {
    console.error("[Supabase] Exception deleting story:", err);
    return {
      success: false,
      error: err.message || "Network error while deleting story.",
    };
  }
}
