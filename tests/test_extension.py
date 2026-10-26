"""End-to-end test of local profile matching on a two-step form."""
import base64
import json
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILE = {
    "first_name": "Demo", "last_name": "User", "email": "demo@example.com", "phone": "+1 202 555 0100",
    "linkedin": "https://linkedin.com/in/demo-profile",
    "address": {"city": "Sample City", "state": "Demo Region", "country": "Canada", "zip": "00000"},
    "desired_work_countries": ["United States"],
    "age_18_or_older": "Yes",
    "work_auth": {
        "authorized": "Yes",
        "requires_sponsorship": "Yes",
        "authorization_basis": "Sample permit",
    },
    "eeo": {
        "gender": "", "disability": "", "lgbtq": "", "veteran": "",
        "race": "", "hispanic_latino": "", "sexual_orientation": [],
        "pronouns": "",
    },
    "answers": {},
    "custom_answers": {"which contact channels do you prefer": "Email"},
    "salary_expectation": {"USD": {"monthly": 4000}, "PKR": {"monthly": 100000}},
    "skills": ["VectorDB", "Python", "FastAPI"],
    "experience": [
        {
            "company": "Example Studio",
            "description": "Contributed to a multi-agent AI platform by improving agent orchestration and state management.",
        },
        {
            "company": "Demo Systems",
            "description": "Built an LLM- and RAG-based automation project that analyzes failed records, resolves common errors, and retries records.",
        },
    ],
    "cv_text": (
        "I used Model Context Protocol (MCP) to manage tools and memory. "
        "I deployed an agentic AI system in production using FastAPI."
    ),
}
CV = {
    "name": "demo.resume",
    "type": "application/x-custom-resume",
    "b64": base64.b64encode(b"original resume bytes").decode(),
}

STUB = """
window.__store = %s;
window.__listeners = [];
window.chrome = {
  storage: { local: {
    get: (k, cb) => {
      const value = Object.fromEntries((Array.isArray(k)?k:[k]).map(x => [x, window.__store[x]]));
      if (cb) cb(value);
      return Promise.resolve(value);
    },
    set: (o, cb) => { Object.assign(window.__store, o); cb && cb(); return Promise.resolve(); } } },
  runtime: {
    onMessage: { addListener: (fn) => window.__listeners.push(fn) },
  },
};
""" % json.dumps({"profile": PROFILE, "cv": CV, "settings": {}})


def fill(page, keep=False):
    return page.evaluate(
        "() => new Promise(res => window.__listeners[0]({type:'jaf-fill', keep:%s}, null, res))" % str(keep).lower()
    )


