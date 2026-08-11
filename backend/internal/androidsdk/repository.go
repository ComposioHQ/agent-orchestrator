package androidsdk

import (
	"encoding/xml"
	"fmt"
	"strings"
)

// Archive is a single resolved, downloadable SDK package artifact.
type Archive struct {
	URL  string
	SHA1 string
	Size int64
	// LicenseID is the id (e.g. "android-sdk-license") of the license this
	// package's manifest entry declares via <uses-license ref="..."/>. Empty
	// if the package declares none.
	LicenseID string
}

// Manifest is a parsed Android SDK repository manifest — either the main
// repository2-3.xml (platform-tools, emulator, ...) or a per-tag sys-img
// manifest (system images). Both share the same channel/remotePackage/archive
// shape, confirmed against the real manifests during the A0 spike.
type Manifest struct {
	Licenses       []xmlLicense       `xml:"license"`
	Channels       []xmlChannel       `xml:"channel"`
	RemotePackages []xmlRemotePackage `xml:"remotePackage"`
}

type xmlLicense struct {
	ID   string `xml:"id,attr"`
	Text string `xml:",chardata"`
}

type xmlChannel struct {
	ID   string `xml:"id,attr"`
	Name string `xml:",chardata"`
}

type xmlRemotePackage struct {
	Path        string         `xml:"path,attr"`
	TypeDetails xmlTypeDetails `xml:"type-details"`
	UsesLicense xmlRef         `xml:"uses-license"`
	ChannelRef  xmlRef         `xml:"channelRef"`
	Archives    []xmlArchive   `xml:"archives>archive"`
}

type xmlTypeDetails struct {
	APILevel int    `xml:"api-level"`
	Tag      xmlTag `xml:"tag"`
}

type xmlTag struct {
	ID string `xml:"id"`
}

type xmlRef struct {
	Ref string `xml:"ref,attr"`
}

type xmlArchive struct {
	Complete xmlComplete `xml:"complete"`
	HostOS   string      `xml:"host-os"`
	HostArch string      `xml:"host-arch"`
}

type xmlComplete struct {
	Size     int64  `xml:"size"`
	Checksum string `xml:"checksum"`
	URL      string `xml:"url"`
}

// ParseManifest parses raw repository/sys-img manifest XML bytes.
func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	if err := xml.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("androidsdk: parse manifest: %w", err)
	}
	return m, nil
}

// LicenseText returns the full text of the license with the given id (e.g.
// "android-sdk-license"), as declared at the top of the manifest and
// referenced by packages via <uses-license ref="..."/>. XML entity decoding
// is handled by encoding/xml; the result is trimmed of the leading/trailing
// whitespace the manifest's formatting introduces around the tag boundaries.
func (m Manifest) LicenseText(id string) (string, bool) {
	for _, l := range m.Licenses {
		if l.ID == id {
			return strings.TrimSpace(l.Text), true
		}
	}
	return "", false
}

// StableChannelID returns the channel id (e.g. "channel-0") whose name is
// "stable". Google's manifests always define this, but the id is not
// guaranteed to be "channel-0" forever, so it must be resolved, not assumed.
func (m Manifest) StableChannelID() string {
	for _, c := range m.Channels {
		if c.Name == "stable" {
			return c.ID
		}
	}
	return ""
}

// ResolvePlatformTools finds the platform-tools archive matching plat on the
// stable channel.
func (m Manifest) ResolvePlatformTools(plat Platform) (Archive, error) {
	stable := m.StableChannelID()
	for _, pkg := range m.RemotePackages {
		if pkg.Path != "platform-tools" || pkg.ChannelRef.Ref != stable {
			continue
		}
		if archive, ok := findArchiveForHost(pkg.Archives, plat, false); ok {
			archive.LicenseID = pkg.UsesLicense.Ref
			return archive, nil
		}
	}
	return Archive{}, fmt.Errorf("androidsdk: no stable platform-tools archive for %s/%s", plat.RepoOS, plat.RepoArch)
}

// ResolveEmulator finds the emulator archive matching plat on the stable
// channel. Manifests list multiple "emulator" packages (dev/canary/stable
// channels, different revisions) — the stable one must be selected explicitly,
// not just the newest revision, confirmed necessary during the A0 spike.
func (m Manifest) ResolveEmulator(plat Platform) (Archive, error) {
	stable := m.StableChannelID()
	for _, pkg := range m.RemotePackages {
		if pkg.Path != "emulator" || pkg.ChannelRef.Ref != stable {
			continue
		}
		if archive, ok := findArchiveForHost(pkg.Archives, plat, true); ok {
			archive.LicenseID = pkg.UsesLicense.Ref
			return archive, nil
		}
	}
	return Archive{}, fmt.Errorf("androidsdk: no stable emulator archive for %s/%s", plat.RepoOS, plat.RepoArch)
}

// ResolveSystemImage finds the system-image archive for the given Android API
// level and tag (e.g. "google_apis") matching plat's ABI, on the stable
// channel. System-image archives are host-OS-agnostic (a single zip works on
// any host), unlike platform-tools/emulator.
func (m Manifest) ResolveSystemImage(apiLevel int, tag string, plat Platform) (Archive, error) {
	stable := m.StableChannelID()
	wantPath := fmt.Sprintf("system-images;android-%d;%s;%s", apiLevel, tag, plat.SysImgABI)
	for _, pkg := range m.RemotePackages {
		if pkg.Path != wantPath || pkg.ChannelRef.Ref != stable {
			continue
		}
		if len(pkg.Archives) == 0 {
			continue
		}
		archive, err := archiveFromXML(pkg.Archives[0].Complete)
		if err != nil {
			return Archive{}, err
		}
		archive.LicenseID = pkg.UsesLicense.Ref
		return archive, nil
	}
	return Archive{}, fmt.Errorf("androidsdk: no stable system image for android-%d %s %s", apiLevel, tag, plat.SysImgABI)
}

// findArchiveForHost picks the archive within pkg whose host-os (and,
// requireArch, host-arch) matches plat.
func findArchiveForHost(archives []xmlArchive, plat Platform, requireArch bool) (Archive, bool) {
	for _, a := range archives {
		if a.HostOS != plat.RepoOS {
			continue
		}
		if requireArch && a.HostArch != plat.RepoArch {
			continue
		}
		archive, err := archiveFromXML(a.Complete)
		if err != nil {
			continue
		}
		return archive, true
	}
	return Archive{}, false
}

func archiveFromXML(c xmlComplete) (Archive, error) {
	if c.URL == "" {
		return Archive{}, fmt.Errorf("androidsdk: archive has no url")
	}
	return Archive{URL: c.URL, SHA1: c.Checksum, Size: c.Size}, nil
}
