"""R7: Hugging Face commits back off and retry on 429 (honouring the server's wait), fail fast on 4xx."""

from __future__ import annotations

from typing import Any

import pytest

from typhoon import publish


class _Resp:
    def __init__(self, status: int, headers: dict[str, str]) -> None:
        self.status_code, self.headers = status, headers


class _HTTPError(Exception):
    def __init__(self, status: int, headers: dict[str, str] | None = None) -> None:
        super().__init__(f"{status}")
        self.response = _Resp(status, headers or {})


class _Api:
    def __init__(self, errors: list[Exception]) -> None:
        self.errors, self.calls = errors, 0

    def create_commit(self, *_: Any, **__: Any) -> str:
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return "ok"


def test_hf_commit_waits_on_429_then_succeeds() -> None:
    waits: list[float] = []
    a = _Api([_HTTPError(429, {"Retry-After": "40"}), _HTTPError(429, {"RateLimit": '"api";r=0;t=120'}),
              _HTTPError(503)])
    assert publish.hf_commit(a, [], "m", sleep=waits.append) == "ok"
    assert a.calls == 4
    assert waits[0] == 41 and waits[1] == 121          # the server's hint (+1 s)
    assert publish.COMMIT_BACKOFF_S * 0.75 <= waits[2] <= publish.COMMIT_BACKOFF_MAX_S


def test_hf_commit_gives_up_at_once_on_permanent_errors() -> None:
    a = _Api([_HTTPError(403)])
    with pytest.raises(_HTTPError):
        publish.hf_commit(a, [], "m", sleep=lambda _s: None)
    assert a.calls == 1
