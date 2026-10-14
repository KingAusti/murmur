// End-to-end test of the real Murmur extension against the live local server
// (start it first: scripts/install.sh). Usage:
//   cd e2e && npm install && node run.mjs        (CHROME=/path/to/chromium to override)
// Headless Chromium on macOS can't open a microphone without a TCC prompt, so
// dictation is fed synthesized speech as its mic stream; the rest is real.
import puppeteer from "puppeteer";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.resolve(HERE, "../extension");
const TOKEN = fs.readFileSync(path.join(os.homedir(), "Library/Application Support/Murmur/token"), "utf8").trim();

// Fixtures generated on the fly: a speech clip (from the server) and a small PDF.
async function speechWav(text) {
  const r = await fetch("http://127.0.0.1:47811/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Murmur-Token": TOKEN },
    body: JSON.stringify({ text }),
  });
  const { pcm, sr } = await r.json();
  const speech = Buffer.from(pcm, "base64");
  const data = Buffer.concat([Buffer.alloc(sr), speech, Buffer.alloc(sr * 2 * 5)]); // 0.5 s lead, 5 s silence
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function tinyPdf(lines) {
  const content = ["BT /F1 14 Tf 72 720 Td 18 TL", ...lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) '`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const SPEECH = await speechWav("Mitochondria are the powerhouse of the cell, and they produce most of its energy.");
const PDF = tinyPdf([
  "Enzymes are biological catalysts that speed up chemical reactions.",
  "They lower the activation energy required for a reaction to occur.",
  "Each enzyme has an active site that binds a specific substrate.",
]);
const ID = "fhclfpkjgiaghbagldighhljljobfijc";
const EXE = process.env.CHROME || puppeteer.executablePath();
const results = [];
const ok = (name, pass, info = "") => {
  results.push({ name, pass, info });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture server (PDF only served with a cookie, like a logged-in LMS) ---
const site = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/login") {
    res.writeHead(200, { "Set-Cookie": "sess=1; Path=/", "Content-Type": "text/html" });
    return res.end("<p>logged in</p>");
  }
  if (u.pathname === "/doc.pdf") {
    if (!(req.headers.cookie || "").includes("sess=1")) return res.writeHead(403).end("no cookie");
    res.writeHead(200, { "Content-Type": "application/pdf" });
    return res.end(PDF);
  }
  const f = path.join(HERE, "site", path.basename(u.pathname));
  if (!fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${site.address().port}`;

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: process.env.HEADFUL ? false : true,
  enableExtensions: [EXT],
  pipe: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(ID), { timeout: 15000 });
  const sw = await swTarget.worker();
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.grantPermissions", { origin: `chrome-extension://${ID}`, permissions: ["audioCapture"] });

  // Pair (welcome page also does this automatically).
  await sleep(1500);
  const paired = await sw.evaluate(async () => (await chrome.storage.local.get("token")).token || (await pair()));
  ok("pairing with server via Origin", !!paired);

  const page = await browser.newPage();
  await page.goto(`${BASE}/login`);
  await page.goto(`${BASE}/article.html`, { waitUntil: "load" });
  await page.bringToFront();
  const tabId = async (urlPart) =>
    sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((t) => (t.url || "").includes(u));
      if (t) return t.id;
      const c = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      return c.find((x) => x.documentUrl.includes(u))?.tabId;
    }, urlPart);
  const artTab = await tabId("article.html");

  // Sampler in the page's main world: the highlight registry is per-document.
  const sample = async (p, ms) => {
    return p.evaluate(async (ms) => {
      const out = [];
      const t0 = performance.now();
      let last = "";
      while (performance.now() - t0 < ms) {
        const s = CSS.highlights.get("murmur-sentence");
        const w = CSS.highlights.get("murmur-word");
        const st = s ? [...s].map((r) => r.toString()).join("|") : "";
        const wt = w ? [...w].map((r) => r.toString()).join("|") : "";
        const key = st + "§" + wt;
        if (key !== last) out.push({ t: Math.round(performance.now() - t0), s: st.slice(0, 60), w: wt });
        last = key;
        await new Promise((r) => setTimeout(r, 25));
      }
      return out;
    }, ms);
  };

  // ---------- A. read page ----------
  const t0 = Date.now();
  await sw.evaluate(async (id) => readCommand(await chrome.tabs.get(id)), artTab);
  const trace = await sample(page, 20000);
  const firstWord = trace.find((e) => e.w);
  ok("read page starts & highlights a word", !!firstWord, firstWord ? `first word "${firstWord.w}" at ~${firstWord.t}ms after command (+${Date.now() - t0 - 14000 > 0 ? 0 : 0})` : JSON.stringify(trace.slice(0, 5)));
  ok("starts at main content (not nav)", !!trace.find((e) => e.s.startsWith("Chapter 4")), trace[0]?.s);
  const sentences = [...new Set(trace.map((e) => e.s).filter(Boolean))];
  ok("advances through sentences", sentences.length >= 3, sentences.map((s) => s.slice(0, 30)).join(" / "));
  const words = trace.map((e) => e.w).filter(Boolean);
  ok("word highlights progress", new Set(words).size > 15, words.slice(0, 25).join(" "));
  ok("citation not highlighted as spoken word", !words.some((w) => /Smith|2019|\[12\]/.test(w)), "");
  ok("e.g. highlighted as the source of 'for example'", words.some((w) => w.startsWith("e.g")), words.join(" ").match(/cytoplasm.{0,80}/)?.[0]);
  // gap check: at sentence changes, time from last word of previous sentence highlight to next sentence's first word
  let maxGap = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i].w && trace[i - 1].w) maxGap = Math.max(maxGap, trace[i].t - trace[i - 1].t);
  ok("no long gaps between highlighted words (gapless playback)", maxGap < 1600, `max gap ${maxGap}ms`);
  const playerVisible = await page.evaluate(() => !!document.querySelector("murmur-player"));
  ok("player bar mounted despite strict page CSP", playerVisible);

  // ---------- B. pause / resume ----------
  await sw.evaluate(() => toOffscreen({ type: "toggle", port: active }));
  await sleep(400);
  const paused = await sample(page, 1500);
  ok("pause freezes highlighting", paused.length <= 1, `${paused.length} changes while paused`);
  await sw.evaluate(() => toOffscreen({ type: "toggle", port: active }));
  const resumed = await sample(page, 2000);
  ok("resume continues", resumed.filter((e) => e.w).length >= 2, `${resumed.length} changes ${JSON.stringify(paused.concat(resumed)).slice(0, 400)}`);

  // ---------- C. rapid skip (⌥⇧→ ×4) ----------
  const before = (await sample(page, 100)).at(-1)?.s;
  await page.mouse.click(5, 5); // focus page (not an input)
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await sleep(60);
  }
  const tSkip = Date.now();
  const afterSkip = await sample(page, 3000);
  const firstNewWord = afterSkip.find((e) => e.w && e.s !== before);
  ok("rapid skip lands quickly", !!firstNewWord && firstNewWord.t < 1200, firstNewWord ? `word after ${firstNewWord.t}ms in "${firstNewWord.s.slice(0, 40)}"` : "none");

  // ---------- D. ⌥-click on a link: reads from there, no navigation ----------
  const urlBefore = page.url();
  await page.keyboard.down("Alt");
  await page.click("#lnk");
  await page.keyboard.up("Alt");
  const altTrace = await sample(page, 3500);
  ok("⌥-click on link does not navigate", page.url() === urlBefore);
  ok("⌥-click reads from clicked spot", altTrace.some((e) => /^the reference diagram|^See the reference|reference diagram/.test(e.s) || /diagram/.test(e.w)), altTrace.slice(0, 3).map((e) => e.s).join(" / "));

  // ---------- D2. quiz text inside <form> is readable; synthetic events are ignored ----------
  await page.keyboard.down("Alt");
  await page.click("#q1", { offset: { x: 2, y: 8 } });
  await page.keyboard.up("Alt");
  const quiz = await sample(page, 3000);
  ok("⌥-click reads quiz question inside <form>", quiz.some((e) => /Question 1/.test(e.s)), quiz.slice(0, 2).map((e) => e.s).join(" / "));
  await sw.evaluate(() => toOffscreen({ type: "stop" }));
  await sw.evaluate(() => { if (active) post(active, { type: "state", state: "stopped" }); active = null; });
  await sleep(500);
  await page.evaluate(() => {
    const r = document.getElementById("p4").getBoundingClientRect();
    document.getElementById("p4").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  const synth = await sample(page, 1500);
  ok("page-synthesized ⌥-click is ignored", !synth.some((e) => e.w || e.s), JSON.stringify(synth.slice(0, 2)));

  // ---------- E. selection inside an iframe ----------
  await sw.evaluate(() => toOffscreen({ type: "stop" }));
  await sw.evaluate(() => { if (active) post(active, { type: "state", state: "stopped" }); active = null; });
  await sleep(300);
  const frame = page.frames().find((f) => f.url().includes("frame.html"));
  await frame.evaluate(() => {
    const p = document.getElementById("fp");
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await sw.evaluate(async (id) => readCommand(await chrome.tabs.get(id)), artTab);
  const ft = await sample(frame, 4000);
  ok("reads selection inside iframe", ft.some((e) => /Calvin/.test(e.s)), ft.slice(0, 2).map((e) => e.s).join(" / "));
  await sw.evaluate(() => toOffscreen({ type: "stop" }));
  await sw.evaluate(() => { if (active) post(active, { type: "state", state: "stopped" }); active = null; });

  // ---------- F. dictation into the iframe textarea ----------
  await frame.focus("#notes");
  await frame.evaluate(() => {
    const t = document.getElementById("notes");
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await sw.evaluate(() => {
    globalThis.__dlog = [];
    const orig = onDictateEvent;
    onDictateEvent = (m) => (__dlog.push(m), orig(m));
  });
  // Headless Chromium can't open a real/fake mic here (macOS TCC), so feed the
  // synthesized speech in as the mic stream; everything downstream is real.
  await sw.evaluate(() => ensureOffscreen());
  const offT = await browser.waitForTarget((t) => t.url().includes("offscreen.html"));
  const offPage = await offT.asPage();
  offPage.on("console", (m) => console.log("  [offscreen]", m.text()));
  await offPage.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(bytes.buffer.slice(0));
      const src = ac.createBufferSource();
      src.buffer = buf;
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  }, SPEECH.toString("base64"));
  await sw.evaluate(async (id) => dictateCommand(await chrome.tabs.get(id)), artTab);
  let notes = "";
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    notes = await frame.evaluate(() => document.getElementById("notes").value);
    if (notes !== "My notes:") break;
  }
  ok("dictation inserts transcript into focused field (iframe)", /powerhouse/i.test(notes), JSON.stringify(notes) + " events=" + JSON.stringify(await sw.evaluate(() => __dlog)));

  // ---------- G. Reader view ----------
  const pagesBefore = (await browser.pages()).length;
  await sw.evaluate(async (id) => openReaderView(await chrome.tabs.get(id)), artTab);
  let rv;
  for (let i = 0; i < 30 && !rv; i++) {
    await sleep(300);
    rv = (await browser.pages()).find((p) => p.url().includes("reader/reader.html"));
  }
  ok("Reader view opens", !!rv && (await browser.pages()).length > pagesBefore);
  if (rv) {
    await rv.waitForFunction(() => document.querySelector("#article")?.textContent.includes("Glycolysis"), { timeout: 10000 }).catch(() => {});
    const art = await rv.evaluate(() => document.querySelector("#article")?.textContent || "");
    ok("Reader view extracts article (no nav/footer)", /Glycolysis/.test(art) && !/Grades/.test(art), art.slice(0, 80));
    await rv.bringToFront();
    await rv.click("#listen").catch((e) => ok("Reader view listen button", false, e.message));
    const rt = await sample(rv, 4000);
    ok("Reader view reads with highlights", rt.some((e) => e.w), rt.slice(0, 2).map((e) => e.w).join(","));
    await sw.evaluate(() => toOffscreen({ type: "stop" }));
    // ⌥⇧R routing into an extension tab
    const rvTab = await tabId("reader/reader.html");
    const probe = await sw.evaluate(async (id) => probeFrames(id, { type: "probe" }), rvTab);
    ok("commands route to extension-page tabs", probe.length === 1, JSON.stringify(probe));
    await rv.close();
  }

  // ---------- H. PDF redirect + read ----------
  const pdfPage = await browser.newPage();
  await pdfPage.goto(`${BASE}/doc.pdf?a=1&b=2`).catch(() => {});
  await sleep(2500);
  ok("PDF redirected to Murmur viewer", pdfPage.url().startsWith(`chrome-extension://${ID}/pdfjs/web/viewer.html`), pdfPage.url().slice(0, 120));
  const loaded = await pdfPage.waitForFunction(() => globalThis.PDFViewerApplication?.pdfDocument?.numPages > 0, { timeout: 15000 }).then(() => true, () => false);
  ok("PDF loads with cookies (logged-in)", loaded);
  if (loaded) {
    const pdfTab = await tabId("pdfjs/web/viewer.html");
    await sleep(1500);
    await sw.evaluate(async (id) => readCommand(await chrome.tabs.get(id)), pdfTab);
    const pt = await sample(pdfPage, 6000);
    ok("PDF read-aloud highlights words in text layer", pt.some((e) => e.w), pt.filter((e) => e.w).slice(0, 8).map((e) => e.w).join(" "));
    await sw.evaluate(() => toOffscreen({ type: "stop" }));
  }

  // ---------- I. popup renders status ----------
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${ID}/popup.html`);
  await sleep(1500);
  const status = await pop.evaluate(() => document.getElementById("status").textContent.trim());
  const voices = await pop.evaluate(() => document.querySelectorAll("#voice option").length);
  ok("popup shows Ready + voices", /Ready/.test(status) && voices >= 10, `${status}, ${voices} voices`);

  // ---------- J. welcome page ----------
  const wel = (await browser.pages()).find((p) => p.url().includes("welcome.html")) || (await browser.newPage());
  if (!wel.url().includes("welcome.html")) await wel.goto(`chrome-extension://${ID}/welcome.html`);
  await sleep(3000);
  const steps = await wel.evaluate(() => [...document.querySelectorAll(".step")].map((s) => `${s.id}:${s.className.replace("step", "").trim()}`));
  ok("welcome: server+connect steps OK", steps.includes("step-server:ok") && steps.includes("step-connect:ok"), steps.join(" "));
} catch (e) {
  ok("unexpected error", false, e.stack);
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  site.close();
  process.exit(failed.length ? 1 : 0);
}
