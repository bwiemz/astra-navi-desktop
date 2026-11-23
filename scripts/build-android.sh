#!/usr/bin/env bash
# Builds the phone app (phone-app/) into phone-app/build/astra-navi.apk, which the station
# then offers to paired phones. Needs the tools fetched by scripts/setup-android.sh.
#
# Modes:
#   scripts/build-android.sh                       # Dev/local build using user data keystore
#   scripts/build-android.sh --release             # Release build using permanent external keystore
#   scripts/build-android.sh --init-release-key <path>  # Creates a permanent EC PKCS12 release keystore
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
xdg_data="${XDG_DATA_HOME:-${HOME}/.local/share}"
default_tools="${xdg_data}/astra-navi-android"
[[ ! -d "${default_tools}" && -d "${xdg_data}/ai-chan-android" ]] && default_tools="${xdg_data}/ai-chan-android"
tools="${ASTRA_NAVI_ANDROID_TOOLS:-${AI_CHAN_ANDROID_TOOLS:-${default_tools}}}"

default_data="${xdg_data}/astra-navi"
[[ ! -d "${default_data}" && -d "${xdg_data}/ai-chan" ]] && default_data="${xdg_data}/ai-chan"
data="${ASTRA_NAVI_DATA_DIR:-${AI_CHAN_DATA_DIR:-${default_data}}}"
bt="${tools}/sdk/build-tools/35.0.0"
platform="${tools}/sdk/platforms/android-35/android.jar"

release_mode=false
init_key_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      release_mode=true
      shift
      ;;
    --init-release-key)
      init_key_path="${2:-}"
      if [[ -z "${init_key_path}" ]]; then
        echo "Usage: scripts/build-android.sh --init-release-key <external-path.p12>" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

ensure_path_outside_repo() {
  local target_abs repo_abs
  repo_abs="$(cd "${here}" && pwd -P)"
  if command -v python3 >/dev/null 2>&1; then
    target_abs="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1")"
  else
    target_abs="$(readlink -m -- "$1")"
  fi
  if [[ "${target_abs}" == "${repo_abs}" || "${target_abs}" == "${repo_abs}/"* ]]; then
    echo "Refusing keystore inside git repository: ${target_abs}" >&2
    exit 1
  fi
}

if [[ -n "${init_key_path}" ]]; then
  ensure_path_outside_repo "${init_key_path}"
  if [[ -e "${init_key_path}" ]]; then
    echo "Refusing to overwrite existing keystore: ${init_key_path}" >&2
    exit 1
  fi
  keytool_bin="keytool"
  if [[ -x "${tools}/jdk/bin/keytool" ]]; then
    keytool_bin="${tools}/jdk/bin/keytool"
  fi
  if ! command -v "${keytool_bin}" >/dev/null 2>&1; then
    echo "keytool not found. Install OpenJDK or run scripts/setup-android.sh first." >&2
    exit 1
  fi
  mkdir -p -m 700 "$(dirname "${init_key_path}")"
  pass_file="${init_key_path%.p12}.pass"
  (
    umask 077
    head -c 32 /dev/urandom | base64 | tr -d '\n/+=' >"${pass_file}"
    "${keytool_bin}" -genkeypair -keystore "${init_key_path}" -storetype PKCS12 \
      -storepass:file "${pass_file}" -alias astranavi-release \
      -keyalg EC -groupname secp256r1 -validity 10950 \
      -dname "CN=Astra Navi Desktop Release,O=Astra Navi Project" >/dev/null
  )
  chmod 600 "${init_key_path}" "${pass_file}"
  echo "Created permanent Android release keystore: ${init_key_path}"
  echo "Created companion passphrase file: ${pass_file}"
  echo "Back up BOTH files offline immediately (losing this key breaks in-place APK upgrades):"
  "${keytool_bin}" -list -v -keystore "${init_key_path}" -storetype PKCS12 -storepass:file "${pass_file}" | grep -E "Alias name:|SHA256:" || true
  exit 0
fi

export JAVA_HOME="${tools}/jdk"
export PATH="${JAVA_HOME}/bin:${PATH}"

if [[ ! -x "${JAVA_HOME}/bin/javac" || ! -f "${platform}" || ! -x "${bt}/d8" ]]; then
  echo "The Android build tools are not here yet. Run scripts/setup-android.sh first." >&2
  exit 1
fi

key=""
pass_file=""
pass_env=""
alias_name="aichan"

