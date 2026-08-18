package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/spf13/cobra"
)

// androidSDKStatusDTO mirrors the daemon's controllers.AndroidSDKStatusResponse.
// The CLI keeps its own copy so it need not import httpd/controllers.
type androidSDKStatusDTO struct {
	State      string                        `json:"state"`
	Components []androidSDKComponentProgress `json:"components,omitempty"`
	Error      string                        `json:"error,omitempty"`
	Detected   *androidSDKDetectedInfo       `json:"detected,omitempty"`
	Source     string                        `json:"source,omitempty"`
}

// androidSDKDetectedInfo mirrors controllers.AndroidSDKDetectedInfo.
type androidSDKDetectedInfo struct {
	Root     string `json:"root"`
	APILevel int    `json:"apiLevel"`
	Tag      string `json:"tag"`
	ABI      string `json:"abi"`
}

type androidSDKComponentProgress struct {
	Component  string `json:"component"`
	BytesDone  int64  `json:"bytesDone"`
	BytesTotal int64  `json:"bytesTotal"`
}

type androidSDKSetupRequest struct {
	AcceptLicenses bool `json:"acceptLicenses"`
}

func newAndroidCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "android",
		Short: "Manage AO's optional, embedded Android emulator",
	}

	sdkCmd := &cobra.Command{
		Use:   "sdk",
		Short: "Manage the Android SDK components AO's emulator needs (platform-tools, emulator, one system image)",
	}

	var statusJSON bool
	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show whether AO's managed Android SDK is installed, downloading, or failed",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := ctx.androidSDKStatus(cmd.Context())
			if err != nil {
				return err
			}
			return writeAndroidSDKStatus(cmd.OutOrStdout(), status, statusJSON)
		},
	}
	statusCmd.Flags().BoolVar(&statusJSON, "json", false, "print JSON")
	sdkCmd.AddCommand(statusCmd)

	var (
		setupJSON           bool
		setupAcceptLicenses bool
	)
	setupCmd := &cobra.Command{
		Use:   "setup",
		Short: "Download and install AO's managed Android SDK (~2GB)",
		Long: "Download and install the Android SDK components AO's embedded emulator needs\n" +
			"(platform-tools, emulator, one system image — roughly 2GB). This also accepts\n" +
			"the Android SDK license on your behalf, so it requires --accept-licenses.\n\n" +
			"The download runs in the background; poll `ao android sdk status` for progress.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !setupAcceptLicenses {
				return fmt.Errorf("refusing to proceed without --accept-licenses: this downloads the Android SDK and accepts its license on your behalf")
			}
			status, err := ctx.androidSDKSetup(cmd.Context())
			if err != nil {
				return err
			}
			return writeAndroidSDKStatus(cmd.OutOrStdout(), status, setupJSON)
		},
	}
	setupCmd.Flags().BoolVar(&setupJSON, "json", false, "print JSON")
	setupCmd.Flags().BoolVar(&setupAcceptLicenses, "accept-licenses", false, "accept the Android SDK license and proceed")
	sdkCmd.AddCommand(setupCmd)

	var useExistingJSON bool
	useExistingCmd := &cobra.Command{
		Use:   "use-existing",
		Short: "Use an Android SDK already installed on this machine instead of downloading AO's own copy",
		Long: "Adopts an existing Android SDK AO detected on this host (e.g. one installed by\n" +
			"Android Studio) instead of downloading AO's own managed copy. Run `ao android sdk\n" +
			"status` first to see what AO would detect.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := ctx.androidSDKUseExisting(cmd.Context())
			if err != nil {
				return err
			}
			return writeAndroidSDKStatus(cmd.OutOrStdout(), status, useExistingJSON)
		},
	}
	useExistingCmd.Flags().BoolVar(&useExistingJSON, "json", false, "print JSON")
	sdkCmd.AddCommand(useExistingCmd)

	cmd.AddCommand(sdkCmd)
	cmd.AddCommand(newEmulatorCommand(ctx))
	return cmd
}

func (c *commandContext) androidSDKStatus(ctx context.Context) (androidSDKStatusDTO, error) {
	var out androidSDKStatusDTO
	err := c.doJSONPath(ctx, http.MethodGet, "/api/v1/android-device/sdk/status", nil, &out)
	return out, err
}

func (c *commandContext) androidSDKSetup(ctx context.Context) (androidSDKStatusDTO, error) {
	var out androidSDKStatusDTO
	err := c.doJSONPath(ctx, http.MethodPost, "/api/v1/android-device/sdk/setup", androidSDKSetupRequest{AcceptLicenses: true}, &out)
	return out, err
}

func (c *commandContext) androidSDKUseExisting(ctx context.Context) (androidSDKStatusDTO, error) {
	var out androidSDKStatusDTO
	err := c.doJSONPath(ctx, http.MethodPost, "/api/v1/android-device/sdk/use-existing", nil, &out)
	return out, err
}

func writeAndroidSDKStatus(w io.Writer, status androidSDKStatusDTO, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(status)
	}
	if _, err := fmt.Fprintf(w, "state: %s\n", status.State); err != nil {
		return err
	}
	for _, c := range status.Components {
		if _, err := fmt.Fprintf(w, "  %s: %d/%d bytes\n", c.Component, c.BytesDone, c.BytesTotal); err != nil {
			return err
		}
	}
	if status.Source != "" {
		if _, err := fmt.Fprintf(w, "source: %s\n", status.Source); err != nil {
			return err
		}
	}
	if status.Detected != nil {
		d := status.Detected
		if _, err := fmt.Fprintf(w, "detected: %s (android-%d, %s, %s)\n", d.Root, d.APILevel, d.Tag, d.ABI); err != nil {
			return err
		}
	}
	if status.Error != "" {
		if _, err := fmt.Fprintf(w, "error: %s\n", status.Error); err != nil {
			return err
		}
	}
	return nil
}
