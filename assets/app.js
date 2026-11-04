import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult, sendPasswordResetEmail,
  signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, writeBatch,
  query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

// Firebase's web configuration identifies the project; Firestore Rules enforce access.
const firebaseConfig = {
  apiKey: "AIzaSyB3Sps_bCLiykV2y1MxO4i9IhMWOp278Rg",
  authDomain: "vivara-forge.firebaseapp.com",
  databaseURL: "https://vivara-forge-default-rtdb.firebaseio.com",
  projectId: "vivara-forge",
  storageBucket: "vivara-forge.firebasestorage.app",
  messagingSenderId: "267201020386",
  appId: "1:267201020386:web:c07b73370fb6185c79f9bb"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
let currentUser = null;
let prospectRows = [];
let candidateRows = [];
let jobRows = [];
let stopProspects = null;
let stopCandidates = null;
let stopJobs = null;
let localItems = [];
let currentLocation = null;
let toastTimer = null;
let authMode = "signin";

const labels = {
  new: "New", queued: "Queued", running: "Searching", found: "Email found",
  needs_review: "Needs review", not_found: "Not found", failed: "Failed",
  completed: "Completed", partial: "Partially complete"
};

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.borderColor = error ? "#9d4654" : "#2a4260";
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function setLoginMessage(message, isError = true) {
  const el = $("#loginMessage");
  el.textContent = message || "";
  el.style.color = isError ? "#b94751" : "#287f62";
}

function friendlyError(error) {
  const code = error?.code || "";
  if (code.includes("auth/unauthorized-domain")) return "Add this GitHub Pages domain under Firebase Authentication → Settings → Authorized domains.";
  if (code.includes("auth/operation-not-allowed")) return "Enable this sign-in provider in Firebase Authentication → Sign-in method.";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) return "Email or password was not accepted.";
  if (code.includes("auth/email-already-in-use")) return "An account already uses that email. Sign in or reset the password instead.";
  if (code.includes("auth/invalid-email")) return "Enter a valid email address.";
  if (code.includes("auth/weak-password")) return "Choose a stronger password with at least 6 characters.";
  if (code.includes("auth/too-many-requests")) return "Too many attempts. Wait a little and try again.";
  if (code.includes("permission-denied")) return "Firestore denied this action. Deploy the repository's Firestore Rules, then refresh.";
  if (code.includes("unavailable")) return "Firebase is temporarily unavailable. Try again in a moment.";
  return error?.message || "Something went wrong.";
}

function userCollection(name) {
  return collection(db, "users", currentUser.uid, name);
}

function setConnection(online, message) {
  $("#firebaseStatus").classList.toggle("offline", !online);
  $("#firebaseStatus").innerHTML = "<i></i>" + (online ? "Firebase ready" : "Firebase needs setup");
  $("#connectionDot").classList.toggle("online", online);
  $("#connectionText").textContent = message || (online ? "Signed in and connected" : "Waiting for sign-in");
}

function stopListeners() {
  [stopProspects, stopCandidates, stopJobs].forEach((stop) => { if (stop) stop(); });
  stopProspects = stopCandidates = stopJobs = null;
}

function beginWorkspace(user) {
  currentUser = user;
  $("#loginScreen").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#userEmail").textContent = user.email || "Signed in";
  $("#userInitial").textContent = (user.displayName || user.email || "V").trim().charAt(0).toUpperCase();
  $("#adminUid").value = user.uid;
  $("#copyAdminUid").disabled = false;
  setConnection(true, "Signed in and connected");
  stopListeners();

  stopProspects = onSnapshot(query(userCollection("prospects"), orderBy("createdAt", "desc")), (snapshot) => {
    prospectRows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderProspects();
    updateMetrics();
  }, (error) => {
    setConnection(false, "Firestore rules need setup");
    showToast(friendlyError(error), true);
  });

  stopCandidates = onSnapshot(userCollection("candidates"), (snapshot) => {
    candidateRows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderProspects();
    updateMetrics();
  }, (error) => showToast(friendlyError(error), true));

  stopJobs = onSnapshot(query(userCollection("jobs"), orderBy("createdAt", "desc")), (snapshot) => {
    jobRows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderJobs();
    updateMetrics();
  }, (error) => showToast(friendlyError(error), true));
}

