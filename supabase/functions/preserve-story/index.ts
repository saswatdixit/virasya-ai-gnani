/**
 * Virasya Server-Side Story Preservation Edge Function
 *
 * Provides a trusted, server-side sealing authority for cultural stories in Virasya.
 *
 * Security & Archival Invariants:
 * 1. Strict JWT Authentication: Requires a valid bearer token from an authenticated user.
 * 2. Identity Derivation: Storyteller `user_id` is derived server-side via Supabase Auth;
 *    any client-supplied user ID is ignored.
 * 3. Payload Integrity: Requires non-empty title, narrative text, valid visibility, and explicit confirmation.
 * 4. Ownership Enforcement: Verifies that the authenticated user owns any pre-existing draft record.
 * 5. Re-sealing Protection: Rejects any attempt to overwrite or re-seal an already preserved story (409 Conflict).
 * 6. Cryptographic Provenance: Computes `VIR-{sha256[:12]}` server-side using an authoritative UTC timestamp.
 * 7. Trusted Execution: Operates with `service_role` credentials exclusively on the server,
 *    satisfying PostgreSQL's `is_trusted_backend()` and `trigger_protect_story_integrity`.
 */

// Setup type definitions for Supabase Edge Runtime
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateAudioBuffer } from "./audio-validator.ts";

