#!/usr/bin/env bash
# One-time: init the Swarm on the manager, join the workers, label the stateful node.
# Works for Hetzner (SSH_USER=root, the default) and GCP (SSH_USER=deploy).
# Usage: ./swarm-bootstrap.sh <manager_public_ip> <manager_private_ip> [worker_public_ip...]
set -euo pipefail
MANAGER_PUB="${1:?manager public ip}"
MANAGER_PRIV="${2:?manager private ip}"
shift 2

USER_AT="${SSH_USER:-root}"
SSH=(ssh -o StrictHostKeyChecking=accept-new -i "${SSH_KEY:-$HOME/.ssh/skout_hetzner_deploy}")

# The node installs Docker on first boot (cloud-init on Hetzner, a startup script on GCP). Wait until the
# Docker daemon answers for our user, so we do not race the install or the docker-group change.
wait_for_docker() {
  local host="$1"
  for _ in $(seq 1 60); do
    if "${SSH[@]}" -o ConnectTimeout=5 "$USER_AT@$host" "docker info >/dev/null 2>&1"; then
      return 0
    fi
    sleep 10
  done
  echo "Docker did not become ready on $host" >&2
  return 1
}

for host in "$MANAGER_PUB" "$@"; do
  wait_for_docker "$host"
done

"${SSH[@]}" "$USER_AT@$MANAGER_PUB" "docker info --format '{{.Swarm.LocalNodeState}}' | grep -q active || docker swarm init --advertise-addr $MANAGER_PRIV"
TOKEN="$("${SSH[@]}" "$USER_AT@$MANAGER_PUB" docker swarm join-token -q worker)"

for worker in "$@"; do
  "${SSH[@]}" "$USER_AT@$worker" "docker info --format '{{.Swarm.LocalNodeState}}' | grep -q active || docker swarm join --token $TOKEN $MANAGER_PRIV:2377"
done

MANAGER_ID="$("${SSH[@]}" "$USER_AT@$MANAGER_PUB" docker node ls --filter role=manager -q | head -n1)"
"${SSH[@]}" "$USER_AT@$MANAGER_PUB" "docker node update --label-add stateful=true $MANAGER_ID"
"${SSH[@]}" "$USER_AT@$MANAGER_PUB" docker node ls
