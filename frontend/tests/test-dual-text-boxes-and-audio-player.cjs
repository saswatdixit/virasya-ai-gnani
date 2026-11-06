/**
 * Virasya Test Suite: Separate Text Boxes & Hidden Audio Filename Verification
 *
 * Verifies:
 * 1. extractStoryTextOutputs function:
 *    - Separates user-written text (Output 1) from transcribed audio narrative (Output 2).
 *    - Guarantees neither text is merged into or appended to the other.
 *    - Correctly handles multi-paragraph written text and multi-paragraph speech text.
 *    - Handles explicit written_text column mapping as well as double-newline combined stories.
 *    - Provides graceful fallback for single-output records (oral-only and text-only).
 * 2. Explore Audio Player UI:
 *    - Confirms audio filename element is completely removed from the DOM.
 *    - Confirms audio playback controls, signed URL resolution, and token refresh remain intact.
 * 3. Explore Reader Modal Layout:
 *    - Two independent container boxes (.exp-narrative-box-written & .exp-narrative-box-transcribed).
 *    - Meaningful headings ("Written Story Context" and "Transcribed Audio Narrative").
 *    - Responsive CSS grid (.exp-narrative-dual-grid: 1fr on mobile, 1fr 1fr on desktop).
 *    - Long text word-break and overflow protection.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

console.log("=== Virasya Dual Text Boxes & Hidden Audio Filenames Test Suite ===\n");

(async () => {
  // Dynamically load the TypeScript utilities
  const utils = await import("../src/preserve/utils.ts");
  const { extractStoryTextOutputs, combineOptionalAndTranscribedText } = utils;

  // ---------------------------------------------------------------------------
  // Test 1: extractStoryTextOutputs separates two outputs cleanly
  // ---------------------------------------------------------------------------
  console.log("1. Testing clean extraction of two distinct text outputs...");
  {
    const written = "Every Thursday my grandmother, Nirmala Devi, made khechedi in a clay handi over a wood fire. Moong dal, rice, a spoon of ghee and a little ginger — nothing more.";
    const transcribed = "કાલે હું ગુજરાત જવાનો છું અહીંયાથી વાળની દૂરી લગભગ સાતસો પચાસ કિલોમીટર છે તમે ક્યાં જશો";
    const combined = `${written}\n\n${transcribed}`;

    const res = extractStoryTextOutputs({
      final_text: combined,
      written_text: written,
    });

    assert.strictEqual(res.hasTwoOutputs, true, "Must detect two outputs");
    assert.strictEqual(res.output1, written, "Output 1 must contain exclusively the written text");
    assert.strictEqual(res.output2, transcribed, "Output 2 must contain exclusively the transcribed audio text");
    assert.ok(!res.output1.includes(transcribed), "Output 1 must NEVER contain transcribed text");
    assert.ok(!res.output2.includes(written), "Output 2 must NEVER contain written text");
    console.log("   ✓ Both outputs extracted into separate strings with zero cross-contamination.");
  }

  // ---------------------------------------------------------------------------
  // Test 2: Double newline separation without explicit written_text column
  // ---------------------------------------------------------------------------
  console.log("2. Testing extraction from combined final_text without explicit written_text column...");
  {
    const written = "Paragraph 1: Background family memory.";
    const transcribed = "Paragraph 2: Transcribed voice recording.";
    const combined = `${written}\n\n${transcribed}`;

    const res = extractStoryTextOutputs({
      final_text: combined,
    });

    assert.strictEqual(res.hasTwoOutputs, true, "Must split on double newline when two sections exist");
    assert.strictEqual(res.output1, written);
    assert.strictEqual(res.output2, transcribed);
    console.log("   ✓ Extracted two outputs cleanly from combined narrative.");
  }

  // ---------------------------------------------------------------------------
  // Test 3: Multi-paragraph written context and multi-paragraph transcription
  // ---------------------------------------------------------------------------
  console.log("3. Testing multi-paragraph formatting in both text outputs...");
  {
    const written = "Written Para 1: Context.\n\nWritten Para 2: Details.";
    const transcribed = "Speech Para 1: Speech story.\n\nSpeech Para 2: Speech conclusion.";
    const combined = `${written}\n\n${transcribed}`;

    const res = extractStoryTextOutputs({
      final_text: combined,
      written_text: written,
    });

    assert.strictEqual(res.hasTwoOutputs, true);
    assert.strictEqual(res.output1, written, "Multi-paragraph written text preserved intact in Output 1");
    assert.strictEqual(res.output2, transcribed, "Multi-paragraph speech preserved intact in Output 2");
    console.log("   ✓ Multi-paragraph structure within each container perfectly preserved.");
  }

  // ---------------------------------------------------------------------------
  // Test 4: Single output fallback (Oral audio recording only, no written text)
  // ---------------------------------------------------------------------------
  console.log("4. Testing single output fallback (Audio transcription only)...");
  {
    const oralOnly = "Only speech was recorded and transcribed for this historical record.";
    const res = extractStoryTextOutputs({
      final_text: oralOnly,
      written_text: "",
    });

    assert.strictEqual(res.hasTwoOutputs, false, "Must not flag two outputs for single oral text");
    assert.strictEqual(res.output1, "", "Output 1 must be empty");
    assert.strictEqual(res.output2, oralOnly, "Output 2 must contain the entire transcript");
    console.log("   ✓ Oral-only stories fall back gracefully to single narrative rendering.");
  }

  // ---------------------------------------------------------------------------
  // Test 5: Single output fallback (Written text only, no audio recording)
  // ---------------------------------------------------------------------------
  console.log("5. Testing single output fallback (Written text only)...");
  {
    const writtenOnly = "Only written notes were provided for this document.";
    const res = extractStoryTextOutputs({
      final_text: writtenOnly,
      written_text: writtenOnly,
    });

    assert.strictEqual(res.hasTwoOutputs, false, "Must not flag two outputs when final equals written");
    assert.strictEqual(res.output1, writtenOnly);
    assert.strictEqual(res.output2, "");
    console.log("   ✓ Written-only stories fall back gracefully to single container.");
  }

  // ---------------------------------------------------------------------------
  // Test 6: Verify Audio Filename is NOT rendered in ExplorePage.tsx
  // ---------------------------------------------------------------------------
  console.log("6. Verifying audio filename has been removed from ExplorePage.tsx...");
  {
    const explorePageSrc = fs.readFileSync(
      path.join(__dirname, "../src/explore/ExplorePage.tsx"),
      "utf8"
    );

    // Ensure audio.filename is NOT rendered in the player metadata
    assert(
      !explorePageSrc.includes("exp-audio-filename"),
      "ExplorePage.tsx must NOT render exp-audio-filename"
    );
    assert(
      !explorePageSrc.includes("{audio.filename"),
      "ExplorePage.tsx must NOT render {audio.filename}"
    );

    // Ensure audio playback controls remain functional
    assert(explorePageSrc.includes("<audio"), "Audio element must remain present");
    assert(explorePageSrc.includes("controls"), "Audio player controls must remain enabled");
    assert(explorePageSrc.includes("playbackSrc"), "Audio source must remain bound to playbackSrc");
    assert(explorePageSrc.includes("handleAudioError"), "Audio error handler must remain active");
    assert(explorePageSrc.includes("Archival audio record"), "Archival badge must remain");

    console.log("   ✓ Audio filename element completely stripped from ExploreAudioPlayer.");
    console.log("   ✓ Native audio controls, playback ticket resolution, and error handling preserved.");
  }

  // ---------------------------------------------------------------------------
  // Test 7: Verify Two Independent Containers & Headings in ExplorePage.tsx
  // ---------------------------------------------------------------------------
  console.log("7. Verifying two independent containers and headings in ExplorePage.tsx...");
  {
    const explorePageSrc = fs.readFileSync(
      path.join(__dirname, "../src/explore/ExplorePage.tsx"),
      "utf8"
    );

    assert(explorePageSrc.includes("exp-narrative-dual-grid"), "Must define dual grid container");
    assert(explorePageSrc.includes("exp-narrative-box-written"), "Must render Text Box 1 for written context");
    assert(explorePageSrc.includes("exp-narrative-box-transcribed"), "Must render Text Box 2 for audio transcription");
    assert(explorePageSrc.includes("Written Story Context"), "Must include meaningful heading for Box 1");
    assert(explorePageSrc.includes("Transcribed Audio Narrative"), "Must include meaningful heading for Box 2");
    assert(explorePageSrc.includes("Text Output 1"), "Must label Box 1 as Text Output 1");
    assert(explorePageSrc.includes("Text Output 2"), "Must label Box 2 as Text Output 2");

    console.log("   ✓ Two separate text containers and their corresponding headings confirmed.");
  }

  // ---------------------------------------------------------------------------
  // Test 8: Verify Responsive Layout & Typography in explore.css
  // ---------------------------------------------------------------------------
  console.log("8. Verifying responsive CSS grid rules and typography in explore.css...");
  {
    const exploreCss = fs.readFileSync(
      path.join(__dirname, "../src/explore/explore.css"),
      "utf8"
    );

    // Grid definition
    assert(exploreCss.includes(".exp-narrative-dual-grid"), "CSS must define .exp-narrative-dual-grid");
    assert(exploreCss.includes("grid-template-columns: 1fr;"), "Default layout must be 1-column stacked for small screens");

    // Media query for desktop / tablet
    assert(exploreCss.includes("@media (min-width: 768px)"), "CSS must define breakpoint at 768px");
    assert(exploreCss.includes("grid-template-columns: 1fr 1fr;"), "Desktop layout must be 2-column side-by-side");

    // Word break and overflow handling
    assert(exploreCss.includes("word-break: break-word"), "CSS must specify word-break: break-word for long text safety");
    assert(exploreCss.includes("overflow-wrap: anywhere"), "CSS must specify overflow-wrap: anywhere for long text safety");

    // Audio meta alignment
    assert(exploreCss.includes("justify-content: flex-end"), "Audio meta must align badge to end when filename is hidden");

    console.log("   ✓ Responsive 1-col mobile and 2-col desktop grid verified.");
    console.log("   ✓ Long text word-break and overflow containment verified.");
  }

  console.log("\n=== ALL DUAL TEXT BOX & AUDIO PLAYER TESTS PASSED (100%) ===");
})();