const ALLOWED_ORIGINS = [
  "https://virasya-ai-gnani.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

interface PreserveRequestBody {
  id?: string;
  title?: string;
  carrier?: string;
  relationship?: string;
  place?: string;
  roots?: string;
  category?: string;
  language?: string;
  period?: string;
  email?: string;
  written_text?: string;
  writtenText?: string;
  working_draft?: string;
  workingDraft?: string;
  final_text?: string;
  story?: string;
  audio?: {
    filename?: string;
    name?: string;
    url?: string | null;
    size?: number | null;
    duration?: number | null;
    kind?: string;
    storage_path?: string;
    bucket?: string;
  } | null;
  raw_transcripts?: Record<string, any>;
  vocabulary?: Array<Record<string, any>>;
  punctuation?: Record<string, any>;
  final_settings?: Record<string, any>;
  finalSettings?: Record<string, any>;
  visibility?: string;
  confirmed?: boolean;
  permission_confirmed?: boolean;
  permissionConfirmed?: boolean;
  audio_public_playback?: boolean;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // 1. Handle CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Enforce HTTP POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: `Method ${req.method} not allowed. Preservation requires POST.` }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // 2. Validate Authorization Header & Bearer Token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized: Missing or malformed Authorization header with Bearer token.",
          code: "MISSING_BEARER_TOKEN",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error("CRITICAL: Missing required Supabase Edge Function environment variables.");
      return new Response(
        JSON.stringify({
          error: "Server configuration error: missing archival database credentials.",
          code: "MISSING_SERVER_CONFIG",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Authenticate User & Derive Identity Server-Side
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({
          error: `Authentication failed: ${authError?.message || "Invalid or expired session token."}`,
          code: "INVALID_SESSION",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Parse & Validate Payload
    let body: PreserveRequestBody;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body.", code: "INVALID_JSON" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // A. Validate Title
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return new Response(
        JSON.stringify({ error: "Story title is required and cannot be empty.", code: "MISSING_TITLE" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // B. Validate Narrative Text (Authoritative Odia Narrative)
    const clientFinalText = (
      typeof body.final_text === "string" ? body.final_text :
      typeof body.story === "string" ? body.story :
      typeof body.working_draft === "string" ? body.working_draft :
      typeof body.workingDraft === "string" ? body.workingDraft :
      ""
    ).trim();

    const writtenText = (
      typeof body.written_text === "string" ? body.written_text :
      typeof body.writtenText === "string" ? body.writtenText :
      ""
    ).trim();

    const transcriptText = (
      typeof body.raw_transcripts?.vaani?.text === "string" ? body.raw_transcripts.vaani.text :
      typeof body.raw_transcripts?.gnani?.text === "string" ? body.raw_transcripts.gnani.text :
      ""
    ).trim();

    let finalText = clientFinalText;
    if (writtenText && transcriptText) {
      if (!finalText || finalText === writtenText || finalText === transcriptText) {
        finalText = `${writtenText}\n\n${transcriptText}`;
      } else if (!finalText.includes(writtenText) && finalText.includes(transcriptText)) {
        finalText = `${writtenText}\n\n${finalText}`;
      } else if (finalText.includes(writtenText) && !finalText.includes(transcriptText)) {
        finalText = `${finalText}\n\n${transcriptText}`;
      }
    } else if (!finalText) {
      finalText = writtenText || transcriptText;
    }

    if (!finalText) {
      return new Response(
        JSON.stringify({ error: "Story narrative text is required before permanent preservation.", code: "MISSING_NARRATIVE" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // C. Validate Language
    const language = typeof body.language === "string" && body.language.trim()
      ? body.language.trim()
      : "Odia";

    // D. Validate Visibility
    const rawVisibility = String(
      body.visibility ||
      body.final_settings?.visibility ||
      body.finalSettings?.visibility ||
      "private"
    ).toLowerCase();

    const allowedVisibilities = ["private", "family", "community", "public"];
    if (!allowedVisibilities.includes(rawVisibility)) {
      return new Response(
        JSON.stringify({
          error: `Invalid visibility '${rawVisibility}'. Must be one of: ${allowedVisibilities.join(", ")}`,
          code: "INVALID_VISIBILITY",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // E. Validate Confirmation
    const isConfirmed = Boolean(
      body.confirmed ??
      body.final_settings?.confirmed ??
      body.finalSettings?.confirmed
    );
    if (!isConfirmed) {
      return new Response(
        JSON.stringify({
          error: "Story preservation requires explicit storyteller confirmation (confirmed = true).",
          code: "CONFIRMATION_REQUIRED",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // F. Story ID Sanitization
    let storyId = typeof body.id === "string" ? body.id.trim() : "";
    if (!storyId || !/^[a-zA-Z0-9_\-]+$/.test(storyId) || storyId.length > 64) {
      const entropy = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      storyId = `story_${Date.now()}_${entropy}`;
    }

    // 5. Server-Side Ownership & Immutability Enforcement
    // Initialize admin client with service_role key to inspect database state
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: existing, error: existingLookupError } = await adminClient
      .from("stories")
      .select("id, user_id, status, provenance_id, title")
      .eq("id", storyId)
      .maybeSingle();

    if (existingLookupError) {
      console.error("Database error looking up existing story:", existingLookupError);
      return new Response(
        JSON.stringify({ error: `Database lookup failed: ${existingLookupError.message}`, code: "DB_LOOKUP_ERROR" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (existing) {
      // Enforce ownership: only the original author can seal their story
      if (existing.user_id && existing.user_id !== user.id) {
        return new Response(
          JSON.stringify({
            error: "Forbidden: You do not have permission to modify or preserve this story.",
            code: "FORBIDDEN_OWNERSHIP",
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Enforce immutability: already preserved stories cannot be re-sealed or overwritten
      if (existing.status === "preserved") {
        return new Response(
          JSON.stringify({
            error: `Conflict: Story '${storyId}' has already been permanently sealed with provenance ID '${existing.provenance_id}' and cannot be altered.`,
            provenance_id: existing.provenance_id,
            code: "ALREADY_PRESERVED",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 6. Cryptographic Provenance Sealing (Authoritative Server Computation)
    const preservedAt = new Date().toISOString();
    const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";

    const seed = `${storyId}:${preservedAt}:${title}:${carrier}:${finalText.slice(0, 40)}`;
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const provenanceHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12).toUpperCase();
    const provenanceId = `VIR-${provenanceHash}`;

    // 7. Validate and Format Audio Record
    const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MiB (5,242,880 bytes)
    const MAX_AUDIO_DURATION_SEC = 60.0;
    const ALLOWED_STORAGE_BUCKET = "story-recordings-private";

    let audioPayload = null;
    if (body.audio) {
      const audioInput = body.audio;
      const filename = String(audioInput.filename || audioInput.name || "").trim();
      const storagePath = typeof audioInput.storage_path === "string" ? audioInput.storage_path.trim() : null;
      let bucket = typeof audioInput.bucket === "string" ? audioInput.bucket.trim() : null;

      // Fail-closed: audio preservation requires verified storage path
      if (!storagePath) {
        return new Response(
          JSON.stringify({
            error: "Audio recording requires a verified storage_path in archival cloud storage before preservation.",
            code: "MISSING_STORAGE_PATH",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (bucket && bucket !== ALLOWED_STORAGE_BUCKET) {
        return new Response(
          JSON.stringify({
            error: `Invalid storage bucket '${bucket}'. Only '${ALLOWED_STORAGE_BUCKET}' is permitted.`,
            code: "INVALID_BUCKET",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      bucket = ALLOWED_STORAGE_BUCKET;

      // Enforce strict security validation on storage path (path traversal prevention)
      if (storagePath.includes("..") || storagePath.includes("\\") || storagePath.startsWith("/")) {
        return new Response(
          JSON.stringify({
            error: "Malformed storage path. Path traversal and backslashes are strictly forbidden.",
            code: "MALFORMED_STORAGE_PATH",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Ownership: Path must begin with user.id/
      const expectedPrefix = `${user.id}/`;
      if (!storagePath.startsWith(expectedPrefix)) {
        return new Response(
          JSON.stringify({
            error: "Forbidden: Storage path must reside within the authenticated user's directory.",
            code: "FORBIDDEN_STORAGE_PATH",
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // SEC-03: Reliable exact-object existence verification & retrieval via direct download
      // Eliminates prefix matching bugs, list limits, and pagination issues
      const { data: audioBlob, error: downloadError } = await adminClient.storage
        .from(bucket)
        .download(storagePath);

      if (downloadError || !audioBlob) {
        console.error("Storage download/existence error:", downloadError);
        return new Response(
          JSON.stringify({
            error: `Referenced audio object '${storagePath}' was not found in storage or cannot be retrieved.`,
            code: "AUDIO_OBJECT_NOT_FOUND",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Enforce verified size limit <= 5 MiB (5,242,880 bytes)
      const actualSizeBytes = audioBlob.size;
      if (actualSizeBytes === 0) {
        return new Response(
          JSON.stringify({
            error: "Audio recording file in storage is empty (0 bytes).",
            code: "EMPTY_AUDIO_FILE",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (actualSizeBytes > MAX_AUDIO_BYTES) {
        return new Response(
          JSON.stringify({
            error: `Audio file size (${actualSizeBytes} bytes) exceeds the 5 MiB (5,242,880 bytes) limit.`,
            code: "AUDIO_TOO_LARGE",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // SEC-01: Trusted server-side audio container & duration validation
      // Never treat body.audio.duration as proof of duration!
      const audioBuffer = new Uint8Array(await audioBlob.arrayBuffer());
      const ext = "." + (filename.split(".").pop()?.toLowerCase() || storagePath.split(".").pop()?.toLowerCase() || "");
      const validation = validateAudioBuffer(audioBuffer, ext);

      if (!validation.valid) {
        return new Response(
          JSON.stringify({
            error: validation.error || "Audio validation failed at server boundary.",
            code: validation.code || "AUDIO_VALIDATION_FAILED",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Use verified duration and verified size from server-side validation
      const verifiedDuration = validation.durationSeconds;
      const verifiedSizeBytes = validation.byteSize;

      audioPayload = {
        filename: filename || "recording",
        url: audioInput.url || null,
        size: verifiedSizeBytes,
        duration: verifiedDuration,
        kind: audioInput.kind || "uploaded",
        storage_path: storagePath,
        bucket: bucket,
        verified_format: validation.format,
      };
    }

    const rawTranscripts = typeof body.raw_transcripts === "object" && body.raw_transcripts !== null
      ? body.raw_transcripts
      : {};

    const vocabulary = Array.isArray(body.vocabulary) ? body.vocabulary : [];
    const punctuation = typeof body.punctuation === "object" && body.punctuation !== null ? body.punctuation : {};

    const permissionConfirmed = Boolean(
      body.permission_confirmed ??
      body.permissionConfirmed ??
      body.final_settings?.permissionConfirmed ??
      body.finalSettings?.permissionConfirmed ??
      true
    );

    const audioPublicPlayback = Boolean(body.audio_public_playback);

    const finalSettings = {
      ...(body.final_settings || body.finalSettings || {}),
      visibility: rawVisibility,
      confirmed: true,
      permissionConfirmed,
      provenance_id: provenanceId,
      provenance_hash: provenanceHash,
      preserved_at: preservedAt,
      sealed_by: "virasya-edge-function",
    };

    // 8. Atomic Database Sealing via RPC (with row-level lock serialization)
    // Satisfies is_trusted_backend() (Case 1: jwt_role = 'service_role')
    // Eliminates TOCTOU race conditions between concurrent requests
    let savedRow: Record<string, any> | null = null;

    const { data: rpcData, error: rpcError } = await adminClient.rpc("seal_story_preservation", {
      p_story_id: storyId,
      p_user_id: user.id,
      p_title: title,
      p_carrier: carrier,
      p_relationship: String(body.relationship || "").trim(),
      p_place: String(body.place || body.roots || "").trim(),
      p_roots: String(body.roots || body.place || "").trim(),
      p_category: String(body.category || "").trim(),
      p_language: language,
      p_period: String(body.period || "").trim(),
      p_email: user.email || String(body.email || "").trim(),
      p_written_text: writtenText,
      p_working_draft: String(body.working_draft || body.workingDraft || finalText).trim(),
      p_final_text: finalText,
      p_story: finalText,
      p_audio: audioPayload,
      p_raw_transcripts: rawTranscripts,
      p_vocabulary: vocabulary,
      p_punctuation: punctuation,
      p_final_settings: finalSettings,
      p_visibility: rawVisibility,
      p_audio_public_playback: audioPublicPlayback,
      p_provenance_id: provenanceId,
      p_provenance_hash: provenanceHash,
      p_preserved_at: preservedAt,
    });

    if (rpcError) {
      const errorMsg = rpcError.message || "";
      // Handle Conflict: story was sealed concurrently or already preserved
      if (errorMsg.includes("ALREADY_PRESERVED") || rpcError.code === "P0004") {
        const { data: current } = await adminClient
          .from("stories")
          .select("provenance_id")
          .eq("id", storyId)
          .maybeSingle();

        const currentProv = current?.provenance_id || existing?.provenance_id || "";
        return new Response(
          JSON.stringify({
            error: `Conflict: Story '${storyId}' has already been permanently sealed with provenance ID '${currentProv}' and cannot be altered.`,
            provenance_id: currentProv,
            code: "ALREADY_PRESERVED",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Handle Forbidden Ownership
      if (errorMsg.includes("FORBIDDEN_OWNERSHIP") || rpcError.code === "42501") {
        return new Response(
          JSON.stringify({
            error: "Forbidden: You do not have permission to modify or preserve this story.",
            code: "FORBIDDEN_OWNERSHIP",
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Strict Security Boundary: Fail closed on all other RPC errors (e.g. PGRST202, timeouts, schema errors).
      // Unsafe fallback writes are explicitly forbidden to prevent bypassing transactional integrity or row locks.
      console.error("Database error sealing story via RPC:", rpcError);
      return new Response(
        JSON.stringify({
          error: `Database persistence error: ${rpcError.message || "Failed to seal story preservation."}`,
          code: rpcError.code || "DB_SEAL_ERROR",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    savedRow = rpcData;

    // 9. Return Verified Permanent Preservation Receipt Payload
    return new Response(
      JSON.stringify({
        status: "success",
        story: savedRow,
        preserved_at: preservedAt,
        provenance_id: provenanceId,
        provenance_hash: provenanceHash,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Unhandled error in preserve-story edge function:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error occurred.", code: "INTERNAL_SERVER_ERROR" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
