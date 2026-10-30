#!/usr/bin/env bash
# Reads `aapt2 dump permissions <apk>` on stdin and checks the APK's merged <uses-permission> set
# against the allowlist file given as $1 (one permission per line, # comments). Any difference
# fails (exit 1) and is printed: a new permission (a library's manifest, a plugin) must be a
# reviewed edit of the allowlist, never a surprise. Storage and media permissions are never allowed.
set -euo pipefail

allow_file=$1
actual=$(sed -n "s/^uses-permission\(-sdk-23\)\{0,1\}: name='\([^']*\)'.*$/\2/p" | sort -u)
expected=$(sed 's/#.*//; s/[[:space:]]//g; /^$/d' "$allow_file" | sort -u)

status=0
forbidden=$(printf '%s\n' "$actual" "$expected" | grep -E '_EXTERNAL_STORAGE$|^android\.permission\.READ_MEDIA_|MEDIA_LOCATION$|MANAGE_EXTERNAL_STORAGE$' | sort -u || true)
if [ -n "$forbidden" ]; then
  echo "storage/media permissions are never allowed:" >&2
  printf '  %s\n' $forbidden >&2
  status=1
fi
extra=$(comm -23 <(printf '%s\n' "$actual") <(printf '%s\n' "$expected") | sed '/^$/d')
missing=$(comm -13 <(printf '%s\n' "$actual") <(printf '%s\n' "$expected") | sed '/^$/d')
if [ -n "$extra" ]; then
  echo "in the APK but not in $(basename "$allow_file"):" >&2
  printf '  + %s\n' $extra >&2
  status=1
fi
if [ -n "$missing" ]; then
  echo "in $(basename "$allow_file") but not in the APK:" >&2
  printf '  - %s\n' $missing >&2
  status=1
fi
if [ -z "$actual" ]; then
  echo "no uses-permission lines read (is this aapt2 dump permissions output?)" >&2
  status=1
fi
[ "$status" -eq 0 ] && printf '%s\n' "$actual"
exit "$status"