function endWorkspace() {
  currentUser = null;
  stopListeners();
  prospectRows = [];
  candidateRows = [];
  jobRows = [];
  $("#workspace").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  $("#adminUid").value = "";
  $("#copyAdminUid").disabled = true;
  setAuthMode("signin");
  setConnection(false);
}

function setAuthMode(mode) {
  authMode = mode;
  const creating = mode === "signup";
  $("#authSubmit").textContent = creating ? "Create account" : "Sign in";
  $("#authModeToggle").textContent = creating ? "Already have an account? Sign in" : "New here? Create account";
  $("#confirmPasswordField").classList.toggle("hidden", !creating);
  $("#confirmPasswordInput").required = creating;
  $("#passwordInput").autocomplete = creating ? "new-password" : "current-password";
  $("#resetPassword").classList.toggle("hidden", creating);
  setLoginMessage("");
}

async function submitEmailAuth(event) {
  event.preventDefault();
  const email = $("#emailInput").value.trim();
  const password = $("#passwordInput").value;
  const creating = authMode === "signup";
  if (creating && password !== $("#confirmPasswordInput").value) {
    setLoginMessage("The passwords do not match.");
    return;
  }
  const submitButton = $("#authSubmit");
  submitButton.disabled = true;
  setLoginMessage(creating ? "Creating your account…" : "Signing in…", false);
  try {
    if (creating) await createUserWithEmailAndPassword(auth, email, password);
    else await signInWithEmailAndPassword(auth, email, password);
    setLoginMessage("");
  } catch (error) {
    setLoginMessage(friendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

async function signInGoogle() {
  setLoginMessage("Opening Google sign-in…", false);
  try {
    const provider = new GoogleAuthProvider();
    if (window.matchMedia("(pointer: coarse)").matches) {
      await signInWithRedirect(auth, provider);
      return;
    }
    await signInWithPopup(auth, provider);
    setLoginMessage("");
  } catch (error) {
    setLoginMessage(friendlyError(error));
  }
}

async function resetPassword() {
  const email = $("#emailInput").value.trim();
  if (!email) return setLoginMessage("Enter your email first.");
  try {
    await sendPasswordResetEmail(auth, email);
    setLoginMessage("Password reset email sent if the account exists.", false);
  } catch (error) {
    setLoginMessage(friendlyError(error));
  }
}

function gotoView(name) {
  const view = $("#view-" + name);
  if (!view) return;
  $$(".view").forEach((item) => item.classList.remove("active"));
  view.classList.add("active");
  $$(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $$(".mobile-nav button").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  const title = name.charAt(0).toUpperCase() + name.slice(1).replace("companion", "Browser companion");
  $("#pageTitle").textContent = name === "local" ? "Local discovery" : name === "jobs" ? "Enrichment queue" : title;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function candidateFor(prospectId) {
  return candidateRows.filter((item) => item.prospectId === prospectId)
    .sort((a, b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0))[0];
}

function statusPill(status) {
  const label = labels[status] || "New";
  return '<span class="status-badge ' + escapeHtml(status || "new") + '">' + escapeHtml(label) + "</span>";
}

function renderProspects() {
  const body = $("#leadRows");
  const needle = ($("#leadSearch")?.value || "").toLowerCase().trim();
  const status = $("#statusFilter")?.value || "";
  const filtered = prospectRows.filter((prospect) => {
    const candidate = candidateFor(prospect.id);
    const text = [prospect.businessName, prospect.city, prospect.state, prospect.phone, candidate?.email, prospect.manualEmail].join(" ").toLowerCase();
    return (!needle || text.includes(needle)) && (!status || prospect.status === status);
  });
  $("#leadCountBadge").textContent = String(prospectRows.length);
  $("#emptyLeads").classList.toggle("visible", prospectRows.length === 0);
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">' + (prospectRows.length ? "No prospects match these filters." : "Your list is empty.") + "</td></tr>";
    return;
  }
  body.innerHTML = filtered.map((prospect) => {
    const candidate = candidateFor(prospect.id);
    const contact = candidate
      ? '<b>' + escapeHtml(candidate.email) + '</b><small>Evidence score ' + escapeHtml(candidate.confidenceScore ?? "—") + '/10 · mailbox unverified</small>'
      : prospect.manualEmail
        ? '<b>' + escapeHtml(prospect.manualEmail) + '</b><small>Provided/captured · unverified</small>'
      : '<span class="muted">' + (prospect.status === "not_found" ? "No public email" : "No candidate yet") + "</span>";
    const evidence = candidate
      ? '<details><summary class="evidence-link">View evidence</summary><div class="evidence-box"><b>' + escapeHtml(candidate.sourceRouteLabel || candidate.sourceRoute || "Source") + '</b><br><a href="' + escapeHtml(candidate.sourceUrl || "#") + '" target="_blank" rel="noopener">' + escapeHtml(candidate.sourceUrl || "No source URL") + '</a><p>' + escapeHtml(candidate.evidenceText || "No excerpt saved.") + '</p><small>' + escapeHtml(candidate.domainCheckLabel || "Mailbox not confirmed") + '</small><small>' + escapeHtml(candidate.scoreBasis || "Initial evidence rubric; not a probability.") + '</small><div class="feedback-actions"><button class="mini-button" data-feedback="' + escapeHtml(candidate.id) + '" data-label="correct">Correct</button><button class="mini-button" data-feedback="' + escapeHtml(candidate.id) + '" data-label="wrong">Wrong</button><button class="mini-button" data-feedback="' + escapeHtml(candidate.id) + '" data-label="stale">Stale</button></div></div></details>'
      : prospect.manualEmail
        ? '<details><summary class="evidence-link">View capture</summary><div class="evidence-box"><b>Provided or browser-captured · unverified</b><br><a href="' + escapeHtml(prospect.manualSourceUrl || prospect.website || "#") + '" target="_blank" rel="noopener">' + escapeHtml(prospect.manualSourceUrl || prospect.website || "No source URL") + '</a><p>' + escapeHtml(prospect.manualEvidenceText || "No evidence excerpt was included.") + '</p></div></details>'
      : '<span class="muted">—</span>';
    const location = [prospect.city, prospect.state].filter(Boolean).join(", ") || "—";
    const lookupNote = prospect.lastLookupNote ? '<small class="muted">' + escapeHtml(prospect.lastLookupNote) + '</small>' : '';
    return '<tr data-id="' + escapeHtml(prospect.id) + '"><td><input class="lead-check" type="checkbox" value="' + escapeHtml(prospect.id) + '" aria-label="Select ' + escapeHtml(prospect.businessName) + '"></td><td><div class="business-cell"><b>' + escapeHtml(prospect.businessName) + '</b><small>' + escapeHtml(prospect.category || "Business") + '</small></div></td><td>' + escapeHtml(location) + '</td><td>' + contact + '</td><td>' + statusPill(prospect.status) + lookupNote + '</td><td>' + evidence + '</td><td><div class="row-actions"><button class="mini-button" data-row-action="queue" data-id="' + escapeHtml(prospect.id) + '">Queue</button><button class="mini-button" data-row-action="delete" data-id="' + escapeHtml(prospect.id) + '" title="Delete prospect">×</button></div></td></tr>';
  }).join("");
}

function updateMetrics() {
  const found = new Set(candidateRows.map((item) => item.prospectId));
  $("#metricProspects").textContent = String(prospectRows.length);
  $("#metricFound").textContent = String(prospectRows.filter((item) => found.has(item.id) || item.manualEmail).length);
  $("#metricReview").textContent = String(prospectRows.filter((item) => item.status === "needs_review").length);
  $("#metricNotFound").textContent = String(prospectRows.filter((item) => item.status === "not_found").length);
}

function renderJobs() {
  const container = $("#jobsList");
  if (!jobRows.length) {
    container.innerHTML = '<div class="empty-help visible"><div class="empty-illustration">◷</div><b>No jobs yet</b><p>Select prospects and queue them to start.</p></div>';
    return;
  }
  container.innerHTML = jobRows.map((job) => {
    const progress = Math.max(0, Math.min(100, Number(job.progressPercent || 0)));
    const created = job.createdAt?.toDate ? job.createdAt.toDate().toLocaleString() : "Just created";
    return '<article class="job-card"><div class="job-top"><b>Prospect batch · ' + escapeHtml(job.requestedCount || 0) + ' records</b>' + statusPill(job.status) + '</div><div class="job-meta"><span>Created ' + escapeHtml(created) + '</span><span>' + escapeHtml(job.progress || 0) + ' / ' + escapeHtml(job.requestedCount || 0) + ' processed</span></div><div class="progress-track"><div class="progress-bar" style="width:' + progress + '%"></div></div>' + (job.lastError ? '<p class="fine-print">' + escapeHtml(job.lastError) + '</p>' : "") + "</article>";
  }).join("");
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") { row.push(cell.trim()); cell = ""; }
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return rows.map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] || ""])));
}

function firstValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeInput(row) {
  const fields = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [
    key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), value
  ]));
  const businessName = firstValue(fields, ["businessname", "business_name", "business", "company", "company_name", "name", "title"]);
  if (!businessName) return null;
  return {
    businessName: businessName.slice(0, 160),
    category: firstValue(fields, ["category", "industry", "type"]).slice(0, 80),
    city: firstValue(fields, ["city", "town"]).slice(0, 100),
    state: firstValue(fields, ["state", "region", "province"]).slice(0, 50),
    phone: firstValue(fields, ["phone", "phone_number", "telephone", "tel"]).slice(0, 40),
    website: cleanUrl(firstValue(fields, ["website", "website_url", "url", "domain"])),
    sourceUrlsText: firstValue(fields, ["sourceurls", "source_urls", "source_urls_text", "source_url", "source", "sources"]).slice(0, 4000),
    notes: firstValue(fields, ["notes", "description"]).slice(0, 500),
    manualEmail: firstValue(fields, ["email", "email_address", "contact_email"]).slice(0, 254).toLowerCase(),
    manualEvidenceText: firstValue(fields, ["evidencetext", "evidence_text", "email_evidence"]).slice(0, 500),
    manualSourceUrl: cleanUrl(firstValue(fields, ["manualsourceurl", "manual_source_url", "sourceurl", "source_url"])),
    status: "new"
  };
}

function cleanUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.slice(0, 2048);
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return ("https://" + raw).slice(0, 2048);
  return "";
}

async function saveProspects(records, { fromCapture = false } = {}) {
  const clean = records.map(normalizeInput).filter(Boolean);
  if (!clean.length) throw new Error("No rows had a business name.");
  const seen = new Set(prospectRows.map((p) => [p.businessName, p.city, p.phone].join("|").toLowerCase()));
  const newRows = clean.filter((item) => {
    const key = [item.businessName, item.city, item.phone].join("|").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!newRows.length) return { added: 0, duplicates: clean.length };
  for (let start = 0; start < newRows.length; start += 400) {
    const batch = writeBatch(db);
    newRows.slice(start, start + 400).forEach((item) => {
      const ref = doc(userCollection("prospects"));
      batch.set(ref, { ...item, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    await batch.commit();
  }
  return { added: newRows.length, duplicates: clean.length - newRows.length, fromCapture };
}

async function importFile(file) {
  const text = await file.text();
  let values;
  if (file.name.toLowerCase().endsWith(".json") || file.type.includes("json")) {
    const parsed = JSON.parse(text);
    values = Array.isArray(parsed) ? parsed : [parsed.prospect || parsed];
  } else values = parseCSV(text);
  const result = await saveProspects(values);
  showToast("Imported " + result.added + " prospects; skipped " + result.duplicates + " duplicates.");
}

function selectedProspectIds() {
  return $$(".lead-check:checked").map((item) => item.value);
}

async function queueProspects(ids) {
  if (!currentUser) return;
  const chosen = ids.length ? ids : prospectRows.filter((item) => item.status === "new").map((item) => item.id);
  if (!chosen.length) return showToast("Select at least one new prospect.", true);
  const validIds = chosen.filter((id) => prospectRows.some((item) => item.id === id && ["new", "not_found", "failed", "needs_review", "found"].includes(item.status)));
  if (!validIds.length) return showToast("Those prospects are already queued or running.", true);
  if (validIds.length > 400) return showToast("Queue up to 400 prospects per batch.", true);
  try {
    const batch = writeBatch(db);
    for (const id of validIds) {
      batch.update(doc(db, "users", currentUser.uid, "prospects", id), {
        status: "queued",
        updatedAt: serverTimestamp()
      });
    }
    const jobRef = doc(userCollection("jobs"));
    batch.set(jobRef, {
      status: "queued",
      requestedCount: validIds.length,
      prospectIds: validIds,
      progress: 0,
      progressPercent: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await batch.commit();
    gotoView("jobs");
    showToast(validIds.length + " prospects saved to the queue.");
    const base = localStorage.getItem("vivaraBackendUrl") || "";
    if (base) {
      const token = await currentUser.getIdToken();
      fetch(base.replace(/\/$/, "") + "/api/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ job_id: jobRef.id })
      }).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        setWorkerStatus(true, "Worker connected");
      }).catch(() => setWorkerStatus(false, "Saved; worker did not respond"));
    } else {
      setWorkerStatus(false, "Saved; add worker URL in Settings");
    }
  } catch (error) {
    showToast(friendlyError(error), true);
  }
}

async function saveManualProspect(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const record = Object.fromEntries(form.entries());
  try {
    const result = await saveProspects([record]);
    event.currentTarget.reset();
    event.currentTarget.classList.add("hidden");
    showToast(result.added ? "Prospect saved." : "That prospect is already in your list.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteProspect(id) {
  const record = prospectRows.find((item) => item.id === id);
  if (!record || !window.confirm("Delete " + record.businessName + " from your list?")) return;
  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "prospects", id));
    showToast("Prospect deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function submitFeedback(candidateId, label) {
  const candidate = candidateRows.find((item) => item.id === candidateId);
  if (!candidate) return;
  const defaultRating = label === "correct" ? "9" : "2";
  const ratingInput = window.prompt("Rate this candidate from 1 to 10 (evidence quality, not probability).", defaultRating);
  if (ratingInput === null) return;
  const parsedRating = Number(ratingInput);
  if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 10) return showToast("Enter a whole number from 1 to 10.", true);
  const rating = parsedRating;
  try {
    await addDoc(userCollection("feedback"), {
      candidateId,
      prospectId: candidate.prospectId,
      email: candidate.email,
      sourceRoute: candidate.sourceRoute || "unknown",
      businessName: candidate.businessName || prospectRows.find((item) => item.id === candidate.prospectId)?.businessName || "",
      label,
      rating,
      note: "",
      createdAt: serverTimestamp()
    });
    showToast("Feedback saved. Future scores can learn from reviewed examples.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function exportCSV() {
  const header = ["business_name", "category", "city", "state", "phone", "website", "status", "email", "confidence_score", "source_url", "evidence_text"];
  const lines = [header.join(",")];
  for (const row of prospectRows) {
    const candidate = candidateFor(row.id);
    const values = [row.businessName, row.category, row.city, row.state, row.phone, row.website, row.status, candidate?.email || row.manualEmail, candidate?.confidenceScore, candidate?.sourceUrl || row.manualSourceUrl, candidate?.evidenceText || row.manualEvidenceText];
    lines.push(values.map((value) => '"' + String(value ?? "").replace(/"/g, '""') + '"').join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "vivara-forge-prospects.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function setWorkerStatus(online, message) {
  const text = online ? "Worker connected" : "Worker not connected";
  $("#workerBadge").innerHTML = "<i></i>" + text;
  $("#workerBadge").classList.toggle("offline", !online);
  $("#queueWorkerStatus").classList.toggle("offline", !online);
  $("#queueWorkerStatus").innerHTML = "<i></i>" + text;
  if (message) $("#backendMessage").textContent = message;
}

function getBackendUrl() {
  return (localStorage.getItem("vivaraBackendUrl") || $("#backendUrl").value || "").trim().replace(/\/$/, "");
}

async function checkBackend() {
  const base = getBackendUrl();
  if (!base) return showToast("Add the Hugging Face worker URL first.", true);
  $("#backendMessage").textContent = "Checking worker…";
  try {
    const response = await fetch(base + "/health");
    const data = await response.json();
    if (!response.ok || data.status !== "ok") throw new Error(data.message || "Worker did not return ready status.");
    setWorkerStatus(Boolean(data.worker_ready), data.worker_ready ? "Worker is ready." : "Backend is online; worker credentials are not configured.");
    showToast(data.worker_ready ? "Worker is online." : "Backend is online, but needs its server secrets.", !data.worker_ready);
  } catch (error) {
    setWorkerStatus(false, error.message || "Could not reach the worker.");
    showToast(error.message || "Could not reach the worker.", true);
  }
}

function renderLocalResults() {
  const container = $("#localResults");
  if (!localItems.length) { container.innerHTML = ""; return; }
  container.innerHTML = localItems.map((item, index) => {
    const detail = [item.category, item.phone, item.website, item.email ? "Email tag: " + item.email : ""].filter(Boolean).join(" · ");
    return '<article class="local-result"><div><b>' + escapeHtml(item.name || "Unnamed business") + '</b><small>' + escapeHtml(item.address || item.city || "Location unavailable") + '</small><small>' + escapeHtml(detail || "No public contact tags") + '</small><small><a href="' + escapeHtml(item.sourceUrl || "#") + '" target="_blank" rel="noopener">Open source record ↗</a></small></div><button class="button secondary" data-save-local="' + index + '">Save</button></article>';
  }).join("");
}

function updateMapLink() {
  const category = $("#localCategory").selectedOptions[0]?.textContent || "businesses";
  const queryText = currentLocation
    ? category + " near " + currentLocation.lat.toFixed(4) + "," + currentLocation.lon.toFixed(4)
    : category + " near me";
  const link = $("#openMaps");
  link.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(queryText);
  link.classList.remove("disabled-link");
}

async function runLocalSearch() {
  const base = getBackendUrl();
  if (!base) return showToast("Connect the Hugging Face worker in Settings to search local open data.", true);
  if (!currentLocation) return showToast("Tap Use my location first.", true);
  $("#runLocalSearch").disabled = true;
  $("#runLocalSearch").textContent = "Searching…";
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch(base + "/api/local-search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        radius_m: Number($("#localRadius").value),
        category: $("#localCategory").value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Local search failed.");
    localItems = data.results || [];
    renderLocalResults();
    showToast("Found " + localItems.length + " open-data results. Review before saving.");
  } catch (error) { showToast(error.message || "Local search failed.", true); }
  finally { $("#runLocalSearch").disabled = false; $("#runLocalSearch").textContent = "Search open data"; }
}

async function saveLocalResult(index) {
  const item = localItems[index];
  if (!item) return;
  try {
    const data = normalizeInput({
      businessName: item.name,
      category: item.category,
      city: item.city || "",
      state: item.state || "",
      phone: item.phone || "",
      website: item.website || "",
      sourceUrlsText: item.sourceUrl || "",
      email: item.email || "",
      evidenceText: item.emailEvidence || "",
      manualSourceUrl: item.sourceUrl || "",
      notes: "Discovered from OpenStreetMap. Verify details before outreach."
    });
    if (!data) return showToast("This result has no business name.", true);
    const duplicate = prospectRows.some((p) => p.businessName.toLowerCase() === data.businessName.toLowerCase() && p.city === data.city);
    if (duplicate) return showToast("That business is already in your list.");
    await addDoc(userCollection("prospects"), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    showToast("Saved to prospects.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function importExtensionCapture(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const normalized = items.map((item) => ({
      businessName: item.businessName || item.name || item.title,
      category: item.category || "",
      city: item.city || "",
      state: item.state || "",
      phone: item.phone || "",
      website: item.website || item.sourceUrl || item.url || "",
      sourceUrlsText: item.sourceUrl || item.url || "",
      email: item.email || "",
      evidenceText: item.evidenceText || "",
      manualSourceUrl: item.sourceUrl || item.url || "",
      notes: item.notes || "Captured manually from an open public business page."
    }));
    const result = await saveProspects(normalized, { fromCapture: true });
    gotoView("prospects");
    showToast("Imported " + result.added + " captured page(s).");
  } catch (error) { showToast("Could not import this JSON file: " + error.message, true); }
}

function buildMobileNav() {
  if ($(".mobile-nav")) return;
  const nav = document.createElement("nav");
  nav.className = "mobile-nav";
  nav.setAttribute("aria-label", "Mobile navigation");
  nav.innerHTML = [
    ["overview", "◫", "Home"],
    ["prospects", "◎", "Leads"],
    ["local", "⌖", "Local"],
    ["jobs", "◷", "Queue"],
    ["settings", "⚙", "Settings"]
  ].map((item) => '<button data-view="' + item[0] + '" type="button"><span>' + item[1] + '</span>' + item[2] + "</button>").join("");
  $("#workspace").appendChild(nav);
}

function initEvents() {
  $("#loginForm").addEventListener("submit", submitEmailAuth);
  $("#authModeToggle").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
  $("#googleSignIn").addEventListener("click", signInGoogle);
  $("#resetPassword").addEventListener("click", resetPassword);
  $("#signOut").addEventListener("click", () => signOut(auth).catch((error) => showToast(friendlyError(error), true)));
  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-view]");
    if (nav) gotoView(nav.dataset.view);
    const goto = event.target.closest("[data-goto]");
    if (goto) gotoView(goto.dataset.goto);
    const action = event.target.closest("[data-row-action]");
    if (action && action.dataset.rowAction === "queue") queueProspects([action.dataset.id]);
    if (action && action.dataset.rowAction === "delete") deleteProspect(action.dataset.id);
    const feedback = event.target.closest("[data-feedback]");
    if (feedback) submitFeedback(feedback.dataset.feedback, feedback.dataset.label);
    const saveLocal = event.target.closest("[data-save-local]");
    if (saveLocal) saveLocalResult(Number(saveLocal.dataset.saveLocal));
  });
  $("#fileImport").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { const result = await importFile(file); } catch (error) { showToast(error.message || "Import failed.", true); }
    event.target.value = "";
  });
  $("#extensionImport").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importExtensionCapture(file);
    event.target.value = "";
  });
  $("#extensionImportTrigger").addEventListener("click", () => $("#extensionImport").click());
  $("#leadSearch").addEventListener("input", renderProspects);
  $("#statusFilter").addEventListener("change", renderProspects);
  $("#selectAll").addEventListener("change", (event) => $$(".lead-check").forEach((item) => { item.checked = event.target.checked; }));
  $("#queueSelected").addEventListener("click", () => queueProspects(selectedProspectIds()));
  $("#exportLeads").addEventListener("click", exportCSV);
  $("#showAddForm").addEventListener("click", () => $("#addProspectForm").classList.remove("hidden"));
  $("#closeAddForm").addEventListener("click", () => $("#addProspectForm").classList.add("hidden"));
  $("#cancelAdd").addEventListener("click", () => $("#addProspectForm").classList.add("hidden"));
  $("#addProspectForm").addEventListener("submit", saveManualProspect);
  $("#useLocation").addEventListener("click", () => {
    if (!navigator.geolocation) return showToast("This browser does not offer location access.", true);
    $("#locationLabel").textContent = "Requesting location…";
    navigator.geolocation.getCurrentPosition((position) => {
      currentLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
      $("#locationLabel").textContent = currentLocation.lat.toFixed(4) + ", " + currentLocation.lon.toFixed(4);
      $("#runLocalSearch").disabled = false;
      updateMapLink();
    }, (error) => { $("#locationLabel").textContent = error.message; showToast("Location was not shared.", true); }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });
  $("#localCategory").addEventListener("change", updateMapLink);
  $("#runLocalSearch").addEventListener("click", runLocalSearch);
  $("#saveBackend").addEventListener("click", () => {
    const value = $("#backendUrl").value.trim().replace(/\/$/, "");
    if (value && !/^https:\/\/[^/]+/i.test(value)) return showToast("Use an HTTPS Space URL.", true);
    localStorage.setItem("vivaraBackendUrl", value);
    $("#backendMessage").textContent = value ? "Worker URL saved on this device." : "Worker URL cleared.";
    showToast(value ? "Worker URL saved." : "Worker URL cleared.");
  });
  $("#checkBackend").addEventListener("click", checkBackend);
  $("#copyAdminUid").addEventListener("click", async () => {
    if (!currentUser?.uid) return;
    try {
      await navigator.clipboard.writeText(currentUser.uid);
      showToast("Account UID copied. Paste it into the worker's ADMIN_UID setting.");
    } catch {
      $("#adminUid").select();
      showToast("Select and copy this UID, then paste it into the worker's ADMIN_UID setting.");
    }
  });
  $("#userMenu").addEventListener("click", () => gotoView("settings"));
}

initEvents();
buildMobileNav();
$("#backendUrl").value = localStorage.getItem("vivaraBackendUrl") || "";
updateMapLink();
setPersistence(auth, browserLocalPersistence).catch(() => {});
onAuthStateChanged(auth, (user) => {
  if (user) beginWorkspace(user);
  else endWorkspace();
});
getRedirectResult(auth).catch((error) => setLoginMessage(friendlyError(error)));
