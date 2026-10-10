# Threadline

A room for good conversations. Built with Vite, React 19, TypeScript, and Material UI **v6**, powered by Firebase and Google Gemini (`gemini-3.8-flash`).

## Deployment & Status

- **Source:** [`DeChen17714/threadline`](https://github.com/DeChen17714/threadline) — public, application-only repository; clean source install/build and GitHub CI passed.
- **Live demos:** [`threadline-demo.web.app`](https://threadline-demo.web.app) and [`mit-app-assignment.web.app`](https://mit-app-assignment.web.app) — both serve the same application and share the same accounts, rooms and AI allowance. Firebase provides HTTPS/CDN; Firestore/Functions run in Singapore `asia-southeast1`.
- **Own-key evaluation:** the local emulator route below uses real Gemini, allows every authenticated room member and needs no real Firebase project or reviewer approval.
- **Verified:** real Google/signup/recovery, contextual Gemini, refresh persistence, pre-join privacy, invitation/joined history, own-message edit/delete and real-time updates. The owner also verified the published site's reviewer AI, Google login with unapproved AI denial, invites and phone/narrow-window chat layout. This is functional acceptance, not a security certification.
- **Landing videos:** Three short illustrated workflows show screened AI chat, owner-approved invitations and saved-history editing. High-DPI screens use genuine 4K-rendered clips; standard-density screens use smaller copies. Reduced-motion/data-saving settings and unsupported transparent playback show posters instead.

---

## Quickstart: Own-Key Local Development (Real Firebase Emulators + Real Gemini)

Evaluators running Threadline locally with their own Gemini and OpenAI keys **do not need a real Firebase project, Google OAuth setup, or public `.env.local`**.

The emulator development runner (`npm run dev:emulator`) automatically targets loopback Firebase emulators for `demo-threadline` with built-in client configuration. Only Node.js, the Firebase CLI, Java 21+ and the two server-side API keys are required.

### Prerequisites

- **Node.js:** `>=22.13.0` and **npm**
- **Java:** `21+` *(required only by Firebase emulators; React and Cloud Functions do not require Java)*
- **Firebase CLI:** Installed globally (`npm install -g firebase-tools`).
- Commands below use a POSIX shell (Linux/macOS; use WSL on Windows).
- **Gemini API Key:** A Google Gemini API key with paid billing enabled (see [Billing & Pricing Caveats](#billing--pricing-caveats))
- **OpenAI API Key:** Access to `omni-moderation-latest` for standalone screening (currently free). Restrict the key to moderation Write access where supported; the application never requests an OpenAI chat/generation model.

### Step-by-Step Setup

1. **Install dependencies:**
   ```sh
   npm ci
   ```

2. **Configure server-only keys:**
   Create `functions/.secret.local` in your editor. Never put these keys in `.env`, `VITE_*`, client files, or shell history:
   ```ini
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   OPENAI_API_KEY=your_actual_openai_api_key_here
   ```
   Restrict file permissions to owner-only:
   ```sh
   chmod 600 functions/.secret.local
   ```

3. **Start isolated Firebase emulators:**
   In Terminal 1, start the Auth (port 9099), Firestore (port 8080), and Functions (port 5001) emulators:
   ```sh
   npm run emulators
   ```

4. **Run the paid synthetic AI qualification preflight:**
   In Terminal 2, qualify the loopback server against real Gemini. Setup requires both server keys before any paid probe, verifies emulator bindings, and executes one bounded synthetic Gemini qualification. The standalone moderation qualification command below exercises the selected moderation policy separately.
   ```sh
   npm run setup:local-ai -- --ack-paid-service
   ```
   *Optional personal caps:* Clean own-key setup defaults to **no money cap** (`allowanceMicroUsd: null`) and **no lifetime attempt cap** (`localAttemptLimit: null`). To test with personal caps, supply `--attempt-cap=N` and/or `--allowance-micro-usd=N` (or set `LOCAL_AI_ATTEMPT_LIMIT` / `LOCAL_AI_ALLOWANCE_MICRO_USD`). An existing ledger retains its state; subsequent runs can only lower caps, never raise or erase recorded usage.

5. **Start the emulator-connected web client:**
   In Terminal 2 (or 3), launch the Vite dev server configured for the local emulators with AI enabled:
   ```sh
   VITE_THREADLINE_AI_ENABLED=true npm run dev:emulator
   ```

6. **Open the application:**
   Navigate to [http://127.0.0.1:5174/](http://127.0.0.1:5174/).
   - Click **Open workspace**, then register or log in.
   - Create an account using email/password or use the emulator's Google sign-in.
   - Local emulator accounts are separate from the published demo's accounts. Hosted reviewer credentials do not automatically work locally; create a local account for a fresh clone.
   - Create a private room and start chatting.
   - **Local AI Access:** In this own-key setup, **every signed-in room member** (including newly registered accounts) can use **Ask Threadline**. There is no reviewer allowlist, no default lifetime attempt cap, and no default spending cap.

---

## Simulated Preview Mode (Optional Zero-Config Demo)

For quick UI inspection without Java, Firebase emulators, or a Gemini API key:

```sh
npm run dev
```

Open [http://localhost:5173/](http://localhost:5173/).

- **Simulated Adapter:** Uses a deterministic in-memory `WorkspacePort` adapter.
- **Persistent Notice:** A persistent banner clearly labels accounts, rooms, storage, and AI replies as simulated preview data.
- **State:** In-memory only; reloading the browser resets preview data.
- **Production Isolation:** In accordance with architectural boundaries, production release builds (`npm run build`) strictly exclude all preview adapters. Accessing `/workspace` without real Firebase infrastructure fails closed with an honest explanation.

---

## Architecture & Server Policies (One Codebase)

Threadline maintains a single codebase supporting two distinct server runtime policies determined strictly by server environment isolation, never by browser flags:

1. **Own-Key Local Development (`demo-threadline` Emulators):**
   - Unrestricted AI access for all authenticated room members.
   - Clean setup has no default monetary allowance cap and no lifetime attempt cap.
   - Evaluator-controlled optional caps may be applied via CLI flags.

2. **Hosted Cloud Production (both demo URLs, one Firebase project):**
   - **AI-Only Restriction:** Hosted AI is strictly gated to **eight exact server-configured reviewer accounts**, capped at **50 lifetime attempts per reviewer** and a shared **RM20 total lifetime allowance** carrying prior development/testing consumption forward.
   - **Human collaboration:** Any authenticated user can create rooms and request access without reviewer approval. Room membership, owner approval, privacy, moderation and human-message rate limits still apply.

### Public Client Config vs. Private Server Secrets

| Boundary | Storage | Variables | Access |
|---|---|---|---|
| **Client / Browser** | `.env.local` / build bundle | `VITE_FIREBASE_API_KEY`<br>`VITE_FIREBASE_PROJECT_ID`<br>`VITE_FIREBASE_AUTH_DOMAIN`<br>`VITE_FIREBASE_APP_ID`<br>`VITE_FIREBASE_APPCHECK_SITE_KEY`<br>`VITE_THREADLINE_AI_ENABLED` | Public web credentials; never contains server secrets or Gemini keys. |
| **Server / Functions** | `functions/.secret.local` (local)<br>Google Cloud Secret Manager (prod) | `GEMINI_API_KEY`<br>`OPENAI_API_KEY` | Restricted server-only secrets (`chmod 600`). Never exposed to browser or client bundles. |
| **Server Runtime Config** | `functions/.env` | `ALLOWED_ORIGINS`<br>`AI_TESTER_UIDS`<br>`FUNCTION_SERVICE_ACCOUNT` | Cloud Functions configuration for origin CORS protection and reviewer UIDs. |

---

## AI Design, Context Bounds & Safety Boundaries

Threadline integrates Google Gemini via the official typed `@google/genai` server SDK inside Cloud Functions (`asia-southeast1`).

### Pinned Model & Rationale

- **Model:** `gemini-3.8-flash` (pinned, single model; no silent fallbacks).
- **Why Gemini:** I initially chose Gemini expecting to use my Google Cloud trial credits. I later learned that the Gemini API has separate billing and those welcome credits do not cover this usage. I kept Gemini, enabled paid API access, and added explicit spending protection. Flash fits the short conversational responses this demo needs; low thinking and bounded input/output keep each request limited.
- **No Hallucinated Fallbacks:** If Gemini refuses a prompt, exceeds quotas, or experiences network transport errors, Threadline presents the honest provider error to the user. It never switches models, invokes lower-tier fallbacks, or fabricates placeholder answers.
- **Tools Disabled:** Answers synthesize general model knowledge with captured room history. No browsing, code interpreters, or external web tools are enabled.

### Challenges & Lessons

This was my first project using Firebase. I spent time learning how Hosting, Auth, Firestore, Functions and App Check fit together, configuring deployment and separating public browser settings from private server secrets. Checking which services qualify for cloud credits was part of that work. Hosting serves the frontend; Functions call Gemini; Firestore stores chats. An available trial credit does not make every service or future request free.

### Context Bounds & Token Budget

- **Message Window:** Up to 32 non-deleted message rows.
- **Payload Bound:** Maximum 131,072 bytes (128 KiB) JSON payload.
- **Context Truncation:** Oldest context is pruned with token counting to keep input within **8,192 tokens**.
- **Output Bound:** Combined maximum of **2,048 output tokens** (answer + reasoning).
- **Prompt Bound:** Human prompts are limited to 4,000 characters / 16 KiB.
- **Untrusted Content:** Member labels, messages and prior assistant replies are quoted as data, not authority. This reduces prompt-injection risk; it is not a guarantee.

### Billing & Pricing Caveats

- **Independent Billing:** Gemini API billing is distinct from Firebase credits or trial tiers. Using your own key incurs direct Gemini API charges.
- **Reservation Model:** Each AI dispatch conservatively reserves **30,000 microUSD** against the ledger (nominal turn cost envelope is ~13,824 microUSD).
- **Pricing Qualification:** Pinned pricing approval expires on 2027-01-01 (see [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)). The hosted currency/funds review expires on **2026-10-15 at 23:59:59 UTC**; expired qualification blocks AI until the operator verifies current funds/rates, without resetting consumption.
- **Paid Preflight:** `setup:local-ai --ack-paid-service` executes one real token count and one short generation (`READY`) to qualify provider connectivity and billing status.
- **Provider quotas:** Gemini limits vary by model, project and usage tier, and include requests/minute, tokens/minute and requests/day. There is no universal “five requests per minute” API-key limit. The demo uses paid Gemini access, which still has quotas; check the project's [active limits in AI Studio](https://aistudio.google.com/rate-limit) and the [rate-limit guide](https://ai.google.dev/gemini-api/docs/rate-limits).
- **Trial-credit lesson:** Google's [billing guide](https://ai.google.dev/gemini-api/docs/billing#cloud-credits) excludes Google Cloud welcome/free-trial credits from current Gemini API usage. Eligible Firebase/GCP usage may use remaining applicable credits or free allowances; eligibility, expiry and excess usage still matter. No zero-cost guarantee is made.

---

## Abuse Prevention & API Efficiency

Threadline enforces multi-layered abuse protection for both human messaging and AI invocation:

1. **Human Message Rate Limit:**
   - Enforces a durable Firestore-backed rate limit of **20 accepted sends per account per fixed server minute** across all rooms.
   - Retrying an already accepted message does not consume an extra slot.
   - Messages are limited to 4,000 characters / 16 KiB UTF-8.

2. **Durable Exact AI Request-Result Replay Caching:**
   - Every AI request carries a unique client `requestId`.
   - The server maintains a durable receipt (`receipts/${uid}_askThreadline_${requestId}`) recording the operation status, sequence number, and prompt hash.
   - If a client resubmits an identical request (e.g., due to network retry, double click, or reconnection), the server reuses the stored receipt and answer.
   - **Crucial Distinction:** This is idempotent request-result replay caching to prevent duplicate provider dispatches and double billing. It does **not** cache or reuse answers across different prompts or evolving room contexts.


### Standalone Moderation Qualification

Chat answers remain `gemini-3.8-flash`. The separate [OpenAI moderation endpoint](https://developers.openai.com/api/docs/guides/moderation) is currently free; Gemini generation is separately billed.

Add `OPENAI_API_KEY=your-key` alongside `GEMINI_API_KEY=your-key` in the ignored, owner-only `functions/.secret.local` (`chmod 600`), then run:

```sh
npm run qualify:moderation -- --ack-external-service
```

The qualifier sends 46 frozen synthetic examples and 12 holdouts to `omni-moderation-latest`, once each, and writes private evidence under ignored `.firebase/`. Missing configuration, service errors and malformed responses fail closed. The conservative demo policy caught all 26 harmful examples in this small sample but blocked four harmless educational/prevention examples; false positives are accepted and reported, not relabeled. This is not a factual-accuracy or comprehensive-safety guarantee. OpenAI processing is not assumed to occur in Singapore. The command qualifies screening independently; it does not enable chat AI or modify budgets.

New messages, questions and edits are screened before publication—including solo rooms—and generated answers are screened before they appear. Solo rooms use **Ask Threadline** (Enter asks); group rooms offer **Send to room** and **Ask Threadline** (Enter sends to the room). A blocked or unavailable input check keeps your draft; a rejected edit leaves the previous approved text unchanged. A withheld AI answer leaves its approved question saved. Pending plaintext is never stored in shared Firestore records. Replaying the same operation does not repeat screening or AI generation.

**Latency trade-off:** Both ordinary Send and Ask wait for OpenAI screening before publishing text. Ask also waits for Gemini generation and answer screening. This adds network latency in exchange for keeping unchecked content out of shared history; screening cannot be bypassed. Three synthetic local measurements took 0.63–0.77 seconds per Send, including 0.57–0.72 seconds for moderation and 0.04–0.06 seconds for the remaining handler work. These are not production guarantees: connectivity, cold starts, contention and provider response times vary.

### Owner-Approved Room Access

An invitation lets a signed-in person **request access**, not automatically join. Before approval, the applicant sees only their own pending/rejected/expired status—not the room's name, description, members or messages. Use **Check status** after the owner responds; reload preserves the current request.

The creator opens **Invite** to refresh pending requests and approve or reject them. Each entry shows its display name, stable account UID and expiry; display names are not verified real-world identities. Ignoring a request leaves it pending until expiry. Replacing or revoking a link invalidates its pending requests, but does not remove existing members.

Rooms allow at most 20 members and 20 active access requests. The server permits at most three new admission attempts per account in a sliding ten-minute window; retries of the same operation do not create another request, and rejection/expiry does not reset that cooldown. Room deletion also purges private access requests. Owner member-removal, an additional operator pause control and response reporting are not included in this demo release.

### Assumptions, Limitations & Future Plans

- This is a hiring demo. Hosted AI is available only to the eight approved accounts within the existing shared allowance; self-hosted local evaluation uses the evaluator's own keys.
- Screening adds the latency described above and can reject harmless text. It checks content safety, not factual accuracy or complete protection against abuse.
- Replies appear as complete messages, not token-by-token streams. External APIs, network issues and cold starts can delay or fail a request; errors preserve recoverable drafts and show a safe failure state.
- **Planned, not implemented:** owner-controlled removal of existing members, broader cross-feature abuse/race protections, a dedicated operator AI-pause control and private response reporting. Removing a member needs checks that also stop their old in-flight work, so it was deferred rather than shipping an unsafe shortcut. Existing membership privacy, quotas, admission limits and moderation remain active.

---

## Firebase Configuration & Hosting

The provided demo uses Firebase Hosting, Auth, Firestore and Functions. Hosting supplies HTTPS automatically; Functions hold the Gemini and OpenAI keys. The own-key local quickstart above needs no cloud provisioning.

For a separately configured live Firebase project:

1. Register a web app; copy `.env.example` to `.env.local` and fill the public Firebase values and reCAPTCHA Enterprise site key. Leave `VITE_THREADLINE_AI_ENABLED=false` until server qualification is complete.
2. Enable Email/Password and Google in Firebase Auth. Authorize the included `<site-id>.web.app` and `<site-id>.firebaseapp.com` domains. Configure Google Auth Platform branding/support details and the password-reset action URL at `/auth/reset-password`. Basic `openid`/`email`/`profile` sign-in has Google's [Testing-status exception](https://support.google.com/cloud/answer/15549945#publishing-status).
3. Provision Standard Firestore and Functions in Singapore `asia-southeast1`; register domain-restricted reCAPTCHA Enterprise App Check and enforce it for Firestore. Functions enforce App Check server-side.
4. Copy `functions/.env.example` to `functions/.env.<project-id>`; set exact HTTPS origins, approved reviewer UIDs and a dedicated runtime service account with Datastore access and secret-specific access to `GEMINI_API_KEY` and `OPENAI_API_KEY`. Store each key using `firebase functions:secrets:set <KEY> --project <project-id>`; do not grant project-wide secret access.
5. **Hosted AI requires separate operator qualification:** a reviewed private server budget, prior consumption, verified remaining funds and expiring MYR/USD conversion/headroom. Merely deploying or setting the browser AI flag does not grant access. Missing configuration fails closed. Do not copy another owner's ledger/qualification. Use the local quickstart for unrestricted own-key evaluation.
6. After prerequisites and billing/publication approval, bind the primary included Hosting site and deploy explicitly:
   ```sh
   firebase target:apply hosting primary <site-id> --project <project-id>
   firebase deploy --only firestore,functions:threadline,hosting:primary --project <project-id>
   ```
   The supplied `mit-app-assignment` target configuration also binds `demo` to `threadline-demo`; deploying `--only hosting` publishes both sites. For another project, configure its own targets. Predeploy hooks build the application. Enable the public AI UI flag only after qualification and rebuild before publishing. No purchased domain is needed.

Only sanitized examples are tracked. Real `.env*`, server secrets, reviewer credentials, local exports and planning/reference files are excluded. Firebase web configuration and the App Check site key are public by design—not the private Gemini key.

**Costs and limits:** the hosted RM20 allowance covers AI accounting only, not Firebase signup, reads/writes, storage, traffic, builds or logs. Gemini billing is separate from Firebase credits. The existing provider monthly backstop and disabled auto-reload are separate protections, not instant universal cost stops. Firebase/App Check/instance limits reduce exposure but cannot guarantee zero abuse or zero cost.

---

## Feature Coverage: Required & Six Bonuses

Threadline fulfills all baseline specifications and six bonus capabilities:

| Scope | Feature | Description & Test Coverage |
|---|---|---|
| **Required** | **Private Rooms & Members** | Create named rooms with optional descriptions, sidebar selection, membership privacy and owner-approved invitations. (`test:rooms-emulator`, `test:invitations-emulator`) |
| **Required** | **Live Messaging & History** | Real-time messaging, ordered gapless sequence allocation, sliding window history (50 → 500 messages). (`test:messages-emulator`, `test:history-emulator`) |
| **Required** | **Ask Threadline (AI)** | Pinned `gemini-3.8-flash` integration, bounded context search, budget reservations, truthful failure handling. (`test:ai-emulator`, `test:ai-client`) |
| **Required** | **Resumable Room Deletion** | Creator-only, confirmed cascading deletion of room documents, messages, invites, access requests and pending generations. (`test:deletion-emulator`) |
| **Bonus 1** | **Authentication** | Email/password login and registration, password recovery, Google sign-in and explicitly confirmed account linking. (`test:auth-emulator`, `test:auth-routing`) |
| **Bonus 2** | **Message Mutations (Edit/Delete)** | Author-owned edits and deletions; edited prompts truthfully mark associated AI answers as historical context. (`test:message-mutations-emulator`) |
| **Bonus 3** | **Safe Markdown Rendering** | Sanitized GitHub Flavored Markdown (GFM) formatting in chat messages, code blocks, lists, and quotes. |
| **Bonus 4** | **Last Room Restoration** | Restores user's last visited room automatically across browser reloads via client storage. |
| **Bonus 5** | **Honest Loading & Error States** | Asynchronous states for message sending, room joining, generation dispatches, and explicit network error banners. |
| **Bonus 6** | **Rate Limiting & Replay Caching** | 20 human sends/min per account; durable exact AI request replay caching preventing duplicate API dispatches and charges. (`test:messages-emulator`, `test:ai-emulator`) |
| **Extra** | **Input & Answer Screening** | Real OpenAI moderation before publishing messages, edits, questions and Gemini answers; unavailable screening fails closed. (`test:moderation`, `test:messages-emulator`, `test:ai-emulator`) |
| **Extra** | **Owner Approval & UI Polish** | Generic pre-approval status, bounded pending-request controls, clearer invitation layout and the Threadline logo in desktop/mobile navigation. (`test:invitations-emulator`; browser and owner acceptance) |

---

## Verification & Test Commands

Emulator test commands below create a separate, disposable `demo-threadline` instance on loopback ports (Auth 9199, Firestore 8180, Functions 5101). They run selected suites sequentially, use empty test-provider secrets, and shut down their owned processes afterward. They never import your local rooms, reviewer credentials or AI ledger. Busy test ports fail closed; do not run tests directly against the human demo emulator.

`npm run test:emulator` runs all emulator suites. Both the test runner and `npm run emulators` default to two Java processors and a 2 GiB heap; explicit `JAVA_TOOL_OPTIONS` are respected. These limits and test isolation reduce resource pressure, not guarantee immunity from exhaustion. The deployed site uses managed Firestore and Node.js Cloud Functions—not this local Java emulator.

```sh
# Type safety and linting
npm run typecheck
npm run lint

# AI qualification, pricing and ledger tests
npm run test:setup-local-ai
npm run test:ai-emulator
npm run test:ai-client

# Authentication and routing tests
npm run test:auth-emulator
npm run test:auth-routing

# Room lifecycle, membership, and invitations
npm run test:rooms-emulator
npm run test:invitations-emulator
npm run test:deletion-emulator
npm run test:conversation-revocation

# Messaging, ordering, and rate-limiting
npm run test:messages-emulator
npm run test:history-emulator
npm run test:message-mutations-emulator
```

---

## Shutdown

- **Local:** press `Ctrl+C` in the emulator and Vite terminals. Export emulator data first if you want to preserve it: `firebase emulators:export <backup-directory> --project demo-threadline`; import it with `npm run emulators -- --import <backup-directory>`.
- **Disable hosted AI without deleting chats:** as the project owner, set the private Firestore document `budgets/threadline` field `qualified` to `false`. Do not reset counters or allowances. In-flight work may already be billable; leave its reservation settlement intact.
- **Take the website offline:** `firebase hosting:disable --project <project-id>`. This does not disable Auth/Firestore/Functions endpoints by itself; for full backend shutdown, remove public invoker access on the regional `command` Cloud Run service. Re-enable only after reviewing access and the unchanged budget.
