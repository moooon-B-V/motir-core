#!/usr/bin/env bash
#
# fetch_installer <url> <dest> — download a vendor's install SCRIPT to a file and
# prove it IS one before anything runs it (MOTIR-6495). Sourced by
# install-agent.sh; kept in its own file so the test suite can drive it against
# a stub server without running an install arm.
#
# WHY NOT `curl … | bash`. A pipe executes whatever arrives. The antigravity arm
# failed on CI three times in a day with `bash: line 1: syntax error near
# unexpected token ')'`, and the bytes bash quoted back began `1f 8b 08` — a
# GZIP stream. The vendor's endpoint sits behind a public cache
# (`cache-control: public, max-age=600`) that sometimes hands a compressed body
# to a client that never asked for one. `-f` cannot see it: the status is 200.
# So a vendor hiccup read as a broken image build, and the only way to tell was
# to decode a Docker log by hand.
#
# WHAT IT DOES, per attempt:
#   1. `curl --compressed`, so a body the server MARKED as gzip is decoded;
#   2. a body that still starts with the gzip magic (compressed but UNMARKED)
#      is gunzipped here — the shape CI actually received;
#   3. the result must start with a `#!` shebang AND pass `bash -n`.
# A bad attempt is retried with backoff (3 attempts: waits of 2s, then 4s). When
# every attempt fails, the error names the URL and what came back instead of
# letting bash report a syntax error in a file nobody can see.
#
# MOTIR_INSTALLER_ATTEMPTS / MOTIR_INSTALLER_BACKOFF override the defaults; the
# test suite sets them so a failing case does not sleep.

# One attempt. On failure it prints the REASON on stdout and returns 1.
_fetch_installer_once() {
    local url="$1" dest="$2"
    local raw="$dest.download" err="$dest.err" magic
    if ! curl -fsSL --compressed -o "$raw" "$url" 2>"$err"; then
        printf 'curl failed: %s' "$(tr '\n' ' ' <"$err")"
        return 1
    fi
    magic="$(head -c 2 "$raw" | od -An -tx1 | tr -d ' \n')"
    if [ "$magic" = '1f8b' ]; then
        if ! gzip -dc "$raw" >"$dest" 2>"$err"; then
            printf 'a gzip body that does not decompress (%s)' "$(tr '\n' ' ' <"$err")"
            return 1
        fi
    else
        mv "$raw" "$dest"
    fi
    if [ "$(head -c 2 "$dest")" != '#!' ]; then
        printf 'not a shell script — no #! shebang; the body (%s bytes) starts: %s' \
            "$(wc -c <"$dest" | tr -d ' ')" \
            "$(head -c 60 "$dest" | LC_ALL=C tr -c '[:print:]' '.')"
        return 1
    fi
    if ! bash -n "$dest" 2>"$err"; then
        printf 'not a valid shell script — bash -n rejects it: %s' "$(head -c 200 "$err" | tr '\n' ' ')"
        return 1
    fi
    rm -f "$raw" "$err"
}

fetch_installer() {
    local url="$1" dest="$2"
    local attempts="${MOTIR_INSTALLER_ATTEMPTS:-3}" delay="${MOTIR_INSTALLER_BACKOFF:-2}"
    local n=1 why
    while :; do
        if why="$(_fetch_installer_once "$url" "$dest")"; then
            return 0
        fi
        if [ "$n" -ge "$attempts" ]; then
            echo "motir-sandbox: the installer at $url was not usable after $attempts attempts: $why" >&2
            rm -f "$dest" "$dest.download" "$dest.err"
            return 1
        fi
        echo "motir-sandbox: installer attempt $n/$attempts for $url failed ($why); retrying in ${delay}s." >&2
        sleep "$delay"
        n=$((n + 1))
        delay=$((delay * 2))
    done
}
