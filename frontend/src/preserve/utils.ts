// Helper utilities for Preserve Your Story experience
export const uid = () => Math.random().toString(36).slice(2, 9);

export const formatTime = (sec: number | null | undefined): string => {
  if (sec == null || !isFinite(sec)) return "—";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const formatSize = (bytes: number | null): string => {
  if (!bytes) return "—";
  return bytes > 1048576
    ? (bytes / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
};

export const wordCount = (t: string | undefined): number =>
  t && t.trim() ? t.trim().split(/\s+/).length : 0;

/**
 * Combines optional user-provided text (from Step 1) and speech-transcribed text into a cohesive story narrative.
 *
 * Rules:
 * 1. Order: Optional text first, followed by transcribed text.
 * 2. If both texts are present, separates them with a double newline ("\n\n"), preserving paragraph structure.
 * 3. Surrounding leading and trailing whitespace on the optional text is cleanly trimmed.
 * 4. If optional text is blank or whitespace-only, returns ONLY the transcribed text (no empty lines, placeholders, or separators).
 * 5. If transcribed text is blank or missing, returns ONLY the trimmed optional text.
 * 6. If both are blank, returns an empty string.
 */
export function combineOptionalAndTranscribedText(
  optionalText?: string | null,
  transcribedText?: string | null
): string {
  const opt = (optionalText || "").trim();
  const tx = (transcribedText || "").trim();

  if (opt && tx) {
    return `${opt}\n\n${tx}`;
  }
  if (opt) {
    return opt;
  }
  if (tx) {
    return tx;
  }
  return "";
}

export interface StoryTextOutputs {
  output1: string; // The first generated text output: Written Story Context & Notes
  output2: string; // The second generated text output: Transcribed Oral Narrative
  hasTwoOutputs: boolean;
}

/**
 * Extracts and cleanly separates the two text outputs for independent rendering:
 * - Output 1 (Text Box 1): Written story context/notes provided by user
 * - Output 2 (Text Box 2): Transcribed oral recording / spoken speech text
 *
 * Ensures:
 * 1. Independent content rendering (neither text is merged with or appended inside the other).
 * 2. Clean multi-paragraph extraction.
 * 3. Safe fallback for single-output records (e.g. oral-only or text-only stories).
 */
export function extractStoryTextOutputs(story: {
  final_text?: string | null;
  written_text?: string | null;
  writtenText?: string | null;
  has_audio?: boolean;
}): StoryTextOutputs {
  const final = (story.final_text || "").trim();
  const explicitWritten = (story.written_text || story.writtenText || "").trim();

  // Scenario 1: Authoritative written_text exists and is non-empty
  if (explicitWritten) {
    if (final.startsWith(explicitWritten)) {
      const remaining = final.slice(explicitWritten.length).trim();
      return {
        output1: explicitWritten,
        output2: remaining,
        hasTwoOutputs: Boolean(remaining),
      };
    }
    if (final.includes(explicitWritten)) {
      const parts = final.split(explicitWritten);
      const remaining = parts.join("").trim();
      return {
        output1: explicitWritten,
        output2: remaining,
        hasTwoOutputs: Boolean(remaining),
      };
    }
    if (final && final !== explicitWritten) {
      return {
        output1: explicitWritten,
        output2: final,
        hasTwoOutputs: true,
      };
    }
    return {
      output1: explicitWritten,
      output2: "",
      hasTwoOutputs: false,
    };
  }

  // Scenario 2: Explicit written_text field was supplied as empty string, whitespace, or null,
  // or historical records where written_text was not tracked.
  // Authoritative protection: NEVER heuristically split multi-paragraph oral narratives or historical records!
  // If records cannot be authoritatively separated, preserve the original text in a single identified fallback.
  if (story.has_audio === false) {
    return {
      output1: final,
      output2: "",
      hasTwoOutputs: false,
    };
  }

  // Oral or historical record with only final_text
  return {
    output1: "",
    output2: final,
    hasTwoOutputs: false,
  };
}

/**
 * Converts an in-memory audio Blob (such as browser-recorded WebM) to a standard 16kHz mono 16-bit PCM WAV Blob.
 *
 * This guarantees client-side recordings produce a format universally accepted by the ASR provider
 * (Gnani Prisma STT v2.5 / v3 accepts WAV, OGG, M4A, FLAC, AAC, MP3) without requiring external FFmpeg
 * binaries in serverless or Deno Edge Function environments.
 */
export async function convertAudioBlobTo16kPcmWav(sourceBlob: Blob): Promise<Blob> {
  if (typeof window === "undefined") return sourceBlob;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return sourceBlob;

  const arrayBuffer = await sourceBlob.arrayBuffer();
  if (!arrayBuffer || arrayBuffer.byteLength === 0) return sourceBlob;

  const audioCtx = new AudioCtx();
  let decodedBuffer: AudioBuffer;
  try {
    decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    if (typeof audioCtx.close === "function") {
      audioCtx.close().catch(() => {});
    }
  }

  const targetRate = 16000;
  const numSamples = Math.ceil(decodedBuffer.duration * targetRate);
  if (numSamples <= 0) return sourceBlob;

  const OfflineCtx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  if (!OfflineCtx) return sourceBlob;

  const offlineCtx = new OfflineCtx(1, numSamples, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decodedBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const resampled = await offlineCtx.startRendering();

  const pcmData = resampled.getChannelData(0);
  const wavBuffer = new ArrayBuffer(44 + pcmData.length * 2);
  const view = new DataView(wavBuffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcmData.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM format chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono (1 channel)
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); // byte rate (16000 * 2)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, pcmData.length * 2, true);

  let offset = 44;
  for (let i = 0; i < pcmData.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcmData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
}

export const getClock = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function diffTokens(a: string[], b: string[]) {
  const n = a.length,
    m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i + 1][j + 1]);
    }
  }
  const aG = new Array(n).fill(-1);
  const bG = new Array(m).fill(-1);
  const groups: { id: number; a: number[]; b: number[] }[] = [];
  let i = 0,
    j = 0,
    cur: { id: number; a: number[]; b: number[] } | null = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      cur = null;
      i++;
      j++;
      continue;
    }
    if (!cur) {
      cur = { id: groups.length, a: [], b: [] };
      groups.push(cur);
    }
    if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      cur.a.push(i);
      aG[i] = cur.id;
      i++;
    } else {
      cur.b.push(j);
      bG[j] = cur.id;
      j++;
    }
  }
  return { aG, bG, groups };
}

