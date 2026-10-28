#!/bin/bash
set -euo pipefail
ios_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${1:-$ios_root/build/sideload}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT
xcodegen generate --spec "$ios_root/project.yml"
xcodebuild -project "$ios_root/BuffReader.xcodeproj" -scheme BuffReader \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$output_dir/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM= build
app_path="$output_dir/DerivedData/Build/Products/Release-iphoneos/BuffReader.app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Info.plist")"
build_number="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_path/Info.plist")"
mkdir -p "$staging_dir/Payload"
ditto "$app_path" "$staging_dir/Payload/BuffReader.app"
# Release archives must not expose the developer's source / object-file paths.
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Info.plist")"
xcrun strip -S "$staging_dir/Payload/BuffReader.app/$executable_name"
ipa_path="$output_dir/饰品交易账本-$version-$build_number-unsigned.ipa"
ditto -c -k --keepParent "$staging_dir/Payload" "$ipa_path"
python3 "$ios_root/scripts/verify_sideload_ipa.py" "$ipa_path"
(cd "$output_dir" && shasum -a 256 "$(basename "$ipa_path")" > SHA256SUMS.txt)
echo "Unsigned IPA: $ipa_path"
