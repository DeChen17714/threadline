# Threadline

A room for good conversations. Built with Vite, React 19, TypeScript, and Material UI **v6**, powered by Firebase and Google Gemini (`gemini-3.8-flash`).

## Deployment & Status

- **Source:** [`DeChen17714/threadline`](https://github.com/DeChen17714/threadline) — public, application-only repository; clean source install/build and GitHub CI passed.
- **Live demo:** [`https://mit-app-assignment.web.app`](https://mit-app-assignment.web.app) — Firebase-provided HTTPS and global CDN; Firestore/Functions run in Singapore `asia-southeast1`.
- **Own-key evaluation:** the local emulator route below uses real Gemini, allows every authenticated room member and needs no real Firebase project or reviewer approval.
- **Verified:** real Google/signup/recovery, contextual Gemini, refresh persistence, pre-join privacy, invitation/joined history, own-message edit/delete and real-time updates. The owner also verified the published site's reviewer AI, Google login with unapproved AI denial, invites and phone/narrow-window chat layout. This is functional acceptance, not a security certification.

---

## Quickstart: Own-Key Local Development (Real Firebase Emulators + Real Gemini)

Evaluators running Threadline locally with their own Gemini API key **do not need a real Firebase project, Google OAuth setup, or public `.env.local`**.

The emulator development runner (`npm run dev:emulator`) automatically targets loopback Firebase emulators for `demo-threadline` with built-in client configuration. Only a Node.js runtime, the Firebase CLI, Java 21+ (for emulators), and a server-side Gemini API key are required.

### Prerequisites

- **Node.js:** `>=22.13.0` and **npm**
- **Java:** `21+` *(required only by Firebase emulators; React and Cloud Functions do not require Java)*
- **Firebase CLI:** Installed globally (`npm install -g firebase-tools`) or accessible via `npx`
- Commands below use a POSIX shell (Linux/macOS; use WSL on Windows).
- **Gemini API Key:** A Google Gemini API key with paid billing enabled (see [Billing & Pricing Caveats](#billing--pricing-caveats))

### Step-by-Step Setup

1. **Install dependencies:**
   ```sh
   npm ci
   ```

2. **Configure server-only Gemini secret:**
   Create `functions/.secret.local` in your editor. Never put this key in `.env`, `VITE_*`, client files, or shell history:
   ```ini
   GEMINI_API_KEY=your_actual_gemini_api_key_here
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
   In Terminal 2, qualify the loopback server against the real Gemini provider. This step explicitly checks emulator bindings, verifies key validity, and executes exactly one bounded synthetic qualification probe:
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
   - Click **Start a conversation** to register, or **Log in** for an existing account.
   - Create an account using email/password or use the emulator's Google sign-in.
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

2. **Hosted Cloud Production (`mit-app-assignment.web.app`):**
   - **AI-Only Restriction:** Hosted AI is strictly gated to **eight exact server-configured reviewer accounts**, capped at **50 lifetime attempts per reviewer** and a shared **RM20 total lifetime allowance** carrying prior development/testing consumption forward.
   - **Human Collaboration Unrestricted:** Room creation, member invitations, membership access, and human chat are fully open to any authenticated user and are never gated by reviewer approval.

### Public Client Config vs. Private Server Secrets

| Boundary | Storage | Variables | Access |
|---|---|---|---|
| **Client / Browser** | `.env.local` / build bundle | `VITE_FIREBASE_API_KEY`<br>`VITE_FIREBASE_PROJECT_ID`<br>`VITE_FIREBASE_AUTH_DOMAIN`<br>`VITE_FIREBASE_APP_ID`<br>`VITE_FIREBASE_APPCHECK_SITE_KEY`<br>`VITE_THREADLINE_AI_ENABLED` | Public web credentials; never contains server secrets or Gemini keys. |
| **Server / Functions** | `functions/.secret.local` (local)<br>Google Cloud Secret Manager (prod) | `GEMINI_API_KEY` | Restricted server-only secret (`chmod 600`). Never exposed to browser or client bundles. |
| **Server Runtime Config** | `functions/.env` | `ALLOWED_ORIGINS`<br>`AI_TESTER_UIDS`<br>`FUNCTION_SERVICE_ACCOUNT` | Cloud Functions configuration for origin CORS protection and reviewer UIDs. |

---

## AI Design, Context Bounds & Safety Boundaries

Threadline integrates Google Gemini via the official typed `@google/genai` server SDK inside Cloud Functions (`asia-southeast1`).

### Pinned Model & Rationale

- **Model:** `gemini-3.8-flash` (pinned, single model; no silent fallbacks).
- **Rationale:** High throughput, low latency, predictable token economics, and structured low-thinking reasoning (`ThinkingLevel.LOW`, `includeThoughts: false`).
- **No Hallucinated Fallbacks:** If Gemini refuses a prompt, exceeds quotas, or experiences network transport errors, Threadline presents the honest provider error to the user. It never switches models, invokes lower-tier fallbacks, or fabricates placeholder answers.
- **Tools Disabled:** Answers synthesize general model knowledge with captured room history. No browsing, code interpreters, or external web tools are enabled.

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

---

## Firebase Configuration & Hosting

The provided demo uses Firebase Hosting, Auth, Firestore and Functions. Hosting supplies HTTPS automatically; Functions hold the Gemini key. The own-key local quickstart above needs no cloud provisioning.

For a separately configured live Firebase project:

1. Register a web app; copy `.env.example` to `.env.local` and fill the public Firebase values and reCAPTCHA Enterprise site key. Leave `VITE_THREADLINE_AI_ENABLED=false` until server qualification is complete.
2. Enable Email/Password and Google in Firebase Auth. Authorize the included `<site-id>.web.app` and `<site-id>.firebaseapp.com` domains. Configure Google Auth Platform branding/support details and the password-reset action URL at `/auth/reset-password`. Basic `openid`/`email`/`profile` sign-in has Google's [Testing-status exception](https://support.google.com/cloud/answer/15549945#publishing-status).
3. Provision Standard Firestore and Functions in Singapore `asia-southeast1`; register domain-restricted reCAPTCHA Enterprise App Check and enforce it for Firestore. Functions enforce App Check server-side.
4. Copy `functions/.env.example` to `functions/.env.<project-id>`; set exact HTTPS origins, approved reviewer UIDs and a dedicated runtime service account with Datastore access and access to only the Gemini secret. Store the key with `firebase functions:secrets:set GEMINI_API_KEY --project <project-id>`.
5. **Hosted AI requires separate operator qualification:** a reviewed private server budget, prior consumption, verified remaining funds and expiring MYR/USD conversion/headroom. Merely deploying or setting the browser AI flag does not grant access. Missing configuration fails closed. Do not copy another owner's ledger/qualification. Use the local quickstart for unrestricted own-key evaluation.
6. After those prerequisites and billing/publication approval, deploy explicitly to the intended project:
   ```sh
   firebase deploy --only firestore,functions:threadline,hosting --project <project-id>
   ```
   The predeploy hooks build the application. Enable the public AI UI flag only after qualification and rebuild before publishing. Use the included HTTPS domains; no purchased domain is needed.

Only sanitized examples are tracked. Real `.env*`, server secrets, reviewer credentials, local exports and planning/reference files are excluded. Firebase web configuration and the App Check site key are public by design—not the private Gemini key.

**Costs and limits:** the hosted RM20 allowance covers AI accounting only, not Firebase signup, reads/writes, storage, traffic, builds or logs. Gemini billing is separate from Firebase credits. The existing provider monthly backstop and disabled auto-reload are separate protections, not instant universal cost stops. Firebase/App Check/instance limits reduce exposure but cannot guarantee zero abuse or zero cost.

---

## Feature Coverage: Required & Six Bonuses

Threadline fulfills all baseline specifications and six bonus capabilities:

| Scope | Feature | Description & Test Coverage |
|---|---|---|
| **Required** | **Private Rooms & Members** | Multi-user private rooms, membership authorization, invite links, room sequence consistency. (`test:rooms-emulator`, `test:invitations-emulator`) |
| **Required** | **Live Messaging & History** | Real-time messaging, ordered gapless sequence allocation, sliding window history (50 → 500 messages). (`test:messages-emulator`, `test:history-emulator`) |
| **Required** | **Ask Threadline (AI)** | Pinned `gemini-3.8-flash` integration, bounded context search, budget reservations, truthful failure handling. (`test:ai-emulator`, `test:ai-client`) |
| **Required** | **Resumable Room Deletion** | Batched cascading deletion of room documents, messages, invites, and pending generations. (`test:deletion-emulator`) |
| **Bonus 1** | **Comprehensive Authentication** | Email/password login & registration, password recovery, account linking, Google authentication with seamless provider merging. (`test:auth-emulator`, `test:auth-routing`) |
| **Bonus 2** | **Message Mutations (Edit/Delete)** | Author-owned edits and deletions; edited prompts truthfully mark associated AI answers as historical context. (`test:message-mutations-emulator`) |
| **Bonus 3** | **Safe Markdown Rendering** | Sanitized GitHub Flavored Markdown (GFM) formatting in chat messages, code blocks, lists, and quotes. |
| **Bonus 4** | **Last Room Restoration** | Restores user's last visited room automatically across browser reloads via client storage. |
| **Bonus 5** | **Honest Loading & Error States** | Asynchronous states for message sending, room joining, generation dispatches, and explicit network error banners. |
| **Bonus 6** | **Rate Limiting & Replay Caching** | 20 human sends/min per account; durable exact AI request replay caching preventing duplicate API dispatches and charges. (`test:messages-emulator`, `test:ai-emulator`) |

---

## Verification & Test Commands

Run the automated test suite against the local emulator environment:

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

- **Local:** press `Ctrl+C` in the emulator and Vite terminals. Export emulator data first if you want to preserve it: `firebase emulators:export <backup-directory> --project demo-threadline`; import it with `firebase emulators:start --only auth,firestore,functions --project demo-threadline --import <backup-directory>`.
- **Disable hosted AI without deleting chats:** as the project owner, set the private Firestore document `budgets/threadline` field `qualified` to `false`. Do not reset counters or allowances. In-flight work may already be billable; leave its reservation settlement intact.
- **Take the website offline:** `firebase hosting:disable --project <project-id>`. This does not disable Auth/Firestore/Functions endpoints by itself; for full backend shutdown, remove public invoker access on the regional `command` Cloud Run service. Re-enable only after reviewing access and the unchanged budget.
