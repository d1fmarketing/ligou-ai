# Voice onboarding acceptance in the Codex in-app browser

RJ requires trying all available options in Codex's own in-app browser first.
He subsequently authorized Edge only as a last resort after those options are
exhausted. Use a separate test session in that case, preserving his personal
tabs and windows; do not reuse the disabled native launch/cleanup helpers.
All browser actions belong in `cua_repl`, using the selected test tab and its
documented CDP/file-input capabilities. There is no external CDP launcher.

The former `openRealBrowser()` entrypoint now fails immediately with
`native_browser_execution_disabled_use_codex_in_app`. Native panel tests are
explicitly skipped. `self-test --browser-smoke` reports the browser checks as
`SKIPPED`, with `browserAudioVerified: false`; it does not turn those checks into
PASS. Earlier native-browser evidence remains historical evidence only.

## Export the existing observer and local owner audio manifest

This command only reads the existing prepared fixture and writes local files:

```sh
/Users/d1f/.local/bin/node scripts/voice-onboarding-audio-acceptance.mjs export-in-app --origin https://client-nine-taupe-24.vercel.app
```

The default output directory is
`output/voice-onboarding-20260906/audio-acceptance/in-app/`:

- `observer.js`: origin-scoped page observer and synthetic owner-input driver.
- `owner-audio-manifest.json`: all 114 prepared questions, existing special
  scenarios, and the 70 local owner WAV paths, durations, and SHA-256 hashes.

The export contains no access token, refresh token, provider credential, SDP,
authentication shortcut, new production route, or uploaded fixture. Authenticate
the controlled test account through the separately authorized account procedure.
Verify its actual owner, tenant, generation, selected source, and budget before
creating a call. Exporting a script is not browser or audio acceptance.

Pure/module exports in `scripts/voice-onboarding-audio-acceptance.mjs`:

```js
buildBrowserHarnessSource({ origin, isolatedTestOnly: true, recordTestAudio: true })
buildOwnerFileManifest(preparedAnswerPlan, absoluteAudioDirectory)
validateOwnerAudioFile(file, clip) // verifies file name, WAV header and exact hash
writeInAppHarnessArtifacts({ origin, output }) // optional output; local files only
installBrowserHarness(settings, validateOwnerAudioFile) // page function
```

`buildBrowserHarnessSource` includes its verifier, is safe to install more than
once in the same document, and does nothing on a different origin. Install it
before clicking Start, so it can observe creation of the actual session peer and
audio element. For a reload/cold application run, install it using the selected
in-app tab's `Page.addScriptToEvaluateOnNewDocument` capability before navigation.
Also evaluate it in the current document if that document already loaded.

If the source is transferred through a file input, select the local `observer.js`
using the in-app file chooser or documented CDP `DOM.setFileInputFiles`. Read that
selected `File` with `File.text()` inside the page and pass the resulting source
to the same in-app CDP session. Do not add a production script route or upload the
source to a remote server. Browser automation remains inside `cua_repl`.

## Supply owner WAV files without base64 tool transfers

After the observer is installed, invoke these through the in-app tab:

```js
window.__voiceAcceptance.prepareOwnerFileInput()
// => { selector: '#ligou-owner-audio-files', selectedFiles: 0 }
```

Set that input's files to the exported `owner-audio-manifest.json` and all WAV
`absolutePath` values in its `clips` array. The input is multiple-file and local;
it has no form action, upload handler, or network request. Then call:

```js
await window.__voiceAcceptance.loadOwnerAudioFiles()
// => { loaded: 70, itemCount: 114, fixtureHash: '...' }

await window.__voiceAcceptance.playWavFile(clipId)
// During the specifically planned interruption only:
await window.__voiceAcceptance.playWavFile(correctionClipId, true)
```

The driver checks the exact local bytes and decoded duration. It sends only the
owner's prerecorded/synthesized audio through the real Web Audio microphone
input path. The application microphone gate and turn state must permit the clip;
the driver does not override either. It never injects owner transcripts, tools,
approval messages, or generated agent audio.

The existing `matchQuestion(plan, selectedSpeech)` export maps the selected
authoritative question to its prepared clip. Preserve the normal, varied-answer,
correction/off-scope, and recoverable-failure/resume scenarios and existing caps.
`window.__voiceAcceptance.armFault()` arms the existing one-time browser-scoped
speech-read failure; use it only in the authorized recovery scenario.

## Collect real streamed output

```js
window.__voiceAcceptance.drain()
```

This returns redacted timings, selected action/dispatch/response identities,
headers and provider output shape, UI/input state, and recording metadata. It
omits recording base64 by default. Each actual remote recording remains available
for a local download link:

```js
window.__voiceAcceptance.recordingLink('output-0001.webm')
// => { selector, filename, bytes, sha256 }
```

Click that returned link using `cua_repl` and retain the downloaded local file.
Creating the link does not click it or close a browser. Verify downloaded size
and SHA-256 against the returned metadata before local waveform/Whisper analysis.
The older explicit `drain({ includeRecordingBytes: true })` exists for bounded
programmatic artifact collection; it is unnecessary for file-based collection.

The recording observes the actual remote WebRTC track on a separate branch that
follows the real output element's mute/volume state. It does not change the
speaker route. Capture starts before the response's audio onset and is divided
by response identity. A valid complete rendition joins successful generation,
matching server buffer stop, actual nonzero unmuted media, and bounded local tail
drain. Cleared, cancelled, interrupted, muted, and superseded recordings cannot
qualify as a completely played recap.

Use the rendered Stop control and verify the actual provider and budget outcome.
`window.__voiceAcceptance.cleanup()` releases this test document's synthetic
inputs, observation resources, and peer connections; it is not a server hangup
receipt. Do not call it instead of the audited Stop/settlement process. It does
not quit a browser. Download recordings and save drain results before disposing
the test document.

## Terminal-only checks

These do not launch a native browser:

```sh
/Users/d1f/.local/bin/node --check scripts/voice-onboarding-audio-acceptance.mjs
/Users/d1f/.local/bin/node --test dashboard/tests/voice-in-app-harness.test.mjs dashboard/tests/website-stream.test.mjs dashboard/tests/website-stream-session.test.mjs
/Users/d1f/.local/bin/node scripts/voice-onboarding-audio-acceptance.mjs self-test
```

The page file-input integration has syntax and unit coverage. It still requires
actual in-app browser verification. No new real-provider audio acceptance or
human acceptance is implied by these checks.
