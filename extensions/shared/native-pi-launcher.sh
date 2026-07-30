#!/bin/sh

EMPTY_VALUE="__PI_NATIVE_SPLIT_EMPTY__"

cwd=$1
session_file=$2
prompt_file=$3
marker_file=${4:-$EMPTY_VALUE}
if [ "$#" -ge 4 ]; then
  shift 4
else
  shift 3
fi

cd "$cwd" || {
  printf '\npi-native-split: failed to cd to %s\n' "$cwd" >&2
  exec "${SHELL:-/bin/sh}" -i
}

if [ "$session_file" != "$EMPTY_VALUE" ]; then
  set -- --session "$session_file"
else
  set --
fi

if [ "$prompt_file" != "$EMPTY_VALUE" ]; then
  prompt_dir=$(dirname "$prompt_file")
  prompt=$(cat "$prompt_file")
  rm -f "$prompt_file"
  rm -rf "$prompt_dir"
  set -- "$@" "$prompt"
fi

if [ "$marker_file" != "$EMPTY_VALUE" ]; then
  export PI_NATIVE_SPLIT_MARKER_FILE="$marker_file"
fi

pi "$@"
status=$?

if [ "$status" -ne 0 ]; then
  printf '\npi-native-split: pi launch failed with exit code %s\n' "$status" >&2
  printf 'cwd: %s\n' "$cwd" >&2
  if [ "$session_file" != "$EMPTY_VALUE" ]; then
    printf 'session: %s\n' "$session_file" >&2
  fi
  exec "${SHELL:-/bin/sh}" -i
fi
