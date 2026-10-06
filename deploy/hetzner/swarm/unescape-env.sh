#!/bin/sh
# For every VAR__NL=<value with literal \n sequences>, export VAR=<value with real newlines>,
# then exec the original entrypoint/command. Used for PEM keys that cannot live in an env_file.
set -eu
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)__NL=.*/\1/p'); do
  raw=$(printenv "${name}__NL")
  # Trailing sentinel keeps a final newline, which $(...) would otherwise strip.
  value=$(printf '%b.' "$raw")
  value=${value%.}
  export "$name=$value"
  unset "${name}__NL"
done
exec "$@"