if [[ "${release_mode}" == "true" ]]; then
  key="${ASTRA_NAVI_ANDROID_RELEASE_KEYSTORE:-}"
  pass_file="${ASTRA_NAVI_ANDROID_RELEASE_PASS_FILE:-}"
  pass_env="${ASTRA_NAVI_ANDROID_RELEASE_PASS:-}"
  alias_name="${ASTRA_NAVI_ANDROID_RELEASE_ALIAS:-astranavi-release}"
  if [[ -z "${key}" || ! -f "${key}" ]]; then
    echo "Release build requires ASTRA_NAVI_ANDROID_RELEASE_KEYSTORE pointing to an existing keystore outside this repo." >&2
    echo "Initialize one with: scripts/build-android.sh --init-release-key ~/.local/share/astra-navi-release/android-release.p12" >&2
    exit 1
  fi
  ensure_path_outside_repo "${key}"
  perm="$(stat -c '%a' "${key}" 2>/dev/null || echo '')"
  if [[ -n "${perm}" && "${perm: -2}" != "00" ]]; then
    echo "Warning: Release keystore ${key} has overly broad permissions (${perm}); tightening to 600." >&2
    chmod 600 "${key}" || true
  fi
  if [[ -n "${pass_file}" && ! -f "${pass_file}" ]]; then
    echo "ASTRA_NAVI_ANDROID_RELEASE_PASS_FILE does not exist: ${pass_file}" >&2
    exit 1
  fi
  if [[ -z "${pass_file}" && -z "${pass_env}" ]]; then
    echo "Release build requires ASTRA_NAVI_ANDROID_RELEASE_PASS_FILE or ASTRA_NAVI_ANDROID_RELEASE_PASS." >&2
    exit 1
  fi
else
  key="${data}/android-signing.p12"
  pass_file="${data}/android-signing.pass"
  if [[ -f "${key}" && ! -f "${pass_file}" ]] || [[ ! -f "${key}" && -f "${pass_file}" ]]; then
    # Making a new key here would lock every phone out of updates without saying so.
    echo "Only one of ${key} and ${pass_file} is there. Both are needed to sign the app." >&2
    echo "Restore the missing one from a backup; or, to start again with a new key, delete the" >&2
    echo "other too (phones must then uninstall the app before they can install the new build)." >&2
    exit 1
  fi
  if [[ ! -f "${key}" ]]; then
    alias_name="astranavi"
    mkdir -p -m 700 "${data}"
    # Made readable by this user alone from the first moment, not tightened afterwards.
    (
      umask 077
      head -c 24 /dev/urandom | base64 | tr -d '\n/+=' >"${pass_file}"
      keytool -genkeypair -keystore "${key}" -storetype PKCS12 -storepass:file "${pass_file}" \
        -alias "${alias_name}" -keyalg EC -groupname secp256r1 -validity 10950 \
        -dname "CN=Astra Navi companion app (built on this computer)" >/dev/null 2>&1
    )
  elif ! keytool -list -keystore "${key}" -storetype PKCS12 -storepass:file "${pass_file}" -alias "${alias_name}" >/dev/null 2>&1; then
    alias_name="astranavi"
  fi
fi

src="${here}/phone-app"
out="${src}/build"
rm -rf "${out}"
mkdir -p "${out}/gen" "${out}/classes" "${out}/dex"

# The version shown on the phone comes from package.json; the number Android compares
# (newer must be higher) is the minute of the build.
name="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "${here}/package.json" | head -1)"
code="$(($(date +%s) / 60))"

"${bt}/aapt2" compile --dir "${src}/res" -o "${out}/res.zip"
"${bt}/aapt2" link -o "${out}/unsigned.apk" -I "${platform}" \
  --manifest "${src}/AndroidManifest.xml" --java "${out}/gen" \
  --min-sdk-version 29 --target-sdk-version 34 \
  --version-code "${code}" --version-name "${name:-0.1.0}" \
  "${out}/res.zip"

mapfile -t sources < <(find "${src}/java" "${out}/gen" -name '*.java')
javac --release 17 -Xlint:all -Werror -classpath "${platform}" -d "${out}/classes" "${sources[@]}"

mapfile -t classes < <(find "${out}/classes" -name '*.class')
"${bt}/d8" --release --min-api 29 --lib "${platform}" --output "${out}/dex" "${classes[@]}"
# Added with the SDK's own tool: the system's zip rewrites the package instead of adding to it.
(cd "${out}/dex" && "${bt}/aapt" add "${out}/unsigned.apk" classes.dex >/dev/null)

"${bt}/zipalign" -f -p 4 "${out}/unsigned.apk" "${out}/aligned.apk"

if [[ -n "${pass_file}" ]]; then
  "${bt}/apksigner" sign --ks "${key}" --ks-type PKCS12 --ks-key-alias "${alias_name}" \
    --ks-pass "file:${pass_file}" --out "${out}/astra-navi.apk" "${out}/aligned.apk"
else
  "${bt}/apksigner" sign --ks "${key}" --ks-type PKCS12 --ks-key-alias "${alias_name}" \
    --ks-pass "env:ASTRA_NAVI_ANDROID_RELEASE_PASS" --out "${out}/astra-navi.apk" "${out}/aligned.apk"
fi
"${bt}/apksigner" verify --print-certs "${out}/astra-navi.apk" | grep -E "Signer #1 certificate DN:|Signer #1 certificate SHA-256 digest:" || "${bt}/apksigner" verify "${out}/astra-navi.apk"

rm -rf "${out}/gen" "${out}/classes" "${out}/dex" "${out}/res.zip" "${out}/unsigned.apk" \
  "${out}/aligned.apk" "${out}/astra-navi.apk.idsig"
printf '%s\n' "${name:-0.1.0}" >"${out}/version"
echo "Built ${out}/astra-navi.apk ($(du -h "${out}/astra-navi.apk" | cut -f1), version ${name:-0.1.0}, build ${code}, mode $([[ "${release_mode}" == "true" ]] && echo release || echo dev))"
