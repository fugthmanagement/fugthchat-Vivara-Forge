const $ = (selector) => document.querySelector(selector);
let capture = null;

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

function extractVisiblePage() {
  const bodyText = document.body?.innerText || "";
  const emailPattern = /(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/ig;
  const emailSet = new Set([...bodyText.matchAll(emailPattern)].map((match) => match[0].replace(/[.,;:()\[\]{}<>"']+$/g, "").toLowerCase()));
  const mailLinks = [...document.querySelectorAll('a[href^="mailto:"]')]
    .filter((anchor) => anchor.getClientRects().length)
    .map((anchor) => decodeURIComponent(anchor.getAttribute("href").slice(7).split(/[?#]/)[0]).trim().toLowerCase());
  mailLinks.forEach((email) => { if (emailPattern.test(email)) emailSet.add(email); emailPattern.lastIndex = 0; });
  const emails = [...emailSet].slice(0, 12).map((email) => {
    const index = bodyText.toLowerCase().indexOf(email);
    const evidence = index >= 0 ? bodyText.slice(Math.max(0, index - 90), Math.min(bodyText.length, index + email.length + 90)).replace(/\s+/g, " ").trim() : "Visible mail link: " + email;
    return { email, evidence: evidence.slice(0, 300) };
  });
  const phoneFromLink = [...document.querySelectorAll('a[href^="tel:"]')]
    .filter((anchor) => anchor.getClientRects().length)
    .map((anchor) => anchor.getAttribute("href").slice(4).trim())[0] || "";
  const phoneFromText = bodyText.match(/(?:\+?1[\s.()-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/)?.[0] || "";
  const h1 = [...document.querySelectorAll("h1")].find((item) => item.getClientRects().length)?.innerText?.trim() || "";
  return {
    title: h1 || document.title || "",
    url: location.href,
    host: location.hostname,
    emails,
    phone: phoneFromLink || phoneFromText,
    excerpt: bodyText.slice(0, 3000).replace(/\s+/g, " ").trim()
  };
}

async function capturePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return message("Open a public business website first.", true);
  if (isGoogleMaps(tab.url)) return message("Capture is blocked on Google Maps. Use Local Discovery or open a business-owned website.", true);
  if (!/^https?:/i.test(tab.url)) return message("This page cannot be captured. Open an HTTP or HTTPS website.", true);
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractVisiblePage });
    capture = results?.[0]?.result;
    if (!capture) throw new Error("The page did not return visible content.");
    $("#businessName").value = capture.title.slice(0, 160);
    $("#phone").value = capture.phone.slice(0, 40);
    $("#email").innerHTML = '<option value="">No email selected</option>' + capture.emails.map((item, i) => '<option value="' + i + '">' + item.email + '</option>').join("");
    $("#fields").hidden = false;
    $("#evidence").value = "Select an email to review its visible context.";
    $("#message").textContent = capture.emails.length
      ? "Found " + capture.emails.length + " visible email candidate(s). Choose one and check its context."
      : "No visible email was found. You can still capture the business and phone.";
    $("#message").classList.remove("error");
  } catch (error) {
    message(error.message || "Capture failed. The page may block scripts.", true);
  }
}

function updateEvidence() {
  const index = $("#email").value;
  $("#evidence").value = index === "" ? "Select an email to review its visible context." : capture?.emails?.[Number(index)]?.evidence || "Visible email on the page.";
}

function downloadJSON() {
  const businessName = $("#businessName").value.trim();
  if (!businessName || !capture) return message("Enter a business name before downloading.", true);
  const selectedIndex = $("#email").value;
  const selected = selectedIndex === "" ? null : capture.emails[Number(selectedIndex)];
  const record = {
    businessName,
    category: $("#category").value.trim(),
    city: $("#city").value.trim(),
    state: $("#state").value.trim(),
    phone: $("#phone").value.trim(),
    website: capture.url,
    sourceUrl: capture.url,
    email: selected?.email || "",
    evidenceText: selected?.evidence || "",
    sourceRoute: "user_clicked_page_capture",
    notes: "Captured from visible page content; email and mailbox are unverified.",
    capturedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify([record], null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "vivara-page-capture.json";
  link.click();
  URL.revokeObjectURL(link.href);
  message("Downloaded. Import this JSON in the mobile workspace.");
}

$("#capture").addEventListener("click", capturePage);
$("#email").addEventListener("change", updateEvidence);
$("#download").addEventListener("click", downloadJSON);
