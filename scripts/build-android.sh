#!/usr/bin/env bash
# Builds the phone app (phone-app/) into phone-app/build/astra-navi.apk, which the station
# then offers to paired phones. Needs the tools fetched by scripts/setup-android.sh.
#
# The app is signed with a key made on this computer the first time and kept with her
# other private files. Android only lets an app be updated by one signed with the same
# key, so that file is what makes a later build install over an earlier one.
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
export JAVA_HOME="${tools}/jdk"
export PATH="${JAVA_HOME}/bin:${PATH}"

if [[ ! -x "${JAVA_HOME}/bin/javac" || ! -f "${platform}" || ! -x "${bt}/d8" ]]; then
  echo "The Android build tools are not here yet. Run scripts/setup-android.sh first." >&2
  exit 1
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

key="${data}/android-signing.p12"
pass="${data}/android-signing.pass"
if [[ -f "${key}" && ! -f "${pass}" ]] || [[ ! -f "${key}" && -f "${pass}" ]]; then
  # Making a new key here would lock every phone out of updates without saying so.
  echo "Only one of ${key} and ${pass} is there. Both are needed to sign the app." >&2
  echo "Restore the missing one from a backup; or, to start again with a new key, delete the" >&2
  echo "other too (phones must then uninstall the app before they can install the new build)." >&2
  exit 1
fi
if [[ ! -f "${key}" ]]; then
  mkdir -p -m 700 "${data}"
  # Made readable by this user alone from the first moment, not tightened afterwards.
  (
    umask 077
    head -c 24 /dev/urandom | base64 | tr -d '\n/+=' >"${pass}"
    keytool -genkeypair -keystore "${key}" -storetype PKCS12 -storepass:file "${pass}" \
      -alias aichan -keyalg EC -groupname secp256r1 -validity 10950 \
      -dname "CN=Astra Navi companion app (built on this computer)" >/dev/null 2>&1
  )
fi
"${bt}/apksigner" sign --ks "${key}" --ks-type PKCS12 --ks-key-alias aichan \
  --ks-pass "file:${pass}" --out "${out}/astra-navi.apk" "${out}/aligned.apk"
"${bt}/apksigner" verify "${out}/astra-navi.apk"

rm -rf "${out}/gen" "${out}/classes" "${out}/dex" "${out}/res.zip" "${out}/unsigned.apk" \
  "${out}/aligned.apk" "${out}/astra-navi.apk.idsig"
printf '%s\n' "${name:-0.1.0}" >"${out}/version"
echo "Built ${out}/astra-navi.apk ($(du -h "${out}/astra-navi.apk" | cut -f1), version ${name:-0.1.0}, build ${code})"
