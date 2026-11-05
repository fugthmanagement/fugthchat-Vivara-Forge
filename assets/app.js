import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult, sendPasswordResetEmail, sendEmailVerification,
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
const ADMIN_EMAILS = new Set(["fugthchat@gmail.com", "fugthmanagement@gmail.com"]);
const IMPORT_META_PREFIX = "[VF-META]";
const APP_VERSION = "2026.11.05-import-fix-1";
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
let adminAccounts = [];

function safeStorageGet(key, fallback = "") {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}

function sanitizeDiagnostic(value) {
  return String(value || "Unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (url) => url.split("?")[0])
    .slice(0, 300);
}

function recordClientError(context, error) {
  const current = (() => {
    try { return JSON.parse(safeStorageGet("vivaraDiagnostics", "[]")); }
    catch { return []; }
  })();
  const entries = Array.isArray(current) ? current.slice(-24) : [];
  entries.push({
    at: new Date().toISOString(),
    context: String(context || "client").slice(0, 80),
    message: sanitizeDiagnostic(error?.message || error),
    code: String(error?.code || "").slice(0, 80),
    online: navigator.onLine,
    version: APP_VERSION
  });
  safeStorageSet("vivaraDiagnostics", JSON.stringify(entries));
}

const labels = {
  new: "New", queued: "Queued", running: "Searching", found: "Contact found",
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
  if (error) recordClientError("handled", error);
  const code = error?.code || "";
  if (code.includes("auth/unauthorized-domain")) return "Add this site domain under the account service's authorized domains.";
  if (code.includes("auth/operation-not-allowed")) return "Enable this sign-in method in the account service settings.";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) return "Email or password was not accepted.";
  if (code.includes("auth/email-already-in-use")) return "An account already uses that email. Sign in or reset the password instead.";
  if (code.includes("auth/invalid-email")) return "Enter a valid email address.";
  if (code.includes("auth/weak-password")) return "Choose a stronger password with at least 6 characters.";
  if (code.includes("auth/too-many-requests")) return "Too many attempts. Wait a little and try again.";
  if (code.includes("permission-denied")) return "Cloud memory blocked this import. Open Settings → Data rules, publish the repository rules, then refresh.";
  if (code.includes("unavailable")) return "Cloud memory is temporarily unavailable. Your queued data was not cleared; try again in a moment.";
  return error?.message || "Something went wrong.";
}

function userCollection(name) {
  return collection(db, "users", currentUser.uid, name);
}

function isAdminEmail(user = currentUser) {
  return Boolean(user?.email && ADMIN_EMAILS.has(user.email.trim().toLowerCase()));
}

function isAdminUser(user = currentUser) {
  return isAdminEmail(user) && user.emailVerified === true;
}

function updateAdminVisibility() {
  const isConfiguredAdmin = isAdminEmail();
  const verified = isAdminUser();
  $("#adminNav").classList.toggle("hidden", !verified);
  $("#adminVerifyPanel").classList.toggle("hidden", !isConfiguredAdmin || verified);
  if (isConfiguredAdmin && !verified) {
    $("#verificationMessage").textContent = "Verify the email address to unlock the admin dashboard and worker.";
  }
  buildMobileNav();
}

