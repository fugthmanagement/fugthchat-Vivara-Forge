const $ = (selector) => document.querySelector(selector);
let capture = null;
let openTabs = [];

function message(text, error = false) {
  const node = $("#message");
  node.textContent = text;
  node.classList.toggle("error", error);
}

function isGoogleMaps(url) {
  try {
    const parsed = new URL(url);
    return (/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && /\/maps(?:\/|$)/i.test(parsed.pathname))
      || /(^|\.)maps\.google\./i.test(parsed.hostname)
      || parsed.hostname === "maps.app.goo.gl";
  } catch { return false; }
}

function schemaObjects(value, depth = 0) {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((item) => schemaObjects(item, depth + 1));
  if (!value || typeof value !== "object") return [];
  return [value, ...(value["@graph"] ? schemaObjects(value["@graph"], depth + 1) : [])];
}

function extractVisiblePage() {
  const bodyText = (document.body?.innerText || "").slice(0, 500000);
  const emailPattern = /(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/i;
  const structured = [];
  for (const node of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
    try {
      structured.push(...schemaObjects(JSON.parse((node.textContent || "").slice(0, 200000))));
      if (structured.length > 100) structured.length = 100;
    } catch {}
  }
  const business = structured.find((item) => {
    const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : String(item["@type"] || "");
    return /organization|localbusiness|store|professionalservice|medicalbusiness|automotivebusiness/i.test(type) && item.name;
  }) || structured.find((item) => item.name) || {};
  const textEmails = [...bodyText.matchAll(new RegExp(emailPattern.source, "ig"))].map((match) => match[0].replace(/[.,;:()\[\]{}<>"']+$/g, "").toLowerCase());
  const mailLinks = [...document.querySelectorAll('a[href^="mailto:"]')]
    .filter((anchor) => anchor.getClientRects().length)
    .map((anchor) => {
      const value = anchor.getAttribute("href").slice(7).split(/[?#]/)[0];
      try { return decodeURIComponent(value).trim().toLowerCase(); }
      catch { return value.trim().toLowerCase(); }
    });
  const schemaEmail = String(business.email || "").trim().toLowerCase();
  const emails = [...new Set([...textEmails, ...mailLinks, ...(schemaEmail ? [schemaEmail] : [])])].filter((email) => emailPattern.test(email)).slice(0, 40);
  const emailEvidence = emails.map((email) => {
    const index = bodyText.toLowerCase().indexOf(email);
    const evidence = index >= 0
      ? bodyText.slice(Math.max(0, index - 90), Math.min(bodyText.length, index + email.length + 90)).replace(/\s+/g, " ").trim()
      : schemaEmail === email ? "Email found in the page's Schema.org JSON-LD metadata." : "Visible mail link: " + email;
    return { email, evidence: evidence.slice(0, 300) };
  });
  const addressObj = business.address && typeof business.address === "object" ? business.address : {};
  const address = [addressObj.streetAddress, addressObj.addressLocality, addressObj.addressRegion, addressObj.postalCode]
    .filter(Boolean).join(", ");
  const phoneLinks = [...document.querySelectorAll('a[href^="tel:"]')]
    .filter((anchor) => anchor.getClientRects().length)
    .map((anchor) => ({ value: anchor.getAttribute("href").slice(4).trim(), evidence: anchor.innerText?.trim() || "Public telephone link on the page." }));
  const phonePattern = /(?<![A-Za-z0-9])(?:\+\d{1,3}[\s().-]*(?:\d[\s().-]*){7,12}|(?:\+?1[\s().-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})(?:\s*(?:ext\.?|x)\s*\d{1,6})?(?!\d)/ig;
  const visiblePhoneMatches = [...bodyText.matchAll(phonePattern)].map((match) => ({ value: match[0], evidence: bodyText.slice(Math.max(0, match.index - 70), Math.min(bodyText.length, match.index + match[0].length + 70)).replace(/\s+/g, " ").trim() }));
  const structuredPhones = Array.isArray(business.telephone) ? business.telephone : business.telephone ? [business.telephone] : [];
  const phoneCandidates = [];
  const seenPhones = new Set();
  for (const entry of [...phoneLinks, ...visiblePhoneMatches, ...structuredPhones.map((value) => ({ value: String(value), evidence: "Phone listed in the page's Schema.org business data." }))]) {
    const raw = String(entry.value || "").trim().slice(0, 80);
    const digits = raw.replace(/\D/g, "");
    const extension = raw.match(/(?:ext\.?|x)\s*(\d{1,6})$/i)?.[1] || "";
    const baseDigits = raw.replace(/(?:ext\.?|x)\s*\d{1,6}$/i, "").replace(/\D/g, "");
    let e164 = "";
    let formatted = raw;
    if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) e164 = "+" + digits;
    else if (baseDigits.length === 10 && /^[2-9]/.test(baseDigits[0]) && /^[2-9]/.test(baseDigits[3])) e164 = "+1" + baseDigits;
    else if (baseDigits.length === 11 && baseDigits.startsWith("1") && /^[2-9]/.test(baseDigits[1]) && /^[2-9]/.test(baseDigits[4])) e164 = "+" + baseDigits;
    if (e164.startsWith("+1") && e164.replace(/\D/g, "").length === 11) {
      const national = e164.replace(/\D/g, "").slice(1);
      formatted = "(" + national.slice(0, 3) + ") " + national.slice(3, 6) + "-" + national.slice(6);
    }
    if (extension) formatted += " ext. " + extension;
    const key = e164 || digits;
    if (!key || seenPhones.has(key)) continue;
    seenPhones.add(key);
    phoneCandidates.push({ raw, formatted, e164, extension, kind: /\bfax\b|facsimile/i.test(entry.evidence || "") ? "fax" : "public_source_number", sourceUrl: location.href, sourceRoute: "user_clicked_page_capture", evidenceText: String(entry.evidence || "").slice(0, 300), requiresReview: true });
    if (phoneCandidates.length >= 20) break;
  }
  const h1 = [...document.querySelectorAll("h1")].find((item) => item.getClientRects().length)?.innerText?.trim() || "";
  const rating = business.aggregateRating && typeof business.aggregateRating === "object" ? business.aggregateRating : {};
  const sameAs = typeof business.sameAs === "string" ? [business.sameAs] : Array.isArray(business.sameAs) ? business.sameAs : [];
  const publicContacts = [];
  const seenContacts = new Set();
  const addContact = (name, role, evidence) => {
    const cleanName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!cleanName || /\d|@|https?:\/\//i.test(cleanName) || /^(business name|company name|learn more)$/i.test(cleanName)) return;
    const key = cleanName.toLowerCase() + "|" + role;
    if (seenContacts.has(key)) return;
    seenContacts.add(key);
    publicContacts.push({ name: cleanName, role, sourceUrl: location.href, sourceRoute: "user_clicked_page_capture", evidenceText: String(evidence || "").slice(0, 300), requiresReview: true });
  };
  for (const field of ["owner", "founder", "founders", "member"]) {
    const values = Array.isArray(business[field]) ? business[field] : business[field] ? [business[field]] : [];
    for (const value of values) addContact(typeof value === "object" ? value.name : value, field === "founders" ? "founder" : field, "Schema.org business data identifies this public role.");
  }
  const personRolePattern = /\b(registered\s+agent|authorized\s+person(?:\(s\))?|managing\s+member|co[- ]?founder|chief\s+executive\s+officer|owner|founder|president|CEO|organizer|manager|member|director|officer)\s*(?:name\s*)?(?::|[-–]|\bis\b)?\s*([A-Z][A-Za-z'’.-]{1,40}(?:\s+(?:[A-Z][A-Za-z'’.-]{1,40}|[A-Z]\.)){1,3})/ig;
  for (const match of bodyText.matchAll(personRolePattern)) {
    const role = match[1].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const evidence = bodyText.slice(Math.max(0, match.index - 60), Math.min(bodyText.length, match.index + match[0].length + 80)).replace(/\s+/g, " ").trim();
    addContact(match[2], role, evidence);
    if (publicContacts.length >= 20) break;
  }
  const personRoleAfterName = /\b([A-Z][A-Za-z'’.-]{1,40}(?:\s+(?:[A-Z][A-Za-z'’.-]{1,40}|[A-Z]\.)){1,3})\s*[,|—–-]\s*(registered\s+agent|authorized\s+person(?:\(s\))?|managing\s+member|co[- ]?founder|chief\s+executive\s+officer|owner|founder|president|CEO|organizer|manager|member|director|officer)\b/ig;
  for (const match of bodyText.matchAll(personRoleAfterName)) {
    const role = match[2].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const evidence = bodyText.slice(Math.max(0, match.index - 60), Math.min(bodyText.length, match.index + match[0].length + 80)).replace(/\s+/g, " ").trim();
    addContact(match[1], role, evidence);
    if (publicContacts.length >= 20) break;
  }
  return {
    title: String(business.name || h1 || document.title || "").trim().slice(0, 160),
    url: location.href,
    host: location.hostname,
    emails: emailEvidence,
    phone: phoneCandidates[0]?.formatted || "",
    phones: phoneCandidates,
    publicContacts,
    address,
    hours: Array.isArray(business.openingHours) ? business.openingHours.join("; ") : String(business.openingHours || ""),
    description: String(business.description || document.querySelector('meta[name="description"]')?.content || "").slice(0, 500),
    rating: String(rating.ratingValue || ""),
    reviewCount: String(rating.reviewCount || rating.ratingCount || ""),
    socialUrls: [...new Set(sameAs.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)))].slice(0, 8),
    excerpt: bodyText.slice(0, 3000).replace(/\s+/g, " ").trim()
  };
}

