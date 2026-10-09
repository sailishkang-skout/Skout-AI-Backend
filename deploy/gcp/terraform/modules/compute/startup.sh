#!/bin/bash
# Runs on every boot, so each step is safe to repeat.
# ${ssh_user} is filled in by Terraform's templatefile() before the script reaches the VM.
# shellcheck disable=SC2154
set -eu
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y unattended-upgrades fail2ban ca-certificates curl

mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"}}
JSON

command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker unattended-upgrades fail2ban

# The guest agent creates the SSH user from instance metadata; wait for it, then grant Docker access.
for _ in $(seq 1 60); do
  id "${ssh_user}" >/dev/null 2>&1 && break
  sleep 5
done
usermod -aG docker "${ssh_user}"