function setConnection(online, message) {
  $("#firebaseStatus").classList.toggle("offline", !online);
  $("#firebaseStatus").innerHTML = "<i></i>" + (online ? "Cloud memory ready" : "Cloud memory needs setup");
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
  updateAdminVisibility();
  setConnection(true, "Signed in and connected");
  stopListeners();

  stopProspects = onSnapshot(query(userCollection("prospects"), orderBy("createdAt", "desc")), (snapshot) => {
    prospectRows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    refreshCategoryFilter();
    renderProspects();
    updateMetrics();
  }, (error) => {
    setConnection(false, "Cloud data rules need setup");
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
  $("#adminNav").classList.add("hidden");
  $("#adminVerifyPanel").classList.add("hidden");
  buildMobileNav();
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
    if (creating) {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(credential.user);
    }
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
  $("#pageTitle").textContent = name === "local" ? "Local discovery" : name === "jobs" ? "Enrichment queue" : name === "admin" ? "Admin dashboard" : title;
  if (name === "admin" && isAdminUser()) loadAdminDashboard();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function candidateFor(prospectId) {
  return candidateRows.filter((item) => item.prospectId === prospectId && item.email && item.isCurrent !== false)
    .sort((a, b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0))[0];
}

function emailCandidatesFor(prospect) {
  const sources = candidateRows.filter((item) => item.prospectId === prospect.id && item.email && item.isCurrent !== false)
    .sort((a, b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0));
  const imported = Array.isArray(prospect.emailCandidates) ? prospect.emailCandidates : [];
  const manual = prospect.manualEmail ? [{ email: prospect.manualEmail, sourceUrl: prospect.manualSourceUrl || prospect.website || "", evidenceText: prospect.manualEvidenceText || "", sourceRouteLabel: "Imported or captured", requiresReview: true }] : [];
  const byEmail = new Map();
  for (const item of [...sources, ...imported, ...manual]) {
    const email = String(item.email || "").trim().toLowerCase();
    if (!email) continue;
    const entry = byEmail.get(email) || { ...item, email, id: item.id || "", confidenceScore: Number(item.confidenceScore || 0), sources: [] };
    entry.sources.push(item);
    if (Number(item.confidenceScore || 0) > Number(entry.confidenceScore || 0)) {
      entry.id = item.id || entry.id;
      entry.confidenceScore = Number(item.confidenceScore || 0);
      entry.sourceRouteLabel = item.sourceRouteLabel || item.sourceRoute || entry.sourceRouteLabel;
    }
    byEmail.set(email, entry);
  }
  return [...byEmail.values()];
}

function profileDocsFor(prospectId) {
  return candidateRows.filter((item) => item.prospectId === prospectId && item.candidateType === "business_profile" && item.isCurrent !== false);
}

function profileFor(prospectId) {
  return profileDocsFor(prospectId)[0];
}

function importedMeta(notes) {
  const text = String(notes || "");
  const marker = text.lastIndexOf(IMPORT_META_PREFIX);
  if (marker < 0) return {};
  try { return JSON.parse(text.slice(marker + IMPORT_META_PREFIX.length).trim()); }
  catch { return {}; }
}

function profileFacts(prospect) {
  const imported = importedMeta(prospect.notes);
  const profileDocs = profileDocsFor(prospect.id);
  const profiles = profileDocs.map((item) => item.profile || {});
  const pick = (key) => profiles.map((profile) => profile[key]).find((value) => value !== undefined && value !== null && value !== "") || "";
  const mergeBy = (items, keyFn, limit) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyFn(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
  };
  const socialUrls = [...new Set([...profiles.flatMap((profile) => Array.isArray(profile.socialUrls) ? profile.socialUrls : []), ...(Array.isArray(imported.socialUrls) ? imported.socialUrls : [])])].slice(0, 8);
  const businessPhones = mergeBy([
    ...(Array.isArray(prospect.businessPhones) ? prospect.businessPhones : []),
    ...profiles.flatMap((profile) => Array.isArray(profile.businessPhones) ? profile.businessPhones : []),
    ...(prospect.phone ? [normalizePublicPhone(prospect.phone, prospect.manualSourceUrl || prospect.website || "", "imported")].filter(Boolean) : [])
  ], (item) => String(item.e164 || item.raw || item.formatted || "").replace(/\D/g, "") || item.raw, 40);
  const publicContacts = mergeBy([
    ...(Array.isArray(prospect.publicContacts) ? prospect.publicContacts : []),
    ...profiles.flatMap((profile) => Array.isArray(profile.publicContacts) ? profile.publicContacts : [])
  ], (item) => String(item.name || "").trim().toLowerCase() + "|" + String(item.role || "").toLowerCase(), 20);
  const firstProfileUrl = profileDocs.find((item) => item.sourceUrl)?.sourceUrl || "";
  return {
    address: pick("address") || imported.address || "",
    postalCode: pick("postalCode") || imported.postalCode || "",
    email: pick("email") || prospect.manualEmail || "",
    phone: businessPhones[0]?.formatted || pick("phone") || prospect.phone || "",
    businessPhones,
    publicContacts,
    website: pick("website") || prospect.website || "",
    hours: pick("hours") || imported.hours || "",
    description: pick("description") || imported.description || "",
    rating: imported.rating || "",
    reviewCount: imported.reviewCount || "",
    placeId: imported.placeId || "",
    googleMapsUrl: imported.googleMapsUrl || "",
    socialUrls,
    evidenceUrl: firstProfileUrl,
  };
}

function statusPill(status) {
  const label = labels[status] || "New";
  return '<span class="status-badge ' + escapeHtml(status || "new") + '">' + escapeHtml(label) + "</span>";
}

function renderProspects() {
  const body = $("#leadRows");
  const needle = ($("#leadSearch")?.value || "").toLowerCase().trim();
  const status = $("#statusFilter")?.value || "";
  const category = $("#categoryFilter")?.value || "";
  const websiteFilter = $("#websiteFilter")?.value || "";
  const filtered = prospectRows.filter((prospect) => {
    const facts = profileFacts(prospect);
    const emails = emailCandidatesFor(prospect).map((item) => item.email);
    const names = facts.publicContacts.map((item) => item.name + " " + item.role);
    const phones = facts.businessPhones.map((item) => item.formatted || item.raw || item.e164);
    const text = [prospect.businessName, prospect.category, prospect.city, prospect.state, prospect.phone, prospect.website, facts.address, facts.description, ...emails, ...names, ...phones].join(" ").toLowerCase();
    const hasWebsite = Boolean(prospect.website || facts.website);
    return (!needle || text.includes(needle))
      && (!status || prospect.status === status)
      && (!category || prospect.category === category)
      && (!websiteFilter || (websiteFilter === "has" ? hasWebsite : !hasWebsite));
  });
  $("#leadCountBadge").textContent = String(prospectRows.length);
  $("#emptyLeads").classList.toggle("visible", prospectRows.length === 0);
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">' + (prospectRows.length ? "No prospects match these filters." : "Your list is empty.") + "</td></tr>";
    updateSelectionSummary();
    return;
  }
  body.innerHTML = filtered.map((prospect) => {
    const emails = emailCandidatesFor(prospect);
    const facts = profileFacts(prospect);
    const emailSummary = emails.length
      ? emails.slice(0, 6).map((item) => '<div class="contact-item"><b>' + escapeHtml(item.email) + '</b><small>' + (item.confidenceScore ? 'Evidence score ' + escapeHtml(item.confidenceScore) + '/10' : 'Source listed') + ' · ' + escapeHtml(item.sources.length) + ' source(s)</small></div>').join("") + (emails.length > 6 ? '<small>+' + (emails.length - 6) + ' more emails</small>' : '')
      : "";
    const phoneSummary = facts.businessPhones.slice(0, 3).map((item) => '<div class="contact-item"><b>' + escapeHtml(item.formatted || item.raw || item.e164) + '</b><small>' + (item.kind === "fax" ? "Fax number" : "Publicly listed number") + '</small></div>').join("") + (facts.businessPhones.length > 3 ? '<small>+' + (facts.businessPhones.length - 3) + ' more numbers</small>' : '');
    const peopleSummary = facts.publicContacts.slice(0, 3).map((item) => '<div class="contact-item"><b>' + escapeHtml(item.name) + '</b><small>' + escapeHtml(String(item.role || "public contact").replace(/_/g, " ")) + ' · source needs review</small></div>').join("") + (facts.publicContacts.length > 3 ? '<small>+' + (facts.publicContacts.length - 3) + ' more names</small>' : '');
    const contact = [emailSummary, phoneSummary, peopleSummary].filter(Boolean).join("") || '<span class="muted">' + (prospect.status === "not_found" ? "No public contact found" : "No contact candidate yet") + "</span>";
    const emailEvidence = emails.length
      ? '<details><summary class="evidence-link">Review ' + emails.length + ' email candidate(s)</summary><div class="evidence-box">' + emails.map((item) => '<div class="contact-evidence"><b>' + escapeHtml(item.email) + '</b>' + item.sources.map((source) => '<small>' + escapeHtml(source.sourceRouteLabel || source.sourceRoute || "Source") + ' · ' + escapeHtml(source.domainCheckLabel || "Mailbox not confirmed") + '</small><a href="' + escapeHtml(source.sourceUrl || "#") + '" target="_blank" rel="noopener">' + escapeHtml(source.sourceUrl || "No source URL") + '</a><p>' + escapeHtml(source.evidenceText || "No excerpt saved.") + '</p>').join("") + (item.id ? '<small>' + escapeHtml(item.scoreBasis || "Evidence score is a review rubric, not a probability.") + '</small><div class="feedback-actions"><button class="mini-button" data-feedback="' + escapeHtml(item.id) + '" data-label="correct">Correct</button><button class="mini-button" data-feedback="' + escapeHtml(item.id) + '" data-label="wrong">Wrong</button><button class="mini-button" data-feedback="' + escapeHtml(item.id) + '" data-label="stale">Stale</button></div>' : '') + '</div>').join("") + '</div></details>'
      : '<span class="muted">—</span>';
    const phoneText = facts.businessPhones.map((item) => [item.formatted || item.raw, item.e164 && item.e164 !== item.formatted ? item.e164 : ""].filter(Boolean).join(" · ")).join("; ");
    const peopleText = facts.publicContacts.map((item) => item.name + " — " + String(item.role || "contact").replace(/_/g, " ")).join("; ");
    const factsList = [
      ["Address", facts.address], ["Postal code", facts.postalCode], ["Publicly listed phone numbers", phoneText || facts.phone], ["Website", facts.website], ["Hours", facts.hours],
      ["Rating", facts.rating], ["Reviews", facts.reviewCount], ["About", facts.description],
      ["Publicly named people and roles", peopleText],
      ["Google Place ID", facts.placeId],
    ].filter(([, value]) => value);
    const links = [facts.googleMapsUrl && ["Google Maps profile", facts.googleMapsUrl], facts.evidenceUrl && ["Crawled source", facts.evidenceUrl], ...facts.socialUrls.map((url) => ["Social profile", url])].filter(Boolean);
    const contactSources = [...facts.businessPhones, ...facts.publicContacts].map((item) => '<div class="contact-evidence"><b>' + escapeHtml(item.formatted || item.name || item.raw || "Public contact") + (item.role ? ' · ' + escapeHtml(String(item.role).replace(/_/g, " ")) : '') + '</b><small>' + escapeHtml(item.sourceRoute || "Source") + (item.kind ? ' · ' + escapeHtml(item.kind.replace(/_/g, " ")) : '') + '</small><p>' + escapeHtml(item.evidenceText || "Source-listed business contact; confirm before use.") + '</p>' + (item.sourceUrl ? '<a href="' + escapeHtml(item.sourceUrl) + '" target="_blank" rel="noopener">Open evidence source ↗</a>' : '') + '</div>').join("");
    const profileEvidence = factsList.length || links.length || contactSources
      ? '<details><summary class="evidence-link">Business information</summary><div class="evidence-box">' + factsList.map(([label, value]) => '<small><b>' + escapeHtml(label) + ':</b> ' + escapeHtml(value) + '</small>').join("") + links.map(([label, url]) => '<small><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(label) + ' ↗</a></small>').join("") + contactSources + '</div></details>'
      : "";
    const evidence = '<div class="evidence-stack">' + emailEvidence + profileEvidence + '</div>';
    const location = [prospect.city, prospect.state].filter(Boolean).join(", ") || "—";
    const lookupNote = prospect.lastLookupNote ? '<small class="muted">' + escapeHtml(prospect.lastLookupNote) + '</small>' : '';
    return '<tr data-id="' + escapeHtml(prospect.id) + '"><td><input class="lead-check" type="checkbox" value="' + escapeHtml(prospect.id) + '" aria-label="Select ' + escapeHtml(prospect.businessName) + '"></td><td><div class="business-cell"><b>' + escapeHtml(prospect.businessName) + '</b><small>' + escapeHtml(prospect.category || "Business") + '</small></div></td><td>' + escapeHtml(location) + '</td><td>' + contact + '</td><td>' + statusPill(prospect.status) + lookupNote + '</td><td>' + evidence + '</td><td><div class="row-actions"><button class="mini-button" data-row-action="queue" data-id="' + escapeHtml(prospect.id) + '">Queue</button><button class="mini-button" data-row-action="delete" data-id="' + escapeHtml(prospect.id) + '" title="Delete prospect">×</button></div></td></tr>';
  }).join("");
  updateSelectionSummary();
}

function updateMetrics() {
  $("#metricProspects").textContent = String(prospectRows.length);
  $("#metricFound").textContent = String(prospectRows.filter((item) => emailCandidatesFor(item).length > 0).length);
  $("#metricReview").textContent = String(prospectRows.filter((item) => item.status === "needs_review").length);
  $("#metricNotFound").textContent = String(prospectRows.filter((item) => item.status === "not_found").length);
}

function refreshCategoryFilter() {
  const select = $("#categoryFilter");
  const selected = select.value;
  const categories = [...new Set(prospectRows.map((item) => String(item.category || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All niches</option>' + categories.map((item) => '<option value="' + escapeHtml(item) + '">' + escapeHtml(item) + '</option>').join("");
  if (categories.includes(selected)) select.value = selected;
}

function renderJobs() {
  const container = $("#jobsList");
  if (!jobRows.length) {
    container.innerHTML = '<div class="empty-help visible"><div class="empty-illustration">◷</div><b>No jobs yet</b><p>Select prospects and queue them to start.</p></div>';
    $("#startQueuedJobs").disabled = true;
    $("#startQueuedJobs").textContent = "No queued jobs";
    return;
  }
  const queuedCount = jobRows.filter((job) => job.status === "queued").length;
  $("#startQueuedJobs").disabled = queuedCount === 0;
  $("#startQueuedJobs").textContent = queuedCount ? "Start crawling " + queuedCount + " queued job" + (queuedCount === 1 ? "" : "s") + " →" : "No queued jobs";
  container.innerHTML = jobRows.map((job) => {
    const progress = Math.max(0, Math.min(100, Number(job.progressPercent || 0)));
    const created = job.createdAt?.toDate ? job.createdAt.toDate().toLocaleString() : "Just created";
    const attempt = Number(job.attemptCount || 0);
    return '<article class="job-card"><div class="job-top"><b>Prospect batch · ' + escapeHtml(job.requestedCount || 0) + ' records</b>' + statusPill(job.status) + '</div><div class="job-meta"><span>Created ' + escapeHtml(created) + (attempt > 1 ? ' · recovery attempt ' + escapeHtml(attempt) : '') + '</span><span>' + escapeHtml(job.progress || 0) + ' / ' + escapeHtml(job.requestedCount || 0) + ' processed</span></div><div class="progress-track"><div class="progress-bar" style="width:' + progress + '%"></div></div>' + (job.lastError ? '<p class="fine-print">' + escapeHtml(job.lastError) + '</p>' : "") + "</article>";
  }).join("");
}

function normalizeImportKey(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted && ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
    else if (quoted && ch === '"') quoted = false;
    else if (!quoted && ch === '"' && !cell.trim()) { cell = ""; quoted = true; }
    else if (!quoted && ch === ",") { row.push(cell.trim()); cell = ""; }
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error("This CSV has an unmatched quotation mark. Export it again as CSV, or save it as JSON.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map(normalizeImportKey);
  return rows.map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] || ""])));
}

function firstValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

function listValues(value, separators = /[,;|\n]+/) {
  if (Array.isArray(value)) return value.flatMap((item) => item && typeof item === "object" ? [item] : listValues(item, separators));
  if (value && typeof value === "object") return [value];
  return String(value || "").split(separators).map((item) => item.trim()).filter(Boolean);
}

function structuredValues(value, separators) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  const text = String(value || "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return listValues(text, separators);
}

function restoreManagementPhoneExport(value) {
  return String(value || "").replace(/^'\s*async function importList\(event\)\{/i, "+").trim();
}

function normalizePublicPhone(value, sourceUrl = "", sourceRoute = "imported", evidenceText = "") {
  if (value && typeof value === "object") {
    const raw = restoreManagementPhoneExport(value.raw || value.formatted || value.e164 || "");
    if (!raw) return null;
    const sourceUrlValue = value.sourceUrl || value.source_url || sourceUrl;
    const sourceRouteValue = value.sourceRoute || value.source_route || sourceRoute;
    const evidenceValue = value.evidenceText || value.evidence_text || evidenceText;
    const normalized = normalizePublicPhone(raw, sourceUrlValue, sourceRouteValue, evidenceValue);
    return { ...normalized, ...value, raw, formatted: restoreManagementPhoneExport(value.formatted || "") || normalized.formatted, e164: value.e164 || normalized.e164, sourceUrl: sourceUrlValue, sourceRoute: sourceRouteValue, evidenceText: evidenceValue };
  }
  // The management CSV exporter prefixes formula-leading cells with this exact
  // string. Restore the original international plus so imported numbers remain clean.
  const raw = restoreManagementPhoneExport(value).replace(/\s+/g, " ").slice(0, 80);
  if (!raw) return null;
  const extension = raw.match(/(?:ext\.?|x)\s*(\d{1,6})$/i)?.[1] || "";
  const base = raw.replace(/(?:ext\.?|x)\s*\d{1,6}$/i, "").trim();
  const digits = base.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  let e164 = "";
  let formatted = raw;
  if (base.startsWith("+") && digits.length >= 8 && digits.length <= 15) e164 = "+" + digits;
  else if (digits.length === 10 && /^[2-9]/.test(digits[0]) && /^[2-9]/.test(digits[3])) e164 = "+1" + digits;
  else if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits[1]) && /^[2-9]/.test(digits[4])) e164 = "+" + digits;
  if (e164.startsWith("+1") && e164.replace(/\D/g, "").length === 11) {
    const national = e164.replace(/\D/g, "").slice(1);
    formatted = "(" + national.slice(0, 3) + ") " + national.slice(3, 6) + "-" + national.slice(6);
  }
  if (extension) formatted += " ext. " + extension;
  return {
    raw,
    formatted: formatted.slice(0, 80),
    e164,
    extension,
    kind: /\bfax\b|facsimile/i.test(evidenceText) ? "fax" : "public_source_number",
    sourceRoute,
    sourceUrl: cleanUrl(sourceUrl),
    evidenceText: String(evidenceText || "").slice(0, 300),
    requiresReview: true
  };
}

function normalizeInput(row) {
  const fields = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [normalizeImportKey(key), value]));
  const businessName = firstValue(fields, ["businessname", "business_name", "business", "company", "company_name", "name", "title"]);
  if (!businessName) return null;
  const meta = {};
  const metaFields = [
    ["sourceRecordId", ["source_record_id", "external_record_id", "source_id"], 160],
    ["sourceLabel", ["source_label", "source_system", "source"], 100],
    ["websiteSource", ["website_source"], 80],
    ["sourceHasWebsite", ["has_website", "website_present"], 10],
    ["address", ["address", "full_address", "formatted_address", "street_address", "street"] , 240],
    ["postalCode", ["postal_code", "postcode", "zip", "zip_code"], 24],
    ["googleMapsUrl", ["google_maps_url", "google_map_url", "google_profile_url", "google_listing_link", "maps_url", "maps_link", "google_url"], 2048],
    ["placeId", ["place_id", "google_place_id", "google_placeid"], 160],
    ["rating", ["rating", "stars", "average_rating", "avg_rating"], 24],
    ["reviewCount", ["review_count", "reviews_count", "reviews", "user_ratings_total", "rating_count"], 32],
    ["hours", ["hours", "opening_hours", "business_hours", "working_hours"], 260],
    ["description", ["business_description", "description", "about", "summary"], 260],
  ];
  for (const [key, aliases, limit] of metaFields) {
    let value = firstValue(fields, aliases);
    if (key === "googleMapsUrl") value = cleanGoogleMapsUrl(value);
    if (value) meta[key] = value.slice(0, limit);
  }
  const socialUrls = ["facebook", "instagram", "linkedin", "tiktok", "youtube"].map((network) =>
    cleanUrl(firstValue(fields, [network, network + "_url", network + "_link"]))
  ).filter(Boolean);
  socialUrls.push(...firstValue(fields, ["social_urls", "social_links"]).split(/[\s,|]+/).map(cleanUrl).filter(Boolean));
  if (socialUrls.length) meta.socialUrls = [...new Set(socialUrls)].slice(0, 5);
  const sourceUrl = cleanUrl(firstValue(fields, ["source_url", "website", "website_url", "business_website", "url"]));
  const emailEvidence = firstValue(fields, ["evidencetext", "evidence_text", "email_evidence"]);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
  const emailValues = Object.entries(fields)
    .filter(([key]) => /^(?:email|email_address|primary_email|business_email|contact_email|website_email|owner_email|founder_email|principal_email|personal_email|emails|all_emails|public_emails|email_candidates)(?:_\d+)?$/.test(key))
    .flatMap(([key, value]) => structuredValues(value, /[,;|\n]+/));
  emailValues.sort((a, b) => Number(Boolean(b && typeof b === "object" && (b.sourceRoute || b.sourceUrl || b.evidenceText))) - Number(Boolean(a && typeof a === "object" && (a.sourceRoute || a.sourceUrl || a.evidenceText))));
  const emailCandidates = [];
  const seenEmails = new Set();
  for (const value of emailValues) {
    const item = value && typeof value === "object" ? value : { email: value };
    const email = String(item.email || "").trim().toLowerCase();
    const route = item.sourceRoute || item.source_route || "user_import";
    const candidateUrl = cleanUrl(item.sourceUrl || item.source_url || sourceUrl);
    const identity = [email, route, candidateUrl].join("|").toLowerCase();
    if (!emailRegex.test(email) || seenEmails.has(identity)) continue;
    seenEmails.add(identity);
    emailCandidates.push({
      email,
      sourceRoute: route,
      sourceRouteLabel: item.sourceRouteLabel || item.source_route_label || "Imported or captured",
      sourceUrl: candidateUrl,
      evidenceText: String(item.evidenceText || item.evidence_text || emailEvidence || "").slice(0, 300),
      confidenceScore: Math.max(0, Math.min(10, Number(item.confidenceScore || item.confidence_score || 0))),
      domainCheckLabel: String(item.domainCheckLabel || item.domain_check_label || "Mailbox not verified").slice(0, 100),
      requiresReview: true
    });
    if (emailCandidates.length >= 40) break;
  }
  const phoneValues = Object.entries(fields)
    .filter(([key]) => /^(?:phone|phone_number|telephone|telephone_number|tel|business_phone|primary_phone|phone_numbers|business_phones|phones|phone_candidates|phone_evidence)(?:_\d+)?$/.test(key))
    .flatMap(([, value]) => structuredValues(value, /[;,|\n]+/));
  phoneValues.sort((a, b) => Number(Boolean(b && typeof b === "object" && (b.sourceRoute || b.sourceUrl || b.evidenceText))) - Number(Boolean(a && typeof a === "object" && (a.sourceRoute || a.sourceUrl || a.evidenceText))));
  const businessPhones = [];
  const seenPhones = new Set();
  for (const value of phoneValues) {
    const item = normalizePublicPhone(value, sourceUrl, "user_import", firstValue(fields, ["phone_evidence", "phone_evidence_text"]));
    if (!item) continue;
    const key = String(item.e164 || item.raw).replace(/\D/g, "") || item.raw;
    if (!key || seenPhones.has(key)) continue;
    seenPhones.add(key);
    businessPhones.push(item);
    if (businessPhones.length >= 40) break;
  }
  const publicContacts = [];
  const contactValues = structuredValues(fields.public_contacts || fields.contacts || [], /[;|\n]+/);
  for (const value of contactValues) {
    if (!value || typeof value !== "object" || !String(value.name || "").trim()) continue;
    publicContacts.push({
      name: String(value.name).trim().slice(0, 100),
      role: String(value.role || "business_contact").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60),
      sourceRoute: value.sourceRoute || value.source_route || "user_import",
      sourceUrl: cleanUrl(value.sourceUrl || value.source_url || sourceUrl),
      evidenceText: String(value.evidenceText || value.evidence_text || "").slice(0, 300),
      requiresReview: true
    });
  }
  const explicitRoles = [
    ["owner_name", "owner"], ["owner", "owner"], ["founder_name", "founder"], ["founder", "founder"],
    ["registered_agent", "registered_agent"], ["registered_agent_name", "registered_agent"],
    ["authorized_person", "authorized_person"], ["organizer", "organizer"], ["manager_name", "manager"],
    ["president_name", "president"], ["officer_name", "officer"], ["director_name", "director"],
    ["contact_name", "business_contact"]
  ];
  for (const [field, role] of explicitRoles) {
    const name = firstValue(fields, [field]);
    if (name) publicContacts.push({ name: name.slice(0, 100), role, sourceRoute: "user_import", sourceUrl, evidenceText: firstValue(fields, ["contact_evidence", "owner_evidence"]).slice(0, 300), requiresReview: true });
  }
  const uniqueContacts = [...new Map(publicContacts.map((person) => [(person.name + "|" + person.role).toLowerCase(), person])).values()].slice(0, 20);
  let city = firstValue(fields, ["city", "town", "locality"]);
  let state = firstValue(fields, ["state", "region", "province"]);
  const stateCodes = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
  const cityState = city.match(/^(.+?),\s*([A-Z]{2})$/);
  if (cityState && stateCodes.has(cityState[2])) {
    city = cityState[1].trim();
    if (!state) state = cityState[2];
  }
  const baseNotes = firstValue(fields, ["notes", "internal_notes"]).slice(0, Object.keys(meta).length ? 120 : 500);
  let notes = baseNotes;
  if (Object.keys(meta).length) {
    const entries = Object.entries(meta);
    while (entries.length && (baseNotes.length + 1 + IMPORT_META_PREFIX.length + JSON.stringify(Object.fromEntries(entries)).length > 500)) entries.pop();
    const encoded = JSON.stringify(Object.fromEntries(entries));
    notes = [baseNotes, IMPORT_META_PREFIX + encoded].filter(Boolean).join("\n").slice(0, 500);
  }
  const sourceUrls = Object.entries(fields)
    .filter(([key]) => /^(?:source_url|source_urls|public_source_url|contact_page_url|website_contact_url|filing_url|registry_url)(?:_\d+)?$/.test(key))
    .flatMap(([, value]) => structuredValues(value, /[,;|\n]+/))
    .map(cleanUrl)
    .filter(Boolean);
  return {
    businessName: businessName.slice(0, 160),
    category: firstValue(fields, ["category", "industry", "type", "niche", "business_type"]).slice(0, 80),
    city: city.slice(0, 100),
    state: state.slice(0, 50),
    phone: businessPhones[0]?.formatted || firstValue(fields, ["phone", "phone_number", "telephone", "tel", "business_phone", "primary_phone"]).slice(0, 40),
    website: cleanUrl(firstValue(fields, ["website", "website_url", "business_website", "url", "domain"])),
    sourceUrlsText: [...new Set(sourceUrls)].slice(0, 12).join("\n").slice(0, 4000),
    notes,
    manualEmail: emailCandidates[0]?.email || "",
    manualEvidenceText: emailEvidence.slice(0, 500),
    manualSourceUrl: cleanUrl(firstValue(fields, ["manualsourceurl", "manual_source_url", "sourceurl", "source_url"])),
    emailCandidates,
    businessPhones,
    publicContacts: uniqueContacts,
    status: "new"
  };
}

function cleanUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw) && /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) raw = "https://" + raw;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return "";
    if (parsed.port && !["80", "443"].includes(parsed.port)) return "";
    parsed.hash = "";
    return parsed.toString().slice(0, 2048);
  } catch { return ""; }
}

function cleanGoogleMapsUrl(value) {
  const clean = cleanUrl(value);
  if (!clean) return "";
  try {
    const url = new URL(clean);
    if (!/(^|\.)google\.[a-z.]+$/i.test(url.hostname) || !/\/maps\//i.test(url.pathname)) return "";
    const detailsIndex = url.pathname.search(/\/data[=!]/i);
    if (detailsIndex >= 0) url.pathname = url.pathname.slice(0, detailsIndex);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:authuser|hl|rclk|entry|g_ep|utm_.*|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString().slice(0, 2048);
  } catch { return ""; }
}

async function saveProspects(records, { fromCapture = false } = {}) {
  if (!Array.isArray(records) || records.length > 5000) throw new Error("Import up to 5,000 prospects at a time.");
  const normalized = records.map((record) => normalizeInput(record));
  const clean = normalized.filter(Boolean);
  const invalidRows = normalized.length - clean.length;
  if (!clean.length) {
    if (!records.length) throw new Error("No data rows were found. Keep the first row as column headers and include at least one business.");
    const headers = Object.keys(records[0] || {}).slice(0, 20).join(", ") || "No headers detected";
    throw new Error("I read " + records.length + " row(s), but could not find a business name in any row. Headers detected: " + headers + ". Use Business Name, businessName, business_name, Business, Company, or Name as the column header.");
  }
  const seen = new Set(prospectRows.map((p) => [p.businessName, p.city, p.phone].join("|").toLowerCase()));
  const newRows = clean.filter((item) => {
    const key = [item.businessName, item.city, item.phone].join("|").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!newRows.length) return { added: 0, duplicates: clean.length, invalidRows, fromCapture };
  const ids = [];
  for (let start = 0; start < newRows.length; start += 400) {
    const batch = writeBatch(db);
    const chunkIds = [];
    newRows.slice(start, start + 400).forEach((item) => {
      const ref = doc(userCollection("prospects"));
      chunkIds.push(ref.id);
      batch.set(ref, { ...item, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    try {
      await batch.commit();
      ids.push(...chunkIds);
    } catch (error) {
      if (ids.length) throw new Error(ids.length + " prospects were saved before the connection failed. Re-import the same file after reconnecting; saved duplicates will be skipped. " + friendlyError(error));
      throw error;
    }
  }
  return { added: newRows.length, duplicates: clean.length - newRows.length, invalidRows, fromCapture, ids };
}

async function queueIdsInBatches(ids) {
  let allStarted = true;
  for (let start = 0; start < ids.length; start += 400) {
    const started = await queueProspects(ids.slice(start, start + 400), { allowUnloaded: true, throwOnError: true });
    if (!started) allStarted = false;
  }
  return allStarted;
}

async function importFile(file) {
  if (file.size > 5_000_000) throw new Error("Import files must be 5 MB or smaller. Split this list into smaller batches.");
  const text = await file.text();
  let values;
  if (file.name.toLowerCase().endsWith(".json") || file.type.includes("json")) {
    const parsed = JSON.parse(text);
    if (parsed?.format === "vivara-forge-backup-v1" && Array.isArray(parsed.prospects)) values = parsed.prospects;
    else values = Array.isArray(parsed) ? parsed : [parsed.prospect || parsed];
  } else values = parseCSV(text);
  const result = await saveProspects(values);
  const skippedText = result.invalidRows ? "; skipped " + result.invalidRows + " row(s) without a recognized business name" : "";
  if ($("#autoQueueImports").checked && result.ids?.length) {
    let started;
    try { started = await queueIdsInBatches(result.ids); }
    catch (error) { throw new Error("Prospects were imported, but queuing failed: " + friendlyError(error)); }
    showToast(started
      ? "Imported and started crawling " + result.added + " prospects; skipped " + result.duplicates + " duplicates" + skippedText + "."
      : "Imported " + result.added + " prospects. Jobs are saved, but the worker needs setup before crawling can start." + skippedText,
      !started);
  } else showToast("Imported " + result.added + " prospects; skipped " + result.duplicates + " duplicates" + skippedText + ".");
}

function downloadJsonFile(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBackupJSON() {
  const prospects = prospectRows.map((row) => {
    const facts = profileFacts(row);
    const emailCandidates = emailCandidatesFor(row).flatMap((item) => (item.sources.length ? item.sources : [item]).map((source) => ({
      email: item.email,
      sourceRoute: source.sourceRoute || "",
      sourceRouteLabel: source.sourceRouteLabel || source.sourceRoute || "",
      sourceUrl: source.sourceUrl || "",
      evidenceText: source.evidenceText || "",
      confidenceScore: Number(item.confidenceScore || 0),
      requiresReview: source.requiresReview !== false
    })));
    return {
      businessName: row.businessName || "",
      category: row.category || "",
      city: row.city || "",
      state: row.state || "",
      phone: facts.phone || row.phone || "",
      businessPhones: facts.businessPhones,
      website: facts.website || row.website || "",
      sourceUrlsText: row.sourceUrlsText || facts.evidenceUrl || "",
      notes: row.notes || "",
      emailCandidates,
      publicContacts: facts.publicContacts,
      address: facts.address,
      postalCode: facts.postalCode,
      hours: facts.hours,
      description: facts.description,
      rating: facts.rating,
      reviewCount: facts.reviewCount,
      googleMapsUrl: facts.googleMapsUrl,
      socialUrls: facts.socialUrls
    };
  });
  let diagnostics = [];
  try { diagnostics = JSON.parse(safeStorageGet("vivaraDiagnostics", "[]")); } catch {}
  const backup = {
    format: "vivara-forge-backup-v1",
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    accountUid: currentUser?.uid || "",
    prospects,
    jobHistory: jobRows.map((job) => ({
      id: job.id,
      status: job.status || "",
      requestedCount: Number(job.requestedCount || 0),
      progress: Number(job.progress || 0),
      progressPercent: Number(job.progressPercent || 0),
      attemptCount: Number(job.attemptCount || 0),
      lastError: sanitizeDiagnostic(job.lastError || "")
    })),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.slice(-25) : []
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJsonFile("vivara-forge-backup-" + stamp + ".json", backup);
  showToast("Full recovery backup downloaded.");
}

function selectedProspectIds() {
  return $$(".lead-check:checked").map((item) => item.value);
}

function updateSelectionSummary() {
  const selectedCount = selectedProspectIds().length;
  const boxes = $$(".lead-check");
  const selectAll = $("#selectAll");
  selectAll.checked = boxes.length > 0 && selectedCount === boxes.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < boxes.length;
  $("#selectionSummary").textContent = selectedCount + " selected";
  const button = $("#queueSelected");
  if (selectedCount) button.textContent = "Start crawling " + selectedCount + " selected →";
  else {
    const newCount = prospectRows.filter((item) => item.status === "new").length;
    button.textContent = newCount ? "Start crawling " + newCount + " new prospects →" : "Select prospects to crawl";
    button.disabled = newCount === 0;
  }
  if (selectedCount) button.disabled = false;
}

function setQueueNotice(message, isError = false) {
  const notice = $("#queueNotice");
  notice.classList.toggle("hidden", !message);
  notice.classList.toggle("warning", isError);
  notice.classList.toggle("success", Boolean(message) && !isError);
  notice.querySelector("p").textContent = message || "";
}

async function startSelectedCrawl() {
  const selected = selectedProspectIds();
  const ids = selected.length
    ? selected
    : prospectRows.filter((item) => item.status === "new").map((item) => item.id);
  if (!ids.length) return showToast("Select at least one prospect that can be checked.", true);
  const button = $("#queueSelected");
  button.disabled = true;
  button.textContent = "Saving crawl jobs…";
  try {
    await queueIdsInBatches(ids);
  } catch (error) {
    showToast(friendlyError(error), true);
  } finally {
    button.disabled = false;
    updateSelectionSummary();
  }
}

async function startQueuedJobs() {
  const queued = jobRows.filter((job) => job.status === "queued");
  if (!queued.length) return showToast("There are no queued jobs waiting to start.", true);
  const button = $("#startQueuedJobs");
  button.disabled = true;
  button.textContent = "Contacting worker…";
  setQueueNotice("Sending " + queued.length + " saved job" + (queued.length === 1 ? "" : "s") + " to the background worker…");
  let started = 0;
  try {
    for (const job of queued) {
      const result = await workerRequest("/api/wake", {
        method: "POST",
        body: JSON.stringify({ job_id: job.id })
      }, { attempts: 1, timeoutMs: 12000 });
      if (result.started || result.status === "running" || result.status === "already_running") started += 1;
    }
    setWorkerStatus(true, "Worker accepted saved jobs.", "Worker connected");
    setQueueNotice("Worker accepted " + started + " saved job" + (started === 1 ? "" : "s") + ". You can close this page; processing runs on the server.");
    showToast("Background crawling started for " + started + " queued job" + (started === 1 ? "" : "s") + ".");
  } catch (error) {
    const detail = friendlyError(error);
    setWorkerStatus(false, detail, "Worker setup needed");
    setQueueNotice("Jobs are still safely saved in Firestore, but crawling did not start: " + detail, true);
    showToast("Jobs saved; crawling did not start: " + detail, true);
  } finally {
    renderJobs();
  }
}

async function queueProspects(ids, { allowUnloaded = false, throwOnError = false } = {}) {
  if (!currentUser) {
    if (throwOnError) throw new Error("Sign in first.");
    return false;
  }
  const chosen = ids.length ? ids : prospectRows.filter((item) => item.status === "new").map((item) => item.id);
  if (!chosen.length) {
    if (throwOnError) throw new Error("Select at least one new prospect.");
    showToast("Select at least one new prospect.", true);
    return false;
  }
  const validIds = chosen.filter((id) => {
    const record = prospectRows.find((item) => item.id === id);
    return record ? ["new", "not_found", "failed", "needs_review", "found"].includes(record.status) : allowUnloaded;
  });
  if (!validIds.length) {
    if (throwOnError) throw new Error("Those prospects are already queued or running.");
    showToast("Those prospects are already queued or running.", true);
    return false;
  }
  if (validIds.length > 400) {
    if (throwOnError) throw new Error("Queue up to 400 prospects per batch.");
    showToast("Queue up to 400 prospects per batch.", true);
    return false;
  }
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
    setQueueNotice(validIds.length + " prospect" + (validIds.length === 1 ? " is" : "s are") + " saved. Starting the background worker…");
    const base = getBackendUrl();
    let started = false;
    if (base) {
      try {
        await workerRequest("/api/wake", {
          method: "POST",
          body: JSON.stringify({ job_id: jobRef.id })
        }, { attempts: 1, timeoutMs: 12000 });
        started = true;
        setWorkerStatus(true, "Worker accepted the job.", "Worker connected");
        setQueueNotice("Worker accepted " + validIds.length + " prospect" + (validIds.length === 1 ? "" : "s") + ". Processing continues on the server if you close this page.");
        showToast("Crawling started for " + validIds.length + " prospect" + (validIds.length === 1 ? "" : "s") + ".");
      } catch (error) {
        recordClientError("wake queued job", error);
        const detail = friendlyError(error);
        setWorkerStatus(false, detail, "Worker setup needed");
        setQueueNotice("Saved safely in Firestore, but crawling did not start: " + detail, true);
        showToast("Saved, but crawling did not start: " + detail, true);
      }
    } else {
      setWorkerStatus(false, "Add the Hugging Face worker URL in Settings.", "Worker setup needed");
      setQueueNotice("Saved safely in Firestore, but the worker URL is missing. Open Settings and save the Hugging Face worker URL.", true);
      showToast("Prospects saved, but crawling did not start. Add the worker URL in Settings.", true);
    }
    return started;
  } catch (error) {
    if (throwOnError) throw error;
    showToast(friendlyError(error), true);
    return false;
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
    if (result.ids?.length && $("#autoQueueImports").checked) {
      try {
        const started = await queueIdsInBatches(result.ids);
        if (started) showToast("Prospect saved and crawling started.");
      } catch (error) {
        showToast("Prospect saved, but queuing failed: " + friendlyError(error), true);
      }
    } else showToast(result.added ? "Prospect saved." : "That prospect is already in your list.");
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
  const header = ["business_name", "category", "address", "postal_code", "city", "state", "phone", "business_phones", "phone_evidence", "website", "hours", "rating", "review_count", "google_place_id", "google_maps_url", "social_urls", "public_contacts", "status", "email", "all_emails", "email_candidates", "confidence_score", "source_url", "evidence_text"];
  const lines = [header.join(",")];
  for (const row of prospectRows) {
    const candidate = candidateFor(row.id);
    const facts = profileFacts(row);
    const emails = emailCandidatesFor(row);
    const phoneList = facts.businessPhones.map((item) => [item.formatted || item.raw, item.e164].filter(Boolean).join(" ")).join(" | ");
    const publicContacts = JSON.stringify(facts.publicContacts);
    const phoneEvidence = JSON.stringify(facts.businessPhones);
    const emailCandidates = JSON.stringify(emails.flatMap((item) => (item.sources.length ? item.sources : [item]).map((source) => ({ email: item.email, sourceRoute: source.sourceRoute || "", sourceRouteLabel: source.sourceRouteLabel || source.sourceRoute || "", sourceUrl: source.sourceUrl || "", evidenceText: source.evidenceText || "", confidenceScore: item.confidenceScore, requiresReview: source.requiresReview !== false }))));
    const values = [row.businessName, row.category, facts.address, facts.postalCode, row.city, row.state, facts.phone, phoneList, phoneEvidence, facts.website, facts.hours, facts.rating, facts.reviewCount, facts.placeId, facts.googleMapsUrl, facts.socialUrls.join(" | "), publicContacts, row.status, candidate?.email || row.manualEmail, emails.map((item) => item.email).join(" | "), emailCandidates, candidate?.confidenceScore, candidate?.sourceUrl || row.manualSourceUrl, candidate?.evidenceText || row.manualEvidenceText];
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

function setWorkerStatus(online, message, label = "") {
  const text = label || (online ? "Worker connected" : "Worker not connected");
  $("#workerBadge").innerHTML = "<i></i>" + text;
  $("#workerBadge").classList.toggle("offline", !online);
  $("#queueWorkerStatus").classList.toggle("offline", !online);
  $("#queueWorkerStatus").innerHTML = "<i></i>" + text;
  if (message) $("#backendMessage").textContent = message;
}

function normalizeBackendUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch { return ""; }
}

function getBackendUrl() {
  return normalizeBackendUrl(safeStorageGet("vivaraBackendUrl") || $("#backendUrl").value || "");
}

async function resilientFetch(url, options = {}, { attempts = 2, timeoutMs = 20000, context = "network request" } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (attempt < attempts && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.text().catch(() => "");
        await new Promise((resolve) => setTimeout(resolve, 450 * attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("Request timed out.") : error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 450 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  recordClientError(context, lastError);
  throw lastError || new Error("Network request failed.");
}

async function workerRequest(path, options = {}, requestOptions = {}) {
  const base = getBackendUrl();
  if (!base) throw new Error("Save the background worker URL in Settings first.");
  if (!currentUser) throw new Error("Sign in first.");
  const token = await currentUser.getIdToken();
  const response = await resilientFetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
      "Authorization": "Bearer " + token
    }
  }, { attempts: requestOptions.attempts ?? 2, timeoutMs: requestOptions.timeoutMs ?? 25000, context: "worker " + path });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "The worker request failed.");
  return data;
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function renderAdminAccounts() {
  const body = $("#adminAccountRows");
  const needle = $("#adminAccountSearch").value.trim().toLowerCase();
  const visible = adminAccounts.filter((account) => !needle || [account.email, account.displayName, account.uid].join(" ").toLowerCase().includes(needle));
  $("#adminAccountCount").textContent = String(adminAccounts.length);
  if (!visible.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">No matching accounts.</td></tr>';
    return;
  }
  body.innerHTML = visible.map((account) => {
    const locked = isAdminEmail({ email: account.email }) && account.emailVerified;
    const ranks = ["admin", "staff", "member", "viewer"].map((rank) => '<option value="' + rank + '" ' + (account.rank === rank ? "selected" : "") + ' ' + (rank === "admin" && !locked ? "disabled" : "") + '>' + rank.charAt(0).toUpperCase() + rank.slice(1) + '</option>').join("");
    const name = account.displayName ? '<small>' + escapeHtml(account.displayName) + '</small>' : '';
    return '<tr><td><b>' + escapeHtml(account.email || "No email") + '</b>' + name + '<small class="uid-small">' + escapeHtml(account.uid) + '</small></td><td>' + escapeHtml(formatDate(account.lastSignInAt)) + '</td><td>' + (account.emailVerified ? "Verified" : "Unverified") + (account.disabled ? " · Disabled" : "") + '</td><td><select data-account-rank="' + escapeHtml(account.uid) + '" ' + (locked ? "disabled" : "") + '>' + ranks + '</select></td><td><button class="mini-button" data-save-rank="' + escapeHtml(account.uid) + '" ' + (locked ? "disabled" : "") + '>' + (locked ? "Protected admin" : "Save rank") + '</button></td></tr>';
  }).join("");
}

async function loadAdminAccounts() {
  if (!isAdminUser()) return;
  $("#adminStatus").innerHTML = "<i></i>Loading accounts";
  $("#adminAccountsMessage").textContent = "Loading accounts…";
  try {
    const data = await workerRequest("/api/admin/accounts");
    adminAccounts = data.accounts || [];
    renderAdminAccounts();
    $("#adminStatus").innerHTML = "<i></i>Admin access ready";
    $("#adminAccountsMessage").textContent = "Showing registered accounts and their most recent sign-in.";
  } catch (error) {
    $("#adminStatus").innerHTML = "<i></i>Worker not available";
    $("#adminAccountsMessage").textContent = error.message || "Could not load accounts.";
    $("#adminAccountRows").innerHTML = '<tr><td colspan="5" class="empty-state">' + escapeHtml(error.message || "Connect the worker to load accounts.") + '</td></tr>';
  }
}

async function loadWakeSchedule() {
  if (!isAdminUser()) return;
  try {
    const data = await workerRequest("/api/admin/wake-schedule");
    $("#wakeInterval").value = data.enabled ? String(data.intervalMinutes) : "0";
    $("#wakeScheduleMessage").textContent = data.enabled
      ? "Enabled every " + data.intervalMinutes + " minutes. Next check: " + formatDate(data.nextRunAt) + (data.lastTriggeredAt ? " · Last check: " + formatDate(data.lastTriggeredAt) : "")
      : "Schedule is off.";
  } catch (error) {
    $("#wakeScheduleMessage").textContent = error.message || "Could not load the wake schedule.";
  }
}

async function loadAdminDashboard() {
  if (!isAdminUser()) return;
  await Promise.all([loadAdminAccounts(), loadWakeSchedule()]);
}

async function saveAdminRank(uid) {
  const select = document.querySelector('[data-account-rank="' + CSS.escape(uid) + '"]');
  if (!select) return;
  try {
    await workerRequest("/api/admin/accounts/" + encodeURIComponent(uid) + "/rank", {
      method: "PUT",
      body: JSON.stringify({ rank: select.value })
    });
    showToast("Account rank updated.");
    await loadAdminAccounts();
  } catch (error) {
    showToast(error.message || "Could not update account rank.", true);
  }
}

async function saveWakeSchedule() {
  const interval = Number($("#wakeInterval").value);
  $("#wakeScheduleMessage").textContent = "Saving schedule…";
  try {
    const data = await workerRequest("/api/admin/wake-schedule", {
      method: "PUT",
      body: JSON.stringify({ enabled: interval > 0, interval_minutes: interval })
    });
    $("#wakeScheduleMessage").textContent = data.enabled
      ? "Saved. The worker checks every " + data.intervalMinutes + " minutes; repository wake secrets must also be configured."
      : "Saved. Automatic wake is off.";
  } catch (error) {
    $("#wakeScheduleMessage").textContent = error.message || "Could not save the schedule.";
  }
}

async function resendVerification() {
  if (!currentUser || !isAdminEmail()) return;
  try {
    await sendEmailVerification(currentUser);
    $("#verificationMessage").textContent = "Verification email sent. Check your inbox, then return and tap “I verified it.”";
  } catch (error) {
    $("#verificationMessage").textContent = friendlyError(error);
  }
}

async function refreshVerification() {
  if (!auth.currentUser) return;
  try {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    currentUser = auth.currentUser;
    updateAdminVisibility();
    $("#verificationMessage").textContent = currentUser.emailVerified ? "Verified. Admin access is ready." : "The account service still shows this email as unverified. Open the verification link, then tap again.";
    if (isAdminUser()) showToast("Admin access is ready.");
  } catch (error) {
    $("#verificationMessage").textContent = friendlyError(error);
  }
}

async function checkBackend() {
  const base = getBackendUrl();
  if (!base) return showToast("Add the background worker URL first.", true);
  $("#backendMessage").textContent = "Checking worker…";
  try {
    const response = await resilientFetch(base + "/health", {}, { attempts: 2, timeoutMs: 15000, context: "worker health" });
    const data = await response.json();
    if (!response.ok || data.status !== "ok") throw new Error(data.message || "Worker did not return ready status.");
    const ready = Boolean(data.worker_ready);
    const message = ready
      ? "Worker is online and ready. Your two configured admin emails are recognized automatically."
      : "Space is online, but Firebase is not initialized. Add the FIREBASE_SERVICE_ACCOUNT_JSON secret in Hugging Face Space Settings. No ADMIN_UID is needed for the two admin emails.";
    setWorkerStatus(ready, message, ready ? "Worker connected" : "Worker setup needed");
    setQueueNotice(ready ? "Worker is online and ready to process saved jobs." : message, !ready);
    showToast(ready ? "Worker is online." : "Backend is online, but needs its Firebase service-account secret.", !ready);
  } catch (error) {
    setWorkerStatus(false, error.message || "Could not reach the worker.", "Worker unavailable");
    setQueueNotice(error.message || "Could not reach the worker.", true);
    showToast(error.message || "Could not reach the worker.", true);
  }
}

function renderLocalResults() {
  const container = $("#localResults");
  if (!localItems.length) { container.innerHTML = ""; return; }
  const websiteFilter = $("#localWebsiteFilter").value;
  const visible = localItems.map((item, index) => ({ item, index })).filter(({ item }) => {
    const hasWebsite = Boolean(item.website);
    return !websiteFilter || (websiteFilter === "has" ? hasWebsite : !hasWebsite);
  });
  container.innerHTML = visible.map(({ item, index }) => {
    const detail = [item.category, item.phone, item.website, item.email ? "Email tag: " + item.email : ""].filter(Boolean).join(" · ");
    const mapsQuery = [item.name, item.address, item.city, item.state].filter(Boolean).join(" ");
    const mapsUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(mapsQuery);
    return '<article class="local-result"><div><b>' + escapeHtml(item.name || "Unnamed business") + '</b><small>' + escapeHtml(item.address || item.city || "Location unavailable") + '</small><small>' + escapeHtml(detail || "No public contact tags") + '</small><small><a href="' + escapeHtml(item.sourceUrl || "#") + '" target="_blank" rel="noopener">Open source record ↗</a> · <a href="' + escapeHtml(mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps ↗</a></small></div><button class="button secondary" data-save-local="' + index + '">Save</button></article>';
  }).join("") || '<p class="empty-state">No results match the website filter.</p>';
}

function updateMapLink() {
  const category = $("#localCategory").selectedOptions[0]?.textContent || "businesses";
  const searchPhrase = $("#mapsSearchTerm").value.trim() || category;
  const queryText = currentLocation
    ? searchPhrase + " near " + currentLocation.lat.toFixed(4) + "," + currentLocation.lon.toFixed(4)
    : searchPhrase + " near me";
  const link = $("#openMaps");
  link.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(queryText);
  link.classList.remove("disabled-link");
}

async function runLocalSearch() {
  const base = getBackendUrl();
  if (!base) return showToast("Connect the background worker in Settings to search local open data.", true);
  if (!currentLocation) return showToast("Tap Use my location first.", true);
  $("#runLocalSearch").disabled = true;
  $("#runLocalSearch").textContent = "Searching…";
  try {
    const data = await workerRequest("/api/local-search", {
      method: "POST",
      body: JSON.stringify({
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        radius_m: Number($("#localRadius").value),
        category: $("#localCategory").value
      })
    });
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
      address: item.address || "",
      postalCode: item.postalCode || "",
      hours: item.hours || "",
      socialUrls: item.socialUrls || [],
      googleMapsUrl: item.googleMapsUrl || "",
      sourceUrlsText: item.sourceUrl || "",
      email: item.email || "",
      evidenceText: item.emailEvidence || "",
      manualSourceUrl: item.sourceUrl || "",
      notes: "Discovered from OpenStreetMap. Verify details before outreach."
    });
    if (!data) return showToast("This result has no business name.", true);
    const duplicate = prospectRows.some((p) => p.businessName.toLowerCase() === data.businessName.toLowerCase() && p.city === data.city);
    if (duplicate) return showToast("That business is already in your list.");
    const result = await saveProspects([data]);
    if (result.ids?.length && $("#autoQueueImports").checked) {
      try {
        const started = await queueIdsInBatches(result.ids);
        if (started) showToast("Saved and crawling started.");
      } catch (error) {
        showToast("Saved, but queuing failed: " + friendlyError(error), true);
      }
    } else {
      showToast(result.added ? "Saved to prospects." : "That business is already in your list.");
    }
  } catch (error) { showToast(friendlyError(error), true); }
}

async function importExtensionCapture(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const result = await saveProspects(items, { fromCapture: true });
    let started = false;
    if ($("#autoQueueImports").checked && result.ids?.length) {
      try { started = await queueIdsInBatches(result.ids); }
      catch (error) { throw new Error("Capture was imported, but queuing failed: " + friendlyError(error)); }
    }
    gotoView("prospects");
    const autoQueue = $("#autoQueueImports").checked && Boolean(result.ids?.length);
    showToast(!autoQueue
      ? "Imported " + result.added + " captured page(s)."
      : started
        ? "Imported and started crawling " + result.added + " captured page(s)."
        : "Imported " + result.added + " captured page(s). Jobs are saved, but the worker needs setup before crawling can start.",
      autoQueue && !started);
  } catch (error) { showToast(friendlyError(error), true); }
}

function buildMobileNav() {
  let nav = $(".mobile-nav");
  if (!nav) {
    nav = document.createElement("nav");
    nav.className = "mobile-nav";
    nav.setAttribute("aria-label", "Mobile navigation");
    $("#workspace").appendChild(nav);
  }
  const items = [
    ["overview", "◫", "Home"],
    ["prospects", "◎", "Leads"],
    ["local", "⌖", "Local"],
    ["jobs", "◷", "Queue"],
    ["settings", "⚙", "Settings"]
  ];
  if (isAdminUser()) items.splice(items.length - 1, 0, ["admin", "♙", "Admin"]);
  nav.innerHTML = items.map((item) => '<button data-view="' + item[0] + '" type="button"><span>' + item[1] + '</span>' + item[2] + "</button>").join("");
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
    try { await importFile(file); } catch (error) { showToast(friendlyError(error), true); }
    event.target.value = "";
  });
  $("#extensionImport").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importExtensionCapture(file);
    event.target.value = "";
  });
  $("#extensionImportTrigger").addEventListener("click", () => $("#extensionImport").click());
  $("#leadSearch").addEventListener("input", renderProspects);
  $("#categoryFilter").addEventListener("change", renderProspects);
  $("#websiteFilter").addEventListener("change", renderProspects);
  $("#statusFilter").addEventListener("change", renderProspects);
  $("#selectAll").addEventListener("change", (event) => {
    $$(".lead-check").forEach((item) => { item.checked = event.target.checked; });
    updateSelectionSummary();
  });
  $("#leadRows").addEventListener("change", (event) => {
    if (event.target.matches(".lead-check")) updateSelectionSummary();
  });
  $("#selectAllVisible").addEventListener("click", () => {
    const boxes = $$(".lead-check");
    const select = boxes.length > 0 && boxes.some((item) => !item.checked);
    boxes.forEach((item) => { item.checked = select; });
    updateSelectionSummary();
  });
  $("#queueSelected").addEventListener("click", startSelectedCrawl);
  $("#startQueuedJobs").addEventListener("click", startQueuedJobs);
  $("#exportLeads").addEventListener("click", exportCSV);
  $("#exportBackup").addEventListener("click", exportBackupJSON);
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
  $("#mapsSearchTerm").addEventListener("input", updateMapLink);
  $("#localWebsiteFilter").addEventListener("change", renderLocalResults);
  $("#runLocalSearch").addEventListener("click", runLocalSearch);
  $("#autoQueueImports").checked = safeStorageGet("vivaraAutoQueueImports") !== "false";
  $("#autoQueueImports").addEventListener("change", (event) => safeStorageSet("vivaraAutoQueueImports", String(event.target.checked)));
  $("#saveBackend").addEventListener("click", () => {
    const entered = $("#backendUrl").value.trim();
    const value = normalizeBackendUrl(entered);
    if (entered && !value) return showToast("Use an HTTPS worker URL without embedded credentials, query parameters, or fragments.", true);
    safeStorageSet("vivaraBackendUrl", value);
    $("#backendUrl").value = value;
    $("#backendMessage").textContent = value ? "Worker URL saved on this device." : "Worker URL cleared.";
    showToast(value ? "Worker URL saved." : "Worker URL cleared.");
  });
  $("#checkBackend").addEventListener("click", checkBackend);
  $("#resendVerification").addEventListener("click", resendVerification);
  $("#refreshVerification").addEventListener("click", refreshVerification);
  $("#refreshAdminAccounts").addEventListener("click", loadAdminAccounts);
  $("#adminAccountSearch").addEventListener("input", renderAdminAccounts);
  $("#saveWakeSchedule").addEventListener("click", saveWakeSchedule);
  $("#adminAccountRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-save-rank]");
    if (button) saveAdminRank(button.dataset.saveRank);
  });
  $("#userMenu").addEventListener("click", () => gotoView("settings"));
}

initEvents();
buildMobileNav();
$("#backendUrl").value = safeStorageGet("vivaraBackendUrl") || "";
updateMapLink();
window.addEventListener("error", (event) => recordClientError("uncaught error", event.error || event.message));
window.addEventListener("unhandledrejection", (event) => {
  recordClientError("unhandled promise rejection", event.reason);
  showToast("A background action failed safely. Your saved data was not cleared.", true);
});
window.addEventListener("offline", () => showToast("This device is offline. Saved cloud jobs remain queued.", true));
window.addEventListener("online", () => showToast("Connection restored."));
setPersistence(auth, browserLocalPersistence).catch((error) => {
  recordClientError("auth persistence fallback", error);
  setLoginMessage("Sign-in will work for this tab, but this browser blocked persistent login.");
});
onAuthStateChanged(auth, (user) => {
  if (user) beginWorkspace(user);
  else endWorkspace();
});
getRedirectResult(auth).catch((error) => setLoginMessage(friendlyError(error)));
