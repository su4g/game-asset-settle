#!/usr/bin/env python3
"""Validate a device IPA without reading user signing or connection credentials."""
import plistlib
import re
import struct
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    info_paths = [p for p in names if p.startswith('Payload/') and p.count('/') == 2 and p.endswith('.app/Info.plist')]
    assert len(info_paths) == 1, 'Expected exactly one application'
    info_path = info_paths[0]
    root = info_path.removesuffix('Info.plist')
    info = plistlib.loads(archive.read(info_path))
    assert info['CFBundlePackageType'] == 'APPL'
    assert info['CFBundleIdentifier'] == 'com.buffhelper.reader'
    assert info['CFBundleDisplayName'] == '饰品交易账本'
    assert info['CFBundleSupportedPlatforms'] == ['iPhoneOS']
    assert 'NSAppTransportSecurity' not in info, 'Do not disable HTTPS transport protections'
    assert not info.get('UIBackgroundModes'), 'Reader does not run platform collection in background'
    assert not any(p.endswith(('.buffconnection', '.p12', '.p8', '.pem', '.mobileprovision')) or '/_CodeSignature/' in p for p in names)
    assert root + 'PrivacyInfo.xcprivacy' in names
    binary = archive.read(root + info['CFBundleExecutable'])
    assert not re.search(rb'/(?:Users|home)/[^/\x00\s]+/', binary), 'Release executable must not contain personal build paths'
    assert b'synthetic-visual-preview-token' not in binary and b'--preview-fixtures' not in binary, 'Debug preview must not ship in Release'
    magic, cpu = struct.unpack_from('<II', binary)
    assert magic == 0xFEEDFACF and cpu == 0x0100000C, 'Expected arm64 Mach-O'
    count = struct.unpack_from('<I', binary, 16)[0]
    offset = 32
    for _ in range(count):
        command, size = struct.unpack_from('<II', binary, offset)
        assert size >= 8
        if command == 0x2C:
            assert struct.unpack_from('<I', binary, offset + 16)[0] == 0, 'Expected unencrypted executable'
        offset += size
    print(f"Verified unsigned arm64 IPA {info['CFBundleShortVersionString']} ({info['CFBundleVersion']})")
