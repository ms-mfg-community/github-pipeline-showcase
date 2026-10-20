"""Tests for report.py."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest
from report import FETCH_TIMEOUT_SECONDS, fetch, load, main, read, summarize


def test_summarize_renders_environment_outcome_and_short_digest() -> None:
    record = {
        "environment": "prod",
        "outcome": "succeeded",
        "digest": "sha256:abcdef0123456789",
    }
    assert summarize(record) == "prod: succeeded [sha256:abcdef012345]"


def test_summarize_tolerates_a_record_with_no_fields() -> None:
    assert summarize({}) == "unknown: unknown [(no digest)]"


def test_summarize_tolerates_an_empty_digest() -> None:
    assert summarize({"environment": "dev", "outcome": "failed", "digest": ""}) == (
        "dev: failed [(no digest)]"
    )


def test_load_reads_a_record_from_disk(tmp_path: Path) -> None:
    target = tmp_path / "dev.json"
    target.write_text(
        json.dumps({"environment": "dev", "outcome": "succeeded", "digest": "sha256:0"}),
        encoding="utf-8",
    )
    assert load(target)["environment"] == "dev"


class FakeResponse:
    """The slice of requests.Response that report.fetch relies on."""

    def __init__(self, payload: dict, error: Exception | None = None) -> None:
        self._payload = payload
        self._error = error

    def raise_for_status(self) -> None:
        if self._error is not None:
            raise self._error

    def json(self) -> dict:
        return self._payload


def fake_requests(
    monkeypatch: pytest.MonkeyPatch, response: FakeResponse
) -> list[tuple[str, float]]:
    """Stand in for the runtime-only ``requests`` package; returns the get() calls made."""
    calls: list[tuple[str, float]] = []

    def get(url: str, timeout: float) -> FakeResponse:
        calls.append((url, timeout))
        return response

    module = types.ModuleType("requests")
    module.get = get
    monkeypatch.setitem(sys.modules, "requests", module)
    return calls


def test_fetch_returns_the_json_body_and_bounds_the_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = {"environment": "prod", "outcome": "succeeded", "digest": "sha256:0"}
    calls = fake_requests(monkeypatch, FakeResponse(record))

    assert fetch("https://example.test/prod.json") == record
    assert calls == [("https://example.test/prod.json", FETCH_TIMEOUT_SECONDS)]


def test_fetch_lets_an_http_error_propagate(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_requests(monkeypatch, FakeResponse({}, error=RuntimeError("404 Not Found")))

    with pytest.raises(RuntimeError, match="404"):
        fetch("https://example.test/missing.json")


@pytest.mark.parametrize(
    "source", ["http://example.test/a.json", "https://example.test/a.json"]
)
def test_read_fetches_http_and_https_urls(
    monkeypatch: pytest.MonkeyPatch, source: str
) -> None:
    record = {"environment": "dev"}
    calls = fake_requests(monkeypatch, FakeResponse(record))

    assert read(source) == record
    assert [url for url, _ in calls] == [source]


def test_read_loads_a_path_from_disk_without_touching_the_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_requests(monkeypatch, FakeResponse({"environment": "wrong"}))
    target = tmp_path / "dev.json"
    target.write_text(json.dumps({"environment": "dev"}), encoding="utf-8")

    assert read(str(target)) == {"environment": "dev"}
    assert calls == []


def test_read_treats_a_filename_that_merely_starts_with_http_as_a_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_requests(monkeypatch, FakeResponse({"environment": "wrong"}))
    (tmp_path / "http-record.json").write_text(
        json.dumps({"environment": "dev"}), encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    assert read("http-record.json") == {"environment": "dev"}
    assert calls == []


def test_main_prints_one_summary_line_per_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    local = tmp_path / "dev.json"
    local.write_text(
        json.dumps({"environment": "dev", "outcome": "failed", "digest": ""}),
        encoding="utf-8",
    )
    remote = {
        "environment": "prod",
        "outcome": "succeeded",
        "digest": "sha256:abcdef0123456789",
    }
    fake_requests(monkeypatch, FakeResponse(remote))

    assert main([str(local), "https://example.test/prod.json"]) == 0

    assert capsys.readouterr().out.splitlines() == [
        "dev: failed [(no digest)]",
        "prod: succeeded [sha256:abcdef012345]",
    ]


def test_main_prints_usage_and_returns_2_when_given_nothing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 2

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "usage: report.py" in captured.err
