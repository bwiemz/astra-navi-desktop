#!/usr/bin/env bash
# Fetches what is needed to build the phone app: a Java kit and Google's Android build
# tools. Everything goes into one folder of its own (no administrator rights, nothing
# system-wide), and deleting that folder removes it all again:
#
#   ~/.local/share/ai-chan-android/
#
# Running this accepts Google's Android SDK licence on your behalf; read it first at
# https://developer.android.com/studio/terms if you have not.
set -euo pipefail

tools="${AI_CHAN_ANDROID_TOOLS:-${XDG_DATA_HOME:-${HOME}/.local/share}/ai-chan-android}"
platform="android-35"
build_tools="35.0.0"
mkdir -p "${tools}"
cd "${tools}"

# Each download is one named release, checked against the checksum written here before
# it is unpacked: these tools build and sign the app, so they must be exactly the files
# this script was written for. To move to newer ones, change the address and the sum together.
jdk_url="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13.1%2B2/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13.1_2.tar.gz"
jdk_sum="bb8a93f9ae6e7a693b2b721e85dbeff26ae1a77447985a8d7afcdd9c7cf6222e"
platform_sum="0988cacad01b38a18a47bac14a0695f246bc76c1b06c0eeb8eb0dc825ab0c8e0"
build_tools_sum="bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88"

fetch_checked() { # <address> <file to save as> <expected sha256>
  curl -fL --retry 3 -o "$2" "$1"
  if ! echo "$3  $2" | sha256sum --check --status; then
    rm -f "$2"
    echo "The download from $1 is not the file this script expects. Nothing was installed from it." >&2
    exit 1
  fi
}

if [[ ! -x jdk/bin/javac ]]; then
  echo "Fetching the Java kit (about 200 MB)…"
  fetch_checked "${jdk_url}" jdk.tar.gz "${jdk_sum}"
  rm -rf jdk jdk.unpack
  mkdir jdk.unpack
  tar -xzf jdk.tar.gz -C jdk.unpack
  mv jdk.unpack/* jdk
  rmdir jdk.unpack
  rm jdk.tar.gz
fi
export JAVA_HOME="${tools}/jdk"
export PATH="${JAVA_HOME}/bin:${PATH}"

# The platform (the library an app is built against) and the build tools are fetched as
# plain archives straight from Google's download server. Google's own installer program
# is not used: it reports usage back to Google unless told not to.
fetch_archive() { # <file name on the server> <folder to end up with> <expected sha256>
  local archive="$1" target="$2" unpacked
  rm -rf "${target}" unpack.tmp
  mkdir -p unpack.tmp "$(dirname "${target}")"
  fetch_checked "https://dl.google.com/android/repository/${archive}" archive.zip "$3"
  unzip -q archive.zip -d unpack.tmp
  # Each archive holds one folder, whatever it is called.
  unpacked="$(find unpack.tmp -mindepth 1 -maxdepth 1 -type d | head -1)"
  mv "${unpacked}" "${target}"
  rm -rf unpack.tmp archive.zip
}

if [[ ! -f "sdk/platforms/${platform}/android.jar" ]]; then
  echo "Fetching the Android platform (about 65 MB)…"
  fetch_archive "platform-35_r02.zip" "sdk/platforms/${platform}" "${platform_sum}"
fi
if [[ ! -x "sdk/build-tools/${build_tools}/d8" ]]; then
  echo "Fetching the Android build tools (about 60 MB)…"
  fetch_archive "build-tools_r35_linux.zip" "sdk/build-tools/${build_tools}" "${build_tools_sum}"
fi

echo "Ready: ${tools}"
du -sh "${tools}" | cut -f1
