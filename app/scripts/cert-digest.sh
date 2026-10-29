#!/usr/bin/env bash
# Reads `apksigner verify --print-certs` output on stdin and prints the signing certificate's
# SHA-256 as AB:CD:… (the form pinned in build-apk.yml).
#
# apksigner prints one digest line per signer/scheme, with varying prefixes ("Signer #1",
# "Signer (minSdkVersion=…)", "V2 Signer:", "V3 Signer:"). Several lines with the same certificate
# are fine; zero or two-plus distinct certificates are an error (exit 1).
set -euo pipefail

digests=$(sed -n 's/^.*certificate SHA-256 digest: \([0-9A-Fa-f]\{64\}\)[[:space:]]*$/\1/p' | tr 'A-F' 'a-f' | sort -u)
count=$(printf '%s' "$digests" | grep -c . || true)
if [ "$count" -ne 1 ]; then
  echo "expected one signing certificate, found $count: ${digests:-none}" >&2
  exit 1
fi
printf '%s\n' "$digests" | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//'
