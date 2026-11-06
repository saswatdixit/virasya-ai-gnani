import { useState, useEffect, useRef } from "react";
import type { AudioItem } from "../types";
import { formatTime, formatSize } from "../utils";
import { fetchAuthenticatedAudioBlob } from "../api";

export default function AudioPlayer({
  audio,
  sticky = false,
  onReplace,
  onRemove,
}: {
  audio: AudioItem | null;
  sticky?: boolean;
  onReplace?: () => void;
  onRemove?: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(
    audio?.url && (audio.url.startsWith("blob:") || audio.url.startsWith("data:"))
      ? audio.url
      : undefined
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const dur = audio?.duration || 0;

  // Resolve authenticated audio blob URL when audio.url is a remote path
  useEffect(() => {
    if (!audio?.url) {
      setResolvedSrc(undefined);
      setLoadError(null);
      return;
    }

    if (audio.url.startsWith("blob:") || audio.url.startsWith("data:")) {
      setResolvedSrc(audio.url);
      setLoadError(null);
      return;
    }

    let active = true;
    let createdUrl: string | null = null;

    fetchAuthenticatedAudioBlob(audio.url)
      .then((blobUrl) => {
        if (!active) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        createdUrl = blobUrl;
        setResolvedSrc(blobUrl);
        setLoadError(null);
      })
      .catch((err) => {
        if (active) {
          setLoadError(err.message || "Failed to load audio recording.");
          setResolvedSrc(undefined);
        }
      });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [audio?.url]);

  // For simulated demo playback
  useEffect(() => {
    if (!playing || audio?.kind !== "demo") return;
    const interval = setInterval(() => {
      setPos((p) => {
        if (p + 0.25 >= dur) {
          setPlaying(false);
          return dur;
        }
        return p + 0.25;
      });
    }, 250);
    return () => clearInterval(interval);
  }, [playing, audio?.kind, dur]);

  // For real audio element
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const handleTimeUpdate = () => setPos(el.currentTime);
    const handleEnded = () => setPlaying(false);
    const handlePause = () => setPlaying(false);
    const handlePlay = () => setPlaying(true);

    el.addEventListener("timeupdate", handleTimeUpdate);
    el.addEventListener("ended", handleEnded);
    el.addEventListener("pause", handlePause);
    el.addEventListener("play", handlePlay);

    return () => {
      el.removeEventListener("timeupdate", handleTimeUpdate);
      el.removeEventListener("ended", handleEnded);
      el.removeEventListener("pause", handlePause);
      el.removeEventListener("play", handlePlay);
    };
  }, [resolvedSrc]);

  if (!audio) return null;

  const togglePlay = () => {
    if (audio.kind === "demo") {
      if (pos >= dur) setPos(0);
      setPlaying(!playing);
    } else if (audioRef.current) {
      if (playing) {
        audioRef.current.pause();
      } else {
        if (audioRef.current.currentTime >= (audioRef.current.duration || 0)) {
          audioRef.current.currentTime = 0;
        }
        audioRef.current.play().catch(() => {});
      }
    }
  };

  const handleSeek = (val: number) => {
    setPos(val);
    if (audio.kind !== "demo" && audioRef.current) {
      audioRef.current.currentTime = val;
    }
  };

  return (
    <div
      style={{
        background: "var(--v-bg)",
        border: "1px solid var(--v-line)",
        borderRadius: 4,
        padding: "12px 18px",
        margin: "12px 0",
        ...(sticky
          ? {
              position: "sticky",
              top: 76,
              zIndex: 25,
              boxShadow: "0 4px 16px rgba(48,34,29,0.06)",
            }
          : {}),
      }}
      aria-label="Audio player"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 15 }}>Master Oral Recording</strong>
          <span className="p-small">
            {formatTime(audio.duration)}
            {audio.size ? ` · ${formatSize(audio.size)}` : ""}
          </span>
          {audio.kind === "demo" && (
            <span className="p-tag-sim">DEMONSTRATION RECORDING</span>
          )}
        </div>

        {(onReplace || onRemove) && (
          <div style={{ display: "flex", gap: 12 }}>
            {onReplace && (
              <button
                type="button"
                className="p-btn-text"
                style={{ fontSize: 13 }}
                onClick={onReplace}
              >
                Replace
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className="p-btn-text"
                style={{ fontSize: 13, color: "var(--v-alert)" }}
                onClick={onRemove}
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      {audio.kind === "lost" ? (
        <p className="p-small" style={{ margin: "6px 0" }}>
          Your earlier audio recording is referenced in metadata. In this frontend demo, raw audio blobs are not persisted in localStorage across browser visits.
        </p>
      ) : audio.kind === "demo" ? (
        <div className="p-audio-player">
          <button
            type="button"
            className="p-audio-btn"
            onClick={togglePlay}
            aria-label={playing ? "Pause demo recording" : "Play demo recording"}
          >
            {playing ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 4l13 8-13 8z" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min="0"
            max={dur}
            step="0.25"
            value={pos}
            onChange={(e) => handleSeek(+e.target.value)}
            className="p-audio-scrub"
            aria-label="Seek position in demonstration recording"
          />
          <span className="p-small p-tabnum">
            {formatTime(pos)} / {formatTime(dur)}
          </span>
          <span className="p-small" style={{ fontStyle: "italic", marginLeft: "auto" }}>
            Simulated player · sample representation
          </span>
        </div>
      ) : loadError ? (
        <div style={{ color: "var(--v-alert)", fontSize: 13, padding: "8px 0" }}>
          {loadError}
        </div>
      ) : (
        <div className="p-audio-player">
          <audio
            ref={audioRef}
            src={resolvedSrc || undefined}
            controls
            style={{ width: "100%", height: 38 }}
            preload="metadata"
          />
        </div>
      )}
    </div>
  );
}
