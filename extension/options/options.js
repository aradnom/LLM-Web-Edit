const serverUrlField = document.getElementById("serverUrl");
const tokenField = document.getElementById("token");
const statusLine = document.getElementById("status");

browser.storage.local.get(["serverUrl", "token"]).then(({ serverUrl, token }) => {
  serverUrlField.value = serverUrl || "";
  tokenField.value = token || "";
});

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await browser.storage.local.set({
    serverUrl: serverUrlField.value.trim(),
    token: tokenField.value.trim(),
  });
  statusLine.className = "";
  statusLine.textContent = "Saved. Testing…";
  const outcome = await browser.runtime.sendMessage({ type: "health" });
  statusLine.className = outcome.ok ? "ok" : "error";
  statusLine.textContent = outcome.ok ? "Saved. Server reachable and token accepted." : `Saved, but: ${outcome.error}`;
});
