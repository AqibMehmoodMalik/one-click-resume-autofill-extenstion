const $ = (id) => document.getElementById(id);
const LOCAL_PARSER = "http://127.0.0.1:8000";
const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const PROFILE_DEFAULTS_VERSION = 2;
const say = (text) => { $("msg").textContent = text; };
const DEFAULT_PROFILE = {
  address: {
    city: "",
    state: "",
    country: "",
    zip: "",
  },
  desired_work_countries: [],
  age_18_or_older: "",
  citizenship: "",
  work_auth: {
    authorized: "",
    requires_sponsorship: "",
    authorization_basis: "",
  },
  eeo: {
    disability: "",
    lgbtq: "",
    gender: "",
    veteran: "",
    race: "",
    hispanic_latino: "",
    sexual_orientation: [],
    pronouns: "",
  },
  answers: {},
};

function withDefaults(profile = {}) {
  return {
    ...DEFAULT_PROFILE,
    ...profile,
    address: { ...DEFAULT_PROFILE.address, ...profile.address },
    work_auth: { ...DEFAULT_PROFILE.work_auth, ...profile.work_auth },
    eeo: { ...DEFAULT_PROFILE.eeo, ...profile.eeo },
    answers: profile.answers || {},
  };
}

function mergeParsedProfile(parsed, existing) {
  const userFields = [
    "address",
    "desired_work_countries",
    "age_18_or_older",
    "citizenship",
    "work_auth",
    "willing_to_relocate",
    "salary_expectation",
    "notice_period",
    "eeo",
    "answers",
    "custom_answers",
  ];
  const preserved = Object.fromEntries(
    userFields.filter((key) => existing[key] !== undefined).map((key) => [key, existing[key]])
  );
  return withDefaults({ ...existing, ...parsed, ...preserved, cv_text: parsed.cv_text });
}

const toB64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read the résumé file."));
    reader.readAsArrayBuffer(file);
  });

(async () => {
  try {
    const { profile, cv, profileDefaultsVersion } = await chrome.storage.local.get(["profile", "cv", "profileDefaultsVersion"]);
    const upgraded = withDefaults(profile);
    $("profile").value = JSON.stringify(upgraded, null, 2);
    $("savedCv").textContent = cv?.name ? `Saved résumé: ${cv.name}` : "No résumé file saved yet.";
    if (profileDefaultsVersion !== PROFILE_DEFAULTS_VERSION) {
      await chrome.storage.local.set({ profile: upgraded, profileDefaultsVersion: PROFILE_DEFAULTS_VERSION });
    }
  } catch (error) {
    say(`Could not load your saved profile: ${error.message}`);
  }
})();

let pendingCV = null;
let pendingCVPromise = Promise.resolve();
let cvReadError = false;

$("cv").addEventListener("change", () => {
  const file = $("cv").files[0];
  pendingCV = null;
  cvReadError = false;
  if (!file) {
    pendingCVPromise = Promise.resolve();
    return;
  }
  if (file.size > MAX_RESUME_BYTES) {
    $("cv").value = "";
    pendingCVPromise = Promise.resolve();
    say("Résumé files must be 10 MB or smaller.");
    return;
  }

  say("Saving the original résumé locally...");
  pendingCVPromise = toB64(file)
    .then((b64) => {
      pendingCV = { name: file.name, type: file.type || "application/octet-stream", b64 };
      $("savedCv").textContent = `Selected résumé: ${file.name} (save to keep it for future applications)`;
      say("Original file is ready to save. Text extraction is optional.");
    })
    .catch((error) => {
      cvReadError = true;
      say(`Could not read the résumé file: ${error.message}`);
    });
});

$("parse").onclick = async () => {
  const file = $("cv").files[0];
  if (!file) return say("Choose your résumé file first.");
  if (file.size > MAX_RESUME_BYTES) return say("Résumé files must be 10 MB or smaller.");
  await pendingCVPromise;
  if (cvReadError) return;
  if (!/\.(pdf|docx|odt|html?|txt|md)$/i.test(file.name)) {
    return say("This file is ready to save and upload as-is. Text extraction supports PDF, DOCX, ODT, HTML, TXT and MD.");
  }

  say("Extracting text with the local parser...");
  const form = new FormData();
  form.append("file", file);
  try {
    const response = await fetch(`${LOCAL_PARSER}/parse-cv`, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) return say(`Error: ${data.detail || response.status}`);

    let old = {};
    try { old = JSON.parse($("profile").value || "{}"); } catch {}
    const merged = mergeParsedProfile(data, old);
    $("profile").value = JSON.stringify(merged, null, 2);
    say("Text extracted locally. Review the profile and save it.");
  } catch (error) {
    say(`Could not reach the local parser at ${LOCAL_PARSER}: ${error.message}`);
  }
};

$("save").onclick = async () => {
  await pendingCVPromise;
  if (cvReadError) return;
  let profile;
  try {
    profile = JSON.parse($("profile").value);
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Expected a JSON object.");
  } catch (error) {
    return say(`Profile is not valid JSON: ${error.message}`);
  }

  const toStore = { profile, profileDefaultsVersion: PROFILE_DEFAULTS_VERSION };
  if (pendingCV) toStore.cv = pendingCV;
  try {
    await chrome.storage.local.set(toStore);
    if (pendingCV) $("savedCv").textContent = `Saved résumé: ${pendingCV.name}`;
    say("Profile and selected résumé saved locally on this browser.");
  } catch (error) {
    say(`Could not save your profile: ${error.message}`);
  }
};
