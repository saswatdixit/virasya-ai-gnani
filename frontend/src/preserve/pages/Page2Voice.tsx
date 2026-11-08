import { useState, useRef, useEffect, useCallback } from "react";
import { usePreserve } from "../context/PreserveContext";
import { useAuth } from "../../auth";
import { uploadAudioToPrivateBucket, isSupabaseConfigured } from "../../supabase";
import { uploadAudioToBackend, isLocalDev } from "../api";
import { formatTime, convertAudioBlobTo16kPcmWav, encodePcmTo16kWav } from "../utils";
import AudioPlayer from "../components/AudioPlayer";
import { LANGUAGE_OPTIONS } from "../types";
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_SIZE_BYTES,
  ALLOWED_AUDIO_EXTENSIONS,
  AUDIO_STORAGE_BUCKET,
} from "../constants";

export default function Page2Voice() {
  const {
    state,
    setAudio,
    startTranscription,
    continueWithWrittenOnly,
    loadSampleTranscript,
    goToStep,
    isTranscribing,
    transcriptionPhase,
    transcriptionError,
    selectedLanguage,
    setSelectedLanguage,
    transcriptionStyle,
    setTranscriptionStyle,
    isLanguageConfirmed,
    setIsLanguageConfirmed,
    retryTranscription,
    updateForm,
  } = usePreserve();
  const { user } = useAuth();

  const [mode, setMode] = useState<"record" | "upload">("record");
  const [recState, setRecState] = useState<"idle" | "requesting" | "recording" | "paused">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const currentLangOption = LANGUAGE_OPTIONS.find((l) => l.code === selectedLanguage);
  const currentLangName = currentLangOption ? currentLangOption.name : "Selected Language";

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recStateRef = useRef<"idle" | "requesting" | "recording" | "paused">("idle");
  recStateRef.current = recState;

  const audio = state.audio;
  const hasAudio = !!audio && !replacing;
  const hasWritten = state.form.story.trim().length > 0;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (processorRef.current) {
        try { processorRef.current.disconnect(); } catch {}
      }
      if (audioCtxRef.current && typeof audioCtxRef.current.close === "function") {
        audioCtxRef.current.close().catch(() => {});
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const stopRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      clearInterval(timerRef.current);
      try {
        mr.stop();
      } catch (err) {
        console.warn("[Voice] Error stopping MediaRecorder:", err);
      }
    }
  }, []);

  const startTimer = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const mr = mediaRecorderRef.current;
      if (!mr || mr.state === "inactive") {
        clearInterval(timerRef.current);
        return;
      }
      // If paused, pause time must NOT be counted toward recording time
      if (mr.state === "paused") {
        return;
      }

      elapsedRef.current += 0.25;
      const currentElapsed = Math.min(elapsedRef.current, MAX_AUDIO_DURATION_SECONDS);
      setElapsed(currentElapsed);

      if (elapsedRef.current >= MAX_AUDIO_DURATION_SECONDS) {
        clearInterval(timerRef.current);
        stopRecording();
      }
    }, 250);
  }, [stopRecording]);

  const drawWaveform = () => {
    if (!analyserRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserRef.current.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = 3;
    const barGap = 2;
    const totalBars = Math.floor(canvas.width / (barWidth + barGap));
    const step = Math.floor(bufferLength / totalBars);

    for (let i = 0; i < totalBars; i++) {
      const val = dataArray[i * step] || 0;
      const barHeight = Math.max(3, (val / 255) * canvas.height);
      const x = i * (barWidth + barGap);
      const y = (canvas.height - barHeight) / 2;

      ctx.fillStyle = "#B85D32";
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    animFrameRef.current = requestAnimationFrame(drawWaveform);
  };

  const startRecording = async () => {
    setErr("");
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setErr("Microphone recording is not supported in this browser. Please upload an audio file instead.");
      return;
    }

    try {
      setRecState("requesting");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];
      recordedBytesRef.current = 0;
      elapsedRef.current = 0;
      setElapsed(0);

      // Web Audio API analyzer and direct PCM capture
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        source.connect(analyser);
        analyserRef.current = analyser;
        drawWaveform();

        // Direct PCM audio capture for 100% reliable standard WAV encoding
        pcmChunksRef.current = [];
        try {
          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (e) => {
            if (mediaRecorderRef.current?.state === "recording") {
              const input = e.inputBuffer.getChannelData(0);
              pcmChunksRef.current.push(new Float32Array(input));
            }
          };
          source.connect(processor);
          processor.connect(audioCtx.destination);
          processorRef.current = processor;
        } catch (procErr) {
          console.warn("[Voice] ScriptProcessor notice:", procErr);
        }
      } catch {}

      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
        "audio/mp4",
        "audio/wav",
      ];
      const supportedMime =
        typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
          ? mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m))
          : undefined;

      const mr = supportedMime ? new MediaRecorder(stream, { mimeType: supportedMime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
          recordedBytesRef.current += e.data.size;
          // Guard against oversized recording while streaming
          if (recordedBytesRef.current > MAX_AUDIO_SIZE_BYTES) {
            mr.stop();
            setErr("Recording reached the maximum permitted size of 5 MiB (5,242,880 bytes) and was stopped.");
          }
        }
      };

      mr.onstop = async () => {
        clearInterval(timerRef.current);
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

        // Clean up audio processor
        if (processorRef.current) {
          try {
            processorRef.current.disconnect();
            processorRef.current = null;
          } catch {}
        }

        const resolvedType = mr.mimeType || supportedMime || "audio/webm";
        let blob: Blob;
        let isWav = false;
        const sourceSampleRate = audioCtxRef.current?.sampleRate || 44100;

        if (pcmChunksRef.current.length > 0) {
          try {
            blob = encodePcmTo16kWav(pcmChunksRef.current, sourceSampleRate, MAX_AUDIO_DURATION_SECONDS);
            isWav = true;
          } catch (encodeErr) {
            console.warn("[Voice] Direct PCM WAV encoding fallback:", encodeErr);
            blob = new Blob(audioChunksRef.current, { type: resolvedType });
          }
        } else {
          blob = new Blob(audioChunksRef.current, { type: resolvedType });
        }

        if (audioCtxRef.current && typeof audioCtxRef.current.close === "function") {
          audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }

        if (blob.size === 0) {
          setErr("Recording was empty. Please check your microphone and try again.");
          setRecState("idle");
          return;
        }

        if (blob.size > MAX_AUDIO_SIZE_BYTES) {
          setErr(`Recording (${(blob.size / (1024 * 1024)).toFixed(2)} MiB) exceeds the 5 MiB (5,242,880 bytes) limit. Please re-record a shorter take.`);
          setRecState("idle");
          return;
        }

        // If not already WAV and type includes webm, attempt client-side WAV normalization
        if (!isWav && resolvedType.includes("webm")) {
          try {
            blob = await convertAudioBlobTo16kPcmWav(blob);
            if (blob.type.includes("wav")) isWav = true;
          } catch (convErr) {
            console.warn("[Voice] Client-side WAV normalization notice:", convErr);
          }
        }

        let ext = isWav ? "wav" : "webm";
        if (!isWav) {
          if (blob.type.includes("wav") || resolvedType.includes("wav")) {
            ext = "wav";
          } else if (resolvedType.includes("ogg")) {
            ext = "ogg";
          } else if (resolvedType.includes("mp4") || resolvedType.includes("m4a") || resolvedType.includes("aac")) {
            ext = "m4a";
          }
        }

        const filename = `recording_${Date.now()}.${ext}`;
        const file = new File([blob], filename, { type: isWav ? "audio/wav" : blob.type });

        const localUrl = URL.createObjectURL(blob);
        const finalDur = Math.min(elapsedRef.current, MAX_AUDIO_DURATION_SECONDS);

        // Retain binary in memory in context for immediate use or deferred guest upload
        setAudio(
          {
            name: filename,
            url: localUrl,
            size: blob.size,
            duration: finalDur,
            kind: "recorded",
          },
          file
        );

        setUploading(true);
        // Decoupled Supabase Cloud Upload: only depends on user & Supabase, NOT on Flask!
        let storagePath: string | undefined = undefined;
        let signedUrl: string | undefined = undefined;

        if (user?.id && isSupabaseConfigured()) {
          try {
            const cloudRes = await uploadAudioToPrivateBucket(file, filename, user.id);
            if (cloudRes.error) {
              console.warn("[Cloud Storage] Upload notice:", cloudRes.error.message);
            } else if (cloudRes.path) {
              storagePath = cloudRes.path;
              signedUrl = cloudRes.signedUrl || undefined;
              setAudio(
                {
                  name: filename,
                  url: signedUrl || localUrl,
                  size: blob.size,
                  duration: finalDur,
                  kind: "recorded",
                  storage_path: storagePath,
                  bucket: AUDIO_STORAGE_BUCKET,
                },
                file
              );
            }
          } catch (cloudErr) {
            console.warn("[Cloud Storage] Upload exception:", cloudErr);
          }
        } else if (isLocalDev()) {
          try {
            const localRes = await uploadAudioToBackend(file);
            if (localRes && localRes.status === "success") {
              setAudio(
                {
                  name: localRes.filename || filename,
                  url: localRes.url || localUrl,
                  size: blob.size,
                  duration: finalDur,
                  kind: "recorded",
                },
                file
              );
            }
          } catch (localErr) {
            console.warn("[Local Upload] Upload exception:", localErr);
          }
        }

        setReplacing(false);
        setRecState("idle");
        setUploading(false);

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
      };

      mr.start(250);
      setRecState("recording");
      startTimer();
    } catch {
      setRecState("idle");
      setErr("Microphone permission denied or audio device unavailable.");
    }
  };

  const pauseResumeRecording = () => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    if (mr.state === "recording") {
      mr.pause();
      clearInterval(timerRef.current);
      setRecState("paused");
    } else if (mr.state === "paused") {
      mr.resume();
      startTimer();
      setRecState("recording");
    }
  };

  const handleFileUpload = async (file: File) => {
    setErr("");
    if (!file) return;

    if (file.size === 0) {
      setErr("The selected file is empty (0 bytes). Please select a valid audio file.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    if (file.size > MAX_AUDIO_SIZE_BYTES) {
      setErr(
        `File size (${(file.size / (1024 * 1024)).toFixed(2)} MiB) exceeds the 5 MiB (5,242,880 bytes) limit. Please select a shorter recording or compressed file.`
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const ext = "." + (file.name.split(".").pop()?.toLowerCase() || "");
    if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext as any)) {
      setErr(`Audio format '${ext}' is not supported. Permitted formats: MP3, WAV, OGG, M4A, FLAC, AAC, or WebM.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setUploading(true);
    const objectUrl = URL.createObjectURL(file);
    const audioEl = new Audio();
    audioEl.src = objectUrl;

    audioEl.onloadedmetadata = async () => {
      const dur = audioEl.duration;
      if (!dur || isNaN(dur) || dur <= 0) {
        URL.revokeObjectURL(objectUrl);
        setUploading(false);
        setErr("Unable to determine audio duration. Please ensure the file is a valid, playable audio recording.");
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      if (dur > MAX_AUDIO_DURATION_SECONDS) {
        URL.revokeObjectURL(objectUrl);
        setUploading(false);
        setErr(`Audio duration (${dur.toFixed(1)}s) exceeds the maximum limit of ${MAX_AUDIO_DURATION_SECONDS} seconds accepted for preservation and transcription.`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      // Valid size and duration! Retain binary file in memory in context
      setAudio(
        {
          name: file.name,
          url: objectUrl,
          size: file.size,
          duration: dur,
          kind: "uploaded",
        },
        file
      );

      // Decoupled Supabase Cloud Upload: only depends on user & Supabase, NOT on Flask!
      let storagePath: string | undefined = undefined;
      let signedUrl: string | undefined = undefined;

      if (user?.id && isSupabaseConfigured()) {
        try {
          const cloudRes = await uploadAudioToPrivateBucket(file, file.name, user.id);
          if (cloudRes.error) {
            console.warn("[Cloud Storage] Private audio upload notice:", cloudRes.error.message);
          } else if (cloudRes.path) {
            storagePath = cloudRes.path;
            signedUrl = cloudRes.signedUrl || undefined;
            setAudio(
              {
                name: file.name,
                url: signedUrl || objectUrl,
                size: file.size,
                duration: dur,
                kind: "uploaded",
                storage_path: storagePath,
                bucket: AUDIO_STORAGE_BUCKET,
              },
              file
            );
          }
        } catch (cloudErr) {
          console.warn("[Cloud Storage] Private audio upload exception:", cloudErr);
        }
      }

      setReplacing(false);
      setUploading(false);
    };

    audioEl.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setUploading(false);
      setErr("Failed to decode or inspect audio file. Please ensure the file is an intact, playable audio recording.");
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
  };

  return (
    <div className="p-compact-step">
      {/* Editorial Header */}
      <header className="p-compact-header">
        <div className="p-wrap">
          <div className="p-header-flex">
            <div>
              <div className="p-eyebrow">02 / VOICE & ORAL RECORD</div>
              <h1 className="p-compact-title" id="page-heading">
                Let the story be heard.
              </h1>
              <p className="p-compact-lede">
                Record the storyteller’s voice directly, or upload an existing audio file.
              </p>
            </div>
            <div className="p-header-meta">
              <span className={`p-status-pill ${isTranscribing ? "proc" : hasAudio ? "done" : "skip"}`}>
                {isTranscribing
                  ? transcriptionPhase === "warming"
                    ? "WARMING MODELS"
                    : "TRANSCRIBING AUDIO"
                  : hasAudio
                  ? "AUDIO READY FOR ASR"
                  : "AWAITING AUDIO"}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="p-wrap p-form-workspace">
        <div className="p-grid-voice">
          {/* Main Card: Audio Player or Capture */}
          <div className="p-card-panel">
            {hasAudio ? (
              <div>
                <div className="p-panel-header">
                  <span className="p-panel-num">✓</span>
                  <div>
                    <h2 className="p-panel-title">Attached Audio Recording</h2>
                    <p className="p-panel-sub">
                      Master oral recording attached to heritage story
                    </p>
                  </div>
                </div>

                <div className="p-audio-player-box">
                  <AudioPlayer
                    audio={audio}
                    onReplace={() => setReplacing(true)}
                    onRemove={() => setAudio(null)}
                  />
                </div>

                <div className="p-audio-meta-row">
                  <span className="p-small">
                    {audio.duration ? `Duration: ${formatTime(audio.duration)}` : "Duration detected"}
                    {audio.size ? ` · ${(audio.size / 1024 / 1024).toFixed(2)} MB` : ""}
                  </span>
                  <button
                    type="button"
                    className="p-btn-text p-btn-sm"
                    onClick={() => {
                      setReplacing(true);
                      setIsLanguageConfirmed(false);
                    }}
                    disabled={isTranscribing}
                  >
                    Replace audio
                  </button>
                </div>

                {/* Language Selection & Confirmation Card */}
                {!isTranscribing && (
                  <div
                    className="p-language-selection-card"
                    style={{
                      marginTop: 18,
                      padding: "16px 18px",
                      background: isLanguageConfirmed ? "rgba(46, 125, 50, 0.08)" : "rgba(184, 93, 50, 0.08)",
                      border: isLanguageConfirmed ? "1px solid rgba(46, 125, 50, 0.35)" : "1px solid rgba(184, 93, 50, 0.3)",
                      borderRadius: 6,
                      transition: "all 0.25s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--v-brown)" }}>
                        Select Audio Language
                      </span>
                      <span className="p-status-pill done" style={{ fontSize: 10, padding: "2px 8px" }}>
                        Gnani Prisma STT v2.5
                      </span>
                    </div>

                    <p className="p-small" style={{ margin: "0 0 14px", color: "var(--v-ink)", lineHeight: 1.5 }}>
                      Gnani Prisma speech recognition supports all 10 scheduled Indian languages. Please confirm the language spoken in this recording before transcription begins.
                    </p>

                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
                      <label htmlFor="audio-language-select" style={{ fontSize: 12, fontWeight: 600, color: "var(--v-ink)" }}>
                        Recording Language:
                      </label>
                      <select
                        id="audio-language-select"
                        value={selectedLanguage}
                        onChange={(e) => {
                          const langCode = e.target.value;
                          setSelectedLanguage(langCode);
                          setIsLanguageConfirmed(false);
                          const matchedLang = LANGUAGE_OPTIONS.find((l) => l.code === langCode);
                          if (matchedLang) {
                            updateForm("language", matchedLang.name);
                          }
                        }}
                        disabled={isTranscribing}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 6,
                          border: "1px solid var(--v-line)",
                          background: "#fff",
                          color: "var(--v-ink)",
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: "pointer",
                        }}
                      >
                        {LANGUAGE_OPTIONS.map((opt) => (
                          <option key={opt.code} value={opt.code}>
                            {opt.name} ({opt.code}) — Supported
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Output Style Selection (Gnani format: verbatim | transcribe) */}
                    <div className="p-style-section" style={{ marginTop: 14, marginBottom: 14 }}>
                      <label id="output-style-label" className="p-style-label">
                        Output Style
                      </label>
                      <p className="p-style-helper">
                        Choose how English words and numbers are written.
                      </p>

                      <div
                        role="radiogroup"
                        aria-labelledby="output-style-label"
                        className="p-style-grid"
                      >
                        {/* Verbatim Option Card */}
                        <div
                          role="radio"
                          aria-checked={transcriptionStyle === "verbatim"}
                          tabIndex={0}
                          className={`p-style-card ${transcriptionStyle === "verbatim" ? "is-selected" : ""}`}
                          onClick={() => setTranscriptionStyle("verbatim")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setTranscriptionStyle("verbatim");
                            }
                          }}
                        >
                          <div className="p-style-card-header">
                            <div className="p-style-radio-indicator">
                              <input
                                type="radio"
                                id="style-verbatim"
                                name="transcription-style"
                                value="verbatim"
                                checked={transcriptionStyle === "verbatim"}
                                onChange={() => setTranscriptionStyle("verbatim")}
                                tabIndex={-1}
                                aria-hidden="true"
                              />
                              <strong className="p-style-title">Verbatim</strong>
                            </div>
                            {transcriptionStyle === "verbatim" && (
                              <span className="p-style-check" aria-hidden="true">✓</span>
                            )}
                          </div>

                          <p className="p-style-desc">
                            Writes the transcript word for word in the selected language, entirely in its native script. English words and numbers are spelled out the way they’re spoken.
                          </p>

                          <div className="p-style-example" aria-label="Verbatim style example: Mera account balance baarah hazaar paanch sau rupaye hai in Devanagari script">
                            <span className="p-style-eg">e.g.</span> मेरा{" "}
                            <span className="p-hl-blue">अकाउंट बैलेंस</span>{" "}
                            <span className="p-hl-amber">बारह हज़ार पाँच सौ रुपये</span> है
                          </div>
                        </div>

                        {/* Transcribe Option Card */}
                        <div
                          role="radio"
                          aria-checked={transcriptionStyle === "transcribe"}
                          tabIndex={0}
                          className={`p-style-card ${transcriptionStyle === "transcribe" ? "is-selected" : ""}`}
                          onClick={() => setTranscriptionStyle("transcribe")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setTranscriptionStyle("transcribe");
                            }
                          }}
                        >
                          <div className="p-style-card-header">
                            <div className="p-style-radio-indicator">
                              <input
                                type="radio"
                                id="style-transcribe"
                                name="transcription-style"
                                value="transcribe"
                                checked={transcriptionStyle === "transcribe"}
                                onChange={() => setTranscriptionStyle("transcribe")}
                                tabIndex={-1}
                                aria-hidden="true"
                              />
                              <strong className="p-style-title">Transcribe</strong>
                            </div>
                            {transcriptionStyle === "transcribe" && (
                              <span className="p-style-check" aria-hidden="true">✓</span>
                            )}
                          </div>

                          <p className="p-style-desc">
                            Writes the transcript in the native script of the selected language, with numbers, dates and amounts as digits and symbols.
                          </p>

                          <div className="p-style-example" aria-label="Transcribe style example: Mera account balance ₹12,500 hai with digits and English loanwords">
                            <span className="p-style-eg">e.g.</span> मेरा{" "}
                            <span className="p-hl-blue">account balance</span>{" "}
                            <span className="p-hl-amber">₹12,500</span> है
                          </div>
                        </div>

                        {/* Code-mix Option Card */}
                        <div
                          role="radio"
                          aria-checked={transcriptionStyle === "codemix"}
                          tabIndex={0}
                          className={`p-style-card ${transcriptionStyle === "codemix" ? "is-selected" : ""}`}
                          onClick={() => setTranscriptionStyle("codemix")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setTranscriptionStyle("codemix");
                            }
                          }}
                        >
                          <div className="p-style-card-header">
                            <div className="p-style-radio-indicator">
                              <input
                                type="radio"
                                id="style-codemix"
                                name="transcription-style"
                                value="codemix"
                                checked={transcriptionStyle === "codemix"}
                                onChange={() => setTranscriptionStyle("codemix")}
                                tabIndex={-1}
                                aria-hidden="true"
                              />
                              <strong className="p-style-title">Code-mix</strong>
                            </div>
                            {transcriptionStyle === "codemix" && (
                              <span className="p-style-check" aria-hidden="true">✓</span>
                            )}
                          </div>

                          <p className="p-style-desc">
                            Keeps English words in Latin script and Indic-language words in their native scripts. Numbers are generally written as words.
                          </p>

                          <div className="p-style-example" aria-label="Code-mix style example: Mera account balance baarah hazaar paanch sau rupaye hai with English words in Latin script and Hindi in Devanagari">
                            <span className="p-style-eg">e.g.</span> मेरा{" "}
                            <span className="p-hl-blue">account balance</span>{" "}
                            <span className="p-hl-amber">बारह हज़ार पाँच सौ रुपये</span> है
                          </div>
                        </div>

                        {/* Transliterate Option Card */}
                        <div
                          role="radio"
                          aria-checked={transcriptionStyle === "transliterate"}
                          tabIndex={0}
                          className={`p-style-card ${transcriptionStyle === "transliterate" ? "is-selected" : ""}`}
                          onClick={() => setTranscriptionStyle("transliterate")}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setTranscriptionStyle("transliterate");
                            }
                          }}
                        >
                          <div className="p-style-card-header">
                            <div className="p-style-radio-indicator">
                              <input
                                type="radio"
                                id="style-transliterate"
                                name="transcription-style"
                                value="transliterate"
                                checked={transcriptionStyle === "transliterate"}
                                onChange={() => setTranscriptionStyle("transliterate")}
                                tabIndex={-1}
                                aria-hidden="true"
                              />
                              <strong className="p-style-title">Transliterate</strong>
                            </div>
                            {transcriptionStyle === "transliterate" && (
                              <span className="p-style-check" aria-hidden="true">✓</span>
                            )}
                          </div>

                          <p className="p-style-desc">
                            Writes the transcript in Latin letters, similar to romanized Hindi/Hinglish. Numbers are written as words.
                          </p>

                          <div className="p-style-example" aria-label="Transliterate style example: Mera account balance baarah hazaar paanch sau rupaye hai entirely in Latin script">
                            <span className="p-style-eg">e.g.</span> Mera{" "}
                            <span className="p-hl-blue">account balance</span>{" "}
                            <span className="p-hl-amber">baarah hazaar paanch sau rupaye</span> hai
                          </div>
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 14px",
                        background: isLanguageConfirmed ? "rgba(46, 125, 50, 0.12)" : "#fff",
                        border: isLanguageConfirmed ? "1px solid rgba(46, 125, 50, 0.4)" : "1px solid var(--v-line)",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                      onClick={() => !isTranscribing && setIsLanguageConfirmed(!isLanguageConfirmed)}
                    >
                      <input
                        type="checkbox"
                        id="language-confirm-checkbox"
                        checked={isLanguageConfirmed}
                        onChange={(e) => setIsLanguageConfirmed(e.target.checked)}
                        disabled={isTranscribing}
                        style={{ width: 18, height: 18, accentColor: "#B85D32", cursor: "pointer" }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <label
                        htmlFor="language-confirm-checkbox"
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: isLanguageConfirmed ? "#1e5c26" : "var(--v-ink)",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        {isLanguageConfirmed
                          ? `✓ Confirmed: Audio recording is in ${currentLangName} for Gnani Prisma STT`
                          : `I confirm this audio recording is spoken in ${currentLangName}`}
                      </label>
                    </div>
                  </div>
                )}

                {/* In-Step Transcription Loading State */}
                {isTranscribing && (
                  <div
                    className="p-asr-processing-card"
                    role="status"
                    aria-live="polite"
                    style={{
                      marginTop: 18,
                      padding: "16px 18px",
                      background: "rgba(184, 93, 50, 0.08)",
                      border: "1px solid rgba(184, 93, 50, 0.3)",
                      borderRadius: 6,
                      display: "flex",
                      gap: 14,
                      alignItems: "center",
                    }}
                  >
                    <div className="p-spinner" style={{ width: 26, height: 26, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <strong style={{ display: "block", color: "var(--v-brown)", fontSize: 14.5 }}>
                        {transcriptionPhase === "warming" || transcriptionPhase === "checking"
                          ? "Connecting to Gnani Prisma speech service…"
                          : "Transcribing your audio with Gnani Prisma…"}
                      </strong>
                      <p className="p-small" style={{ margin: "4px 0 0", color: "var(--v-text-sub)", lineHeight: 1.5 }}>
                        {transcriptionPhase === "warming" || transcriptionPhase === "checking"
                          ? "Verifying Gnani Prisma speech recognition service. This only takes a moment."
                          : "Running Gnani Prisma speech-to-text recognition. As soon as your transcript is ready, you will proceed to review."}
                      </p>
                    </div>
                  </div>
                )}

                {/* In-Step Real Transcription Error Alert */}
                {transcriptionError && !isTranscribing && (
                  <div
                    className="p-asr-error-card"
                    role="alert"
                    style={{
                      marginTop: 18,
                      padding: "16px 18px",
                      background: "rgba(197, 48, 48, 0.08)",
                      border: "1px solid rgba(197, 48, 48, 0.35)",
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 20, lineHeight: 1, color: "var(--v-alert)" }}>⚠️</span>
                      <div style={{ flex: 1 }}>
                        <strong style={{ color: "var(--v-alert)", fontSize: 14.5 }}>
                          Speech recognition encountered an issue
                        </strong>
                        <p className="p-small" style={{ margin: "6px 0 12px", color: "var(--v-ink)", lineHeight: 1.5 }}>
                          {transcriptionError}
                        </p>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="p-btn p-btn-brass p-btn-sm"
                            onClick={retryTranscription}
                          >
                            ↻ Retry Transcription
                          </button>
                          <button
                            type="button"
                            className="p-btn p-btn-dark p-btn-sm"
                            onClick={loadSampleTranscript}
                          >
                            Preview with Sample Odia Transcript (Demo Content) →
                          </button>
                          {hasWritten && (
                            <button
                              type="button"
                              className="p-btn p-btn-ghost p-btn-sm"
                              onClick={continueWithWrittenOnly}
                            >
                              Continue with written story instead
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="p-panel-header">
                  <span className="p-panel-num">A</span>
                  <div>
                    <h2 className="p-panel-title">Audio Capture & Upload</h2>
                    <p className="p-panel-sub">
                      Record spoken audio directly with your microphone or upload an existing recording
                    </p>
                  </div>
                </div>

                {/* Method Switcher Tabs */}
                <div className="p-tabs-segmented" role="tablist" aria-label="Audio capture method">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "record"}
                    className={`p-tab-seg ${mode === "record" ? "is-active" : ""}`}
                    onClick={() => {
                      setMode("record");
                      setErr("");
                    }}
                  >
                    <span className="p-tab-icon">🎙</span> Record with Microphone
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "upload"}
                    className={`p-tab-seg ${mode === "upload" ? "is-active" : ""}`}
                    onClick={() => {
                      setMode("upload");
                      setErr("");
                    }}
                  >
                    <span className="p-tab-icon">📁</span> Upload Audio File
                  </button>
                </div>

                {/* Option A: Microphone Recorder */}
                {mode === "record" && (
                  <div className="p-record-card">
                    <div className="p-rec-center">
                      <button
                        type="button"
                        className={`p-rec-circle-btn ${recState === "recording" ? "is-recording" : recState === "paused" ? "is-paused" : ""}`}
                        onClick={recState === "idle" ? startRecording : stopRecording}
                        disabled={recState === "requesting" || uploading}
                        aria-label={recState === "idle" ? "Start recording" : "Stop recording"}
                      >
                        <span className="p-rec-inner" />
                      </button>

                      <div className="p-rec-timer">{formatTime(elapsed)} / 00:30</div>

                      <p className="p-rec-status">
                        {recState === "idle" && "Click the record button to speak (up to 30 seconds)."}
                        {recState === "requesting" && "Requesting microphone permission…"}
                        {recState === "recording" && "Recording in progress (max 30s). Speak naturally in your native language."}
                        {recState === "paused" && "Recording paused."}
                        {uploading && "Uploading audio recording…"}
                      </p>

                      {recState === "recording" && (
                        <canvas ref={canvasRef} className="p-rec-canvas" width={320} height={40} />
                      )}

                      {(recState === "recording" || recState === "paused") && (
                        <div className="p-rec-actions">
                          <button
                            type="button"
                            className="p-btn p-btn-ghost p-btn-sm"
                            onClick={pauseResumeRecording}
                          >
                            {recState === "recording" ? "Pause" : "Resume"}
                          </button>
                          <button
                            type="button"
                            className="p-btn p-btn-brass p-btn-sm"
                            onClick={stopRecording}
                          >
                            Stop & Save Recording
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Option B: File Dropzone */}
                {mode === "upload" && (
                  <div
                    className={`p-dropzone-compact ${isDragOver ? "is-dragover" : ""} ${uploading ? "is-uploading" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!uploading) setIsDragOver(true);
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragOver(false);
                      if (uploading) return;
                      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        handleFileUpload(e.dataTransfer.files[0]);
                      }
                    }}
                  >
                    <div className="p-drop-icon">↑</div>
                    <h3 className="p-drop-title">
                      {uploading ? "Uploading audio recording…" : "Drag & drop your audio recording"}
                    </h3>
                    <p className="p-drop-sub">Supports MP3, WAV, OGG, M4A, FLAC, or WebM (30 sec max &middot; 5 MiB)</p>

                    <button
                      type="button"
                      className="p-btn p-btn-brass p-btn-sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading ? "Uploading…" : "Browse files"}
                    </button>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.webm,.flac,.opus"
                      style={{ display: "none" }}
                      disabled={uploading}
                      onChange={(e) => {
                        if (e.target.files && e.target.files[0]) {
                          handleFileUpload(e.target.files[0]);
                          e.target.value = "";
                        }
                      }}
                    />
                  </div>
                )}

                {err && <p className="p-field-error" role="alert">{err}</p>}

                {replacing && (
                  <div style={{ marginTop: 12, textAlign: "center" }}>
                    <button
                      type="button"
                      className="p-btn-text p-btn-sm"
                      onClick={() => {
                        setReplacing(false);
                        setErr("");
                      }}
                    >
                      Cancel and keep previous audio
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right Panel: Context Summary */}
          <div className="p-card-panel p-side-info">
            <h3 className="p-side-title">Story Overview</h3>
            <div className="p-side-item">
              <span className="p-side-label">Title</span>
              <strong className="p-side-val">{state.form.title || "Untitled story"}</strong>
            </div>
            <div className="p-side-item">
              <span className="p-side-label">Storyteller</span>
              <span className="p-side-val">{state.form.carrier || "Not specified"}</span>
            </div>
            <div className="p-side-item">
              <span className="p-side-label">Language</span>
              <span className="p-side-val">{state.form.language || "Odia"}</span>
            </div>
            <div className="p-side-item">
              <span className="p-side-label">Output Style</span>
              <span className="p-side-val" style={{ textTransform: "capitalize" }}>
                {transcriptionStyle === "transcribe"
                  ? "Transcribe (Digits & Symbols)"
                  : transcriptionStyle === "codemix"
                  ? "Code-mix (Mixed Script)"
                  : transcriptionStyle === "transliterate"
                  ? "Transliterate (Latin Script)"
                  : "Verbatim (Native Script)"}
              </span>
            </div>

            {hasWritten && (
              <div className="p-side-item" style={{ marginTop: 16 }}>
                <span className="p-side-label">Written story captured</span>
                <p className="p-small" style={{ margin: "4px 0 0", color: "var(--v-ink)" }}>
                  {state.form.story.slice(0, 120)}…
                </p>
              </div>
            )}

            <div className="p-side-note">
              Audio is transcribed using Gnani Prisma Speech Recognition (STT v2.5) with server-side security. Your authentic recording is stored safely in the archive.
            </div>
          </div>
        </div>

        {/* Persistent Bottom Bar */}
        <div className="p-bottom-bar">
          <div className="p-bar-left">
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={() => goToStep(1)}
            >
              ← Back to Story
            </button>
          </div>
          <div className="p-bar-right">
            {hasAudio ? (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {transcriptionError && (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost"
                    onClick={loadSampleTranscript}
                  >
                    Sample Transcript (Demo) →
                  </button>
                )}
                <button
                  type="button"
                  className="p-btn p-btn-brass"
                  onClick={startTranscription}
                  disabled={isTranscribing || !isLanguageConfirmed}
                  aria-busy={isTranscribing}
                  title={!isLanguageConfirmed ? "Confirm audio language above before transcribing" : "Start Gnani speech transcription"}
                >
                  {isTranscribing ? (
                    <>
                      <span className="p-spinner-sm" aria-hidden="true" style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginRight: 8, verticalAlign: "middle" }} />
                      Transcribing in {currentLangName} with Gnani Prisma…
                    </>
                  ) : transcriptionError ? (
                    <>
                      Retry {currentLangName} Transcription <span className="p-ar">↻</span>
                    </>
                  ) : !isLanguageConfirmed ? (
                    <>
                      Confirm {currentLangName} Language Above <span className="p-ar">→</span>
                    </>
                  ) : (
                    <>
                      Start Gnani Transcription ({currentLangName}) <span className="p-ar">→</span>
                    </>
                  )}
                </button>
              </div>
            ) : hasWritten ? (
              <button
                type="button"
                className="p-btn p-btn-dark"
                onClick={continueWithWrittenOnly}
              >
                Continue with Written Story Only <span className="p-ar">→</span>
              </button>
            ) : (
              <span className="p-small p-hint">
                Please record audio or upload an audio file to proceed
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
