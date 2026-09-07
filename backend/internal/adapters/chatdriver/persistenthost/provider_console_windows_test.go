//go:build windows

package persistenthost

import "golang.org/x/sys/windows"

var getConsoleWindow = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow")

func providerHasConsoleWindow() bool {
	handle, _, _ := getConsoleWindow.Call()
	return handle != 0
}
