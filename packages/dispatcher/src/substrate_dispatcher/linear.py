"""Linear GraphQL client for the dispatcher: the D-10 poll, comments and label removal."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

LINEAR_API_BASE = "https://api.linear.app"
LINEAR_GQL_PATH = "/graphql"
DISPATCH_PREFIX = "dispatch:"

# D-10 poll: unstarted issues carrying a dispatch:* label (verified valid, 02-RESEARCH.md Q1).
DISPATCH_QUERY = """
query DispatchCandidates {
  issues(
    first: 50
    filter: { labels: { name: { startsWith: "dispatch:" } }, state: { type: { eq: "unstarted" } } }
  ) {
    nodes { id identifier team { id key } labels { nodes { id name } } }
  }
}
"""

COMMENT_BODIES_QUERY = """
query IssueComments($id: String!) {
  issue(id: $id) { comments(last: 50) { nodes { body } } }
}
"""

COMMENT_CREATE_MUTATION = """
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}
"""

REMOVE_LABEL_MUTATION = """
mutation RemoveLabel($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}
"""


class LinearApiError(RuntimeError):
    """A Linear request failed. The message never carries request headers (the API key)."""


@dataclass(frozen=True)
class Candidate:
    issue_id: str
    identifier: str
    team_id: str
    team_key: str
    surface: str
    dispatch_label_id: str
    dispatch_label: str


class LinearClient:
    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 20.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        key = (api_key or "").strip()
        if not key:
            raise ValueError("api_key required")
        kwargs: dict[str, Any] = {
            "base_url": LINEAR_API_BASE,
            # Linear personal API keys are sent raw: no "Bearer" prefix.
            "headers": {"Authorization": key, "Content-Type": "application/json"},
            "timeout": timeout,
        }
        if transport is not None:
            kwargs["transport"] = transport
        self._client = httpx.Client(**kwargs)

    @classmethod
    def from_env(cls, env_var: str = "LINEAR_API_KEY") -> LinearClient:
        key = os.environ.get(env_var, "")
        if not key.strip():
            raise RuntimeError(f"{env_var} not set")
        return cls(key)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> LinearClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables
        try:
            resp = self._client.post(LINEAR_GQL_PATH, json=payload)
        except httpx.HTTPError as exc:
            raise LinearApiError(f"Linear request failed: {type(exc).__name__}") from None
        if resp.status_code >= 400:
            raise LinearApiError(f"Linear HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            body = resp.json()
        except ValueError:
            raise LinearApiError(f"Linear returned non-JSON: {resp.text[:200]}") from None
        if body.get("errors"):
            messages = [str(e.get("message", e)) for e in body["errors"] if isinstance(e, dict)]
            raise LinearApiError(f"Linear GraphQL errors: {'; '.join(messages)[:200]}")
        data = body.get("data")
        if not isinstance(data, dict):
            raise LinearApiError("Linear response has no data")
        return data

    def dispatch_candidates(self) -> list[Candidate]:
        """One Candidate per dispatch:<surface> label on each unstarted issue."""
        data = self.graphql(DISPATCH_QUERY)
        out: list[Candidate] = []
        for issue in data["issues"]["nodes"]:
            team = issue.get("team") or {}
            for label in (issue.get("labels") or {}).get("nodes") or []:
                name = label.get("name") or ""
                if not name.startswith(DISPATCH_PREFIX):
                    continue
                surface = name[len(DISPATCH_PREFIX):]
                if not surface:
                    continue
                out.append(
                    Candidate(
                        issue_id=issue["id"],
                        identifier=issue["identifier"],
                        team_id=team.get("id", ""),
                        team_key=team.get("key", ""),
                        surface=surface,
                        dispatch_label_id=label["id"],
                        dispatch_label=name,
                    )
                )
        return out

    def comment_bodies(self, issue_id: str) -> list[str]:
        """Bodies of the issue's last 50 comments (for once-only dispatcher comments)."""
        data = self.graphql(COMMENT_BODIES_QUERY, {"id": issue_id})
        issue = data.get("issue")
        if not issue:
            raise LinearApiError(f"Linear issue {issue_id} not found")
        return [n.get("body") or "" for n in issue["comments"]["nodes"]]

    def comment(self, issue_id: str, body: str) -> None:
        data = self.graphql(COMMENT_CREATE_MUTATION, {"input": {"issueId": issue_id, "body": body}})
        if not (data.get("commentCreate") or {}).get("success"):
            raise LinearApiError(f"commentCreate failed for {issue_id}")

    def remove_label(self, issue_id: str, label_id: str) -> None:
        """Remove one label additively (removedLabelIds); never replaces the whole set."""
        data = self.graphql(
            REMOVE_LABEL_MUTATION, {"id": issue_id, "input": {"removedLabelIds": [label_id]}}
        )
        if not (data.get("issueUpdate") or {}).get("success"):
            raise LinearApiError(f"issueUpdate (remove label) failed for {issue_id}")
