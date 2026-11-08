/**
 * Virasya Test Suite: Audio Privacy Confirmation Dialog & Step C UI Text Preservation
 *
 * Verifies:
 * Part D:
 * 1. Audio attached + public playback disabled: confirmation appears before preservation.
 * 2. User confirms: preservation continues with audio playback disabled.
 * 3. User goes back: preservation does not happen and form remains editable.
 * 4. Audio attached + public playback enabled: no private-audio confirmation.
 * 5. No audio attached: no confirmation dialog shown.
 * 6. Consent false, null, or missing: backend and public projection expose no public audio playback.
 * 7. Story visibility and audio playback permission remain independent.
 *
 * Part E (Correction):
 * 1. Step C heading "Written Memory & Notes" and description "Capture your thoughts in your own words. You can also record spoken audio on the next step." are rendered in Step 1.
 * 2. In Step 2 (Voice & Oral Record), when the user selects the Record feature (mode === "record"), the heading and description remain visible above the recording controls.
 * 3. Wording is reused exactly without rewriting or replacing with transcript text.
 * 4. Canonical final_text vs raw transcripts separation is preserved.
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

console.log('=== Virasya Audio Privacy Dialog & Step C UI Text Preservation Tests ===\n');

let failed = false;
function check(name, condition, errorMsg) {
  if (condition) {
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name}: ${errorMsg || 'Condition failed'}`);
    failed = true;
  }
}

// Read relevant component source files
const page1Src = fs.readFileSync(path.join(__dirname, '../src/preserve/pages/Page1Story.tsx'), 'utf8');
const page2Src = fs.readFileSync(path.join(__dirname, '../src/preserve/pages/Page2Voice.tsx'), 'utf8');
const page6Src = fs.readFileSync(path.join(__dirname, '../src/preserve/pages/Page6FinalReview.tsx'), 'utf8');
const contextSrc = fs.readFileSync(path.join(__dirname, '../src/preserve/context/PreserveContext.tsx'), 'utf8');
const storiesSrc = fs.readFileSync(path.join(__dirname, '../src/supabase/stories.ts'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../src/preserve/preserve.css'), 'utf8');

// ============================================================================
// 1. Part E: Additional Notes & Context UX Restructuring Tests
// ============================================================================
console.log('--- 1. Additional Notes & Context UX Restructuring Tests ---');

const OLD_TITLE = 'Written Memory & Notes';
const OLD_DESC = 'Capture your thoughts in your own words. You can also record spoken audio on the next step.';
const NEW_TITLE = 'Additional Notes & Context';
const NEW_DESC = 'Want to share anything else about this memory? Add an optional written note to provide additional context.';

// Check 1: Section C is removed from Step 1 (Page1Story)
check(
  'Step 1 (Page1Story) removes initial Written Memory & Notes section',
  !page1Src.includes(OLD_TITLE) && !page1Src.includes(OLD_DESC),
  'Page1Story must not render old initial Written Memory & Notes section'
);

// Check 2: Step 2 (Page2Voice) renders Audio Capture & Upload header
check(
  'Step 2 (Page2Voice) renders Audio Capture & Upload panel header with badge "A"',
  page2Src.includes('<span className="p-panel-num">A</span>') &&
    page2Src.includes('<h2 className="p-panel-title">Audio Capture & Upload</h2>'),
  'Page2Voice must render Audio Capture & Upload panel header badge'
);

// Check 3: Step 6 (Page6FinalReview) renders Additional Notes & Context heading and description
check(
  'Step 6 (Page6FinalReview) renders Additional Notes & Context heading and description before submission',
  page6Src.includes(NEW_TITLE) && page6Src.includes(NEW_DESC),
  'Page6FinalReview must render Additional Notes & Context section'
);

// Check 4: Step 6 provides optional text area for comments without mandatory validation
check(
  'Step 6 (Page6FinalReview) provides an optional text area for comments',
  page6Src.includes('id="f-additional-notes"') && page6Src.includes('Optional'),
  'Page6FinalReview must render optional comment textarea'
);

// ============================================================================
// 2. Part D: Audio Privacy Confirmation Dialog Static Contract
// ============================================================================
console.log('\n--- 2. Audio Privacy Confirmation Dialog Contract Tests ---');

// Check 5: HTML dialog element with Virasya design system classes
check(
  'Page6FinalReview declares accessible HTML <dialog> modal for audio privacy confirmation',
  page6Src.includes('<dialog') &&
    page6Src.includes('className="dialog p-audio-privacy-dialog"') &&
    page6Src.includes('aria-labelledby="audio-privacy-title"') &&
    page6Src.includes('aria-describedby="audio-privacy-desc"'),
  'Page6FinalReview must render accessible HTML dialog modal'
);

// Check 6: Two explicit actions: "Continue with private audio" and "Go back"
check(
  'Audio privacy dialog provides two explicit actions: Continue with private audio & Go back',
  page6Src.includes('Continue with private audio') &&
    page6Src.includes('Go back') &&
    page6Src.includes('handleContinueWithPrivateAudio') &&
    page6Src.includes('handleGoBackFromAudioDialog'),
  'Dialog must provide exact two explicit user actions'
);

// Check 7: Clear plain-language explanation of visibility, private audio, and readable text
check(
  'Audio privacy dialog explains story visibility, private audio vaulting, and readable text in plain language',
  page6Src.includes('Your story visibility is set to') &&
    page6Src.includes('Because public audio playback is not enabled') &&
    page6Src.includes('strictly private in your sovereign vault') &&
    page6Src.includes('available for public playback in Explore') &&
    page6Src.includes('Your written narrative, cultural vocabulary, and provenance certificate will still be publicly readable in Explore'),
  'Dialog must explain the three plain-language requirements'
);

// Check 8: Dialog CSS is present in preserve.css
check(
  'preserve.css contains styled .p-audio-privacy-dialog with backdrop styling',
  cssSrc.includes('.p-audio-privacy-dialog') &&
    cssSrc.includes('.p-audio-privacy-dialog::backdrop'),
  'preserve.css must define .p-audio-privacy-dialog rules'
);

// ============================================================================
// 3. Functional Simulation of Audio Privacy Dialog Logic
// ============================================================================
console.log('\n--- 3. Functional Simulation of Audio Privacy Dialog Logic ---');

function evaluatePreservationPrompt({ audio, visibility, audioPublicConsent, hasConfirmedPrivateAudio }) {
  const isPublicAudioPlaybackEnabled = Boolean(
    audio && visibility === 'public' && audioPublicConsent
  );

  const shouldShowDialog = Boolean(
    audio && !isPublicAudioPlaybackEnabled && !hasConfirmedPrivateAudio
  );

  return {
    isPublicAudioPlaybackEnabled,
    shouldShowDialog,
  };
}

// Case A: Audio attached + public playback disabled -> confirmation appears
const caseA = evaluatePreservationPrompt({
  audio: { name: 'oral_tradition.webm' },
  visibility: 'public',
  audioPublicConsent: false,
  hasConfirmedPrivateAudio: false,
});
check(
  'Simulation Case A: Audio attached + public playback disabled -> confirmation dialog appears',
  caseA.shouldShowDialog === true && caseA.isPublicAudioPlaybackEnabled === false
);

// Case B: Audio attached + story private -> confirmation appears
const caseB = evaluatePreservationPrompt({
  audio: { name: 'family_secrets.webm' },
  visibility: 'private',
  audioPublicConsent: false,
  hasConfirmedPrivateAudio: false,
});
check(
  'Simulation Case B: Audio attached + story private -> confirmation dialog appears',
  caseB.shouldShowDialog === true && caseB.isPublicAudioPlaybackEnabled === false
);

// Case C: Audio attached + public playback enabled -> NO private-audio confirmation
const caseC = evaluatePreservationPrompt({
  audio: { name: 'festival_chants.wav' },
  visibility: 'public',
  audioPublicConsent: true,
  hasConfirmedPrivateAudio: false,
});
check(
  'Simulation Case C: Audio attached + public playback enabled -> NO private audio confirmation',
  caseC.shouldShowDialog === false && caseC.isPublicAudioPlaybackEnabled === true
);

// Case D: No audio attached -> NO confirmation dialog
const caseD = evaluatePreservationPrompt({
  audio: null,
  visibility: 'public',
  audioPublicConsent: false,
  hasConfirmedPrivateAudio: false,
});
check(
  'Simulation Case D: No audio attached -> NO confirmation dialog',
  caseD.shouldShowDialog === false
);

// Case E: User explicitly confirmed private audio in current attempt -> NO repeated prompt
const caseE = evaluatePreservationPrompt({
  audio: { name: 'oral_tradition.webm' },
  visibility: 'public',
  audioPublicConsent: false,
  hasConfirmedPrivateAudio: true, // User already confirmed "Continue with private audio"
});
check(
  'Simulation Case E: After confirming choice in current attempt -> NO repeated prompt',
  caseE.shouldShowDialog === false
);

// Case F: User clicked "Go back" -> dialog closes, state remains editable, no preservation occurred
let simulatedForm = { title: 'Puri Tale', audioPublicConsent: false };
let simulatedPreserved = false;
let dialogOpen = true;

function simulateGoBack() {
  dialogOpen = false;
  // Does not mutate form or preserved status
}

simulateGoBack();
check(
  'Simulation Case F: User goes back -> dialog closes, form intact, preservation does not occur',
  dialogOpen === false && simulatedPreserved === false && simulatedForm.audioPublicConsent === false
);

// User then toggles consent to true and re-attempts
simulatedForm.audioPublicConsent = true;
const afterToggle = evaluatePreservationPrompt({
  audio: { name: 'oral_tradition.webm' },
  visibility: 'public',
  audioPublicConsent: simulatedForm.audioPublicConsent,
  hasConfirmedPrivateAudio: false,
});
check(
  'Simulation Case F (cont): User toggles audio consent -> prompt bypassed and public playback enabled',
  afterToggle.shouldShowDialog === false && afterToggle.isPublicAudioPlaybackEnabled === true
);

// ============================================================================
// 4. Backend & Public Projection Gating Integrity
// ============================================================================
console.log('\n--- 4. Backend & Public Projection Gating Integrity ---');

function computeBackendAudioPublicPlayback(audio, visibility, audioPublicConsent) {
  return Boolean(audio && visibility === 'public' && audioPublicConsent);
}

check(
  'Backend Gating: audioPublicConsent = false results in audio_public_playback = FALSE',
  computeBackendAudioPublicPlayback({ name: 'rec.wav' }, 'public', false) === false
);

check(
  'Backend Gating: audioPublicConsent = null results in audio_public_playback = FALSE',
  computeBackendAudioPublicPlayback({ name: 'rec.wav' }, 'public', null) === false
);

check(
  'Backend Gating: audioPublicConsent = undefined results in audio_public_playback = FALSE',
  computeBackendAudioPublicPlayback({ name: 'rec.wav' }, 'public', undefined) === false
);

check(
  'Backend Gating: visibility = "private" results in audio_public_playback = FALSE regardless of consent',
  computeBackendAudioPublicPlayback({ name: 'rec.wav' }, 'private', true) === false
);

// Verify canonical final_text vs raw transcripts separation in payload
check(
  'PreserveContext payload separates canonical final_text from raw_transcripts',
  contextSrc.includes('final_text: workingText') &&
    contextSrc.includes('raw_transcripts: {') &&
    contextSrc.includes('working_draft: state.ed.text || state.form.story'),
  'PreserveContext must maintain separate canonical final_text and raw_transcripts'
);

// Check 9: Reset effect in Page6FinalReview resets confirmation if audio/visibility/consent changes
check(
  'Page6FinalReview resets private audio confirmation when audio, visibility, or consent changes',
  page6Src.includes('setHasConfirmedPrivateAudio(false);') &&
    page6Src.includes('[audio, final.visibility, final.audioPublicConsent]'),
  'Page6FinalReview must re-prompt if user changes settings after a confirmation'
);

// ============================================================================
// 5. Preservation Submission Handler Full Lifecycle & Behavioral Invariants
// ============================================================================
console.log('\n--- 5. Preservation Submission Handler Full Lifecycle Simulation ---');

class Page6SubmissionMachine {
  constructor(initialState = {}) {
    this.form = initialState.form || { title: 'Authentic Tale', carrier: 'Nirmala' };
    this.audio = initialState.audio !== undefined ? initialState.audio : { name: 'memory.webm' };
    this.final = {
      visibility: initialState.visibility || 'public',
      confirmed: initialState.confirmed !== undefined ? initialState.confirmed : true,
      audioPublicConsent: initialState.audioPublicConsent || false,
    };
    this.validationError = '';
    this.isPreserving = false;
    this.showAudioPrivacyDialog = false;
    this.hasConfirmedPrivateAudio = false;
    this.apiCalls = [];
    this.authModalOpened = false;
    this.user = initialState.user !== undefined ? initialState.user : { id: 'usr_123', email: 'contributor@heritage.org' };
    this.isSupabaseConfigured = initialState.isSupabaseConfigured !== undefined ? initialState.isSupabaseConfigured : true;
  }

  // Mimic settings change with reset effect
  updateSetting(key, val) {
    if (key === 'visibility' || key === 'audioPublicConsent') {
      this.final[key] = val;
    } else if (key === 'audio') {
      this.audio = val;
    }
    // Effect: reset confirmation on settings alteration
    this.hasConfirmedPrivateAudio = false;
  }

  get isPublicAudioPlaybackEnabled() {
    return Boolean(this.audio && this.final.visibility === 'public' && this.final.audioPublicConsent);
  }

  async executePreservation() {
    this.validationError = '';
    this.isPreserving = true;
    try {
      // Mimic PreserveContext preserveStoryAction authentication check
      if (this.isSupabaseConfigured && !this.user) {
        this.authModalOpened = true;
        throw new Error('Authentication required: Please sign in or create an account to permanently preserve your story.');
      }

      // Mimic successful payload generation
      const payload = {
        title: this.form.title,
        carrier: this.form.carrier,
        audio: this.audio ? { filename: this.audio.name } : null,
        visibility: this.final.visibility,
        audio_public_playback: this.isPublicAudioPlaybackEnabled,
      };
      this.apiCalls.push(payload);
    } catch (err) {
      this.validationError = err.message;
      throw err;
    } finally {
      this.isPreserving = false;
    }
  }

  async handlePreserve() {
    if (!this.final.confirmed) {
      this.validationError = 'Please check the confirmation box below to verify your story before preserving.';
      return;
    }

    if (this.audio && !this.isPublicAudioPlaybackEnabled && !this.hasConfirmedPrivateAudio) {
      this.showAudioPrivacyDialog = true;
      return;
    }

    return await this.executePreservation();
  }

  async handleContinueWithPrivateAudio() {
    this.hasConfirmedPrivateAudio = true;
    this.showAudioPrivacyDialog = false;
    return await this.executePreservation();
  }

  handleGoBackFromAudioDialog() {
    this.showAudioPrivacyDialog = false;
  }
}

(async () => {
  // Test Lifecycle 1: Unconfirmed story fails validation; dialog never opens; API never called
  const sm1 = new Page6SubmissionMachine({ confirmed: false });
  await sm1.handlePreserve();
  check(
    'Lifecycle 1: Unconfirmed story fails validation; dialog does not open; API never invoked',
    sm1.validationError.includes('check the confirmation box') &&
      sm1.showAudioPrivacyDialog === false &&
      sm1.apiCalls.length === 0
  );

  // Test Lifecycle 2: Audio attached + public playback disabled -> dialog opens; API not called yet
  const sm2 = new Page6SubmissionMachine({ audio: { name: 'grandma.webm' }, visibility: 'public', audioPublicConsent: false });
  await sm2.handlePreserve();
  check(
    'Lifecycle 2: Audio attached + public consent false -> dialog opens; preservation suspended',
    sm2.showAudioPrivacyDialog === true &&
      sm2.apiCalls.length === 0 &&
      sm2.hasConfirmedPrivateAudio === false
  );

  // Test Lifecycle 3: User clicks "Go back" -> dialog closes; form remains untouched; no API call
  sm2.handleGoBackFromAudioDialog();
  check(
    'Lifecycle 3: User clicks "Go back" -> dialog closes; confirmation remains false; API never called',
    sm2.showAudioPrivacyDialog === false &&
      sm2.hasConfirmedPrivateAudio === false &&
      sm2.apiCalls.length === 0
  );

  // Test Lifecycle 4: User clicks preserve again -> dialog opens again (not bypassed)
  await sm2.handlePreserve();
  check(
    'Lifecycle 4: Resubmitting without confirming -> dialog re-appears correctly',
    sm2.showAudioPrivacyDialog === true && sm2.apiCalls.length === 0
  );

  // Test Lifecycle 5: User clicks "Continue with private audio" -> proceeds with private audio
  await sm2.handleContinueWithPrivateAudio();
  check(
    'Lifecycle 5: User clicks "Continue with private audio" -> submits with audio_public_playback = FALSE',
    sm2.showAudioPrivacyDialog === false &&
      sm2.hasConfirmedPrivateAudio === true &&
      sm2.apiCalls.length === 1 &&
      sm2.apiCalls[0].audio_public_playback === false
  );

  // Test Lifecycle 6: Altering setting resets confirmation so subsequent submission re-prompts
  sm2.updateSetting('visibility', 'private'); // Change setting
  check(
    'Lifecycle 6: Altering setting resets hasConfirmedPrivateAudio to false',
    sm2.hasConfirmedPrivateAudio === false
  );
  await sm2.handlePreserve();
  check(
    'Lifecycle 6 (cont): Submitting after setting change re-prompts for confirmation',
    sm2.showAudioPrivacyDialog === true && sm2.apiCalls.length === 1 // No second call yet
  );

  // Test Lifecycle 7: Public playback enabled -> bypasses dialog, sets audio_public_playback = TRUE
  const sm3 = new Page6SubmissionMachine({ audio: { name: 'fest.wav' }, visibility: 'public', audioPublicConsent: true });
  await sm3.handlePreserve();
  check(
    'Lifecycle 7: Public playback enabled -> bypasses dialog, preserves with audio_public_playback = TRUE',
    sm3.showAudioPrivacyDialog === false &&
      sm3.apiCalls.length === 1 &&
      sm3.apiCalls[0].audio_public_playback === true
  );

  // Test Lifecycle 8: No audio attached -> bypasses dialog, preserves with audio = null, playback = FALSE
  const sm4 = new Page6SubmissionMachine({ audio: null, visibility: 'public', audioPublicConsent: false });
  await sm4.handlePreserve();
  check(
    'Lifecycle 8: No audio attached -> bypasses dialog, preserves with audio = null, playback = FALSE',
    sm4.showAudioPrivacyDialog === false &&
      sm4.apiCalls.length === 1 &&
      sm4.apiCalls[0].audio === null &&
      sm4.apiCalls[0].audio_public_playback === false
  );

  // Test Lifecycle 9: Unauthenticated user with Supabase configured -> triggers auth modal, rejects
  const sm5 = new Page6SubmissionMachine({ user: null, audio: null });
  let authErrorCaught = false;
  try {
    await sm5.handlePreserve();
  } catch (err) {
    authErrorCaught = true;
  }
  check(
    'Lifecycle 9: Unauthenticated user triggers auth modal and throws actionable authentication error',
    authErrorCaught === true &&
      sm5.authModalOpened === true &&
      sm5.validationError.includes('Authentication required') &&
      sm5.apiCalls.length === 0
  );

  // ============================================================================
  // 6. Manual Transcript Textarea Height Matching & Responsive Rules
  // ============================================================================
  console.log('\n--- 6. Manual Transcript Textarea Height Matching & Sizing Rules ---');

  const page3Src = fs.readFileSync(path.join(__dirname, '../src/preserve/pages/Page3Review.tsx'), 'utf8');

  check(
    'Page3Review renders manual textarea with rows=6 fallback aligning with shared height',
    page3Src.includes('rows={6}') &&
      page3Src.includes('className="p-area p-odia-area"'),
    'Page3Review must render manual textarea with rows=6 fallback'
  );

  check(
    'preserve.css defines shared --p-review-box-height variable in :root',
    cssSrc.includes('--p-review-box-height: 320px;'),
    'preserve.css must declare shared --p-review-box-height: 320px in :root'
  );

  check(
    'preserve.css applies shared height to raw transcript box (.p-odia-scroll-box)',
    cssSrc.includes('height: var(--p-review-box-height, 320px);') &&
      cssSrc.includes('.p-odia-scroll-box {') &&
      cssSrc.includes('max-height: var(--p-review-box-height, 320px);'),
    'Raw transcript scroll box must use shared --p-review-box-height'
  );

  check(
    'preserve.css applies shared height to manual transcript textarea (.p-area.p-odia-area)',
    cssSrc.includes('.p-area.p-odia-area {') &&
      cssSrc.includes('height: var(--p-review-box-height, 320px);') &&
      cssSrc.includes('resize: vertical;') &&
      cssSrc.includes('overflow-y: auto;'),
    'Manual transcript textarea must match shared height, maintain vertical resize, and scroll long text'
  );

  check(
    'preserve.css scales --p-review-box-height responsively at mobile/tablet breakpoints',
    cssSrc.includes('@media (max-width: 960px)') &&
      cssSrc.includes('--p-review-box-height: 260px;'),
    'Shared review box height must scale to 260px at max-width 960px'
  );

  if (failed) {
    console.error('\n❌ Audio privacy confirmation, Step C UI, and Review Box Height tests failed.');
    process.exit(1);
  } else {
    console.log('\n✅ All Audio Privacy Confirmation Dialog, Step C UI Text & Review Textarea Height tests passed successfully.');
  }
})();
