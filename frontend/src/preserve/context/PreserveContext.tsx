import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  PreserveState,
  StoryForm,
  AudioItem,
  VocabularyEntry,
  TranscriptDraftSnapshot,
  ModelTranscript,
  TranscriptionStyle,
} from "../types";
import {
  INITIAL_SAMPLE_STORY,
  INITIAL_SAMPLE_VOCAB,
  DEMO_TRANSCRIPTS,
  STEP_DEFINITIONS,
  STORAGE_KEY,
  STORAGE_KEY_GUEST,
  getDraftStorageKey,
  LANGUAGE_OPTIONS,
  clearCloudDraftDismissed,
} from "../types";

import {
  uid,
  getClock,
  punctItems,
  combineOptionalAndTranscribedText,
} from "../utils";
import {
  deleteStoryDraftFromBackend,
  preserveStoryOnBackend,
  transcribeAudioOnBackend,
  fetchModelStatus,
  isBackendConfigured,
  extractErrorMessage,
} from "../api";
import { useAuth } from "../../auth";
import {
  preserveStoryToSupabase,
  isSupabaseConfigured,
  uploadAudioToPrivateBucket,
  deleteAudioFromPrivateBucket,
} from "../../supabase";
import {
  MAX_AUDIO_SIZE_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  AUDIO_STORAGE_BUCKET,
} from "../constants";

const INITIAL_STATE: PreserveState = {
  stage: 1,
  completed: {},
  skipped: {},
  form: {
    title: "",
    carrier: "",
    category: "",
    place: "",
    language: "Hindi",
    period: "",
    relationship: "",
    story: "",
    email: "",
  },
  audio: null,
  transcriptionStyle: "verbatim",
  tx: {
    forAudio: "",
    gnani: { status: "idle", p: 0, text: "", model: "Gnani Prisma STT v2.5", provider: "Gnani.ai" },
    vaani: { status: "idle", p: 0, text: "" },
    conformer: { status: "idle", p: 0, text: "" },
  },
  enh: {
    status: "idle",
    base: "vaani",
    decisions: {},
  },
  ed: {
    text: "",
    loadedFrom: null,
    baseText: "",
    drafts: [],
    notice: "",
    undoStack: [],
  },
  vocab: [],
  punct: {
    status: "idle",
    decisions: {},
    manual: null,
    done: false,
  },
  final: {
    visibility: "public",
    confirmed: false,
    permissionConfirmed: false,
    audioPublicConsent: false,
    isPreserved: false,
  },
};

interface SimControls {
  scenario: "success" | "fail-conformer" | "slow-vaani";
  speed: "normal" | "instant";
}

interface PreserveContextType {
  state: PreserveState;
  sim: SimControls;
  savedAt: string | null;
  resumeDraft: PreserveState | null;
  cloudDraft: PreserveState | null;
  cloudDraftUpdatedAt: string | null;
  leaveModalOpen: boolean;
  dockOpen: boolean;
  isTranscribing: boolean;
  transcriptionPhase: "idle" | "checking" | "warming" | "transcribing" | "error" | "done";
  transcriptionError: string | null;
  selectedLanguage: string;
  setSelectedLanguage: (lang: string) => void;
  transcriptionStyle: TranscriptionStyle;
  setTranscriptionStyle: (style: TranscriptionStyle) => void;
  isLanguageConfirmed: boolean;
  setIsLanguageConfirmed: (confirmed: boolean) => void;
  clearTranscriptionError: () => void;
  retryTranscription: () => Promise<void>;
  setLeaveModalOpen: (open: boolean) => void;
  setDockOpen: (open: boolean) => void;
  setSim: Dispatch<SetStateAction<SimControls>>;
  goToStep: (stepNumber: number) => void;
  updateForm: (field: keyof StoryForm, value: string) => void;
  fillSampleStory: () => void;
  setAudio: (audio: AudioItem | null, file?: File | Blob | null) => void;
  audioFile: File | Blob | null;
  startTranscription: () => Promise<void>;
  executeTranscription: (langOrModel?: string) => Promise<{
    success: boolean;
    gnaniDone?: boolean;
    vaaniDone: boolean;
    conformerDone: boolean;
    error?: string;
  }>;
  continueWithWrittenOnly: () => void;
  loadSampleTranscript: () => void;
  retryModel: (model: "vaani" | "conformer" | "gnani") => void;
  setEnhDecision: (id: string, decision: "accepted" | "rejected" | undefined) => void;
  acceptAllLowRiskEnh: () => void;
  setEnhBase: (base: "vaani" | "conformer") => void;
  triggerEnhancement: () => void;
  loadSourceIntoEditor: (source: "gnani" | "vaani" | "conformer" | "enhanced" | "written") => void;
  updateWorkingText: (text: string) => void;
  restoreSnapshot: (snap: TranscriptDraftSnapshot) => void;
  undoWorkingText: () => void;
  addVocabEntry: (entry: Omit<VocabularyEntry, "id">) => void;
  updateVocabEntry: (id: string, entry: Partial<VocabularyEntry>) => void;
  removeVocabEntry: (id: string) => void;
  setPunctDecision: (id: string, decision: "accepted" | "rejected" | undefined) => void;
  acceptAllPunct: () => void;
  rejectAllPunct: () => void;
  setManualPunct: (
    text: string | null,
    extra?: {
      isModelPunctuated?: boolean;
      modelSuggestion?: string | null;
      unpunctuatedDraft?: string | null;
    }
  ) => void;
  triggerPunctuation: () => void;
  setVisibility: (v: "private" | "family" | "community" | "public") => void;
  setFinalConfirmed: (val: boolean) => void;
  setPermissionConfirmed: (val: boolean) => void;
  setAudioPublicConsent: (val: boolean) => void;
  preserveStoryAction: () => void;
  resetAll: () => void;
  resumeFromSaved: (source?: "local" | "cloud") => void;
  dismissResume: (source?: "all" | "local" | "cloud") => Promise<boolean> | void;
  dismissBanner: () => void;
  isDiscardingDraft: boolean;
  discardError: string | null;
  clearDiscardError: () => void;
}

