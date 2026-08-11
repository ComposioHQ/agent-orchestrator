package androidsdk

import "testing"

// fixtureManifest is a trimmed-down but structurally real manifest, matching
// the shape confirmed against the live https://dl.google.com/android/repository/repository2-3.xml
// during the A0 spike: channel id/name pairs, then remotePackages with
// channelRef and per-host-os/host-arch archives.
const fixtureManifest = `<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/3">
  <license id="android-sdk-license" type="text">Terms and Conditions

This is the Android SDK License Agreement text, with an escaped ampersand: Google &amp; You.
</license>
  <channel id="channel-0">stable</channel>
  <channel id="channel-1">beta</channel>
  <channel id="channel-2">dev</channel>
  <channel id="channel-3">canary</channel>
  <remotePackage path="platform-tools">
    <revision><major>37</major><minor>0</minor><micro>1</micro></revision>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete>
          <size>8044989</size>
          <checksum type="sha1">e03e78b1d80b396f1c3358e31251cb31740e1110</checksum>
          <url>platform-tools_r37.0.1-win.zip</url>
        </complete>
        <host-os>windows</host-os>
      </archive>
      <archive>
        <complete>
          <size>9054187</size>
          <checksum type="sha1">477254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-linux.zip</url>
        </complete>
        <host-os>linux</host-os>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="emulator">
    <revision><major>37</major><minor>2</minor><micro>3</micro></revision>
    <channelRef ref="channel-2"/>
    <archives>
      <archive>
        <complete>
          <size>456959401</size>
          <checksum type="sha1">f9719105d912a559419a422ee0e21400fb99e9a4</checksum>
          <url>emulator-windows_x64-canary.zip</url>
        </complete>
        <host-os>windows</host-os>
        <host-arch>x64</host-arch>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="emulator">
    <revision><major>37</major><minor>1</minor><micro>11</micro></revision>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete>
          <size>441926448</size>
          <checksum type="sha1">54fa750822ff462d57e04fc8e98e60f08df2bb61</checksum>
          <url>emulator-windows_x64-15917651.zip</url>
        </complete>
        <host-os>windows</host-os>
        <host-arch>x64</host-arch>
      </archive>
      <archive>
        <complete>
          <size>465773989</size>
          <checksum type="sha1">7df8b0acbe915217dcbb576222bddfcc23e81230</checksum>
          <url>emulator-darwin_x64-15917651.zip</url>
        </complete>
        <host-os>macosx</host-os>
        <host-arch>x64</host-arch>
      </archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>`

const fixtureSysImgManifest = `<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-sys-img xmlns:sdk="http://schemas.android.com/sdk/android/repo/sys-img2/3">
  <channel id="channel-0">stable</channel>
  <remotePackage path="system-images;android-34;google_apis;x86_64">
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete>
          <size>1563721130</size>
          <checksum type="sha1">e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7</checksum>
          <url>x86_64-34_r14.zip</url>
        </complete>
      </archive>
    </archives>
  </remotePackage>
</sdk:sdk-sys-img>`

func TestLicenseTextDecodesEntitiesAndTrims(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	text, ok := m.LicenseText("android-sdk-license")
	if !ok {
		t.Fatal("LicenseText(android-sdk-license): not found")
	}
	want := "Terms and Conditions\n\nThis is the Android SDK License Agreement text, with an escaped ampersand: Google & You."
	if text != want {
		t.Errorf("LicenseText = %q, want %q", text, want)
	}
}

func TestLicenseTextUnknownID(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if _, ok := m.LicenseText("no-such-license"); ok {
		t.Error("LicenseText(no-such-license): want ok=false, got true")
	}
}

func TestParseManifestResolvesStableChannelID(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if got := m.StableChannelID(); got != "channel-0" {
		t.Errorf("StableChannelID() = %q, want %q", got, "channel-0")
	}
}

func TestResolvePlatformToolsArchive(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	plat := Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"}

	archive, err := m.ResolvePlatformTools(plat)
	if err != nil {
		t.Fatalf("ResolvePlatformTools: %v", err)
	}
	if archive.URL != "platform-tools_r37.0.1-win.zip" {
		t.Errorf("URL = %q, want platform-tools_r37.0.1-win.zip", archive.URL)
	}
	if archive.SHA1 != "e03e78b1d80b396f1c3358e31251cb31740e1110" {
		t.Errorf("SHA1 = %q, want the windows checksum", archive.SHA1)
	}
	if archive.Size != 8044989 {
		t.Errorf("Size = %d, want 8044989", archive.Size)
	}
	if archive.LicenseID != "android-sdk-license" {
		t.Errorf("LicenseID = %q, want android-sdk-license", archive.LicenseID)
	}
}

func TestResolveEmulatorArchivePicksStableChannelNotDev(t *testing.T) {
	// The fixture deliberately has two "emulator" packages: a newer one on the
	// dev channel and an older one on the stable channel. Resolving must pick
	// stable, not simply the newest revision.
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	plat := Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"}

	archive, err := m.ResolveEmulator(plat)
	if err != nil {
		t.Fatalf("ResolveEmulator: %v", err)
	}
	if archive.URL != "emulator-windows_x64-15917651.zip" {
		t.Errorf("URL = %q, want the stable-channel build, not the dev-channel one", archive.URL)
	}
	if archive.SHA1 != "54fa750822ff462d57e04fc8e98e60f08df2bb61" {
		t.Errorf("SHA1 = %q, want the stable-channel checksum", archive.SHA1)
	}
}

func TestResolveEmulatorArchiveMacOS(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	plat := Platform{RepoOS: "macosx", RepoArch: "x64", SysImgABI: "x86_64"}

	archive, err := m.ResolveEmulator(plat)
	if err != nil {
		t.Fatalf("ResolveEmulator: %v", err)
	}
	if archive.URL != "emulator-darwin_x64-15917651.zip" {
		t.Errorf("URL = %q, want the macOS build", archive.URL)
	}
}

func TestResolveEmulatorArchiveNoMatchingHost(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	// The fixture has no linux archive on the stable emulator package.
	plat := Platform{RepoOS: "linux", RepoArch: "x64", SysImgABI: "x86_64"}

	_, err = m.ResolveEmulator(plat)
	if err == nil {
		t.Fatal("ResolveEmulator: want an error when no archive matches the host, got nil")
	}
}

func TestResolveSystemImageArchive(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureSysImgManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	plat := Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"}

	archive, err := m.ResolveSystemImage(34, "google_apis", plat)
	if err != nil {
		t.Fatalf("ResolveSystemImage: %v", err)
	}
	if archive.URL != "x86_64-34_r14.zip" {
		t.Errorf("URL = %q, want x86_64-34_r14.zip", archive.URL)
	}
	if archive.SHA1 != "e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7" {
		t.Errorf("SHA1 = %q, want the system image checksum", archive.SHA1)
	}
}

func TestResolveSystemImageArchiveUnknownAPILevel(t *testing.T) {
	m, err := ParseManifest([]byte(fixtureSysImgManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	plat := Platform{RepoOS: "windows", RepoArch: "x64", SysImgABI: "x86_64"}

	_, err = m.ResolveSystemImage(99, "google_apis", plat)
	if err == nil {
		t.Fatal("ResolveSystemImage: want an error for an API level not in the manifest, got nil")
	}
}
