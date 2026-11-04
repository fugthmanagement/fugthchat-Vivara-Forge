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

function schemaObjects(value) {
  if (Array.isArray(value)) return value.flatMap(schemaObjects);
  if (!value || typeof value !== "object") return [];
  return [value, ...(value["@graph"] ? schemaObjects(value["@graph"]) : [])];
}

function extractVisiblePage() {
  const bodyText = document.body?.innerText || "";
  const emailPattern = /(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/i;
  const structured = [];
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { structured.push(...schemaObjects(JSON.parse(node.textContent || ""))); } catch {}
  }
  const business = structured.find((item) => {
    const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : String(item["@type"] || "");
    return /organization|localbusiness|store|professionalservice|medicalbusiness|automotivebusiness/i.test(type) && item.name;
  }) || structured.find((item) => item.name) || {};
  const textEmails = [...bodyText.matchAll(new RegExp(emailPattern.source, "ig"))].map((match) => match[0].replace(/[.,;:()\[\]{}<>"']+$/g, "").toLowerCase());
  const mailLinks = [...document.querySelectorAll('a[href^="mailto:"]')]
    .filter((anchor) => anchor.getClientRects().length)
    .map((anchor) => decodeURIComponent(anchor.getAttribute("href").slice(7).split(/[?#]/)[0]).trim().toLowerCase());
  const schemaEmail = String(business.email || "").trim().toLowerCase();
  const emails = [...new Set([...textEmails, ...mailLinks, ...(schemaEmail ? [schemaEmail] : [])])].filter((email) => emailPattern.test(email)).slice(0, 12);
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
  const phoneFromLink = [...document.querySelectorAll('a[href^="tel:"]')]
    .filter((anchor) => anchor.getClientRects().length)
    .map((anchor) => anchor.getAttribute("href").slice(4).trim())[0] || "";
  const phoneFromText = bodyText.match(/(?:\+?1[\s.()-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/)?.[0] || "";
  const h1 = [...document.querySelectorAll("h1")].find((item) => item.getClientRects().length)?.innerText?.trim() || "";
  const rating = business.aggregateRating && typeof business.aggregateRating === "object" ? business.aggregateRating : {};
  const sameAs = typeof business.sameAs === "string" ? [business.sameAs] : Array.isArray(business.sameAs) ? business.sameAs : [];
  return {
    title: String(business.name || h1 || document.title || "").trim().slice(0, 160),
    url: location.href,
    host: location.hostname,
    emails: emailEvidence,
    phone: phoneFromLink || String(business.telephone || phoneFromText).trim(),
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
    $("#phone").value = capture.phone.slice(0, 40);
    $("#address").value = capture.address.slice(0, 240);
    $("#hours").value = capture.hours.slice(0, 260);
    $("#email").innerHTML = '<option value="">No email selected</option>' + capture.emails.map((item, i) => '<option value="' + i + '">' + item.email + '</option>').join("");
    $("#fields").hidden = false;
    $("#evidence").value = "Select an email to review its visible or structured page evidence.";
    $("#message").textContent = capture.emails.length
      ? "Found " + capture.emails.length + " email candidate(s). Review the evidence before saving."
      : "No email was visible. You can still save the business details found on the page.";
    $("#message").classList.remove("error");
  } catch (error) {
    message(error.message || "Capture failed. The page may block script access.", true);
  }
}

function updateEvidence() {
  const index = $("#email").value;
  $("#evidence").value = index === "" ? "Select an email to review its visible or structured page evidence." : capture?.emails?.[Number(index)]?.evidence || "Email found in page content.";
}

function downloadJSON() {
  const businessName = $("#businessName").value.trim();
  if (!businessName || !capture) return message("Enter a business name before downloading.", true);
  const selectedIndex = $("#email").value;
  const selected = selectedIndex === "" ? null : capture.emails[Number(selectedIndex)];
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
    email: selected?.email || "",
    evidenceText: selected?.evidence || "",
    hours: $("#hours").value.trim(),
    description: capture.description,
    rating: capture.rating,
    reviewCount: capture.reviewCount,
    socialUrls: capture.socialUrls,
    googleMapsUrl,
    sourceRoute: "user_clicked_page_capture",
    notes: "Captured from a user-selected public webpage. Email and mailbox are unverified.",
    capturedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify([record], null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "vivara-page-capture.json";
  link.click();
  URL.revokeObjectURL(link.href);
  message("Downloaded. Import this JSON in the workspace.");
}

$("#capture").addEventListener("click", capturePage);
$("#email").addEventListener("change", updateEvidence);
$("#download").addEventListener("click", downloadJSON);
fillTabChoices().catch((error) => message(error.message || "Could not list tabs.", true));
