# Mobile App Improvements

Distilled from [Omnara](https://github.com/omnara-ai/omnara) (YC-backed) and [WhisperCode](https://github.com/DNGriffin/whispercode).

---

## From Omnara

### 1. Voice Input for Agent Interaction

Omnara uses `expo-speech-recognition` for dictating responses to agents. Our `MessageInput` is text-only. Adding voice input lets users respond to agents hands-free — especially valuable since the app's core use case is "walk away, get notified, respond."

**Implementation Details:**

- Install `expo-speech-recognition` (Omnara's approach) or use `expo-av` + a speech API
- Add a microphone icon button next to the send button in `MessageInput`
- On press, start recording and show a visual indicator (pulsing mic icon, waveform)
- On release or stop, transcribe and insert text into the input field
- User can edit the transcription before sending
- Request microphone permission on first use via `expo-permissions`

**Files to modify:**
- `src/screens/SessionDetailScreen.tsx` — add mic button to the message input bar
- Create `src/hooks/useVoiceInput.ts` — encapsulate recording, transcription, and state
- `app.json` — add `expo-speech-recognition` plugin config and microphone usage description

**User-facing feedback:**
- Mic button toggles between idle (gray) and recording (red pulsing)
- "Listening..." overlay while recording
- "Processing..." state while transcribing
- Toast on error ("Microphone permission denied" / "Speech recognition failed")
- Transcribed text appears in input field for review before sending

---

### 2. Real-time Streaming (SSE/WebSocket) Instead of Polling

The app polls every 5 seconds via `useSessions()` and `useSession()`. Omnara uses `react-native-sse` for server-sent events. Switching to SSE or WebSocket for session updates would give instant state changes, reduce battery drain, and eliminate the 0-5 second lag.

**Implementation Details:**

- Install `react-native-sse` or use the existing WebSocket infrastructure (already used for terminal)
- Backend needs a new SSE endpoint: `GET /api/sessions/stream` that emits events on state changes
- Event types: `session:updated`, `session:created`, `session:deleted`, `attention:changed`
- Fall back to polling if SSE connection drops (exponential backoff reconnect)
- Maintain a single SSE connection per app instance, fan out updates to hooks

**Files to modify:**
- `src/hooks/useSessions.ts` — replace `setInterval` polling with SSE listener, keep polling as fallback
- `src/hooks/useSession.ts` — subscribe to filtered SSE events for a specific session ID
- `src/contexts/BackendContext.tsx` — manage SSE connection lifecycle (connect on foreground, disconnect on background)
- Backend: add SSE endpoint in the web package's API routes

**User-facing feedback:**
- Session cards update instantly when agent state changes (no more 5-second delay)
- Connection status indicator in header: green dot = live streaming, yellow = reconnecting, red = disconnected (polling fallback)
- Reduced battery usage (no constant HTTP requests)

---

### 3. Rich Message/Chat History

Omnara has a full chat interface with message history (agent messages, user responses, progress logs). Our SessionDetail only shows current state + a single input bar. Adding a scrollable message thread showing the agent's progress logs, questions asked, and user responses would give much better context when responding.

**Implementation Details:**

- Backend needs a new endpoint: `GET /api/sessions/{id}/messages` returning a list of timestamped messages
- Each message has: `id`, `sender` (agent/user/system), `content`, `timestamp`, `type` (progress/question/response/error)
- Use a `FlatList` with `inverted` prop for chat-style rendering (newest at bottom)
- Agent messages rendered with markdown (see improvement #15)
- User messages styled differently (right-aligned, different background)
- System messages (CI status changes, PR events) as centered info cards
- Auto-scroll to bottom on new messages

**Files to modify:**
- `src/screens/SessionDetailScreen.tsx` — replace the static info sections above the input bar with a chat-style `FlatList`
- Create `src/components/MessageBubble.tsx` — renders a single message with sender avatar, timestamp, and content
- Create `src/components/SystemEvent.tsx` — renders system events (CI fail, PR merged) as info cards
- `src/hooks/useSession.ts` — add `messages` to the fetched session data
- `src/contexts/BackendContext.tsx` — add `fetchMessages(sessionId)` API method

**User-facing feedback:**
- Chat thread loads with a spinner, then shows full history
- New messages appear at the bottom with a subtle slide-in animation
- "New messages" pill appears if user has scrolled up when new messages arrive
- Timestamps shown as relative ("2m ago") with full date on tap
- Pull-to-load-more for older messages (pagination)

---

### 4. Multi-channel Remote Push Notifications

Our notifications are all **local** (triggered by polling/background task every 15 min). Omnara uses server-side push (Expo Push + Twilio SMS + SendGrid email). With local-only notifications, if the app is killed or the background task doesn't fire, alerts are missed. Server-side push via Expo Push Notifications would be far more reliable.

**Implementation Details:**

- Use `expo-notifications` `getExpoPushTokenAsync()` to get the device's push token
- Send the push token to the backend on app launch: `POST /api/devices/register { pushToken, platform }`
- Backend stores push tokens and sends push notifications via Expo Push API when agent attention changes
- Keep local notifications as fallback for when backend push isn't configured
- Add notification preferences screen: toggle per-type (respond/merge/review), quiet hours

**Files to modify:**
- `src/utils/notifications.ts` — add `registerForPushNotifications()` that gets Expo push token and sends to backend
- `App.tsx` — call registration on mount after permissions granted
- `src/contexts/BackendContext.tsx` — add `registerDevice(pushToken)` and `unregisterDevice()` API methods
- Create `src/screens/NotificationSettingsScreen.tsx` — toggles for notification types, quiet hours
- Backend: add push notification service using `expo-server-sdk` (Node.js), endpoints for device registration

**User-facing feedback:**
- Permission prompt on first launch: "Allow notifications to know when agents need your input"
- Settings screen shows notification status: "Push notifications: Active" (green) or "Not configured" (yellow)
- Per-type toggles: "Agent needs response" (on/off), "PR ready to merge" (on/off), "Review needed" (on/off)
- Quiet hours picker (e.g., 10 PM - 8 AM)
- Test notification button in settings (already exists in dev mode, extend to production)

---

### 5. Session Sharing / Team View

Omnara lets users share agent instances with teammates at read/write access levels. Our app is single-user. Adding shareable session links or a team workspace view would help teams coordinate on parallel agent work.

**Implementation Details:**

- Generate shareable URLs: `ao://session/{sessionId}?token={shareToken}`
- Share tokens scoped to read-only or read-write access
- Use `expo-sharing` or React Native Share API to send links
- Receiving user opens the link, app deep-links to session detail
- Backend: `POST /api/sessions/{id}/share` creates a share token, `GET /api/sessions/{id}?token={shareToken}` allows access

**Files to modify:**
- `src/screens/SessionDetailScreen.tsx` — add "Share" button in the header
- Create `src/utils/deepLinking.ts` — handle `ao://` URL scheme for incoming shared links
- `app.json` — configure URL scheme (`ao://`)
- `src/contexts/BackendContext.tsx` — add `shareSession(id, accessLevel)` API method
- Backend: share token generation, validation, and scoped access endpoints

**User-facing feedback:**
- Share button opens native share sheet with a link
- Shared session shows a banner: "Shared by {name} (read-only)" or "(read-write)"
- Access denied screen if token is invalid or expired
- Session owner can revoke shares from session detail

---

### 6. Subscription/Billing (RevenueCat)

Omnara uses `react-native-purchases` (RevenueCat) for in-app subscriptions with free/pro/enterprise tiers. If monetization is planned, this is a proven pattern for React Native.

**Implementation Details:**

- Install `react-native-purchases`
- Configure RevenueCat project with App Store Connect and Google Play Console
- Define offerings: Free (limited sessions), Pro (unlimited), Enterprise (team features)
- Initialize RevenueCat SDK on app launch with API key
- Gate features behind entitlement checks

**Files to modify:**
- Create `src/contexts/PurchaseContext.tsx` — RevenueCat initialization, entitlement state, purchase methods
- Create `src/screens/SubscriptionScreen.tsx` — plan comparison, purchase buttons, restore purchases
- `src/screens/SettingsScreen.tsx` — add subscription status and "Manage Plan" link
- `app.json` — add `react-native-purchases` plugin config

**User-facing feedback:**
- Free tier shows usage limits: "3 of 10 sessions used this month"
- Upgrade prompt when hitting limits with feature comparison
- Purchase confirmation with Apple/Google native payment sheet
- "Restore Purchases" button for re-installing users
- Subscription status in settings: "Pro Plan (renews Mar 15)"

---

### 7. Agent Instance Metrics

Omnara's dashboard shows chat length, message counts, and session duration. Our `StatBar` only shows counts (total, working, PRs, review). Adding per-session metrics like runtime duration, message count, and token usage would help users gauge agent productivity.

**Implementation Details:**

- Backend adds metrics to session response: `duration`, `messageCount`, `tokenUsage`, `filesChanged`
- Display metrics as a horizontal row of stat pills on SessionDetailScreen
- Add a summary metrics section to HomeScreen (total runtime, total tokens, success rate)

**Files to modify:**
- `src/screens/SessionDetailScreen.tsx` — add metrics row below the session header
- `src/components/SessionCard.tsx` — show duration and message count in the footer
- `src/components/StatBar.tsx` — add new stat items (total runtime, tokens used)
- `src/types.ts` — extend `DashboardSession` type with metrics fields

**User-facing feedback:**
- Session card footer shows: "42m | 15 msgs | +12 files"
- Session detail shows expandable metrics section with: runtime, message count, files changed, token usage (if available)
- StatBar on Home adds: "12.5h total runtime" stat

---

## From WhisperCode

### 8. On-Device Speech-to-Text (WhisperKit)

WhisperCode uses on-device WhisperKit for privacy-preserving voice input — no audio leaves the device. If voice input is added, an on-device approach is worth considering for privacy-sensitive users (iOS 18+ only, with SFSpeechRecognizer fallback).

**Implementation Details:**

- This is iOS-only and requires a native module (Swift)
- Use WhisperKit framework with the `openai_whisper-tiny.en` model (~40MB)
- Preload the model in the background on app launch
- Capture audio via AVAudioEngine, resample to 16kHz
- Fall back to Apple SFSpeechRecognizer on iOS < 18
- For cross-platform, use `expo-speech-recognition` (improvement #1) as the primary approach and WhisperKit as an optional iOS enhancement

**Files to modify:**
- Create `ios/WhisperManager.swift` — native module wrapping WhisperKit
- Create `src/native/WhisperBridge.ts` — React Native bridge to the Swift module
- `src/hooks/useVoiceInput.ts` — detect platform and iOS version, choose WhisperKit or fallback
- `app.json` / `eas.json` — add native module config for iOS builds

**User-facing feedback:**
- Same as improvement #1, but with a "On-device" badge in settings indicating audio stays local
- Model download progress indicator on first use (~40MB)
- Settings toggle: "Use on-device transcription (more private, iOS 18+)"

---

### 9. Guided Onboarding Wizard

WhisperCode has a 3-step onboarding (Welcome -> Install -> Connect) with progress indicators and live health checks. Our app drops users into a broken Home screen if the backend URL isn't configured, then they have to find Settings. A proper onboarding flow on first launch would dramatically improve the first-run experience.

**Implementation Details:**

- Check `AsyncStorage` for `@ao_onboarding_complete` flag on app launch
- If not set, navigate to onboarding flow instead of Home
- Step 1 — Welcome: Explain what AO is, show logo/branding
- Step 2 — Setup: Choose connection method (Tailscale / Local Wi-Fi / ngrok / Manual URL)
- Step 3 — Connect: Enter URL (or auto-discover, see #10), live health check with green/red indicator
- Step 4 — Done: Success screen, navigate to Home
- Progress bar at top showing current step (1/4, 2/4, etc.)
- Back/Next navigation, skip option for advanced users

**Files to modify:**
- Create `src/screens/onboarding/WelcomeScreen.tsx`
- Create `src/screens/onboarding/SetupMethodScreen.tsx`
- Create `src/screens/onboarding/ConnectScreen.tsx` — URL input + health check + auto-discovery
- Create `src/screens/onboarding/DoneScreen.tsx`
- `App.tsx` — check onboarding flag, conditionally render onboarding or main navigator
- `src/navigation/types.ts` — add onboarding screen types to navigation params

**User-facing feedback:**
- Step indicator at top: "Step 2 of 4" with progress dots
- Connection method cards with icons and short descriptions
- Live URL health check: spinner while checking, green checkmark on success, red X on failure with error message
- "Skip" link for users who know what they're doing
- Animated transitions between steps
- "All set!" success screen with confetti or checkmark animation

---

### 10. Automatic Server/Network Discovery

WhisperCode scans the local subnet to auto-discover running servers. Our Settings screen requires manual URL entry with 3 collapsible guide sections (Tailscale, Wi-Fi, ngrok). Auto-scanning the LAN for a running AO dashboard (using mDNS/Bonjour or TCP probing) would simplify setup significantly.

**Implementation Details:**

- Get device's local IP via `react-native-network-info` or `expo-network`
- Derive subnet (e.g., 192.168.1.0/24)
- Probe common ports (3000, 14800) across subnet using fetch with short timeout (500ms)
- Verify by hitting `/api/sessions` or a dedicated `/health` endpoint
- Batch concurrent probes (50 at a time, like WhisperCode) to avoid overwhelming the network
- Use a generation counter to cancel stale scans
- Alternative: implement mDNS/Bonjour discovery if the backend advertises via `_ao._tcp`

**Files to modify:**
- Create `src/utils/networkDiscovery.ts` — subnet scanning logic with batched probes
- `src/screens/onboarding/ConnectScreen.tsx` — "Scan network" button with results list
- `src/screens/SettingsScreen.tsx` — add "Auto-discover" button below URL input

**User-facing feedback:**
- "Scanning network..." with a progress indicator and count (e.g., "Checking 142/254 hosts...")
- Found servers appear in a list with IP, port, and response time
- Tap a discovered server to auto-fill the URL field
- "No servers found" message with tips (is the dashboard running? same network?)
- Cancel button to stop scan early

---

### 11. Live Health Indicators

WhisperCode shows green/red dots with real-time connectivity status next to server URLs. Our app only shows connection state when it fails. Adding a persistent connection status indicator (header bar or settings) and per-service health dots (API, WebSocket, orchestrator) would build user confidence.

**Implementation Details:**

- Ping `/health` (or `/api/sessions`) on a 30-second interval
- Track connection state: `connected`, `connecting`, `disconnected`, `error`
- Show a small colored dot in the Home screen header (right side, next to settings)
- On Settings screen, show per-service health: API (HTTP), Terminal (WebSocket), Orchestrator (process running)
- Tap the dot for a tooltip/popover with details

**Files to modify:**
- Create `src/hooks/useHealthCheck.ts` — periodic health ping, returns status enum
- `src/screens/HomeScreen.tsx` — add health dot to header right
- `src/screens/SettingsScreen.tsx` — add health status section showing API/WS/Orchestrator status
- Create `src/components/HealthDot.tsx` — reusable colored dot component (green/yellow/red with optional pulse animation)

**User-facing feedback:**
- Header dot: green = connected, yellow with pulse = reconnecting, red = disconnected
- Tapping the dot shows a popover: "Connected to 192.168.1.100:3000 (45ms)"
- Settings shows detailed breakdown:
  - "Dashboard API: Connected (45ms)" (green dot)
  - "Terminal WebSocket: Connected" (green dot)
  - "Orchestrator: Running (12 sessions)" (green dot)
- On disconnect, a banner slides down from the top: "Connection lost. Retrying..."

---

### 12. Custom Keyboard Toolbar

WhisperCode injects a native keyboard toolbar with arrow keys, newline, and dismiss buttons — critical for coding on mobile. Our `MessageInput` is a plain TextInput. A toolbar with common coding shortcuts (backticks, braces, arrows, tab) would make sending code snippets to agents much easier.

**Implementation Details:**

- Create a custom `InputAccessoryView` (React Native built-in) or use `@flyerhq/react-native-keyboard-accessory`
- Toolbar buttons: `` ` `` (backtick), `{ }`, `( )`, `[ ]`, tab, up/down arrows, dismiss keyboard
- Each button inserts the character at the cursor position or wraps selected text
- Toolbar slides up with the keyboard, positioned directly above it

**Files to modify:**
- Create `src/components/CodeToolbar.tsx` — horizontal ScrollView with toolbar buttons
- `src/screens/SessionDetailScreen.tsx` — wrap `MessageInput` with `InputAccessoryView` containing `CodeToolbar`
- Optionally: `src/screens/SpawnSessionScreen.tsx` — same toolbar for the project/issue ID inputs

**User-facing feedback:**
- Toolbar appears automatically when keyboard opens on message input
- Buttons are evenly spaced, tappable (44pt touch targets)
- Visual press feedback (slight background color change on press)
- Inserting a bracket pair places cursor between them: `{|}` where `|` is cursor
- Dismiss button (down arrow) closes the keyboard
- Toolbar scrolls horizontally if more buttons than screen width

---

### 13. Haptic Feedback

WhisperCode fires haptic responses (light/medium/heavy/success/warning/error) on interactions. Our app has no haptics. Adding haptic feedback on key actions (send message, kill session, merge PR, notification tap) would make the app feel more polished and native.

**Implementation Details:**

- Install `expo-haptics`
- Define a haptics utility mapping action types to feedback styles
- Integrate at key interaction points throughout the app

**Files to modify:**
- Create `src/utils/haptics.ts`:
  ```typescript
  import * as Haptics from "expo-haptics";
  export const haptic = {
    light: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    medium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
    success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
    error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  };
  ```
- `src/screens/SessionDetailScreen.tsx` — `haptic.light()` on send message, `haptic.success()` on merge PR, `haptic.warning()` on kill session
- `src/screens/HomeScreen.tsx` — `haptic.light()` on session card tap, `haptic.success()` on pull-to-refresh complete
- `src/screens/SpawnSessionScreen.tsx` — `haptic.success()` on spawn success, `haptic.error()` on spawn failure
- `src/screens/SettingsScreen.tsx` — `haptic.light()` on save

**User-facing feedback:**
- Users feel a subtle tap on button presses (light impact)
- Success actions (merge, spawn, save) give a satisfying success vibration
- Destructive actions (kill session) give a warning vibration before confirming
- Error states (API failure) give an error vibration
- Settings toggle to disable haptics for users who prefer no vibration

---

## Cross-cutting Improvements

### 14. Dark/Light Theme Support

Both apps support theming. Our app is hardcoded to GitHub dark theme (#0d1117). Adding dynamic theming (at minimum respecting system dark/light mode) would improve accessibility.

**Implementation Details:**

- Use React Native's `useColorScheme()` hook to detect system preference
- Create a theme context with two palettes (dark = current colors, light = inverted)
- Replace all hardcoded hex colors with theme tokens
- Store user preference in AsyncStorage: "system" (default), "dark", "light"

**Files to modify:**
- Create `src/contexts/ThemeContext.tsx` — theme provider with dark/light palettes and `useTheme()` hook
- Create `src/theme/colors.ts` — define `darkColors` and `lightColors` objects with matching keys
- Update ALL screens and components to use `useTheme()` instead of hardcoded colors:
  - `HomeScreen.tsx`, `SessionDetailScreen.tsx`, `SettingsScreen.tsx`, `SpawnSessionScreen.tsx`, `OrchestratorScreen.tsx`, `CommandsScreen.tsx`, `TerminalScreen.tsx`
  - `SessionCard.tsx`, `AttentionBadge.tsx`, `StatBar.tsx`
- `src/screens/SettingsScreen.tsx` — add theme picker: "System" / "Dark" / "Light"

**User-facing feedback:**
- App respects system dark/light mode by default
- Settings screen has a "Theme" section with three options
- Smooth transition when switching themes (no flash)
- All text, backgrounds, borders, and status colors adapt to the theme
- Light theme uses: white backgrounds, dark text, softer status colors

---

### 15. Markdown Rendering for Agent Messages

Both Omnara (`react-native-markdown-display`) and WhisperCode render agent output as markdown. If a chat/message history is added (improvement #3), rendering agent responses with markdown (code blocks, links, lists) would be essential for readability.

**Implementation Details:**

- Install `react-native-markdown-display` (Omnara's choice) or `react-native-markdown-renderer`
- Style code blocks with monospace font and dark background
- Support: headings, bold/italic, code blocks (with syntax highlighting if feasible), links (open in browser), lists, tables
- Inline code styled with background highlight
- Links open via `Linking.openURL()`

**Files to modify:**
- Create `src/components/MarkdownContent.tsx` — wrapper around markdown library with custom styles matching app theme
- `src/components/MessageBubble.tsx` (from improvement #3) — use `MarkdownContent` for agent messages
- `src/screens/SessionDetailScreen.tsx` — use `MarkdownContent` for issue summary and review comments (already showing raw text)

**User-facing feedback:**
- Agent messages render with proper formatting: headers, bold, code blocks
- Code blocks have a copy button (tap to copy to clipboard)
- Links are tappable and open in the system browser
- Long code blocks are horizontally scrollable
- Consistent styling with the app's dark theme

---

### 16. Optimistic UI Updates

Pull-to-refresh exists on Home but actions like `sendMessage`, `killSession`, `mergePR` have no optimistic UI. Adding optimistic updates (immediately reflect the action in UI, revert on error) would make the app feel snappier.

**Implementation Details:**

- On `sendMessage`: immediately append message to chat history (if implemented) or show "Message sent" state
- On `killSession`: immediately update session status to "killing..." and gray out action buttons
- On `mergePR`: immediately show "Merging..." state on the PR section
- On error: revert to previous state and show error toast
- Use a reducer pattern or state setter callbacks to manage optimistic + rollback state

**Files to modify:**
- `src/screens/SessionDetailScreen.tsx` — wrap action handlers with optimistic state updates
- `src/hooks/useSession.ts` — add `optimisticUpdate(partialSession)` method that temporarily overrides fetched data
- Create `src/components/Toast.tsx` — lightweight toast component for success/error feedback

**User-facing feedback:**
- Actions feel instant — button changes to loading state immediately
- "Message sent" confirmation appears without waiting for server response
- "Merging PR..." shows with a spinner, transitions to "PR merged" on success
- Error toast slides in from top if action fails: "Failed to send message. Tap to retry."
- Reverted state is seamless — user sees the previous state restored

---

### 17. Offline/Error Resilience

WhisperCode gracefully handles disconnected states with clear indicators. Our app shows a generic error screen. Adding offline mode (cached last-known state), retry with exponential backoff on API calls, and distinct error states (no network vs server down vs auth error) would improve reliability.

**Implementation Details:**

- Cache last successful API responses in AsyncStorage
- On fetch failure, show cached data with a "Last updated 5m ago" banner
- Distinguish error types:
  - No network: "No internet connection" (check `NetInfo`)
  - Server unreachable: "Cannot reach server at {url}"
  - Server error (5xx): "Server error. Try again later."
  - Unknown: "Something went wrong"
- Retry with exponential backoff: 1s, 2s, 4s, 8s, max 30s
- Install `@react-native-community/netinfo` for network state detection

**Files to modify:**
- Create `src/utils/cache.ts` — AsyncStorage-based cache with TTL (time-to-live)
- Create `src/utils/retry.ts` — exponential backoff wrapper for fetch calls
- `src/contexts/BackendContext.tsx` — wrap `apiFetch` with cache-then-network strategy and retry logic
- `src/hooks/useSessions.ts` — return cached data on error with `stale: true` flag
- `src/screens/HomeScreen.tsx` — show "Offline" banner with last-updated time when using cached data
- Create `src/components/OfflineBanner.tsx` — yellow/orange banner component

**User-facing feedback:**
- Yellow banner at top: "Offline — showing data from 5 minutes ago"
- Automatic retry with countdown: "Retrying in 8s..."
- Different error messages for different failure modes (not just generic "Error loading sessions")
- Cached session list is browsable even offline (read-only, actions disabled)
- When connection restores, banner disappears and data refreshes automatically

---

## Priority Matrix

| # | Feature | Impact | Effort | Source |
|---|---------|--------|--------|--------|
| 9 | Guided onboarding wizard | **High** | Low | WhisperCode |
| 4 | Remote push notifications | **High** | Medium | Omnara |
| 2 | Real-time SSE instead of polling | **High** | Medium | Omnara |
| 3 | Chat/message history view | **High** | Medium | Omnara |
| 11 | Live health indicators | Medium | Low | WhisperCode |
| 13 | Haptic feedback | Medium | Low | WhisperCode |
| 1 | Voice input | Medium | Medium | Both |
| 12 | Custom keyboard toolbar | Medium | Medium | WhisperCode |
| 10 | Auto server discovery | Medium | Medium | WhisperCode |
| 15 | Markdown rendering | Medium | Low | Both |
| 16 | Optimistic updates | Medium | Low | Both |
| 17 | Offline resilience | Medium | Medium | WhisperCode |
| 14 | Dark/Light theming | Low | Medium | Both |
| 5 | Session sharing / teams | High | High | Omnara |
| 7 | Per-session metrics | Low | Low | Omnara |
| 6 | RevenueCat billing | Low | High | Omnara |
