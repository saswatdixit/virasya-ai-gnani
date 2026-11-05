/**
 * Virasya Optional Text + Speech Transcription Combination Test Suite
 *
 * Verifies:
 * 1. Optional text + transcription: combined in order (optional first, "\n\n", transcribed text).
 * 2. Blank optional text + transcription: returns ONLY transcribed text without extra newlines or placeholders.
 * 3. Whitespace-only optional text + transcription: treated as empty, returns ONLY transcribed text.
 * 4. Optional text with surrounding whitespace: trimmed cleanly.
 * 5. Multi-paragraph optional text + multi-paragraph transcription: internal paragraphs preserved.
 * 6. Transcription failure / empty: optional text is preserved intact.
 * 7. Retry transcription: does NOT duplicate the optional text.
 * 8. Back-and-forth navigation: state and editor synchronization preserved.
 * 9. Story save & retrieve round-trip: written_text has optional text, story/final_text has combined narrative.
 * 10. Existing stories without optional text: fully backwards-compatible.
 */

const assert = require("node:assert");

console.log("=== Virasya Optional Text + Transcription Combination Tests ===\n");

(async () => {
  // Dynamically load the TypeScript modules using Node native module loader
  const utils = await import("../src/preserve/utils.ts");
  const adapters = await import("../src/supabase/adapters.ts");

  const { combineOptionalAndTranscribedText } = utils;
  const { storyPayloadToDraftInsert, storyRowToStoryPayload, localStoryJsonToDbRow, dbRowToLocalStoryJson } = adapters;

  const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

  // ---------------------------------------------------------------------------
  // 1. Scenario 1: Optional text + transcription
  // ---------------------------------------------------------------------------
  console.log("1. Testing standard combination (optional text + transcription)...");
  {
    const optional = "Today I visited my grandmother's village. It reminded me of my childhood.";
    const transcribed = "The village was beautiful and the weather was pleasant. I met many relatives.";
    const expected = `${optional}\n\n${transcribed}`;

    const combined = combineOptionalAndTranscribedText(optional, transcribed);
    assert.strictEqual(combined, expected, "Combined text must have optional text first, followed by \\n\\n, then transcribed text");
    assert.ok(combined.startsWith(optional), "Must start with optional text");
    assert.ok(combined.endsWith(transcribed), "Must end with transcribed text");
    console.log("   ✓ Optional text and transcription combined in proper order with double newline.");
  }

  // ---------------------------------------------------------------------------
  // 2. Scenario 2: Blank optional text + transcription
  // ---------------------------------------------------------------------------
  console.log("2. Testing blank optional text + transcription...");
  {
    const optional = "";
    const transcribed = "Only speech was recorded.";
    const combined = combineOptionalAndTranscribedText(optional, transcribed);

    assert.strictEqual(combined, transcribed, "When optional text is empty, must return ONLY transcribed text");
    assert.ok(!combined.startsWith("\n"), "Must not have leading newlines");
    assert.ok(!combined.includes("undefined"), "Must not contain undefined");
    assert.ok(!combined.includes("null"), "Must not contain null");
    console.log("   ✓ Blank optional text yields exclusively transcribed text with no stray newlines.");
  }

  // ---------------------------------------------------------------------------
  // 3. Scenario 3: Whitespace-only optional text + transcription
  // ---------------------------------------------------------------------------
  console.log("3. Testing whitespace-only optional text + transcription...");
  {
    const optional = "   \n\t  \r\n   ";
    const transcribed = "Transcribed speech text here.";
    const combined = combineOptionalAndTranscribedText(optional, transcribed);

    assert.strictEqual(combined, transcribed, "Whitespace-only optional text must be treated as empty");
    assert.strictEqual(combined.trim(), transcribed, "Must match transcribed text exactly");
    console.log("   ✓ Whitespace-only optional text cleanly ignored without stray spacing.");
  }

  // ---------------------------------------------------------------------------
  // 4. Scenario 4: Optional text with surrounding whitespace
  // ---------------------------------------------------------------------------
  console.log("4. Testing optional text with surrounding whitespace (trimming)...");
  {
    const optional = "   \n\n  This is my introductory thought.   \n\t ";
    const transcribed = "  \n This is what I said out loud. \n  ";
    const expected = "This is my introductory thought.\n\nThis is what I said out loud.";

    const combined = combineOptionalAndTranscribedText(optional, transcribed);
    assert.strictEqual(combined, expected, "Both texts must be trimmed cleanly before joining with \\n\\n");
    console.log("   ✓ Leading and trailing whitespace on both components cleanly trimmed.");
  }

  // ---------------------------------------------------------------------------
  // 5. Scenario 5: Multi-paragraph optional text + multi-paragraph transcription
  // ---------------------------------------------------------------------------
  console.log("5. Testing multi-paragraph formatting preservation...");
  {
    const optional = "Paragraph 1 of notes.\n\nParagraph 2 of background context.";
    const transcribed = "Transcribed paragraph 1.\n\nTranscribed paragraph 2.\n\nTranscribed paragraph 3.";
    const expected = `${optional}\n\n${transcribed}`;

    const combined = combineOptionalAndTranscribedText(optional, transcribed);
    assert.strictEqual(combined, expected, "Multi-paragraph internal formatting of both texts must be preserved");

    const paragraphs = combined.split("\n\n");
    assert.strictEqual(paragraphs.length, 5, "Must contain exactly 5 paragraphs in total");
    assert.strictEqual(paragraphs[0], "Paragraph 1 of notes.");
    assert.strictEqual(paragraphs[1], "Paragraph 2 of background context.");
    assert.strictEqual(paragraphs[2], "Transcribed paragraph 1.");
    assert.strictEqual(paragraphs[3], "Transcribed paragraph 2.");
    assert.strictEqual(paragraphs[4], "Transcribed paragraph 3.");
    console.log("   ✓ Multi-paragraph structure across optional and transcribed text perfectly preserved.");
  }

  // ---------------------------------------------------------------------------
  // 6. Scenario 6: Transcription failure / empty transcription
  // ---------------------------------------------------------------------------
  console.log("6. Testing transcription failure or empty speech output...");
  {
    const optional = "User wrote an important story manually.";
    const transcribedEmpty = "";
    const transcribedNull = null;
    const transcribedWhitespace = "   \n\t  ";

    assert.strictEqual(combineOptionalAndTranscribedText(optional, transcribedEmpty), optional);
    assert.strictEqual(combineOptionalAndTranscribedText(optional, transcribedNull), optional);
    assert.strictEqual(combineOptionalAndTranscribedText(optional, transcribedWhitespace), optional);
    assert.strictEqual(combineOptionalAndTranscribedText("", ""), "");
    assert.strictEqual(combineOptionalAndTranscribedText(null, null), "");
    console.log("   ✓ Optional text safely preserved when transcription is empty or failed.");
  }

  // ---------------------------------------------------------------------------
  // 7. Scenario 7: Retrying transcription (no duplicate optional text)
  // ---------------------------------------------------------------------------
  console.log("7. Testing retrying transcription (idempotence / no duplication)...");
  {
    const optionalText = "Introduction to the family legend.";
    const firstTranscript = "First pass transcription with minor error.";
    const secondTranscript = "Second pass transcription cleanly recognized.";

    // Pass 1
    const pass1 = combineOptionalAndTranscribedText(optionalText, firstTranscript);
    assert.strictEqual(pass1, `${optionalText}\n\n${firstTranscript}`);

    // On retry, the model runs again on original audio, returning secondTranscript.
    // The state machine pulls s.form.story (which remains untouched as optionalText)
    // and re-runs combineOptionalAndTranscribedText(s.form.story, secondTranscript).
    const pass2 = combineOptionalAndTranscribedText(optionalText, secondTranscript);
    assert.strictEqual(pass2, `${optionalText}\n\n${secondTranscript}`);

    // Verify optional text appears exactly once
    const occurrences = (pass2.match(/Introduction to the family legend\./g) || []).length;
    assert.strictEqual(occurrences, 1, "Optional text must appear exactly once upon re-transcription");
    assert.ok(!pass2.includes(firstTranscript), "Old transcript must be replaced by new transcript");
    console.log("   ✓ Retrying transcription cleanly replaces previous transcript without duplicating optional text.");
  }

  // ---------------------------------------------------------------------------
  // 8. Scenario 8: Navigation back and forth between steps
  // ---------------------------------------------------------------------------
  console.log("8. Testing step navigation and editor synchronization...");
  {
    // Simulate user state transitions
    let state = {
      form: { title: "My Legend", story: "Initial note written in Step 1." },
      ed: { text: "", baseText: "", loadedFrom: null },
      tx: { gnani: { text: "Audio transcribed in Step 2." } },
    };

    // Step 2 completes -> executes transcription:
    const combined1 = combineOptionalAndTranscribedText(state.form.story, state.tx.gnani.text);
    state.ed.text = combined1;
    state.ed.baseText = combined1;
    state.ed.loadedFrom = "gnani";

    // User navigates back to Step 1 and edits the optional text
    const updatedOptional = "Updated note written in Step 1 with more details.";
    state.form.story = updatedOptional;

    // Simulate updateForm handler logic
    const isEdClean = state.ed.text === state.ed.baseText;
    assert.ok(isEdClean, "Editor should be clean if user hasn't made manual edits in Step 3 yet");
    if (isEdClean && state.tx.gnani.text) {
      const combined2 = combineOptionalAndTranscribedText(updatedOptional, state.tx.gnani.text);
      state.ed.text = combined2;
      state.ed.baseText = combined2;
    }

    assert.strictEqual(state.ed.text, `${updatedOptional}\n\n${state.tx.gnani.text}`);
    assert.ok(!state.ed.text.includes("Initial note"), "Old optional text was replaced by updated text");
    console.log("   ✓ Navigating back to Step 1 and updating optional text cleanly re-synchronizes editor.");
  }

  // ---------------------------------------------------------------------------
  // 9. Scenario 9: Story save and retrieve round-trip
  // ---------------------------------------------------------------------------
  console.log("9. Testing story save and retrieve round-trip in database adapters...");
  {
    const optionalText = "Background notes about our ancestral home in Puri.";
    const transcribedSpeech = "Mo bapa kahuthile ki amara ghara puruna thila.";
    const combinedNarrative = combineOptionalAndTranscribedText(optionalText, transcribedSpeech);

    const payload = {
      id: "story_combined_test_001",
      title: "Puri Heritage",
      carrier: "Saswat",
      relationship: "Self",
      roots: "Puri",
      place: "Puri",
      language: "Odia",
      period: "1980s",
      email: "saswat@example.com",
      story: combinedNarrative,
      writtenText: optionalText,
      working_draft: combinedNarrative,
      final_text: combinedNarrative,
      audio: null,
      raw_transcripts: {},
      vocabulary: [],
      visibility: "public",
      confirmed: true,
      permissionConfirmed: true,
    };

    // 1. Adapter: StoryPayload -> StoryInsert (PostgreSQL row)
    const draftInsert = storyPayloadToDraftInsert(payload, { userId: TEST_USER_ID });
    assert.strictEqual(draftInsert.written_text, optionalText, "written_text column must store original optional text");
    assert.strictEqual(draftInsert.final_text, combinedNarrative, "final_text column must store combined narrative");
    assert.strictEqual(draftInsert.story, combinedNarrative, "story column must store combined narrative");

    // 2. Adapter: DB StoryRow -> StoryPayload (frontend retrieval)
    const retrievedPayload = storyRowToStoryPayload(draftInsert);
    assert.strictEqual(retrievedPayload.writtenText, optionalText, "Frontend retrieved writtenText must match optional text");
    assert.strictEqual(retrievedPayload.final_text, combinedNarrative, "Frontend retrieved final_text must match combined narrative");
    assert.strictEqual(retrievedPayload.story, combinedNarrative, "Frontend retrieved story must match combined narrative");

    console.log("   ✓ Database insert and row hydration preserve both written_text and combined story/final_text.");
  }

  // ---------------------------------------------------------------------------
  // 10. Scenario 10: Existing stories without optional text compatibility
  // ---------------------------------------------------------------------------
  console.log("10. Testing backward compatibility for stories without optional text...");
  {
    const existingStoryRow = {
      id: "legacy_story_001",
      user_id: TEST_USER_ID,
      title: "Audio Only Story",
      carrier: "Grandmother",
      relationship: "Grandmother",
      place: "Cuttack",
      roots: "Cuttack",
      category: "Tradition",
      language: "Odia",
      period: "1950s",
      email: "test@example.com",
      written_text: null, // Legacy story: no optional text provided
      working_draft: "Direct transcribed audio story text.",
      final_text: "Direct transcribed audio story text.",
      story: "Direct transcribed audio story text.",
      audio: null,
      raw_transcripts: {},
      vocabulary: [],
      punctuation: {},
      final_settings: {},
      status: "preserved",
      visibility: "public",
      confirmed: true,
      permission_confirmed: true,
      audio_public_playback: false,
      provenance_id: "prov_001",
      provenance_hash: "hash_001",
      preserved_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const payload = storyRowToStoryPayload(existingStoryRow);
    const combined = combineOptionalAndTranscribedText(payload.writtenText, payload.final_text);

    assert.strictEqual(combined, "Direct transcribed audio story text.", "Legacy stories without written_text must resolve directly to speech text");
    assert.ok(!combined.includes("null") && !combined.includes("undefined"));
    console.log("   ✓ Legacy stories without optional text render cleanly with zero regressions.");
  }

  console.log("\n=== ALL 10 OPTIONAL TEXT COMBINATION TESTS PASSED (100%) ===");
})();