const PreserveContext = createContext<PreserveContextType | null>(null);

export function PreserveProvider({ children }: { children: ReactNode }) {
  const { user, profile, openAuthModal } = useAuth();
  const [state, setState] = useState<PreserveState>(() => {
    // Determine initial stage based on URL if possible
    const path = window.location.pathname.replace(/\/+$/, "") || "/preserve-your-story";
    const found = STEP_DEFINITIONS.find((s) => s.route === path);
    return {
      ...INITIAL_STATE,
      stage: found ? found.step : 1,
    };
  });

  const [sim, setSim] = useState<SimControls>({
    scenario: "success",
    speed: "normal",
  });
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<PreserveState | null>(null);
  const [cloudDraft, setCloudDraft] = useState<PreserveState | null>(null);
  const [cloudDraftUpdatedAt, setCloudDraftUpdatedAt] = useState<string | null>(null);
  const [cloudDraftStoryId, setCloudDraftStoryId] = useState<string | null>(null);
  const [isDiscardingDraft, setIsDiscardingDraft] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const discardedDraftIdsRef = useRef<Set<string>>(new Set());
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const simRef = useRef(sim);
  useEffect(() => {
    simRef.current = sim;
  }, [sim]);

  const activeStorageKey = getDraftStorageKey(user?.id);

  // Actively purge all legacy draft keys from localStorage to prevent draft resurrection
  useEffect(() => {
    try {
      localStorage.removeItem(activeStorageKey);
      localStorage.removeItem(STORAGE_KEY_GUEST);
      localStorage.removeItem(STORAGE_KEY);
      if (user?.id) {
        localStorage.removeItem(`virasya_story_draft_user_${user.id}`);
        localStorage.removeItem(`virasya_cloud_draft_dismissed_${user.id}`);
      }
    } catch {
      // Ignore storage errors safely
    }
    setResumeDraft(null);
    setCloudDraft(null);
  }, [user?.id, activeStorageKey]);

  // Sync route on popstate (browser back/forward)
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.replace(/\/+$/, "");
      const found = STEP_DEFINITIONS.find((s) => s.route === path);
      if (found) {
        setState((s) => ({ ...s, stage: found.step }));
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);



  // Navigation action
  const goToStep = useCallback((stepNumber: number) => {
    const target = STEP_DEFINITIONS.find((s) => s.step === stepNumber);
    if (target) {
      if (window.location.pathname !== target.route) {
        window.history.pushState(null, "", target.route);
      }
      setState((s) => {
        return {
          ...s,
          stage: stepNumber,
          completed: {
            ...s.completed,
            [s.stage]: true,
          },
        };
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const updateForm = useCallback((field: keyof StoryForm, value: string) => {
    setState((s) => ({
      ...s,
      form: { ...s.form, [field]: value },
    }));
    if (field === "language" && value) {
      const match = LANGUAGE_OPTIONS.find(
        (opt) => opt.name.toLowerCase() === value.toLowerCase()
      );
      if (match) {
        setSelectedLanguage(match.code);
      }
    }
  }, []);

  const fillSampleStory = useCallback(() => {
    setState((s) => ({
      ...s,
      form: { ...INITIAL_SAMPLE_STORY },
    }));
  }, []);

  const [transcriptionPhase, setTranscriptionPhase] = useState<
    "idle" | "checking" | "warming" | "transcribing" | "error" | "done"
  >("idle");
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string>("hi-IN");
  const [isLanguageConfirmed, setIsLanguageConfirmed] = useState<boolean>(false);

  const setTranscriptionStyle = useCallback((style: TranscriptionStyle) => {
    setState((s) => ({ ...s, transcriptionStyle: style }));
  }, []);

  const [audioFile, setAudioFileState] = useState<File | Blob | null>(null);
  const audioFileRef = useRef<File | Blob | null>(null);

  const clearTranscriptionError = useCallback(() => {
    setTranscriptionError(null);
  }, []);

  const setAudio = useCallback((audio: AudioItem | null, file?: File | Blob | null) => {
    setTranscriptionError(null);
    setTranscriptionPhase("idle");
    setIsLanguageConfirmed(false); // Revalidate/reset language confirmation when recording changes
    audioFileRef.current = file ?? null;
    setAudioFileState(file ?? null);
    setState((s) => {
      if (s.audio && s.audio.url && audio && audio.url !== s.audio.url) {
        try {
          URL.revokeObjectURL(s.audio.url);
        } catch {}
      }
      return { ...s, audio };
    });
  }, []);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const transcribingRef = useRef<{ vaani: boolean; conformer: boolean }>({
    vaani: false,
    conformer: false,
  });

  const executeTranscription = useCallback(
    async (lang: string = selectedLanguage) => {
      // In-flight guard: prevent concurrent requests thrashing the backend
      if (transcribingRef.current.vaani || transcribingRef.current.conformer) {
        return { success: false, vaaniDone: false, conformerDone: false, error: "Transcription already in progress" };
      }

      // Synchronously resolve current audio from state reference
      const currentAudio = stateRef.current.audio;
      const audioName = currentAudio ? currentAudio.name : "";
      if (!audioName) {
        const noAudioMsg = "No audio file found to transcribe. Please upload or record an audio file.";
        setTranscriptionError(noAudioMsg);
        return { success: false, vaaniDone: false, conformerDone: false, error: noAudioMsg };
      }

      // Enforce strict size and duration boundaries before sending to GNANI API
      if (currentAudio?.size && currentAudio.size > MAX_AUDIO_SIZE_BYTES) {
        const sizeMsg = `Audio file (${(currentAudio.size / (1024 * 1024)).toFixed(2)} MiB) exceeds the maximum allowed limit of 5 MiB (5,242,880 bytes).`;
        setTranscriptionError(sizeMsg);
        return { success: false, vaaniDone: false, conformerDone: false, error: sizeMsg };
      }
      if (currentAudio?.duration && currentAudio.duration > MAX_AUDIO_DURATION_SECONDS) {
        const durMsg = `Audio duration (${currentAudio.duration.toFixed(1)}s) exceeds the maximum ${MAX_AUDIO_DURATION_SECONDS}-second limit accepted by GNANI AI.`;
        setTranscriptionError(durMsg);
        return { success: false, vaaniDone: false, conformerDone: false, error: durMsg };
      }

      transcribingRef.current.vaani = true;
      transcribingRef.current.conformer = true;

      // Set clean in-flight state without displaying false error
      setState((s) => ({
        ...s,
        tx: {
          ...s.tx,
          forAudio: audioName,
          gnani: { ...s.tx.gnani, status: "processing", p: 45, error: null },
          vaani: { ...s.tx.vaani, status: "processing", p: 45, error: null },
          conformer: { ...s.tx.conformer, status: "idle", p: 0, error: null },
        },
      }));

      let storagePath = currentAudio?.storage_path;
      if (!storagePath && user?.id && audioFileRef.current) {
        try {
          const uploadRes = await uploadAudioToPrivateBucket(audioFileRef.current, audioName, user.id);
          if (uploadRes.path) {
            storagePath = uploadRes.path;
            setState((s) => ({
              ...s,
              audio: s.audio ? { ...s.audio, storage_path: storagePath } : s.audio,
            }));
          }
        } catch (uploadErr) {
          console.warn("[Storage] On-demand upload notice:", uploadErr);
        }
      }

      try {
        const currentStyle = stateRef.current.transcriptionStyle || "verbatim";
        const res = await transcribeAudioOnBackend(
          audioName,
          lang,
          stateRef.current.storyId,
          undefined,
          storagePath,
          currentStyle
        );

        const gResult = res.results?.gnani || res.results?.vaani;
        const transcriptText = (
          res.transcript ||
          res.raw_text ||
          res.gnani ||
          res.vaani ||
          gResult?.text ||
          ""
        ).trim();

        const isSuccess = Boolean(transcriptText) || gResult?.status === "done";
        const errorMsg = gResult?.error ? extractErrorMessage(gResult.error, "Speech recognition failed.") : (isSuccess ? null : "Speech recognition returned empty transcript.");

        const modelItem: ModelTranscript = {
          status: isSuccess ? "done" : "error",
          p: isSuccess ? 100 : 0,
          text: transcriptText,
          model: gResult?.model || res.model || "Gnani Prisma STT v2.5",
          provider: gResult?.provider || res.provider || "Gnani Prisma",
          language: res.language || lang,
          requestedLanguage: res.requested_language || (lang.startsWith("hi") ? "Hindi" : lang),
          providerLanguage: res.provider_language || "hi",
          transcriptionStyle: currentStyle,
          format: currentStyle,
          inferenceSeconds: gResult?.inference_seconds || res.inference_seconds,
          durationSeconds: gResult?.duration_seconds,
          error: errorMsg,
        };

        setState((s) => {
          const nextTx = {
            ...s.tx,
            forAudio: audioName,
            gnani: modelItem,
            vaani: modelItem,
            conformer: { status: "idle" as const, p: 0, text: "", error: null },
          };

          // Transcription result is stored in tx.gnani / tx.vaani.
          // Working draft editor is initialized or updated with the transcription text
          // ONLY if the user has not manually edited the editor (preserving user edits on re-runs).
          const tx = (transcriptText || "").trim();
          let nextEd = s.ed;
          const isUserEdited = Boolean(s.ed.text && s.ed.text !== s.ed.baseText);
          const shouldUpdateEd =
            !isUserEdited &&
            (!s.ed.text ||
              s.ed.text === s.ed.baseText ||
              s.ed.loadedFrom === "gnani" ||
              s.ed.loadedFrom === "vaani" ||
              s.ed.loadedFrom === "written" ||
              !s.ed.loadedFrom);

          if (shouldUpdateEd && tx) {
            nextEd = {
              ...s.ed,
              text: tx,
              baseText: tx,
              loadedFrom: "gnani",
              undoStack: [tx],
            };
          }

          return {
            ...s,
            tx: nextTx,
            ed: nextEd,
          };
        });

        return {
          success: isSuccess,
          gnaniDone: isSuccess,
          vaaniDone: isSuccess,
          conformerDone: false,
          error: isSuccess ? undefined : (errorMsg || "ASR transcription failed."),
        };
      } catch (err: any) {
        const errorMsg = extractErrorMessage(err, "Failed to run transcription.");
        setState((s) => ({
          ...s,
          tx: {
            ...s.tx,
            forAudio: audioName,
            gnani: {
              status: "error",
              p: 0,
              text: "",
              error: errorMsg,
            },
            vaani: {
              ...s.tx.vaani,
              status: "error",
              p: 0,
              error: errorMsg,
            },
            conformer: s.tx.conformer,
          },
        }));
        return {
          success: false,
          gnaniDone: false,
          vaaniDone: false,
          conformerDone: false,
          error: errorMsg,
        };
      } finally {
        transcribingRef.current.vaani = false;
        transcribingRef.current.conformer = false;
      }
    },
    [selectedLanguage]
  );

  const startTranscription = useCallback(async () => {
    if (
      transcriptionPhase === "checking" ||
      transcriptionPhase === "warming" ||
      transcriptionPhase === "transcribing"
    ) {
      return; // prevent duplicate clicks
    }
    const currentAudio = stateRef.current.audio;
    if (!currentAudio) {
      setTranscriptionError("Please upload or record an audio file before proceeding.");
      return;
    }

    if (!isLanguageConfirmed) {
      setTranscriptionError("Please confirm the audio recording language (Hindi) before transcribing.");
      return;
    }

    if (isSupabaseConfigured() && !user) {
      setTranscriptionError("Please sign in with your email to transcribe audio recordings with Gnani AI.");
      openAuthModal();
      return;
    }

    setTranscriptionError(null);

    // If backend is not configured (e.g. static preview deployment), provide immediate helpful guidance
    if (!isBackendConfigured()) {
      setTranscriptionPhase("idle");
      setTranscriptionError(
        "Speech recognition models require the Virasya AI backend. You can load a sample transcript below to preview the review workflow, or continue with your written story."
      );
      return;
    }

    setTranscriptionPhase("checking");

    // Check if backend models are currently cold-starting / loading
    try {
      const statusRes = await fetchModelStatus();
      if (
        statusRes.gnani?.status === "loading" ||
        statusRes.vaani.status === "loading" ||
        statusRes.indicconformer.status === "loading" ||
        statusRes.busy
      ) {
        setTranscriptionPhase("warming");
      } else {
        setTranscriptionPhase("transcribing");
      }
    } catch {
      setTranscriptionPhase("transcribing");
    }

    try {
      const res = await executeTranscription(selectedLanguage);

      if (res.success) {
        setTranscriptionPhase("done");
        setTranscriptionError(null);
        goToStep(3); // Navigate to Review only upon success
      } else {
        setTranscriptionPhase("error");
        setTranscriptionError(
          extractErrorMessage(
            res.error,
            "Speech recognition models encountered an error. Your audio file is kept safe below so you can retry."
          )
        );
        // Keep user on Step 2 with their audio selected
      }
    } catch (unexpectedErr: any) {
      setTranscriptionPhase("error");
      setTranscriptionError(
        extractErrorMessage(unexpectedErr, "An unexpected error occurred during transcription. Please try again.")
      );
    }
  }, [transcriptionPhase, isLanguageConfirmed, selectedLanguage, executeTranscription, goToStep, user, openAuthModal]);

  const retryTranscription = useCallback(async () => {
    await startTranscription();
  }, [startTranscription]);

  const loadSampleTranscript = useCallback(() => {
    const sampleItem: ModelTranscript = {
      status: "done",
      p: 100,
      text: DEMO_TRANSCRIPTS.vaani,
      model: "Gnani Prisma STT v2.5 (Sample)",
      provider: "Gnani Prisma (Demo Content)",
      inferenceSeconds: 1.82,
      durationSeconds: 47.59,
      error: null,
    };
    setState((s) => ({
      ...s,
      isSampleTranscript: true,
      completed: { ...s.completed, 2: true },
      tx: {
        forAudio: s.audio?.name || "sample_recording_odia.ogg",
        gnani: sampleItem,
        vaani: sampleItem,
        conformer: {
          status: "idle",
          p: 0,
          text: "",
          error: null,
        },
      },
      ed: {
        ...s.ed,
        text: DEMO_TRANSCRIPTS.vaani,
        baseText: DEMO_TRANSCRIPTS.vaani,
        loadedFrom: "gnani",
        notice: "Loaded sample Odia transcript (demo mode).",
      },
      vocab: s.vocab.length > 0 ? s.vocab : INITIAL_SAMPLE_VOCAB,
    }));
    setTranscriptionPhase("done");
    setTranscriptionError(null);
    goToStep(3);
  }, [goToStep]);

  const continueWithWrittenOnly = useCallback(() => {
    setState((s) => ({
      ...s,
      skipped: { ...s.skipped, 2: true },
      ed: s.ed.text
        ? s.ed
        : {
            ...s.ed,
            text: s.form.story,
            baseText: s.form.story,
            loadedFrom: "written",
          },
    }));
    goToStep(3);
  }, [goToStep]);

  const retryModel = useCallback(
    (_model: "vaani" | "conformer" | "gnani" = "gnani") => {
      executeTranscription(selectedLanguage);
    },
    [executeTranscription, selectedLanguage]
  );

  const setEnhDecision = useCallback(
    (id: string, decision: "accepted" | "rejected" | undefined) => {
      setState((s) => {
        const next = { ...s.enh.decisions };
        if (decision) next[id] = decision;
        else delete next[id];
        return {
          ...s,
          enh: { ...s.enh, decisions: next },
        };
      });
    },
    []
  );

  const acceptAllLowRiskEnh = useCallback(() => {
    // AI enhancement intentionally disabled for this phase
  }, []);

  const setEnhBase = useCallback((base: "vaani" | "conformer") => {
    setState((s) => ({
      ...s,
      enh: { ...s.enh, base, decisions: {} },
    }));
  }, []);

  const triggerEnhancement = useCallback(() => {
    // AI enhancement intentionally disabled for this phase
  }, []);

  const loadSourceIntoEditor = useCallback(
    (source: "gnani" | "vaani" | "conformer" | "enhanced" | "written") => {
      setState((s) => {
        let textToLoad = "";
        if (source === "gnani") {
          textToLoad = (s.tx.gnani?.text || s.tx.vaani?.text || "").trim();
        } else if (source === "vaani") {
          textToLoad = (s.tx.vaani?.text || s.tx.gnani?.text || "").trim();
        } else if (source === "conformer") {
          textToLoad = (s.tx.conformer?.text || "").trim();
        } else if (source === "written") {
          textToLoad = (s.form.story || "").trim();
        } else if (source === "enhanced") {
          textToLoad = (s.tx.gnani?.text || s.tx.vaani?.text || "").trim();
        }

        // Never replace an existing non-empty working draft with an empty string
        if (!textToLoad && s.ed.text) {
          return s;
        }

        const isDirty = s.ed.text && s.ed.text !== s.ed.baseText;
        const newDrafts = isDirty
          ? [
              {
                id: uid(),
                label: `Edits before loading ${source}`,
                text: s.ed.text,
                at: getClock(),
              },
              ...s.ed.drafts,
            ]
          : s.ed.drafts;

        return {
          ...s,
          ed: {
            text: textToLoad,
            baseText: textToLoad,
            loadedFrom: source,
            drafts: newDrafts,
            notice: isDirty
              ? "Your earlier edits were preserved under 'Earlier drafts'."
              : "",
            undoStack: [textToLoad],
          },
        };
      });
    },
    []
  );

  const updateWorkingText = useCallback((text: string) => {
    setState((s) => ({
      ...s,
      ed: {
        ...s.ed,
        text,
        notice: "",
        undoStack: [...s.ed.undoStack.slice(-15), text],
      },
    }));
  }, []);

  const undoWorkingText = useCallback(() => {
    setState((s) => {
      if (s.ed.undoStack.length < 2) return s;
      const newStack = [...s.ed.undoStack];
      newStack.pop(); // remove current
      const prev = newStack[newStack.length - 1];
      return {
        ...s,
        ed: {
          ...s.ed,
          text: prev,
          undoStack: newStack,
        },
      };
    });
  }, []);

  const restoreSnapshot = useCallback((snap: TranscriptDraftSnapshot) => {
    setState((s) => ({
      ...s,
      ed: {
        ...s.ed,
        text: snap.text,
        baseText: snap.text,
        loadedFrom: "draft",
        notice: `Restored snapshot from ${snap.at}.`,
      },
    }));
  }, []);

  const addVocabEntry = useCallback((entry: Omit<VocabularyEntry, "id">) => {
    setState((s) => ({
      ...s,
      vocab: [...s.vocab, { ...entry, id: uid(), isSample: false }],
    }));
  }, []);

  const updateVocabEntry = useCallback(
    (id: string, entry: Partial<VocabularyEntry>) => {
      setState((s) => ({
        ...s,
        vocab: s.vocab.map((v) => (v.id === id ? { ...v, ...entry } : v)),
      }));
    },
    []
  );

  const removeVocabEntry = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      vocab: s.vocab.filter((v) => v.id !== id),
    }));
  }, []);

  const setPunctDecision = useCallback(
    (id: string, decision: "accepted" | "rejected" | undefined) => {
      setState((s) => {
        const next = { ...s.punct.decisions };
        if (decision) next[id] = decision;
        else delete next[id];
        return {
          ...s,
          punct: { ...s.punct, decisions: next },
        };
      });
    },
    []
  );

  const acceptAllPunct = useCallback(() => {
    setState((s) => {
      const fallback = combineOptionalAndTranscribedText(s.form.story, s.tx.gnani?.text || s.tx.vaani?.text);
      const items = punctItems(s.ed.text || fallback);
      const dec: Record<string, "accepted"> = {};
      items.forEach((it) => (dec[it.id] = "accepted"));
      return {
        ...s,
        punct: { ...s.punct, decisions: dec },
      };
    });
  }, []);

  const rejectAllPunct = useCallback(() => {
    setState((s) => {
      const fallback = combineOptionalAndTranscribedText(s.form.story, s.tx.gnani?.text || s.tx.vaani?.text);
      const items = punctItems(s.ed.text || fallback);
      const dec: Record<string, "rejected"> = {};
      items.forEach((it) => (dec[it.id] = "rejected"));
      return {
        ...s,
        punct: { ...s.punct, decisions: dec },
      };
    });
  }, []);

  const setManualPunct = useCallback(
    (
      text: string | null,
      extra?: {
        isModelPunctuated?: boolean;
        modelSuggestion?: string | null;
        unpunctuatedDraft?: string | null;
      }
    ) => {
      setState((s) => ({
        ...s,
        punct: {
          ...s.punct,
          manual: text,
          ...(extra?.isModelPunctuated !== undefined ? { isModelPunctuated: extra.isModelPunctuated } : {}),
          ...(extra?.modelSuggestion !== undefined ? { modelSuggestion: extra.modelSuggestion } : {}),
          ...(extra?.unpunctuatedDraft !== undefined ? { unpunctuatedDraft: extra.unpunctuatedDraft } : {}),
        },
      }));
    },
    []
  );

  const triggerPunctuation = useCallback(() => {
    setState((s) => ({
      ...s,
      punct: { ...s.punct, status: "processing" },
    }));
  }, []);

  const setVisibility = useCallback(
    (v: "private" | "family" | "community" | "public") => {
      setState((s) => ({
        ...s,
        final: { ...s.final, visibility: v },
      }));
    },
    []
  );

  const setFinalConfirmed = useCallback((val: boolean) => {
    setState((s) => ({
      ...s,
      final: { ...s.final, confirmed: val },
    }));
  }, []);

  const setPermissionConfirmed = useCallback((val: boolean) => {
    setState((s) => ({
      ...s,
      final: { ...s.final, permissionConfirmed: val },
    }));
  }, []);

  const setAudioPublicConsent = useCallback((val: boolean) => {
    setState((s) => ({
      ...s,
      final: { ...s.final, audioPublicConsent: val },
    }));
  }, []);

  const preserveStoryAction = useCallback(async () => {
    const storyId = state.storyId || `story_${Date.now()}`;
    const opt = (state.form.story || "").trim();
    const tx = (state.tx.gnani?.text || state.tx.vaani?.text || "").trim();
    const speechPart = (state.punct.manual !== null ? state.punct.manual : state.ed.text || tx || "").trim();

    let workingText = "";
    if (opt && speechPart) {
      if (speechPart.startsWith(opt)) {
        workingText = speechPart;
      } else {
        workingText = combineOptionalAndTranscribedText(opt, speechPart);
      }
    } else {
      workingText = opt || speechPart || "";
    }

    const derivedCarrier =
      (state.form.carrier || "").trim() ||
      profile?.display_name ||
      profile?.full_name ||
      (user?.email ? user.email.split("@")[0] : "") ||
      "Community contributor";

    const payload = {
      id: storyId,
      title: state.form.title,
      carrier: derivedCarrier,
      category: state.form.category,
      roots: state.form.place,
      place: state.form.place,
      language: state.form.language,
      period: state.form.period,
      relationship: state.form.relationship,
      email: state.form.email,
      story: workingText,
      writtenText: opt,
      audio: state.audio
        ? {
            filename: state.audio.name,
            url: state.audio.url || undefined,
            size: state.audio.size,
            duration: state.audio.duration,
            kind: state.audio.kind,
            storage_path: state.audio.storage_path,
            bucket: state.audio.bucket,
          }
        : null,
      raw_transcripts: {
        vaani: state.tx.vaani,
        indicconformer: state.tx.conformer,
      },
      working_draft: state.ed.text || state.form.story,
      final_text: workingText,
      vocabulary: state.vocab.map((v) => ({
        id: v.id,
        preferred: v.preferred,
        heard: v.heard,
        meaning: v.meaning,
        language: v.language,
        context: v.context,
        pronunciation: v.pronunciation,
      })),
      visibility: state.final.visibility,
      confirmed: state.final.confirmed,
      permissionConfirmed: state.final.permissionConfirmed,
      audio_public_playback: Boolean(
        state.audio &&
        state.final.visibility === "public" &&
        state.final.audioPublicConsent
      ),
      finalSettings: {
        visibility: state.final.visibility,
        confirmed: state.final.confirmed,
        permissionConfirmed: state.final.permissionConfirmed,
        audioPublicConsent: Boolean(
          state.audio &&
          state.final.visibility === "public" &&
          state.final.audioPublicConsent
        ),
      },
    };

    // 1. If Supabase is configured, enforce real authenticated database persistence
    if (isSupabaseConfigured()) {
      if (!user) {
        openAuthModal();
        throw new Error(
          "Authentication required: Please sign in or create an account to permanently preserve your story to the Virasya repository."
        );
      }

      // Revalidate audio limits and ensure cloud archival
      if (state.audio) {
        if (state.audio.size && state.audio.size > MAX_AUDIO_SIZE_BYTES) {
          throw new Error("Audio recording exceeds the maximum allowed limit of 5 MiB (5,242,880 bytes).");
        }
        if (state.audio.duration && state.audio.duration > MAX_AUDIO_DURATION_SECONDS) {
          throw new Error(`Audio recording exceeds the maximum allowed limit of ${MAX_AUDIO_DURATION_SECONDS} seconds.`);
        }

        // If audio has no confirmed cloud storage_path (e.g. recorded while guest), upload now!
        if (!state.audio.storage_path) {
          const rawBinary = audioFileRef.current;
          if (!rawBinary) {
            throw new Error(
              "Audio recording binary is not available in browser memory. If you reloaded the page before signing in, please return to Step 2 to re-record or re-select your audio."
            );
          }
          const cloudRes = await uploadAudioToPrivateBucket(rawBinary, state.audio.name || "recording.webm", user.id);
          if (cloudRes.error || !cloudRes.path) {
            throw new Error(`Failed to upload audio recording to archival cloud storage: ${cloudRes.error?.message || "Upload failed"}`);
          }
          // Embed canonical storage references in payload
          payload.audio = {
            filename: state.audio.name,
            url: cloudRes.signedUrl || state.audio.url || undefined,
            size: state.audio.size,
            duration: state.audio.duration,
            kind: state.audio.kind,
            storage_path: cloudRes.path,
            bucket: AUDIO_STORAGE_BUCKET,
          };
          setState((s) => ({
            ...s,
            audio: s.audio ? {
              ...s.audio,
              storage_path: cloudRes.path,
              bucket: AUDIO_STORAGE_BUCKET,
              url: cloudRes.signedUrl || s.audio.url,
            } : null,
          }));
        }
      }

      // Execute real database persistence to Supabase public.stories
      const res = await preserveStoryToSupabase(payload as any, user.id);

      setState((s) => ({
        ...s,
        provenanceId: res.provenance_id,
        storyId: res.story.id,
        final: { ...s.final, isPreserved: true, isPreviewPreserved: false },
      }));

      // Clear all draft storage keys on preservation success
      try {
        localStorage.removeItem(activeStorageKey);
        localStorage.removeItem(STORAGE_KEY_GUEST);
        localStorage.removeItem(STORAGE_KEY);
      } catch {}

      return res;
    }

    // 2. If Supabase is not configured, check if local fallback is configured
    if (isBackendConfigured()) {
      const res = await preserveStoryOnBackend(storyId, payload);
      setState((s) => ({
        ...s,
        provenanceId: res.provenance_id,
        storyId: res.story.id,
        final: { ...s.final, isPreserved: true, isPreviewPreserved: false },
      }));
      try {
        localStorage.removeItem(activeStorageKey);
        localStorage.removeItem(STORAGE_KEY_GUEST);
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      return res;
    }

    // 3. Fail-closed: Never claim preservation or show a fake receipt if no database/backend is connected
    throw new Error(
      "Archival database connection is not available in this environment. Permanent persistence requires an active Supabase connection."
    );
  }, [state, user, profile, openAuthModal, activeStorageKey]);

  const resetAll = useCallback(async () => {
    const targetCloudId = cloudDraftStoryId || cloudDraft?.storyId;
    if (targetCloudId && isSupabaseConfigured()) {
      deleteStoryDraftFromBackend(targetCloudId).catch(() => {});
      discardedDraftIdsRef.current.add(targetCloudId);
      clearCloudDraftDismissed(targetCloudId, user?.id);
    }
    try {
      localStorage.removeItem(activeStorageKey);
      localStorage.removeItem(STORAGE_KEY_GUEST);
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setState({ ...INITIAL_STATE, storyId: uid() });
    setResumeDraft(null);
    setCloudDraft(null);
    setCloudDraftUpdatedAt(null);
    setCloudDraftStoryId(null);
    setDiscardError(null);
    setLeaveModalOpen(false);
    goToStep(1);
  }, [cloudDraftStoryId, cloudDraft, user?.id, goToStep, activeStorageKey]);

  const resumeFromSaved = useCallback((source?: "local" | "cloud") => {
    const chosenDraft =
      source === "cloud"
        ? cloudDraft
        : source === "local"
        ? resumeDraft
        : resumeDraft || cloudDraft;

    if (chosenDraft) {
      if (chosenDraft.storyId) {
        clearCloudDraftDismissed(chosenDraft.storyId, user?.id);
      }
      const restoredFinal = {
        ...INITIAL_STATE.final,
        ...(chosenDraft.final || {}),
        audioPublicConsent: Boolean(chosenDraft.final?.audioPublicConsent),
      };
      if (resumeDraft && source !== "cloud") {
        setState({
          ...chosenDraft,
          final: restoredFinal,
          transcriptionStyle: resumeDraft.transcriptionStyle || "verbatim",
        });
      } else {
        setState({
          ...chosenDraft,
          final: restoredFinal,
          transcriptionStyle: chosenDraft.transcriptionStyle || "verbatim",
        });
      }
      setResumeDraft(null);
      setCloudDraft(null);
      setCloudDraftUpdatedAt(null);
      setCloudDraftStoryId(null);
      setDiscardError(null);
      const target = STEP_DEFINITIONS.find((s) => s.step === chosenDraft.stage);
      if (target && window.location.pathname !== target.route) {
        window.history.pushState(null, "", target.route);
      }
    }
  }, [resumeDraft, cloudDraft, user?.id]);

  const clearDiscardError = useCallback(() => setDiscardError(null), []);

  const dismissResume = useCallback((source?: "all" | "local" | "cloud") => {
    return (async (): Promise<boolean> => {
      const targetSource = source || "all";
      setDiscardError(null);

      // A. Discard cloud draft permanently if requested
      if (targetSource === "all" || targetSource === "cloud") {
        const targetCloudId =
          cloudDraftStoryId ||
          cloudDraft?.storyId ||
          (targetSource === "all" ? resumeDraft?.storyId : undefined);
        if (targetCloudId && isSupabaseConfigured()) {
          setIsDiscardingDraft(true);
          try {
            const res = await deleteStoryDraftFromBackend(targetCloudId);
            if (!res.success) {
              const errMsg =
                res.error || "Failed to permanently discard cloud draft. Please try again.";
              setDiscardError(errMsg);
              setIsDiscardingDraft(false);
              return false; // Do not report success or start fresh draft if database delete failed!
            }
            // Clean up associated draft audio object from storage if path belongs to user
            const draftAudio = cloudDraft?.audio || resumeDraft?.audio;
            if (draftAudio?.storage_path && user?.id) {
              const cleanPath = draftAudio.storage_path.trim();
              if (
                cleanPath.startsWith(`${user.id}/`) &&
                !cleanPath.includes("..") &&
                !cleanPath.includes("\\")
              ) {
                try {
                  await deleteAudioFromPrivateBucket(cleanPath);
                } catch (audioErr) {
                  console.warn("[PreserveContext] Audio cleanup notice on draft discard:", audioErr);
                }
              }
            }
            // Mark as discarded so late in-flight or subsequent fetches cannot restore it
            discardedDraftIdsRef.current.add(targetCloudId);
            clearCloudDraftDismissed(targetCloudId, user?.id);
          } catch (err: any) {
            const errMsg = extractErrorMessage(err, "Failed to permanently discard cloud draft.");
            setDiscardError(errMsg);
            setIsDiscardingDraft(false);
            return false;
          } finally {
            setIsDiscardingDraft(false);
          }
        }

        setCloudDraft(null);
        setCloudDraftUpdatedAt(null);
        setCloudDraftStoryId(null);
      }

      // B. Discard local draft if requested
      if (targetSource === "all" || targetSource === "local") {
        try {
          localStorage.removeItem(activeStorageKey);
          localStorage.removeItem(STORAGE_KEY_GUEST);
          localStorage.removeItem(STORAGE_KEY);
        } catch {}
        setResumeDraft(null);
      }

      // C. Fresh state initialization if no drafts remain
      const remainingCloud = targetSource === "local" ? cloudDraft : null;
      const remainingLocal = targetSource === "cloud" ? resumeDraft : null;

      if (!remainingCloud && !remainingLocal) {
        try {
          localStorage.removeItem(activeStorageKey);
          localStorage.removeItem(STORAGE_KEY_GUEST);
          localStorage.removeItem(STORAGE_KEY);
        } catch {}
        const freshStoryId = uid();
        setState({
          ...INITIAL_STATE,
          storyId: freshStoryId,
        });
        setSavedAt(null);
      }

      return true;
    })();
  }, [cloudDraftStoryId, cloudDraft, resumeDraft, user?.id, activeStorageKey]);

  const dismissBanner = useCallback(() => {
    return dismissResume("all");
  }, [dismissResume]);

  const isTranscribing =
    transcriptionPhase === "checking" ||
    transcriptionPhase === "warming" ||
    transcriptionPhase === "transcribing";

  return (
    <PreserveContext.Provider
      value={{
        state,
        sim,
        savedAt,
        resumeDraft,
        cloudDraft,
        cloudDraftUpdatedAt,
        leaveModalOpen,
        dockOpen,
        isTranscribing,
        transcriptionPhase,
        transcriptionError,
        selectedLanguage,
        setSelectedLanguage,
        transcriptionStyle: state.transcriptionStyle || "verbatim",
        setTranscriptionStyle,
        isLanguageConfirmed,
        setIsLanguageConfirmed,
        clearTranscriptionError,
        retryTranscription,
        setLeaveModalOpen,
        setDockOpen,
        setSim,
        goToStep,
        updateForm,
        fillSampleStory,
        setAudio,
        audioFile,
        startTranscription,
        executeTranscription,
        continueWithWrittenOnly,
        loadSampleTranscript,
        retryModel,
        setEnhDecision,
        acceptAllLowRiskEnh,
        setEnhBase,
        triggerEnhancement,
        loadSourceIntoEditor,
        updateWorkingText,
        restoreSnapshot,
        undoWorkingText,
        addVocabEntry,
        updateVocabEntry,
        removeVocabEntry,
        setPunctDecision,
        acceptAllPunct,
        rejectAllPunct,
        setManualPunct,
        triggerPunctuation,
        setVisibility,
        setFinalConfirmed,
        setPermissionConfirmed,
        setAudioPublicConsent,
        preserveStoryAction,
        resetAll,
        resumeFromSaved,
        dismissResume,
        dismissBanner,
        isDiscardingDraft,
        discardError,
        clearDiscardError,
      }}
    >
      {children}
    </PreserveContext.Provider>
  );
}

export function usePreserve() {
  const ctx = useContext(PreserveContext);
  if (!ctx) throw new Error("usePreserve must be used within PreserveProvider");
  return ctx;
}
