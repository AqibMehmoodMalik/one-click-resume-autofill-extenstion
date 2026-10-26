const $ = (id) => document.getElementById(id);

(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("keep").checked = settings.keep !== false;
  $("next").checked = !!settings.autoNext;
})();

$("opts").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

$("go").onclick = async () => {
  $("out").textContent = "Filling locally...";
  try {
    const keep = $("keep").checked, autoNext = $("next").checked;
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, keep, autoNext } });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Could not find the active tab.");
    const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [{ frameId: 0 }];
    const results = await Promise.all(
      frames.map((frame) =>
        chrome.tabs.sendMessage(tab.id, { type: "jaf-fill", keep }, { frameId: frame.frameId }).catch(() => null)
      )
    );
    const responses = results.filter(Boolean);
    const error = responses.find((result) => result.error);
    if (error) { $("out").textContent = error.error; return; }
    if (!responses.length) {
      $("out").textContent = "Could not access this page. Refresh it and try again.";
      return;
    }
    const sum = (key) => responses.reduce((total, result) => total + (result[key] || 0), 0);
    const warnings = responses.map((result) => result.error).filter(Boolean);
    const filled = sum("rule") + sum("memory") + sum("local");
    $("out").textContent =
      `Filled fields: ${filled}\n` +
      `From profile: ${sum("rule") + sum("memory")} | résumé matches (review): ${sum("local")}\n` +
      `Unmatched fields were left unchanged for your review.` +
      (warnings.length ? `\n${warnings.join("\n")}` : "");
  } catch (error) {
    $("out").textContent = `Could not fill this page: ${error.message}`;
  }
};
