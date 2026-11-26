// Injected into the page on demand by background.js. The value of the final
// expression is what scripting.executeScript hands back, so this must stay
// synchronous and return a structured-cloneable object.
(() => {
  const attempt = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  // Embedded images and fonts are megabytes of noise to a model reading the
  // file; keep the MIME type and drop the bytes.
  const stripDataUris = (text) =>
    text.replace(
      /(data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=-]+)*;base64,)[A-Za-z0-9+/=]{512,}/gi,
      (match, prefix) => `${prefix}[${match.length - prefix.length} base64 chars removed]`,
    );

  const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + "\n" : "";
  const html = stripDataUris(doctype + document.documentElement.outerHTML);

  // Read rules through the CSSOM rather than from <style> text: CSS-in-JS
  // libraries insert rules directly and leave the element empty. Cross-origin
  // sheets throw here; background.js fetches those by URL instead.
  const describeSheet = (sheet, owner) => {
    const entry = {
      href: sheet.href || null,
      media: sheet.media ? sheet.media.mediaText : "",
      disabled: sheet.disabled,
      owner,
      css: null,
    };
    try {
      entry.css = stripDataUris(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"));
    } catch (err) {
      entry.error = String(err && err.name ? err.name : err);
    }
    return entry;
  };

  const stylesheets = [
    ...Array.from(document.styleSheets, (sheet) =>
      describeSheet(sheet, sheet.ownerNode ? sheet.ownerNode.nodeName.toLowerCase() : "import"),
    ),
    ...Array.from(document.adoptedStyleSheets || [], (sheet) => describeSheet(sheet, "constructed")),
  ];

  // Scripts come from two places: <script> elements still in the DOM, and the
  // resource-timing log, which also knows about lazily loaded chunks that
  // never had (or no longer have) an element. External code is left null for
  // background.js to fetch.
  const collectScripts = () => {
    const scripts = [];
    const seen = new Set();
    const isHttp = (url) => /^https?:/i.test(url);

    for (const el of document.scripts) {
      if (el.src) {
        if (!isHttp(el.src) || seen.has(el.src)) continue;
        seen.add(el.src);
      } else if (!el.textContent.trim()) {
        continue;
      }
      scripts.push({
        url: el.src || null,
        type: el.type || "",
        async: el.hasAttribute("async"),
        defer: el.hasAttribute("defer"),
        source: "tag",
        code: el.src ? null : stripDataUris(el.textContent),
      });
    }

    for (const entry of performance.getEntriesByType("resource")) {
      const url = entry.name;
      if (!isHttp(url) || seen.has(url)) continue;
      const looksLikeScript =
        entry.initiatorType === "script" || attempt(() => /\.m?js$/i.test(new URL(url).pathname));
      if (!looksLikeScript) continue;
      seen.add(url);
      scripts.push({ url, type: "", async: false, defer: false, source: "resource", code: null });
    }
    return scripts;
  };

  // Names the page added to `window`, found by diffing against a fresh
  // iframe's window. Content scripts see the page through an Xray wrapper that
  // hides page-defined properties, hence wrappedJSObject. Descriptors are used
  // instead of reading values so no page getter runs.
  const pageGlobals = () => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    document.documentElement.appendChild(frame);
    try {
      const unwrap = (win) => win.wrappedJSObject || win;
      const baseline = new Set(Object.getOwnPropertyNames(unwrap(frame.contentWindow)));
      const page = unwrap(window);
      return Object.getOwnPropertyNames(page)
        .filter((name) => !baseline.has(name) && !/^\d+$/.test(name))
        .slice(0, 1000)
        .map((name) => {
          const descriptor = attempt(() => Object.getOwnPropertyDescriptor(page, name));
          const type = descriptor && "value" in descriptor ? attempt(() => typeof descriptor.value) : "accessor";
          return { name, type: type || "unknown" };
        });
    } finally {
      frame.remove();
    }
  };

  // Key names only: enough to spot a "newsletter_dismissed"-style flag without
  // shipping session tokens to disk.
  const runtime = {
    localStorageKeys: attempt(() => Object.keys(localStorage)),
    sessionStorageKeys: attempt(() => Object.keys(sessionStorage)),
    cookieNames: attempt(() =>
      document.cookie
        .split(";")
        .map((pair) => pair.split("=")[0].trim())
        .filter(Boolean),
    ),
    globals: attempt(pageGlobals),
  };

  return {
    url: location.href,
    title: document.title,
    html,
    stylesheets,
    scripts: attempt(collectScripts) || [],
    runtime,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      devicePixelRatio: window.devicePixelRatio,
    },
    userAgent: navigator.userAgent,
  };
})();
