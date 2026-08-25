package automation

// Embed the IANA database so packaged desktop daemons do not depend on a Go
// installation or an operating-system zoneinfo directory.
import _ "time/tzdata"
