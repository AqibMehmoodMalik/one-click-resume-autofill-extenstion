// One-Click Job Autofill: all matching runs locally in the browser.
(() => {
  if (window.__jafLoaded) return;
  window.__jafLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[*:()\[\]]/g, " ")
      .replace(/\b(required|optional)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const textOf = (n) => ((n && (n.innerText || n.textContent)) || "").trim();
  const store = {
    get: (k) => new Promise((r) => chrome.storage.local.get(k, r)),
    set: (o) => new Promise((r) => chrome.storage.local.set(o, r)),
  };
  const fieldIds = new WeakMap();
  let nextFieldId = 0;

  function fieldId(el) {
    if (!fieldIds.has(el)) fieldIds.set(el, String(++nextFieldId));
    return fieldIds.get(el);
  }

  // ---------- profile matching ----------
  const RULES = [
    ["desired_work_countries", /countries? where you want to work|where do you want to work|preferred work countries|desired work countries/],
    ["authorization_basis", /authorization basis|basis of authorization|basis.*work authorization/],
    ["citizenship", /\bcitizen(ship)?\b|nationality/],
    ["age_18_or_older", /at least 18|18\s*(?:years?\s+of age|years? old|or older|or above|\+)|over 18|minimum age/],
    ["authorized", /authori[sz]ed\s*to\s*work|legally\s*(authori[sz]ed|eligible|permitted)|right\s*to\s*work|work\s*authori[sz]ation|eligible to work/],
    ["sponsorship", /sponsor/],
    ["relocate", /relocat/],
    ["veteran", /veteran/],
    ["disability", /disabilit/],
    ["lgbtq", /lgbtq|identify as (?:lgbt|queer)|sexual minority/],
    ["sexual_orientation", /sexual orientation|orientation.*describe/],
    ["pronouns", /\bpronouns?\b/],
    ["hispanic_latino", /hispanic|latino|latina|latinx/],
    ["race", /\brace\b|racial/],
    ["gender", /gender/],
    ["ethnicity", /ethnic/],
    ["salary", /salary|compensation|\bctc\b|expected\s*pay/],
    ["notice", /notice\s*period|when can you start|earliest\s*start|available to start|start date/],
    ["years_experience", /years?\s*of\s*(total\s*|professional\s*|work\s*)*experience|experience\s*\(years\)|total experience/],
    ["latest_company", /most recent (company|employer)|last (company|employer)/],
    ["current_company", /current\s*(company|employer)|\bemployer\b/],
    ["latest_title", /most recent (title|role)|last (title|role|position)/],
    ["current_title", /current\s*(title|role|position)|job\s*title/],
    ["first_name", /first\s*name|given\s*name|forename|\bfname\b/],
    ["last_name", /last\s*name|family\s*name|surname|\blname\b/],
    ["email", /e-?mail/],
    ["phone", /phone|mobile|\bcell\b|contact\s*number|telephone/],
    ["linkedin", /linkedin/],
    ["github", /github/],
    ["website", /website|portfolio|personal\s*(site|url)|\burl\b/],
    ["zip", /\bzip\b|postal|post\s*code|pin\s*code/],
    ["city", /\bcity\b|\btown\b/],
    ["state", /\bstate\b|province/],
    ["country", /\bcountry\b/],
    ["address1", /street|address\s*(line)?\s*1?$|^address$/],
    ["full_name", /^(your |full |legal |candidate )?name$|full\s*name|your name|legal name/],
    ["summary", /^(professional )?summary$|about yourself|tell us about yourself/],
    ["university", /university|college|school|institution/],
    ["degree", /\bdegree\b|qualification/],
  ];
  const AUTOCOMPLETE = {
    "given-name": "first_name", "family-name": "last_name", name: "full_name", email: "email",
    tel: "phone", "street-address": "address1", "address-line1": "address1",
    "address-level2": "city", "address-level1": "state", "postal-code": "zip", country: "country",
    "country-name": "country", organization: "current_company", "organization-title": "current_title", url: "website",
  };
  function salaryAnswer(field, profile) {
    const explicitContext = `${field.label} ${field.el.getAttribute("placeholder") || ""} ${field.name || ""}`;
    const optionContext = (field.options || []).join(" ");
    const context = norm(explicitContext);
    const explicitPkr = /(?:\bpkr\b|pakistani rupees?|\brupees?\b|₨|\brs\.?\s*\d)/i.test(explicitContext);
    const explicitUsd = /(?:\busd\b|us\s*dollars?|\$)/i.test(explicitContext);
    const hasPkr = /(?:\bpkr\b|pakistani rupees?|\brupees?\b|₨|\brs\.?\s*\d)/i.test(optionContext);
    const hasUsd = /(?:\busd\b|us\s*dollars?|\$)/i.test(optionContext);
    let currency = null;
    if (explicitPkr) currency = "PKR";
    else if (explicitUsd) currency = "USD";
    else if (hasPkr && !hasUsd) currency = "PKR";
    else if (hasUsd && !hasPkr) currency = "USD";
    else if ((profile.desired_work_countries || []).some((country) => /united states|usa/i.test(country))) currency = "USD";
    else if (hasPkr) currency = "PKR";
    if (!currency) return null;

    const period = /annual|annually|yearly|per year|\/\s*year|a year/i.test(context)
      ? "annual"
      : /monthly|per month|\/\s*month|a month/i.test(context)
        ? "monthly"
        : "annual";
    const monthly = Number(profile.salary_expectation?.[currency]?.monthly);
    if (!Number.isFinite(monthly) || monthly <= 0) return null;
    const amount = period === "annual" ? monthly * 12 : monthly;
    return { currency, period, amount };
  }

  function classify(f) {
    const ac = (f.autocomplete || "").split(/\s+/).pop();
    // A combined authorization/sponsorship question must not be guessed from either profile value.
    if (/authori[sz]|eligible|permit/.test(f.label) && /sponsor/.test(f.label)) return null;
    for (const [key, re] of RULES) if (re.test(f.label)) return key;
    if (AUTOCOMPLETE[ac]) return AUTOCOMPLETE[ac];
    const attr = norm((f.name || "").replace(/[_\-.\[\]]/g, " "));
    for (const [key, re] of RULES) if (re.test(attr)) return key;
    return null;
  }

  function valueFor(key, p) {
    const a = p.address || {};
    const full = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ");
    const map = {
      first_name: p.first_name, last_name: p.last_name, full_name: full, email: p.email, phone: p.phone,
      linkedin: p.linkedin, github: p.github, website: p.website || p.github || p.linkedin,
      city: a.city, state: a.state, country: a.country, zip: a.zip, address1: a.line1,
      desired_work_countries: p.desired_work_countries,
      current_company: p.current_company, current_title: p.current_title,
      latest_company: p.latest_company || p.experience?.[0]?.company,
      latest_title: p.latest_title || p.experience?.[0]?.title,
      years_experience: p.years_experience, notice: p.notice_period,
      authorized: p.work_auth?.authorized, sponsorship: p.work_auth?.requires_sponsorship,
      authorization_basis: p.work_auth?.authorization_basis, citizenship: p.citizenship,
      age_18_or_older: p.age_18_or_older, relocate: p.willing_to_relocate,
      gender: p.eeo?.gender, ethnicity: p.eeo?.ethnicity, race: p.eeo?.race,
      hispanic_latino: p.eeo?.hispanic_latino, lgbtq: p.eeo?.lgbtq,
      sexual_orientation: p.eeo?.sexual_orientation, pronouns: p.eeo?.pronouns,
      veteran: p.eeo?.veteran, disability: p.eeo?.disability, summary: p.summary,
      university: p.education?.[0]?.school, degree: p.education?.[0]?.degree,
    };
    const v = map[key];
    return v === undefined || v === null || String(v).trim() === "" ? null : String(v);
  }

  const STOP_WORDS = new Set(
    "a an and are as at be built by can do for from have how i in is it of on or tell that the this to us use used what when where which with work your you hold hands on experience".split(" ")
  );
  const BLOCKED_LEARNING = /\b(consent|agree|agreement|acknowledge|attest|attestation|certify that|truthful|accurate|privacy policy|terms and conditions)\b/i;
  const SENSITIVE_QUESTION = /\b(citizen(ship)?|nationality|authori[sz]ation|authorized|eligible|sponsor(ship)?|disabilit(y|ies)|gender|race|ethnic(ity)?|sexual orientation|lgbtq|veteran|pronouns?)\b/i;
  const AFFIRMATIVE = /\b(used|built|developed|implemented|deployed|created|designed|managed|maintained|worked|experience|experienced|proficient|certified|delivered|led|contributed)\b/i;
  const NEGATIVE = /\b(no experience|never used|not used|without experience|unfamiliar with|not familiar with|not certified|no certification)\b/i;

  function questionTokens(question) {
    return [...new Set((norm(question).match(/[a-z0-9+#.-]+/g) || [])
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
  }

  function savedAnswerFor(question, answers = {}) {
    const target = norm(question);
    const answerStore = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
    const entries = Object.entries(answerStore).filter(([, answer]) =>
      (typeof answer === "string" && answer.trim()) || (Array.isArray(answer) && answer.length)
    );
    const exact = entries.find(([label]) => norm(label) === target);
    if (exact) return exact[1];
    if (SENSITIVE_QUESTION.test(question)) return null;

    const targetTokens = questionTokens(question);
    if (targetTokens.length < 2) return null;
    let best = null;
    let bestScore = 0;
    for (const [label, answer] of entries) {
      if (SENSITIVE_QUESTION.test(label)) continue;
      const tokens = questionTokens(label);
      const shared = targetTokens.filter((token) => tokens.includes(token)).length;
      const score = shared / Math.min(targetTokens.length, tokens.length || 1);
      if (shared >= 2 && score >= 0.8 && score > bestScore) {
        best = answer;
        bestScore = score;
      }
    }
    return best;
  }

  async function learnManualAnswer(event) {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const el = event.target;
    if (!el.matches("input,textarea,select") || el.type === "file" || el.disabled || el.readOnly) return;

    let label;
    let answer;
    if (el.type === "radio" || el.type === "checkbox") {
      const group = el.closest("fieldset,[role=group],[role=radiogroup]");
      const controls = group
        ? [...group.querySelectorAll(`input[type="${el.type}"]`)]
        : el.name
          ? [...el.getRootNode().querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)]
          : [el];
      label = groupLabel(controls);
      if (el.type === "radio") {
        const selected = controls.find((control) => control.checked);
        answer = selected ? labelOf(selected) : "";
      } else {
        answer = controls.filter((control) => control.checked).map(labelOf);
      }
    } else if (el.tagName === "SELECT" && el.multiple) {
      label = labelOf(el);
      answer = [...el.selectedOptions].map((option) => option.text.trim());
    } else {
      label = labelOf(el);
      answer = el.tagName === "SELECT" ? el.selectedOptions[0]?.text.trim() || "" : el.value.trim();
    }
    if (!label || BLOCKED_LEARNING.test(label)) return;

    const hasAnswer = typeof answer === "string" ? !!answer : answer.length > 0;
    const { profile } = await store.get("profile");
    if (!profile) return;
    const answers = profile.answers && typeof profile.answers === "object" && !Array.isArray(profile.answers)
      ? { ...profile.answers }
      : {};
    const existingKey = Object.keys(answers).find((key) => norm(key) === norm(label));
    if (!hasAnswer) {
      if (existingKey) {
        delete answers[existingKey];
        await store.set({ profile: { ...profile, answers } });
      }
      return;
    }
    answers[existingKey || label] = answer;
    await store.set({ profile: { ...profile, answers } });
  }

  let learningQueue = Promise.resolve();
  document.addEventListener("change", (event) => {
    learningQueue = learningQueue
      .then(() => learnManualAnswer(event))
      .catch((error) => console.error("[jaf] Could not save your answer locally.", error));
  }, true);

  function resumeText(profile) {
    const parts = [profile.cv_text, profile.resume_text, profile.summary];
    if (Array.isArray(profile.skills)) parts.push(profile.skills.join(". "));
    const records = [
      ...(Array.isArray(profile.experience) ? profile.experience : []),
      ...(Array.isArray(profile.education) ? profile.education : []),
    ];
    for (const item of records) {
      if (item && typeof item === "object") parts.push(Object.values(item).filter((v) => typeof v === "string").join(". "));
    }
    return parts.filter((part) => typeof part === "string").join("\n");
  }

  function evidenceSentences(label, profile) {
    const acronym = label.match(/\(([A-Za-z][A-Za-z0-9+.-]{1,})\)/)?.[1]?.toLowerCase();
    const terms = [...new Set(norm(label).match(/[a-z0-9+#.-]+/g) || [])]
      .filter((word) => !STOP_WORDS.has(word) && word.length > 2);
    const source = resumeText(profile);
    return source
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => {
        if (!sentence || sentence.length > 500) return false;
        const normalized = norm(sentence);
        if (acronym && (normalized.match(/[a-z0-9+#.-]+/g) || []).includes(acronym)) return true;
        const matched = terms.filter((term) => normalized.includes(term));
        return terms.length > 0 && matched.length >= Math.min(2, terms.length);
      });
  }

  function answerLocally(field, profile) {
    const customAnswers = profile.custom_answers;
    if (customAnswers && typeof customAnswers === "object") {
      const match = Object.entries(customAnswers).find(([key, value]) =>
        typeof value === "string" && value.trim() && norm(field.label).includes(norm(key).replace(/_/g, " "))
      );
      if (match) return match[1].trim();
    }

    const label = norm(field.label);
    const skills = Array.isArray(profile.skills) ? profile.skills.filter((skill) => typeof skill === "string") : [];
    const asksYesNo = /^(have you|do you|are you|can you|will you|would you|is your|are you)\b/.test(label)
      || /certif|authorized|eligible|sponsor|relocat|veteran|disabilit|gender|ethnic/.test(label);
    const skill = skills.find((item) => {
      const normalized = norm(item);
      return normalized.length > 2 && label.includes(normalized);
    });
    if (skill && !/certif|license|degree/.test(label)) {
      if (asksYesNo) {
        if (field.options?.length) {
          return field.options.find((option) => /^(yes|y|true)\b/i.test(norm(option))) || null;
        }
        return "Yes";
      }
      if (!asksYesNo && /\bskills?\b|technolog|tools|programming language/.test(label)) return skills.join(", ");
    }
    if (!asksYesNo && /\bskills?\b|technolog|tools|programming language/.test(label) && skills.length) {
      return skills.join(", ");
    }

    const evidence = evidenceSentences(field.label, profile);
    if (!evidence.length) return null;

    if (asksYesNo) {
      const positive = evidence.find((sentence) => AFFIRMATIVE.test(sentence) && !NEGATIVE.test(sentence));
      if (positive) {
        if (field.options?.length) {
          const yes = field.options.find((option) => /^(yes|y|true)\b/i.test(norm(option)));
          return yes || null;
        }
        if (field.inputType === "textarea") return positive;
        return "Yes";
      }
      const negative = evidence.find((sentence) => NEGATIVE.test(sentence));
      if (negative && field.options?.length) {
        const no = field.options.find((option) => /^(no|n|false)\b/i.test(norm(option)));
        return no || null;
      }
      return null;
    }
    return evidence.slice(0, 2).join(" ");
  }

  function technicalAnswer(field, profile) {
    const label = norm(field.label);
    const experiences = Array.isArray(profile.experience) ? profile.experience : [];
    const agentWork = experiences.find((item) =>
      /openhands|multi.agent|agent orchestration/i.test(`${item.company || ""} ${item.title || ""} ${item.description || ""}`)
    );
    const ragWork = experiences.find((item) =>
      /\brag\b|retrieval.augmented|llm/i.test(item.description || "")
    );
    const skills = Array.isArray(profile.skills) ? profile.skills : [];
    const hasVectorDatabase = skills.some((skill) => /qdrant|vectordb|vector database/i.test(skill));
    const asksNamedFramework = /langchain|langgraph|vertex|agent builder/.test(label);
    const asksAgentWork = /agentic|multi.agent|agent orchestration|autonomous agent/.test(label);
    const asksRagOrVector = /\brag\b|retrieval.augmented|vector database|vector store/.test(label);

    if (asksNamedFramework && agentWork) {
      const text = `My CV does not list hands-on use of LangChain, LangGraph, or Vertex AI Agent Builder. It does document my contributions to a multi-agent AI platform, including agent orchestration and state-management improvements.`;
      return { text, choice: null };
    }
    if (asksAgentWork && agentWork) {
      return {
        text: `I contributed to a multi-agent AI platform, focusing on agent orchestration and state management.${/\bFastAPI\b/i.test(profile.cv_text || "") ? " I also deployed an agentic AI system in production using FastAPI." : ""}${ragWork ? " I also contributed to an LLM- and RAG-based automation project." : ""}`,
        choice: "Yes",
      };
    }
    if (asksRagOrVector && ragWork) {
      const hasVectorRequirement = /vector database|vector store|pinecone|weaviate|chroma|bigquery/.test(label);
      return {
        text: `I contributed to an LLM- and RAG-based automation project that analyzed failed records, automated common resolutions, and retried the records.${hasVectorRequirement && hasVectorDatabase ? " A vector database is listed among my skills; my CV does not specify whether it was used in this project." : ""}`,
        choice: hasVectorRequirement ? null : "Yes",
      };
    }
    return null;
  }

  function salaryValue(field, profile) {
    const salary = salaryAnswer(field, profile);
    if (!salary) return null;
    const formatted = salary.currency === "USD"
      ? `$${salary.amount.toLocaleString("en-US")}`
      : `PKR ${salary.amount.toLocaleString("en-US")}`;
    return { amount: salary.amount, formatted, currency: salary.currency };
  }

  // ---------- DOM helpers ----------
  function* walk(root = document) {
    for (const el of root.querySelectorAll("input, textarea, select")) yield el;
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) yield* walk(host.shadowRoot);
  }
  const visible = (el) => {
    if (el.closest?.("#jaf-host")) return false;
    const cs = getComputedStyle(el);
    return el.getClientRects().length > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };

  function nearbyText(el) {
    let cur = el;
    for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
      const prev = cur.previousElementSibling;
      if (prev && !prev.querySelector("input,select,textarea")) {
        const t = textOf(prev);
        if (t && t.length < 250) return t;
      }
    }
    return "";
  }

  function labelOf(el) {
    let t = "";
    if (el.labels && el.labels.length) t = [...el.labels].map(textOf).join(" ");
    if (!t) {
      const ids = el.getAttribute("aria-labelledby");
      if (ids) t = ids.split(/\s+/).map((id) => textOf(el.getRootNode().getElementById?.(id))).join(" ");
    }
    if (!t) t = el.getAttribute("aria-label") || "";
    if (!t) t = el.getAttribute("placeholder") || "";
    if (!t) t = nearbyText(el);
    if (!t) t = (el.name || el.id || "").replace(/[_\-.\[\]]/g, " ");
    return norm(t);
  }

  function groupLabel(group) {
    const fs = group[0].closest("fieldset");
    const legend = fs && fs.querySelector("legend");
    if (legend) return norm(textOf(legend));
    const rg = group[0].closest('[role="radiogroup"],[role="group"]');
    if (rg) {
      const l = rg.getAttribute("aria-label") || textOf(rg.getRootNode().getElementById?.(rg.getAttribute("aria-labelledby")));
      if (l) return norm(l);
    }
    let a = group[0].parentElement;
    while (a && !group.every((el) => a.contains(el))) a = a.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      const first = a.firstElementChild;
      if (first && !first.querySelector("input") && textOf(first).length < 300 && textOf(first)) return norm(textOf(first));
      const prev = a.previousElementSibling;
      if (prev && !prev.querySelector("input") && textOf(prev) && textOf(prev).length < 300) return norm(textOf(prev));
    }
    return labelOf(group[0]);
  }

  const PLACEHOLDER_OPT = /^(select|choose|please|--|—|pick)/i;

  function collect(force) {
    const fields = [];
    const seen = new Set();
    for (const el of walk()) {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset"].includes(type) || el.disabled || el.readOnly) continue;
      if (el.dataset.jafDone && !force) continue;
      if (type !== "file" && !visible(el)) continue;
      const base = {
        el,
        key: fieldId(el),
        name: el.name || el.id || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        required: el.required || el.getAttribute("aria-required") === "true",
      };

      if (type === "radio") {
        const root = el.getRootNode();
        const key = el.name || el;
        if (seen.has(key)) continue;
        seen.add(key);
        const group = el.name ? [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)] : [el];
        if (!force && group.some((r) => r.checked)) continue;
        fields.push({
          ...base,
          required: group.some((item) => item.required || item.getAttribute("aria-required") === "true"),
          kind: "radio",
          els: group,
          label: groupLabel(group),
          options: group.map(labelOf),
        });
      } else if (type === "checkbox") {
        const container = el.closest("fieldset,[role=group]");
        const key = container || el;
        if (seen.has(key)) continue;
        seen.add(key);
        const group = container
          ? [...container.querySelectorAll('input[type="checkbox"]')].filter((item) => !item.disabled)
          : [el];
        const label = groupLabel(group);
        const options = group.map(labelOf);
        if (/agree|acknowledge|consent|certif|confirm|terms|privacy|accurate|truthful/.test(`${label} ${options.join(" ")}`)) continue;
        if (!force && group.every((item) => item.checked)) continue;
        fields.push({
          ...base,
          required: group.some((item) => item.required || item.getAttribute("aria-required") === "true"),
          kind: "checkbox-group",
          els: group,
          label,
          options,
        });
      } else if (type === "file") {
        if (force || !el.files?.length) fields.push({ ...base, kind: "file", label: labelOf(el), options: [] });
      } else if (el.tagName === "SELECT") {
        const options = [...el.options].map((o) => o.text.trim()).filter((t) => t && !PLACEHOLDER_OPT.test(t));
        const cur = el.selectedOptions[0];
        if (!force && !el.multiple && el.selectedIndex > 0 && cur && !PLACEHOLDER_OPT.test(cur.text.trim())) continue;
        fields.push({ ...base, kind: "select", label: labelOf(el), options });
      } else {
        if (!force && el.value.trim()) continue;
        const combo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") || el.getAttribute("aria-haspopup") === "listbox";
        fields.push({ ...base, kind: combo ? "combo" : "text", inputType: type, label: labelOf(el), options: [] });
      }
    }
    return fields;
  }

  // ---------- filling ----------
  function setNative(el, v) {
    if (el.tagName === "SELECT" && el.multiple && Array.isArray(v)) {
      const selected = new Set(v.map(norm));
      for (const option of el.options) {
        option.selected = selected.has(norm(option.text)) || selected.has(norm(option.value));
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function matchOption(options, value) {
    const v = norm(value);
    const o = options.map(norm);
    let i = o.findIndex((x) => x === v);
    if (i >= 0) return i;
    const aliases = new Map([
      ["united states", ["us", "usa", "united states of america"]],
      ["united kingdom", ["uk", "great britain", "britain"]],
      ["pakistan", ["pk"]],
      ["yes", ["y", "true"]],
      ["no", ["n", "false"]],
      ["not currently authorized", ["not authorized", "not eligible", "not eligible to work"]],
    ]);
    for (const [canonical, variants] of aliases) {
      if (v === canonical || variants.includes(v)) {
        i = o.findIndex((option) => option === canonical || variants.includes(option));
        if (i >= 0) return i;
      }
    }
    if (/^(yes|y|true)$/.test(v)) return o.findIndex((x) => /^(yes|y|true)\b/.test(x));
    if (/^(no|n|false)$/.test(v)) return o.findIndex((x) => /^(no|n|false)\b/.test(x));
    if (/decline|prefer not|not wish/.test(v)) {
      return o.findIndex((x) => /decline|prefer not|do not wish|don.?t wish|not (to )?(say|disclose|specify|answer)/.test(x));
    }
    return -1;
  }

  function matchSalaryOption(options, amount) {
    for (let i = 0; i < options.length; i++) {
      const text = options[i].toLowerCase().replace(/,/g, "");
      const values = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([km])?/g)].map((match) => {
        const multiplier = match[2] === "m" ? 1000000 : match[2] === "k" ? 1000 : 1;
        return Number(match[1]) * multiplier;
      });
      if (values.length >= 2 && amount >= Math.min(values[0], values[1]) && amount <= Math.max(values[0], values[1])) return i;
      if (values.length === 1 && /under|below|less than|up to/.test(text) && amount <= values[0]) return i;
      if (values.length === 1 && /over|above|more than|\+/.test(text) && amount >= values[0]) return i;
    }
    return -1;
  }

  function attachCV(input, cv) {
    const bin = atob(cv.b64);
    const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([arr], cv.name, { type: cv.type || "application/pdf" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillField(f, value) {
    try {
      if (f.kind === "text") {
        let v = value;
        if (f.inputType === "date") {
          const d = new Date(value);
          if (isNaN(d)) return false;
          v = d.toISOString().slice(0, 10);
        }
        if (f.inputType === "number") v = String(typeof value === "object" ? value.amount : value).replace(/[^\d.]/g, "");
        else if (typeof value === "object" && value.formatted) v = value.formatted;
        if (f.inputType === "number" && !v) return false;
        setNative(f.el, v);
        return true;
      }
      if (f.kind === "select") {
        const opts = [...f.el.options];
        if (typeof value === "object" && value.amount) {
          const index = matchSalaryOption(opts.map((option) => option.text.trim()), value.amount);
          if (index >= 0) {
            setNative(f.el, opts[index].value);
            return true;
          }
          const currency = matchOption(opts.map((option) => option.text.trim()), value.currency);
          if (currency < 0) return false;
          setNative(f.el, opts[currency].value);
          return true;
        }
        if (f.el.multiple) {
          const values = Array.isArray(value) ? value : [value];
          const selected = values
            .map((item) => matchOption(opts.map((option) => option.text.trim()), item))
            .filter((index) => index >= 0)
            .map((index) => opts[index].text.trim());
          if (!selected.length) return false;
          setNative(f.el, selected);
          return true;
        }
        const i = matchOption(opts.map((o) => o.text.trim()), value);
        if (i < 0) return false;
        setNative(f.el, opts[i].value);
        return true;
      }
      if (f.kind === "radio") {
        const i = matchOption(f.options, value);
        if (i < 0) return false;
        f.els[i].click();
        return true;
      }
      if (f.kind === "checkbox-group") {
        const desired = Array.isArray(value) ? value : String(value).split(/[,;|]/).map((item) => item.trim());
        let matched = false;
        for (const answer of desired) {
          const i = matchOption(f.options, answer);
          if (i < 0) continue;
          matched = true;
          if (!f.els[i].checked) f.els[i].click();
        }
        return matched;
      }
      if (f.kind === "checkbox") {
        if (!f.el.checked) f.el.click();
        return true;
      }
      if (f.kind === "combo") {
        f.el.focus();
        setNative(f.el, value);
        await sleep(400);
        const opts = [...document.querySelectorAll('[role="option"]')].filter(visible);
        const i = matchOption(opts.map(textOf), value);
        if (i >= 0) { opts[i].click(); return true; }
        return false;
      }
    } catch (e) {
      console.debug("[jaf] fill failed", f.label, e);
    }
    return false;
  }

  const COLORS = { rule: "#22c55e", local: "#eab308" };
  function mark(f, how) {
    const targets = f.els || [f.el];
    for (const t of targets) {
      t.dataset.jafDone = "1";
      t.style.outline = `2px solid ${COLORS[how]}`;
      t.style.outlineOffset = "1px";
      t.title = { rule: "Autofilled from your profile", local: "Matched locally from your résumé: please review" }[how];
    }
  }

  // ---------- main run ----------
  const state = { running: false, armed: false, nextClicks: 0, observed: new WeakSet() };

  async function run({ force = false } = {}) {
    if (state.running) return { busy: true };
    state.running = true;
    try {
      const { profile, cv, settings = {} } = await store.get(["profile", "cv", "settings"]);
      if (!profile) return { error: "No profile saved yet. Open the extension options and upload your CV." };
      const stats = { rule: 0, memory: 0, local: 0, total: 0 };
      const fields = collect(force);
      stats.total = fields.length;
      const pending = [];

      for (const f of fields) {
        for (const el of f.els || [f.el]) state.observed.add(el);
        if (f.kind === "file") {
          const fileContext = `${f.label} ${norm(f.name)}`;
          const isResume = /resume|cv|curriculum/.test(fileContext);
          const isOther = /cover|letter|photo|transcript|certificate/.test(fileContext);
          const onlyFile = document.querySelectorAll('input[type="file"]').length === 1;
          if (cv && !isOther && (isResume || onlyFile)) {
            try { attachCV(f.el, cv); mark(f, "rule"); stats.rule++; }
            catch (error) { stats.error = `Could not attach résumé: ${error.message}`; }
          }
          continue;
        }
        const learned = savedAnswerFor(f.label, profile.answers);
        if (learned !== null && learned !== undefined && await fillField(f, learned)) {
          mark(f, "local");
          stats.memory++;
          continue;
        }
        const key = classify(f);
        const v = key === "salary"
          ? salaryValue(f, profile)
          : key ? valueFor(key, profile) : null;
        if (v !== null && (await fillField(f, v))) { mark(f, "rule"); stats.rule++; continue; }
        const technical = technicalAnswer(f, profile);
        if (technical) {
          if (f.options?.length && technical.choice === null) {
            pending.push(f);
            continue;
          }
          const technicalValue = f.options?.length ? technical.choice : technical.text;
          const descriptive = f.inputType === "textarea" || /describe|explain|tell us|provide details|elaborate/.test(f.label);
          if (technicalValue && (f.options?.length || descriptive) && await fillField(f, technicalValue)) {
            mark(f, "local");
            stats.local++;
            continue;
          }
        }
        const local = answerLocally(f, profile);
        if (local && (await fillField(f, local))) { mark(f, "local"); stats.local++; continue; }
        pending.push(f);
      }

      for (const el of walk()) state.observed.add(el);
      if (state.armed && settings.autoNext && !pending.some((field) => field.required)) await maybeNext();
      return stats;
    } finally {
      state.running = false;
    }
  }

  // ---------- multi-page ----------
  async function maybeNext() {
    if (state.nextClicks >= 15 || document.querySelector(":invalid")) return;
    const btn = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a.button')]
      .filter(visible)
      .find((b) => {
        const t = norm(b.value || textOf(b));
        return /^(next|continue|save (and|&) continue|save (and|&) next|proceed)\b/.test(t) && !/submit|apply|send/.test(t);
      });
    if (btn) { state.nextClicks++; await sleep(700); btn.click(); }
  }

  let obs = null, timer = null, urlWatcher = null, lastUrl = location.href;
  function hasNewControls(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const controls = [];
    if (node.matches("input,textarea,select")) controls.push(node);
    controls.push(...node.querySelectorAll("input,textarea,select"));
    return controls.some((el) => !state.observed.has(el));
  }

  function arm() {
    if (state.armed) return;
    state.armed = true;
    obs = new MutationObserver((muts) => {
      const addedControls = muts.some((mutation) => [...mutation.addedNodes].some(hasNewControls));
      if (!addedControls) return;
      clearTimeout(timer);
      timer = setTimeout(() => state.armed && run(), 1000);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    urlWatcher = setInterval(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; state.dismissed.clear(); run(); }
    }, 800);
  }
  function disarm() {
    state.armed = false;
    obs && obs.disconnect();
    obs = null;
    clearTimeout(timer);
    timer = null;
    clearInterval(urlWatcher);
    urlWatcher = null;
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === "jaf-fill") {
      if (msg.keep) arm(); else disarm();
      run({ force: !!msg.force }).then(send).catch((error) => send({ error: error.message }));
      return true;
    }
  });
})();
