import io
import pathlib
import sys
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "backend"))
import main  # noqa: E402

client = TestClient(main.app)


def test_health_is_local_only():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "mode": "local-only"}


def test_cors_only_allows_the_extension_origin():
    allowed = client.options(
        "/parse-cv",
        headers={
            "Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "Access-Control-Request-Method": "POST",
        },
    )
    denied = client.options(
        "/parse-cv",
        headers={"Origin": "https://example.com", "Access-Control-Request-Method": "POST"},
    )

    assert allowed.headers["access-control-allow-origin"] == "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    assert "access-control-allow-origin" not in denied.headers


def test_parse_cv_text_extracts_only_obvious_contact_details():
    resume = (
        b"Demo User\n"
        b"demo@example.com\n"
        b"+1 202 555 0100\n"
        b"https://linkedin.com/in/demo-profile\n"
        b"Python developer with experience building FastAPI applications.\n"
        b"Skills\nPython, FastAPI"
    )
    response = client.post("/parse-cv", files={"file": ("resume.txt", resume)})

    assert response.status_code == 200
    profile = response.json()
    assert profile["email"] == "demo@example.com"
    assert profile["full_name"] == "Demo User"
    assert profile["phone"] == "+1 202 555 0100"
    assert profile["linkedin"] == "https://linkedin.com/in/demo-profile"
    assert profile["skills"] == ["Python", "FastAPI"]
    assert profile["cv_text"].startswith("Demo User")
    assert profile["work_auth"] == {"authorized": "", "requires_sponsorship": ""}
    assert profile["eeo"] == {}


def test_parse_cv_extracts_education_work_durations_and_bare_links():
    resume = """Demo User
Python | AI/ML Engineer
demo@example.com | linkedin.com/in/demo-profile
PROFESSIONAL SUMMARY
AI/ML Engineer with 2 years of hands-on experience building machine learning systems.
EDUCATION
Bachelor of Science in Artificial Intelligence (BS-AI) | 2022 - 2026
Example University, Sample City
TECHNICAL SKILLS
Programming Languages: Python, Java
PROFESSIONAL EXPERIENCE
Python Developer
Example Company, Sample City Jan 2025 - Mar 2025
Built a machine learning API and automated data pipelines.
CERTIFICATIONS
AI Engineer Certificate
"""
    response = client.post("/parse-cv", files={"file": ("resume.txt", resume.encode())})

    assert response.status_code == 200
    profile = response.json()
    assert profile["full_name"] == "Demo User"
    assert profile["linkedin"] == "https://linkedin.com/in/demo-profile"
    assert profile["years_experience"] == "2"
    assert profile["summary"].startswith("AI/ML Engineer with 2 years")
    assert profile["education"] == [
        {
            "degree": "Bachelor of Science in Artificial Intelligence (BS-AI)",
            "field": "Artificial Intelligence",
            "school": "Example University, Sample City",
            "start_date": "2022",
            "end_date": "2026",
            "duration_months": 48,
            "duration": "4 years",
        }
    ]
    experience = profile["experience"][0]
    assert experience["title"] == "Python Developer"
    assert experience["company"] == "Example Company"
    assert experience["location"] == "Sample City"
    assert profile["latest_company"] == "Example Company"
    assert profile["latest_title"] == "Python Developer"
    assert profile["current_company"] == ""
    assert experience["duration_months"] == 2
    assert experience["description"] == "Built a machine learning API and automated data pipelines."
    assert profile["certifications"] == ["AI Engineer Certificate"]


def test_parse_cv_rejects_scanned_or_empty_text():
    response = client.post("/parse-cv", files={"file": ("resume.txt", b"image-only")})
    assert response.status_code == 422
    assert "No readable text" in response.json()["detail"]


def test_parse_cv_extracts_html_text_without_script_content():
    resume = b"<h1>Demo User</h1><p>demo@example.com</p><script>private noise</script><p>Python developer with production experience.</p>"
    response = client.post("/parse-cv", files={"file": ("resume.html", resume)})

    assert response.status_code == 200
    assert response.json()["full_name"] == "Demo User"
    assert response.json()["email"] == "demo@example.com"
    assert "private noise" not in response.json()["cv_text"]


def test_parse_cv_extracts_odt_paragraph_text():
    odt = io.BytesIO()
    with ZipFile(odt, "w") as archive:
        archive.writestr(
            "content.xml",
            '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
            'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
            "<office:body><office:text><text:p>Demo User</text:p>"
            "<text:p>Python engineer with production experience.</text:p>"
            "</office:text></office:body></office:document-content>",
        )
    response = client.post("/parse-cv", files={"file": ("resume.odt", odt.getvalue())})

    assert response.status_code == 200
    assert response.json()["full_name"] == "Demo User"
    assert "Python engineer" in response.json()["cv_text"]


def test_parse_cv_rejects_unsupported_files():
    response = client.post("/parse-cv", files={"file": ("resume.rtf", b"some text")})
    assert response.status_code == 415


@pytest.mark.parametrize("filename", ["resume.pdf", "resume.docx"])
def test_parse_cv_returns_readable_error_for_malformed_documents(filename):
    response = client.post("/parse-cv", files={"file": (filename, b"not a valid document")})
    assert response.status_code == 422


def test_parse_cv_rejects_files_over_limit():
    response = client.post(
        "/parse-cv",
        files={"file": ("resume.txt", b"x" * (main.MAX_RESUME_BYTES + 1))},
    )
    assert response.status_code == 413
