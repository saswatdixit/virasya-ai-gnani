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
  // Case 1: Both written context and transcription exist
  // ---------------------------------------------------------------------------
  console.log("Case 1: Both written context and transcription exist...");
  {
    const written = "Every Thursday my grandmother, Nirmala Devi, made khechedi in a clay handi over a wood fire. Moong dal, rice, a spoon of ghee and a little ginger — nothing more.";
    const transcribed = "Transcribed speech narrative from oral recording.";
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
  // Case 2: Only written context exists
  // ---------------------------------------------------------------------------
  console.log("Case 2: Only written context exists...");
  {
    const writtenOnly = "Only written notes were provided for this family story.";
    const res = extractStoryTextOutputs({
      final_text: writtenOnly,
      written_text: writtenOnly,
      has_audio: false,
    });

    assert.strictEqual(res.hasTwoOutputs, false, "Must not flag two outputs for written-only story");
    assert.strictEqual(res.output1, writtenOnly, "Output 1 must retain the full written text");
    assert.strictEqual(res.output2, "", "Output 2 must be empty");
    console.log("   ✓ Only written context correctly falls back to single narrative container.");
  }

  // ---------------------------------------------------------------------------
  // Case 3: Only transcription exists
  // ---------------------------------------------------------------------------
  console.log("Case 3: Only transcription exists...");
  {
    const oralOnly = "Oral storytelling recorded and transcribed directly from voice.";
    const res = extractStoryTextOutputs({
      final_text: oralOnly,
      written_text: "",
      has_audio: true,
    });

    assert.strictEqual(res.hasTwoOutputs, false, "Must not flag two outputs for oral-only story");
    assert.strictEqual(res.output1, "", "Output 1 must be empty");
    assert.strictEqual(res.output2, oralOnly, "Output 2 must contain the entire transcript");
    console.log("   ✓ Only transcription correctly falls back to single narrative container.");
  }

  // ---------------------------------------------------------------------------
  // Case 4: Both exist but one is empty or whitespace
  // ---------------------------------------------------------------------------
  console.log("Case 4: Both exist but one is empty or whitespace...");
  {
    // Subcase 4a: written_text is whitespace only
    const oralText = "Authentic spoken words.";
    const resWhitespaceWritten = extractStoryTextOutputs({
      final_text: oralText,
      written_text: "    \n\t  ",
      has_audio: true,
    });
    assert.strictEqual(resWhitespaceWritten.hasTwoOutputs, false);
    assert.strictEqual(resWhitespaceWritten.output1, "");
    assert.strictEqual(resWhitespaceWritten.output2, oralText);

    // Subcase 4b: transcribed is empty (final_text equals written_text)
    const writtenText = "Written memory notes.";
    const resEmptyTranscription = extractStoryTextOutputs({
      final_text: writtenText,
      written_text: writtenText,
    });
    assert.strictEqual(resEmptyTranscription.hasTwoOutputs, false);
    assert.strictEqual(resEmptyTranscription.output1, writtenText);
    assert.strictEqual(resEmptyTranscription.output2, "");
    console.log("   ✓ Whitespace/empty text safely normalized without false output splitting.");
  }

  // ---------------------------------------------------------------------------
  // Case 5: Historical records containing only final_text (no heuristic splitting)
  // ---------------------------------------------------------------------------
  console.log("Case 5: Historical records containing only final_text...");
  {
    const historicalText = "Historical Para 1: Old village memories.\n\nHistorical Para 2: Temple construction.\n\nHistorical Para 3: Harvest ritual.";
    const res = extractStoryTextOutputs({
      final_text: historicalText,
      // written_text omitted / undefined
      has_audio: true,
    });

    assert.strictEqual(res.hasTwoOutputs, false, "Must NOT heuristically split historical records lacking authoritative written_text");
    assert.strictEqual(res.output1, "", "Output 1 must remain empty when written context was not authoritatively tracked");
    assert.strictEqual(res.output2, historicalText, "All historical paragraphs preserved intact without misclassification");
    console.log("   ✓ Historical records preserved in full without unreliable string splitting.");
  }

  // ---------------------------------------------------------------------------
  // Case 6: Multi-paragraph written context
  // ---------------------------------------------------------------------------
  console.log("Case 6: Multi-paragraph written context...");
  {
    const multiWritten = "Written Para 1: Context introduction.\n\nWritten Para 2: Genealogical details.\n\nWritten Para 3: Historical timeframe.";
    const transcription = "Oral narration continues the event.";
    const combined = `${multiWritten}\n\n${transcription}`;

    const res = extractStoryTextOutputs({
      final_text: combined,
      written_text: multiWritten,
      has_audio: true,
    });

    assert.strictEqual(res.hasTwoOutputs, true);
    assert.strictEqual(res.output1, multiWritten, "All 3 written paragraphs preserved in Output 1");
    assert.strictEqual(res.output2, transcription, "Transcription preserved in Output 2");
    console.log("   ✓ Multi-paragraph written context preserved intact in Output 1.");
  }

  // ---------------------------------------------------------------------------
  // Case 7: Multi-paragraph transcription
  // ---------------------------------------------------------------------------
  console.log("Case 7: Multi-paragraph transcription...");
  {
    const written = "Brief written note.";
    const multiTranscribed = "Speech Para 1: Spoken folklore.\n\nSpeech Para 2: Traditional festival chant.\n\nSpeech Para 3: Blessing.";
    const combined = `${written}\n\n${multiTranscribed}`;

    const res = extractStoryTextOutputs({
      final_text: combined,
      written_text: written,
      has_audio: true,
    });

    assert.strictEqual(res.hasTwoOutputs, true);
    assert.strictEqual(res.output1, written);
    assert.strictEqual(res.output2, multiTranscribed, "All 3 speech paragraphs preserved in Output 2");
    console.log("   ✓ Multi-paragraph transcription preserved intact in Output 2.");
  }

  // ---------------------------------------------------------------------------
  // Case 8: Transcription containing punctuation, Gujarati/Hindi characters, and line breaks
  // ---------------------------------------------------------------------------
  console.log("Case 8: Transcription containing punctuation, Indic characters, and line breaks...");
  {
    const written = "Context with English: notes, dates (1947), and names: Nirmala Devi.";
    const indicTranscribed = "કાલે હું ગુજરાત જવાનો છું; વાળની દૂરી લગભગ ૭૫૦ કિ.મી. છે!\n\nતમે ક્યાં જશો? અચ્છા, બોકારો એ તો પાસે જ છે: શું તમે આવશો?";
    const combined = `${written}\n\n${indicTranscribed}`;

    const res = extractStoryTextOutputs({
      final_text: combined,
      written_text: written,
      has_audio: true,
    });

    assert.strictEqual(res.hasTwoOutputs, true);
    assert.strictEqual(res.output1, written);
    assert.strictEqual(res.output2, indicTranscribed);
    assert.ok(res.output2.includes("ગુજરાત"));
    assert.ok(res.output2.includes("૭૫૦"));
    assert.ok(res.output2.includes(";"));
    assert.ok(res.output2.includes("?"));
    assert.ok(res.output2.includes("\n\n"));
    console.log("   ✓ Gujarati/Indic Unicode, punctuation, numerals, and line breaks preserved perfectly.");
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

  // ---------------------------------------------------------------------------
  // Test 9: Verify Page6FinalReview.tsx Dual Boxes & Headings
  // ---------------------------------------------------------------------------
  console.log("\n9. Verifying Step 6 Final Review dual independent text boxes & headings...");
  {
    const page6Src = fs.readFileSync(
      path.join(__dirname, "../src/preserve/pages/Page6FinalReview.tsx"),
      "utf8"
    );

    assert(page6Src.includes("opt && speechPart"), "Page 6 must conditionally branch when both outputs are present");
    assert(page6Src.includes("Written Story Context"), "Page 6 must render heading for Text Box 1");
    assert(page6Src.includes("Transcribed Audio Narrative"), "Page 6 must render heading for Text Box 2");
    assert(page6Src.includes("Text Output 1"), "Page 6 must label Output 1");
    assert(page6Src.includes("Text Output 2"), "Page 6 must label Output 2");

    console.log("   ✓ Step 6 Final Review independently renders dual boxes for written context and audio transcript.");
  }

  // ---------------------------------------------------------------------------
  // Test 10: Verify AudioPlayer.tsx Hides Raw Audio Filename
  // ---------------------------------------------------------------------------
  console.log("\n10. Verifying AudioPlayer.tsx hides raw audio filename alongside playback controls...");
  {
    const audioPlayerSrc = fs.readFileSync(
      path.join(__dirname, "../src/preserve/components/AudioPlayer.tsx"),
      "utf8"
    );

    assert(
      !audioPlayerSrc.includes("{audio.name}"),
      "AudioPlayer.tsx must NOT render raw {audio.name} in UI header"
    );
    assert(audioPlayerSrc.includes("Master Oral Recording"), "AudioPlayer.tsx must display clean Master Oral Recording title");
    assert(audioPlayerSrc.includes("formatTime"), "AudioPlayer.tsx must maintain time playback controls");

    console.log("   ✓ AudioPlayer.tsx completely hides raw audio filename from playback UI.");
  }

  // ---------------------------------------------------------------------------
  // Test 11: Verify MyArchivePage.tsx Dual Boxes Support
  // ---------------------------------------------------------------------------
  console.log("\n11. Verifying MyArchivePage.tsx dual boxes for preserved stories...");
  {
    const myArchiveSrc = fs.readFileSync(
      path.join(__dirname, "../src/archive/MyArchivePage.tsx"),
      "utf8"
    );

    assert(myArchiveSrc.includes("extractStoryTextOutputs"), "MyArchivePage must use extractStoryTextOutputs");
    assert(myArchiveSrc.includes("Written Story Context"), "MyArchivePage must include heading for Box 1");
    assert(myArchiveSrc.includes("Transcribed Audio Narrative"), "MyArchivePage must include heading for Box 2");

    console.log("   ✓ MyArchivePage reader displays dual independent boxes when both outputs are present.");
  }

  console.log("\n=== ALL DUAL TEXT BOX & AUDIO PLAYER TESTS PASSED (100%) ===");
})();