export function placeChanges(base: string, list: any[]) {
  const out: any[] = [];
  list.forEach((c) => {
    const idx = base.indexOf(c.from);
    if (idx >= 0) out.push({ c, idx });
  });
  out.sort((x, y) => x.idx - y.idx);
  out.forEach((o, i) => {
    o.n = i + 1;
  });
  return out;
}

export function applyChanges(
  base: string,
  placed: any[],
  dec: Record<string, string>
) {
  let res = "",
    pos = 0;
  placed.forEach(({ c, idx }) => {
    res += base.slice(pos, idx);
    res += !c.note && dec[c.id] === "accepted" ? c.to : c.from;
    pos = idx + c.from.length;
  });
  return res + base.slice(pos);
}

const END_RE = /(ଥିଲେ|ଥିଲା|ଥିଲୁ|ଥିଲି)$/;
export function punctItems(text: string) {
  const parts = text.split(/(\s+)/);
  const items: any[] = [];
  let ti = -1;
  parts.forEach((p, pi) => {
    if (!p || /^\s+$/.test(p)) return;
    ti++;
    if (ti > 0 && p === "ପ୍ରଥମେ") {
      items.push({
        id: "para" + ti,
        pi,
        type: "paragraph",
        label: `Start a new paragraph before “${p}”`,
      });
    }
    if (END_RE.test(p)) {
      items.push({
        id: "end" + ti,
        pi,
        type: "sentence",
        ins: "।",
        label: `Mark the end of a sentence after “${p}”`,
      });
    } else if (p === "ଲଗାଇ") {
      items.push({
        id: "com" + ti,
        pi,
        type: "comma",
        ins: ",",
        label: `Add a comma after “${p}”`,
      });
    }
  });
  return items;
}

export function punctSegments(
  text: string,
  items: any[],
  dec: Record<string, string>
) {
  const parts = text.split(/(\s+)/);
  const ins: Record<number, any> = {};
  const para: Record<number, any> = {};
  items.forEach((it) => {
    if (it.type === "paragraph") para[it.pi] = it;
    else ins[it.pi] = it;
  });
  const segs: any[] = [];
  parts.forEach((p, pi) => {
    if (p === "") return;
    if (/^\s+$/.test(p)) {
      const nx = para[pi + 1];
      if (nx && dec[nx.id] === "accepted") {
        segs.push({ t: "text", s: "\n\n" });
      } else if (nx && dec[nx.id] !== "rejected") {
        segs.push({ t: "mark", s: "¶", ghost: true, id: nx.id });
        segs.push({ t: "text", s: p });
      } else {
        segs.push({ t: "text", s: p });
      }
      return;
    }
    segs.push({ t: "text", s: p });
    const it = ins[pi];
    if (it) {
      const d = dec[it.id];
      if (d === "accepted") {
        segs.push({ t: "mark", s: it.ins, id: it.id });
      } else if (d !== "rejected") {
        segs.push({ t: "mark", s: it.ins, ghost: true, id: it.id });
      }
    }
  });
  return segs;
}

export const segString = (segs: any[]) =>
  segs
    .filter((x) => x.t === "text" || !x.ghost)
    .map((x) => x.s)
    .join("");

export const stripP = (t: string) =>
  t
    .replace(/[।,.;:?!"“”‘’'()[\]—…-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export function checkIntegrity(before: string, after: string) {
  const A = stripP(before);
  const B = stripP(after);
  if (A.length === B.length && A.every((x, i) => x === B[i])) {
    return { ok: true, removed: [], added: [] };
  }
  const d = diffTokens(A, B);
  return {
    ok: false,
    removed: A.filter((_, i) => d.aG[i] >= 0),
    added: B.filter((_, i) => d.bG[i] >= 0),
  };
}
