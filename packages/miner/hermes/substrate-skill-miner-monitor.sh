#!/bin/sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/agent-substrate/current/packages/miner/src exec /usr/bin/python3 -m substrate_miner monitor
