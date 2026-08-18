package androidemulator

import (
	"testing"
)

// realDumpFixture is trimmed from a real `adb shell uiautomator dump`
// capture during Phase A5 verification (an actual "System UI isn't
// responding" ANR dialog, with real clickable buttons), not hand-written --
// confirms the parser handles real attribute values, nesting, and
// self-closing leaf nodes as Android actually emits them.
const realDumpFixture = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="android" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[28,943][1052,1457]"><node index="0" text="System UI isn't responding" resource-id="android:id/alertTitle" class="android.widget.TextView" package="android" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[133,1032][947,1103]" /><node index="0" text="Close app" resource-id="android:id/aerr_close" class="android.widget.Button" package="android" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[70,1142][1010,1268]" /><node index="1" text="Wait" resource-id="android:id/aerr_wait" class="android.widget.Button" package="android" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[70,1268][1010,1394]" /></node></hierarchy>`

func TestParseUIHierarchyParsesRealDump(t *testing.T) {
	root, err := ParseUIHierarchy([]byte(realDumpFixture))
	if err != nil {
		t.Fatalf("ParseUIHierarchy: %v", err)
	}
	if root.Class != "android.widget.FrameLayout" {
		t.Errorf("root class = %q, want android.widget.FrameLayout", root.Class)
	}
	if len(root.Children) != 3 {
		t.Fatalf("root children = %d, want 3 (title, close button, wait button)", len(root.Children))
	}

	title := root.Children[0]
	if title.Text != "System UI isn't responding" || title.Clickable {
		t.Errorf("title node = %+v, want text set and clickable=false", title)
	}

	closeBtn := root.Children[1]
	if closeBtn.Text != "Close app" || closeBtn.ResourceID != "android:id/aerr_close" || !closeBtn.Clickable {
		t.Errorf("close button = %+v, want text=Close app, resourceId=android:id/aerr_close, clickable=true", closeBtn)
	}
}

func TestParseUIHierarchyParsesBounds(t *testing.T) {
	root, err := ParseUIHierarchy([]byte(realDumpFixture))
	if err != nil {
		t.Fatalf("ParseUIHierarchy: %v", err)
	}
	closeBtn := root.Children[1]
	want := Bounds{X1: 70, Y1: 1142, X2: 1010, Y2: 1268}
	if closeBtn.Bounds != want {
		t.Errorf("bounds = %+v, want %+v", closeBtn.Bounds, want)
	}
}

func TestFindClickableNodesReturnsOnlyClickableLeaves(t *testing.T) {
	root, err := ParseUIHierarchy([]byte(realDumpFixture))
	if err != nil {
		t.Fatalf("ParseUIHierarchy: %v", err)
	}
	clickable := FindClickable(root)
	if len(clickable) != 2 {
		t.Fatalf("clickable nodes = %d, want 2 (Close app, Wait)", len(clickable))
	}
	if clickable[0].Text != "Close app" || clickable[1].Text != "Wait" {
		t.Errorf("clickable nodes = %+v, want [Close app, Wait]", clickable)
	}
}

func TestParseUIHierarchyRejectsInvalidXML(t *testing.T) {
	_, err := ParseUIHierarchy([]byte("not xml at all"))
	if err == nil {
		t.Error("ParseUIHierarchy: want an error for invalid XML, got nil")
	}
}

func TestParseUIHierarchySurfacesTheKnownTransientDumpFailure(t *testing.T) {
	// A real, empirically-observed failure mode: uiautomator sometimes
	// returns "ERROR: null root node returned by UiTestAutomationBridge."
	// on stdout instead of XML (confirmed during Phase A5 verification,
	// especially right after the device wakes/resumes). This must surface
	// as a clear error, not a confusing XML-parse failure.
	_, err := ParseUIHierarchy([]byte("ERROR: null root node returned by UiTestAutomationBridge.\n"))
	if err == nil {
		t.Fatal("ParseUIHierarchy: want an error for the known transient dump failure, got nil")
	}
}