def test_two_step_form():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.add_init_script(STUB)
        page.goto((ROOT / "tests" / "form.html").as_uri())
        page.add_script_tag(path=str(ROOT / "extension" / "content.js"))

        s1 = fill(page)
        assert page.input_value("#fn") == "Demo"
        assert page.input_value("#ln") == "User"
        assert page.input_value("#em") == "demo@example.com"
        assert page.input_value("#li").startswith("https://linkedin")
        assert page.input_value("#co") == "CA"
        assert page.input_value("#city") == "Sample City"
        assert page.input_value("#state") == "Demo Region"
        assert page.input_value("#zip") == "00000"
        assert page.locator("#workcountries option:checked").all_text_contents() == ["United States"]
        assert page.input_value("#salaryUsd") == "48000"
        assert page.input_value("#salaryPkr") == "100000"
        assert page.input_value("#salaryRange") == "$40,000 - $59,999"
        assert page.input_value("#salaryCurrency") == "USD"
        assert page.is_checked("input[name=auth][value=y]")
        assert page.input_value("#basis") == "Sample permit"
        assert page.input_value("#sponsor") == "Yes"
        assert page.input_value("#adult") == "Yes"
        assert page.evaluate("document.getElementById('cv').files[0].name") == "demo.resume"
        assert page.evaluate("document.getElementById('cv').files[0].type") == "application/x-custom-resume"
        assert s1["rule"] >= 10 and "need" not in s1, s1

        page.click("#next1")
        s2 = fill(page)
        assert page.input_value("#gen") == ""
        assert page.input_value("#disability") == ""
        assert page.input_value("#lgbtq") == ""
        assert page.input_value("#race") == ""
        assert page.input_value("#hispanic") == ""
        assert page.input_value("#veteran") == ""
        assert page.input_value("#pronouns") == ""
        assert page.is_checked('fieldset input[value="Email"]')
        assert not page.is_checked('fieldset input[value="SMS"]')
        assert page.input_value("#citizen") == ""
        assert not page.is_checked("#agree")  # consent is never checked automatically
        assert "used Model Context Protocol" in page.input_value("#mcp")
        assert "FastAPI" in page.input_value("#prod")
        framework_answer = page.input_value("#frameworks")
        assert "does not list hands-on use of LangChain, LangGraph, or Vertex AI Agent Builder" in framework_answer
        assert "multi-agent AI platform" in framework_answer
        assert page.input_value("#frameworkChoice") == ""  # specific framework experience is not documented
        rag_answer = page.input_value("#rag")
        assert "LLM- and RAG-based automation project" in rag_answer
        assert "A vector database is listed among my skills" in rag_answer
        assert page.input_value("#ragChoice") == ""  # CV does not tie a vector database to this project
        assert page.input_value("#multiChoice") == "Yes"
        assert page.input_value("#ker") == ""           # no evidence -> left empty, never invented
        assert page.input_value("#citizen") == ""
        assert s2["local"] >= 4, s2
        assert page.locator("#jaf-host").count() == 0
        repeat = fill(page)
        assert repeat["rule"] == repeat["local"] == 0, repeat

        page.locator("#ker").fill("I completed a Kubernetes certification in 2025.")
        page.locator("#ker").blur()
        page.wait_for_function(
            "() => Object.values(window.__store.profile.answers || {}).includes('I completed a Kubernetes certification in 2025.')"
        )
        learned = fill(page)
        assert page.input_value("#kerSimilar") == "I completed a Kubernetes certification in 2025."
        assert learned["memory"] == 1, learned
        b.close()


def test_options_upgrade_preserves_existing_profile_without_personal_defaults():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.add_init_script(STUB)
        page.add_init_script("""(() => {
          window.__store.profile = {
            address: { country: 'United States' },
            work_auth: { authorized: 'Yes' },
            eeo: { gender: 'Decline to self-identify' }
          };
        })();""")
        page.goto((ROOT / "extension" / "options.html").as_uri())
        page.wait_for_function("document.getElementById('profile').value.includes('United States')")
        profile = page.evaluate("JSON.parse(document.getElementById('profile').value)")

        assert profile["address"] == {
            "city": "",
            "state": "",
            "country": "United States",
            "zip": "",
        }
        assert profile["work_auth"]["authorized"] == "Yes"
        assert profile["work_auth"]["requires_sponsorship"] == ""
        assert profile["eeo"]["gender"] == "Decline to self-identify"
        assert profile["eeo"]["sexual_orientation"] == []
        assert profile["citizenship"] == ""
        assert page.evaluate("window.__store.profileDefaultsVersion") == 2

        page.locator("#cv").set_input_files({
            "name": "demo.resume",
            "mimeType": "application/x-custom-resume",
            "buffer": b"original custom resume bytes",
        })
        page.wait_for_function("document.getElementById('savedCv').textContent.includes('demo.resume')")
        page.click("#save")
        page.wait_for_function("window.__store.cv?.name === 'demo.resume'")
        assert page.evaluate("window.__store.cv.type") == "application/x-custom-resume"
        assert page.evaluate("atob(window.__store.cv.b64)") == "original custom resume bytes"
        browser.close()
