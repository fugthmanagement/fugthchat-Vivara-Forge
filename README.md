# Vivara Forge Lead Workspace

Account-scoped, mobile-friendly prospect workspace for importing leads, collecting public contact evidence, and running resumable enrichment jobs. GitHub Pages serves the web interface; Firebase Authentication and Firestore provide sign-in and durable records; a separate Hugging Face Docker Space runs public-source lookups. The desktop Chrome companion captures one public business webpage only after the user clicks it.

## What it does

- Email/password sign-in and account creation, plus Google sign-in. Each account sees only its own Firestore records. The verified addresses `fugthchat@gmail.com` and `fugthmanagement@gmail.com` are protected administrators.
- Imports prospect CSV or JSON, deduplicates the current list, and exports results to CSV.
- Maps common lead-list columns into business name, niche, city/state, phone, website, email, address, Google Maps link, hours, rating, review count, and social URLs. Unavailable values stay blank. The Prospects view filters by niche and website presence.
- Optionally queues each imported batch automatically. The worker can save website profile details from visible HTML and Schema.org JSON-LD alongside email candidates.
- Saves prospects, evidence candidates, ratings, and queue state in Firestore.
- Queues batches up to 400 records. The worker processes the saved queue after the page closes and resumes queued/running jobs after worker restart.
- Checks a supplied business website, a limited number of same-site contact/about pages, supplied public source URLs including PDFs, Florida Sunbiz exact-name entity records and up to three linked filing PDFs, and up to five optional search results when a Brave Search key is configured. Search queries send the business name and location to that configured search provider.
- Extracts only email and business profile fields that appear in fetched public page text or structured metadata. It never invents likely email patterns or executes fetched website JavaScript. PDF bytes are held in memory for extraction and not saved to disk.
- Marks filing, directory, and search-result emails as needing human review. A score is an evidence rubric, not a probability or mailbox verification.
- Finds nearby OpenStreetMap records with attribution and provides a separate Google Maps search link. It does not scrape Google Maps.
- Adds an optional desktop unpacked Chrome companion with a tab selector to capture a selected public business webpage and download JSON. Chrome asks for access to each selected site's page when needed. It blocks capture on Google Maps.

## 1. GitHub Pages

In the repository settings, enable Pages from the `main` branch and the root folder. The site URL should be:

`https://fugthmanagement.github.io/fugthchat-Vivara-Forge/`

The frontend config contains the Firebase **web** configuration from the Firebase project. This is public client configuration; access control must come from Firebase Authentication and Firestore Rules. Do not put service-account JSON, private keys, API tokens, or Hugging Face write tokens in this repository.

## 2. Firebase Authentication and Firestore

The web app uses project `vivara-forge`, email/password account creation and sign-in, Google sign-in, and the default Firestore database. In Firebase Console:

1. In **Authentication → Sign-in method**, enable Email/Password and Google if you plan to use both.
2. In **Authentication → Settings → Authorized domains**, add `fugthmanagement.github.io`. For local testing, add `localhost`.
3. Open the deployed app and choose **New here? Create account**, or use Google sign-in (which creates a Firebase account on first use). Verify email for either protected admin address. The Settings page lets you copy the signed-in user's UID if you want to pin a worker to that account.
4. Review `firestore.rules`, then deploy it using the Firebase CLI from this repository:

   ```sh
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules --project vivara-forge
   ```

The included rules let a signed-in user access only their own prospect, job, feedback, and candidate paths. Candidate evidence is read-only to the browser and written by the server worker. A Firestore `permission-denied` error during import usually means these rules have not yet been published to `vivara-forge`; signing in alone does not publish them. The worker allows only verified configured administrators, not every account that can sign up.

Firestore can store the small JSON prospect/evidence records without requiring a Cloud Functions deployment. Storage usage and request quotas still apply; this design does not depend on Cloud Storage or Cloud Functions.

## 3. Hugging Face worker

Create a **new Docker Space** for this project. Upload the contents of `hf-space/`; do not replace an existing AI Space. Hugging Face's current docs say creating a compute-based Docker Space on a personal account may require a paid plan, even though CPU Basic hardware itself has no hourly charge. Check what your account offers before creating it. If the account blocks new compute Spaces, this bundle is ready but the worker will not be live until it is deployed to an available backend. Add these Space variables/secrets in the Space settings:

- Secret `FIREBASE_SERVICE_ACCOUNT_JSON`: the full JSON contents of a service-account key created for the Firebase project. Keep it out of GitHub and do not paste it in the browser.
- Optional variable `ADMIN_UID`: pin one Firebase Authentication UID. The two verified administrator emails above are also authorized by default; set `ADMIN_EMAILS` only if you want to replace that allowlist.
- Variable `ALLOWED_ORIGINS`: `https://fugthmanagement.github.io` (optionally add `http://localhost:8000` during local testing).
- Secret `WORKER_WAKE_TOKEN`: a long random token shared with the GitHub Actions repository secret of the same name.
- Optional secret `BRAVE_SEARCH_API_KEY`: enables the external web-search route. Without it, the worker checks supplied URLs only.
- Optional variable `OVERPASS_URL`: an alternate OpenStreetMap Overpass API endpoint.

The worker verifies Firebase ID tokens and only accepts the configured administrator emails or UIDs. The admin dashboard uses the worker's Firebase Admin SDK to list accounts and update rank claims; only protected admin identities can call those endpoints. Firestore Admin SDK writes bypass client Security Rules, so keep the service-account key out of the repository and protect the admin allowlist. Once the Space is built, put its base `https://…hf.space` URL in the app's Settings and use **Check status**.

### Background-job behavior

Jobs are recorded in Firestore before the browser asks the worker to start. Once the worker accepts a job, it runs independently of the browser page; closing Safari, Chrome, or the tab does not cancel it. The worker also polls Firestore to resume queued or interrupted work after it restarts. CPU Basic Spaces sleep after 48 hours of inactivity; a sleeping Space cannot make progress until it wakes, but the saved job remains in Firestore and resumes when the worker starts again.

The Admin dashboard can set a 15-minute to 6-hour interval for checking saved jobs. To wake a sleeping Space from outside its own process, add GitHub repository **Actions secrets** `HF_WORKER_URL` and `WORKER_WAKE_TOKEN`, then add the same `WORKER_WAKE_TOKEN` as a secret in the Hugging Face Space. `.github/workflows/wake-worker.yml` calls the worker every 15 minutes; the saved interval decides whether it should start due jobs. This resumes jobs already queued in Firestore. Turn on **Automatically start lookups** to create queue jobs after lead import, manual entry, or saving from Local Discovery. The setting is on by default. The wake workflow sends a request every 15 minutes when both GitHub secrets are configured, including while the saved worker schedule is off; disable the workflow or remove its secrets to stop those requests.

## 4. Sources and quality controls

Supply a website and/or one or more public source URLs in the prospect CSV/JSON or manual form. PDF URLs are extracted in memory, then discarded. `BRAVE_SEARCH_API_KEY` enables searching for source pages from a business name and location; results remain unverified and are tagged for review. Without that secret or a supplied URL, the worker cannot reliably discover a non-Florida business website from a name alone. The service limits page size, redirect count, number of sources, and crawl depth. It does not access pages requiring login, bypass anti-bot controls, execute remote JavaScript, or crawl Google Maps.

No public source means `Not found` or `Failed`; the worker will not manufacture an address. A found email is evidence that the string appeared in a source, not proof that the mailbox exists, belongs to the owner, or is safe to contact. Use the feedback buttons to record whether the candidate is correct, wrong, or stale and rate evidence quality. Future runs use route-level feedback to adjust the evidence score, gradually and within a small bounded range. An email marked wrong for the same business is suppressed on later runs. The score remains a review rubric, not a probability, and a reviewer should still verify important contacts.

Florida prospects marked `FL` or `Florida` are checked against the official Sunbiz entity-name search. The worker follows only exact normalized name matches, checks a maximum of three matching entity records and three PDFs per entity, and labels every filing email for manual review because filings can list agents or preparers instead of a sales contact. Other states can use supplied public filing URLs. The [Florida Department of State search guide](https://dos.fl.gov/sunbiz/search/guides/corporation-records) explains that entity search results lead to filed documents available as PDFs.

## 5. Desktop browser companion

The Chrome extension source is in `extension/`. On desktop Chrome:

1. Download or clone this repo.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the local `extension` folder.
4. Open a public business website, click the extension, review the visible contact details, and download JSON.
5. In the workspace, choose **Browser companion → Import capture JSON**.

The extension does not run on iPhone or Android. Use the responsive web app there. It captures one selected tab after a click and requests access per site; it is not a bulk crawler and blocks Google Maps pages. The app opens Maps search links for manual review but does not copy listings into the prospect database. Google Maps Platform terms prohibit scraping and copying business listing content; see the [official terms](https://cloud.google.com/maps-platform/terms).

## 6. Google Drive project folder

Project archive folder: [Vivara Forge Lead Enrichment](https://drive.google.com/drive/folders/1IFtAz3TzIIqHxroX_FxmPXRx-GgK5B-S)

This version does not archive downloaded PDFs there: the worker extracts PDF text in memory and discards the bytes. Use the folder for notes and project documents that should not go in Firestore. Do not upload service-account keys or API tokens.