async function fillTabChoices() {
  const select = $("#tabSelect");
  const tabs = await chrome.tabs.query({ currentWindow: true });
  openTabs = tabs.filter((tab) => tab.id && /^https?:\/\//i.test(tab.url || ""));
  const pages = openTabs;
  select.innerHTML = pages.map((tab) => {
    const host = (() => { try { return new URL(tab.url).hostname; } catch { return "web page"; } })();
    const label = ((tab.title || host).slice(0, 72) + " · " + host).slice(0, 130);
    return '<option value="' + tab.id + '" ' + (tab.active ? "selected" : "") + '>' + label.replace(/[&<>"']/g, "") + '</option>';
  }).join("");
  if (!pages.length) message("Open a public business webpage in a tab first.", true);
}

async function capturePage() {
  const tabId = Number($("#tabSelect").value);
  if (!tabId) return message("Choose an open public business webpage.", true);
  const tab = openTabs.find((item) => item.id === tabId);
  if (!tab?.url) return message("That tab is no longer available. Refresh the tab list.", true);
  if (isGoogleMaps(tab.url)) return message("Capture is disabled on Google Maps pages. Use the map search link or licensed source data.", true);
  let parsed;
  try { parsed = new URL(tab.url); } catch { return message("Open an HTTP or HTTPS business page.", true); }
  const originPattern = parsed.protocol + "//" + parsed.hostname + "/*";
  const permission = await chrome.permissions.request({ origins: [originPattern] });
  if (!permission) return message("Site access was not granted. You can choose another tab or allow access and retry.", true);
  try {
    const currentTab = await chrome.tabs.get(tabId);
    if (isGoogleMaps(currentTab.url || "")) return message("Capture is disabled on Google Maps pages.", true);
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: extractVisiblePage });
    capture = results?.[0]?.result;
    if (!capture) throw new Error("The page did not return readable content.");
    $("#businessName").value = capture.title;
    $("#phone").value = capture.phone.slice(0, 80);
    $("#phoneEvidence").value = capture.phones.map((item) => [item.formatted, item.e164, item.kind === "fax" ? "Fax" : "Publicly listed", item.evidenceText].filter(Boolean).join(" · ")).join("\n");
    $("#peopleEvidence").value = capture.publicContacts.map((item) => [item.name, item.role.replace(/_/g, " "), item.evidenceText].filter(Boolean).join(" · ")).join("\n");
    $("#address").value = capture.address.slice(0, 240);
    $("#hours").value = capture.hours.slice(0, 260);
    $("#email").innerHTML = capture.emails.length ? capture.emails.map((item, i) => '<option value="' + i + '" selected>' + item.email + '</option>').join("") : '<option value="" disabled>No email found on this page</option>';
    $("#fields").hidden = false;
    $("#evidence").value = capture.emails.length ? capture.emails.map((item) => item.email + " — " + item.evidence).join("\n\n").slice(0, 1200) : "No email was found on this page.";
    $("#message").textContent = "Found " + capture.emails.length + " email candidate(s), " + capture.phones.length + " public phone number(s), and " + capture.publicContacts.length + " explicitly named role(s). Review before saving.";
    $("#message").classList.remove("error");
  } catch (error) {
    message(error.message || "Capture failed. The page may block script access.", true);
  }
}

function updateEvidence() {
  const selected = [...$("#email").selectedOptions].map((option) => capture?.emails?.[Number(option.value)]).filter(Boolean);
  $("#evidence").value = selected.length
    ? selected.map((item) => item.email + " — " + item.evidence).join("\n\n").slice(0, 1200)
    : "Select one or more emails to review their page evidence.";
}

function downloadJSON() {
  const businessName = $("#businessName").value.trim();
  if (!businessName || !capture) return message("Enter a business name before downloading.", true);
  const selected = [...$("#email").selectedOptions].map((option) => capture.emails[Number(option.value)]).filter(Boolean);
  const googleMapsUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([businessName, $("#address").value, $("#city").value, $("#state").value].filter(Boolean).join(" "));
  const record = {
    businessName,
    category: $("#category").value.trim(),
    city: $("#city").value.trim(),
    state: $("#state").value.trim(),
    address: $("#address").value.trim(),
    phone: $("#phone").value.trim(),
    website: capture.url,
    sourceUrl: capture.url,
    email: selected[0]?.email || "",
    emails: selected.map((item) => item.email),
    emailCandidates: selected.map((item) => ({ email: item.email, sourceRoute: "user_clicked_page_capture", sourceRouteLabel: "Selected business webpage", sourceUrl: capture.url, evidenceText: item.evidence, requiresReview: true })),
    evidenceText: selected[0]?.evidence || "",
    businessPhones: capture.phones,
    publicContacts: capture.publicContacts,
    hours: $("#hours").value.trim(),
    description: capture.description,
    rating: capture.rating,
    reviewCount: capture.reviewCount,
    socialUrls: capture.socialUrls,
    googleMapsUrl,
    sourceRoute: "user_clicked_page_capture",
    notes: "Captured from a user-selected public business webpage. Contacts are source-listed and require review; no private contact type is inferred.",
    capturedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify([record], null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "vivara-page-capture.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  message("Downloaded. Import this JSON in the workspace.");
}

$("#capture").addEventListener("click", capturePage);
$("#email").addEventListener("change", updateEvidence);
$("#download").addEventListener("click", downloadJSON);
fillTabChoices().catch((error) => message(error.message || "Could not list tabs.", true));
