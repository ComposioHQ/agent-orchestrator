# macOS Install Command Visibility

The landing hero's Homebrew command is shown only on macOS desktop browsers. Linux, Windows, iPhone, Android, and iPad hide the entire command row with no reserved space. Detection runs before hydration to avoid a visible flash; touch-capable iPads and mobile user agents must be excluded before matching macOS.

The fix stays within the existing HTML data attribute and CSS selector design. Browser emulation verifies computed visibility at desktop, phone, and tablet sizes.
