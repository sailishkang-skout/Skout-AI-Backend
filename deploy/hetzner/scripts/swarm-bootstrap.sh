#!/usr/bin/env bash
# One-time: init the Swarm on the manager, join the workers, label the stateful node.
# Usage: ./swarm-bootstrap.sh <manager_public_ip> <manager_private_ip> <worker_public_ip>...
set -euo pipefail
MANAGER_PUB="${1:?manager public ip}"
MANAGER_PRIV="${2:?manager private ip}"
shift 2

SSH=(ssh -o StrictHostKeyChecking=accept-new -i "${SSH_KEY:-$HOME/.ssh/skout_hetzner_deploy}")

# cloud-init installs Docker on first boot; wait for it so we do not race the install.
for host in "$MANAGER_PUB" "$@"; do
  "${SSH[@]}" "root@$host" "cloud-init status --wait >/dev/null"
done

"${SSH[@]}" "root@$MANAGER_PUB" "docker info --format '{{.Swarm.LocalNodeState}}' | grep -q active || docker swarm init --advertise-addr $MANAGER_PRIV"
TOKEN="$("${SSH[@]}" "root@$MANAGER_PUB" docker swarm join-token -q worker)"

for worker in "$@"; do
  "${SSH[@]}" "root@$worker" "docker info --format '{{.Swarm.LocalNodeState}}' | grep -q active || docker swarm join --token $TOKEN $MANAGER_PRIV:2377"
done

MANAGER_ID="$("${SSH[@]}" "root@$MANAGER_PUB" docker node ls --filter role=manager -q | head -n1)"
"${SSH[@]}" "root@$MANAGER_PUB" "docker node update --label-add stateful=true $MANAGER_ID"
"${SSH[@]}" "root@$MANAGER_PUB" docker node ls
