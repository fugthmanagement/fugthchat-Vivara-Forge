# Vivara Forge Lead Workspace

Private, mobile-friendly prospect workspace for importing leads, collecting public contact evidence, and running resumable enrichment jobs. GitHub Pages serves the web interface; Firebase Authentication and Firestore provide sign-in and durable records; a separate Hugging Face Docker Space runs public-source lookups. The desktop Chrome companion captures one public business webpage only after the user clicks it.

## What it does

- Email/password and Google sign-in; there is no public sign-up form.
- Imports prospect CSV or JSON, deduplicates the current list, and exports results to CSV.
- Saves prospects, evidence candidates, ratings, and queue state in Firestore.
- Queues batches up to 400 records. The worker processes the saved queue after the page closes and resumes queued/running jobs after worker restart.
- Checks a supplied business website, a limited number of same-site contact/about pages, supplied public source URLs including PDFs, and up to five optional search results when a Brave Search key is configured. Search queries send the business name and location to that configured search provider.
- Extracts only email strings that appear in fetched source text. It never invents likely email patterns. PDF bytes are held in memory for extraction and not saved to disk.
- Marks filing, directory, and search-result emails as needing human review. A score is an evidence rubric, not a probability or mailbox verification.
- Finds nearby OpenStreetMap records with attribution and provides a separate Google Maps search link. It does not scrape Google Maps.
- Adds an optional desktop unpacked Chrome companion to capture a single user-opened business webpage and download a JSON file for import. It blocks capture on Google Maps.

## 1. GitHub Pages

In the repository settings, enable Pages from the `main` branch and the root folder. The site URL should be:

`https://fugthmanagement.github.io/fugthchat-Vivara-Forge/`

The frontend config contains the Firebase **web** configuration from the Firebase project. This is public client configuration; access control must come from Firebase Authentication and Firestore Rules. Do not put service-account JSON, private keys, API tokens, or Hugging Face write tokens in this repository.

## 2. Firebase Authentication and Firestore

The web app uses project `vivara-forge`, email/password sign-in, Google sign-in, and the default Firestore database. In Firebase Console:

1. In **Authentication → Sign-in method**, enable Email/Password and Google if you plan to use both.
2. In **Authentication → Settings → Authorized domains**, add `fugthmanagement.github.io`. For local testing, add `localhost`.
3. Create the private admin account in Authentication → Users; the app does not allow people to create accounts from the sign-in screen.
4. Review `firestore.rules`, then deploy it using the Firebase CLI from this repository:

   ```sh
   npm install -g firebase-tools
   firebase login
   firebase use vivara-forge
   firebase deploy --only firestore:rules
   ```

The rules let a signed-in user access only their own prospect, job, and feedback paths. Candidate evidence is read-only to the browser and written by the server worker. Review these prototype rules before sharing the app or adding additional users.

Firestore can store the small JSON prospect/evidence records without requiring a Cloud Functions deployment. Storage usage and request quotas still apply; this design does not depend on Cloud Storage or Cloud Functions.

## 3. Hugging Face worker

Create a **new Docker Space** for this project. Upload the contents of `hf-space/`; do not replace an existing AI Space. Hugging Face's current docs say creating a compute-based Docker Space on a personal account may require a paid plan, even though CPU Basic hardware itself has no hourly charge. Check what your account offers before creating it. If the account blocks new compute Spaces, this bundle is ready but the worker will not be live until it is deployed to an available backend. Add these Space variables/secrets in the Space settings:

- Secret `FIREBASE_SERVICE_ACCOUNT_JSON`: the full JSON contents of a service-account key created for the Firebase project. Keep it out of GitHub and do not paste it in the browser.
- Variable `ADMIN_UID`: the Firebase Authentication UID for the private administrator account.
- Variable `ALLOWED_ORIGINS`: `https://fugthmanagement.github.io` (optionally add `http://localhost:8000` during local testing).
- Optional secret `BRAVE_SEARCH_API_KEY`: enables the external web-search route. Without it, the worker checks supplied URLs only.
- Optional variable `OVERPASS_URL`: an alternate OpenStreetMap Overpass API endpoint.

The worker verifies Firebase ID tokens and rejects every UID except `ADMIN_UID`. Firestore Admin SDK writes bypass client Security Rules, so protect the service account and keep the UID check in place. Once the Space is built, put its base `https://…hf.space` URL in the app's Settings and use **Check status**.

### Background-job behavior

Jobs are recorded in Firestore before the browser asks the worker to start. The worker runs the job independently of the mobile page and polls Firestore to resume queued or interrupted work when it starts. CPU Basic Spaces sleep after 48 hours of inactivity; free hardware is not an always-on guarantee. Work resumes after the worker wakes. Choose an always-on worker plan if uninterrupted processing is required.

## 4. Sources and quality controls

Supply a website and/or one or more public source URLs in the prospect CSV/JSON or manual form. PDF URLs are extracted in memory, then discarded. `BRAVE_SEARCH_API_KEY` enables a search route, but results remain unverified and are tagged for review. The service limits page size, redirect count, number of sources, and crawl depth. It does not access pages requiring login, bypass anti-bot controls, or crawl Google Maps.

No public source means `Not found` or `Failed`; the worker will not manufacture an address. A found email is evidence that the string appeared in a source, not proof that the mailbox exists, belongs to the owner, or is safe to contact. Use the feedback buttons to record whether the candidate is correct, wrong, or stale and rate evidence quality. Future runs use route-level feedback to adjust the evidence score, gradually and within a small bounded range. An email marked wrong for the same business is suppressed on later runs. The score remains a review rubric, not a probability, and a reviewer should still verify important contacts.

For Florida registry data, supply a direct official public filing/PDF URL as a source. The current version does not automatically query Sunbiz by business name. Search route configuration and source-specific adapters can be added after validating official source access and terms.

## 5. Desktop browser companion

The Chrome extension source is in `extension/`. On desktop Chrome:

1. Download or clone this repo.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the local `extension` folder.
4. Open a public business website, click the extension, review the visible contact details, and download JSON.
5. In the workspace, choose **Browser companion → Import capture JSON**.

The extension does not run on iPhone or Android. Use the responsive web app there. It only reads the active page after a click; it is not a bulk crawler and it blocks Google Maps pages.

## 6. Google Drive project folder

Project archive folder: [Vivara Forge Lead Enrichment](https://drive.google.com/drive/folders/1IFtAz3TzIIqHxroX_FxmPXRx-GgK5B-S)

This version does not archive downloaded PDFs there: the worker extracts PDF text in memory and discards the bytes. Use the folder for notes and project documents that should not go in Firestore. Do not upload service-account keys or API tokens.
