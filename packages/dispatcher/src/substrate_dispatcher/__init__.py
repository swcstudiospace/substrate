"""substrate-dispatcher: turns a Linear ``dispatch:<surface>`` label into a Hermes session.

The dispatcher polls Linear for unstarted issues labelled ``dispatch:<surface>``, resolves each
issue to its registered task-graph node through substrate-mcp ``graph_find``, prepares a
per-Graph-ID git worktree under ``/var/lib/substrate/worktrees`` and launches a Hermes session
there with a template-only prompt that claims the node before any work.

Runs on the host's system ``python3`` (httpx is already installed); no package install needed.
"""

__version__ = "0.1.0"
